// In-process stand-ins for the infrastructure in the architecture diagram.
// Each keeps the *semantics* the design relies on, behind an async interface,
// so the room logic is written exactly as it would be against the real systems:
//   LeaseStore  ~ etcd: TTL leases with a per-key fencing epoch
//   StateStore  ~ Redis: room state with a conditional (fenced) write
//   Bus         ~ NATS / Redis pub-sub: one topic per room, ordered per topic

const tick = () => new Promise((r) => setImmediate(r)); // simulate a network hop

export class LeaseStore {
  constructor(now = Date.now) {
    this.now = now;
    this.leases = new Map();
    this.epochs = new Map();
  }

  /** Returns the lease if acquired (or already held by `holder`), else null. Each new acquisition bumps the epoch. */
  async acquire(key, holder, ttlMs) {
    await tick();
    const t = this.now();
    const cur = this.leases.get(key);
    if (cur && cur.expiresAt > t) return cur.holder === holder ? { ...cur } : null;
    const epoch = (this.epochs.get(key) || 0) + 1;
    this.epochs.set(key, epoch);
    const lease = { key, holder, epoch, expiresAt: t + ttlMs };
    this.leases.set(key, lease);
    return { ...lease };
  }

  async renew(key, holder, epoch, ttlMs) {
    await tick();
    const t = this.now();
    const cur = this.leases.get(key);
    if (!cur || cur.holder !== holder || cur.epoch !== epoch || cur.expiresAt <= t) return false;
    cur.expiresAt = t + ttlMs;
    return true;
  }

  async release(key, holder, epoch) {
    await tick();
    const cur = this.leases.get(key);
    if (cur && cur.holder === holder && cur.epoch === epoch) this.leases.delete(key);
  }

  /** Synchronous read, used by gateways as their "lease cache". */
  peek(key) {
    const cur = this.leases.get(key);
    return cur && cur.expiresAt > this.now() ? { ...cur } : null;
  }
}

export class StateStore {
  constructor() {
    this.data = new Map();
    this.stats = { writes: 0, rejected: 0 };
  }

  async get(key) {
    await tick();
    const v = this.data.get(key);
    return v ? structuredClone(v) : null;
  }

  peek(key) {
    return this.data.get(key) || null;
  }

  keys() {
    return [...this.data.keys()];
  }

  /**
   * The fenced write (a Lua script in Redis). Accepted only if the writer's epoch is not older than the
   * stored one AND it extends the stored version by exactly one. A paused or partitioned ex-owner
   * therefore can never overwrite the state written by its successor.
   */
  async casWrite(key, next) {
    await tick();
    const cur = this.data.get(key);
    const ok = !cur || (next.epoch >= cur.epoch && next.version === cur.version + 1);
    if (!ok) {
      this.stats.rejected++;
      return { ok: false, current: { epoch: cur.epoch, version: cur.version } };
    }
    this.data.set(key, structuredClone(next));
    this.stats.writes++;
    return { ok: true };
  }
}

export class Bus {
  constructor() {
    this.topics = new Map();
    this.stats = { published: 0, delivered: 0 };
  }

  subscribe(topic, fn) {
    if (!this.topics.has(topic)) this.topics.set(topic, new Set());
    this.topics.get(topic).add(fn);
    return () => {
      const set = this.topics.get(topic);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) this.topics.delete(topic);
    };
  }

  /** One publish per event regardless of room size; delivered once per subscribed gateway, in order. */
  publish(topic, msg) {
    this.stats.published++;
    const subs = this.topics.get(topic);
    if (!subs) return;
    const payload = JSON.stringify(msg); // serialised once, like a real bus
    for (const fn of subs) {
      this.stats.delivered++;
      setImmediate(() => fn(payload, msg));
    }
  }
}
