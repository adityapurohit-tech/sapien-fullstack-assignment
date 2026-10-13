// Room Service: each node hosts many room actors. A room has exactly one owner at a time,
// decided by a lease with a fencing epoch. The owner is the single writer for that room.

import { CommandError, publicView, reduce, votesNeeded } from './roomLogic.js';

export const leaseKey = (roomId) => `room/${roomId}`;
export const topic = (roomId) => `room:${roomId}`;
const LARGE_ROOM = 100;
const LARGE_ROOM_PRESENCE_MS = 5000;

class RoomActor {
  constructor(node, state, lease) {
    this.node = node;
    this.cluster = node.cluster;
    this.config = node.cluster.config;
    this.roomId = state.roomId;
    this.state = state;
    this.lease = lease;
    this.alive = true;
    this.chain = Promise.resolve();
    // soft state, rebuilt from gateway reports after a failover
    this.members = new Map(); // gatewayId -> Map(userId -> {name, joinedAt})
    this.votes = new Map(); // gatewayId -> Set(userId), for state.trackSeq only
    this.presenceDirty = true;
    this.lastPresenceAt = 0;
    this.hostGraceTimer = null;
    this.skipRequestedFor = 0;
    this.timers = [
      setInterval(() => this.publishState('heartbeat'), this.config.heartbeatMs),
      setInterval(() => this.flushPresence(), this.config.presenceFlushMs),
    ];
    this.trackTimer = null;
    this.scheduleTrackEnd();
  }

  /** Commands are applied strictly one at a time: a total order per room, no locks, no merges. */
  dispatch(cmd) {
    const run = this.chain.then(() => this.apply(cmd));
    this.chain = run.catch(() => {});
    return run;
  }

  async apply(cmd) {
    await this.node.gate();
    if (!this.alive) throw new CommandError('not_owner', 'Room moved to another node');
    const { state, duplicate, changed } = reduce(this.state, cmd, Date.now(), this.cluster);
    if (duplicate) {
      this.cluster.metrics.count('cmd_duplicates');
      return { version: this.state.version, duplicate: true };
    }
    if (!changed) return { version: this.state.version };
    state.epoch = this.lease.epoch;
    const res = await this.cluster.store.casWrite(this.roomId, state);
    if (!res.ok) {
      // We were paused or partitioned long enough for someone else to take over.
      this.cluster.metrics.count('fenced_writes');
      this.cluster.log('fenced', `${this.node.id} tried to write ${this.roomId} v${state.version} with epoch ${state.epoch}; store is at epoch ${res.current.epoch} v${res.current.version}. Write REJECTED, actor stops.`, { roomId: this.roomId });
      this.node.dropActor(this.roomId, 'fenced');
      throw new CommandError('not_owner', 'Room moved to another node');
    }
    const trackChanged = state.trackSeq !== this.state.trackSeq;
    this.state = state;
    if (trackChanged) {
      this.votes.clear();
      this.presenceDirty = true;
    }
    this.publishState('state');
    this.scheduleTrackEnd();
    this.cluster.metrics.count('cmd_applied');
    return { version: state.version };
  }

  publishState(kind) {
    if (!this.alive || this.node.status !== 'up') return;
    // Self-fencing on the local clock narrows the stale-owner window but cannot close it
    // (a pause can happen right after this check). The store's epoch check is what closes it.
    if (kind === 'heartbeat' && Date.now() > this.lease.expiresAt) return;
    this.cluster.bus.publish(topic(this.roomId), {
      t: 'state',
      kind,
      state: publicView(this.state),
      publishedAt: Date.now(),
      owner: this.node.id,
    });
  }

  scheduleTrackEnd() {
    clearTimeout(this.trackTimer);
    const s = this.state;
    if (!s.playing || !s.track) return;
    const endsAt = s.serverTimeMs + (s.track.durationMs - s.positionMs);
    const seq = s.trackSeq;
    this.trackTimer = setTimeout(
      () => this.dispatch({ type: 'trackEnded', trackSeq: seq, system: true, cmdId: `end-${seq}` }).catch(() => {}),
      Math.max(0, endsAt - Date.now()),
    );
  }

  /** A gateway reports who is connected through it and who voted to skip. Full snapshot per gateway. */
  report(gatewayId, members, votes) {
    if (!this.alive) return;
    if (members.length === 0) {
      this.members.delete(gatewayId);
      this.votes.delete(gatewayId);
    } else {
      this.members.set(gatewayId, new Map(members.map((m) => [m.userId, m])));
      if (votes && votes.trackSeq === this.state.trackSeq) this.votes.set(gatewayId, new Set(votes.voters));
      else this.votes.delete(gatewayId);
    }
    this.presenceDirty = true;
    this.checkVotes();
    this.checkHost();
  }

  connected() {
    const all = new Map();
    for (const m of this.members.values()) for (const [id, info] of m) if (!all.has(id)) all.set(id, info);
    return all;
  }

  voteCount() {
    const ids = new Set();
    for (const set of this.votes.values()) for (const id of set) ids.add(id);
    return ids.size;
  }

  checkVotes() {
    const n = this.connected().size;
    if (n === 0) return;
    const seq = this.state.trackSeq;
    if (this.voteCount() >= votesNeeded(n) && this.skipRequestedFor !== seq) {
      this.skipRequestedFor = seq;
      this.cluster.log('vote', `${this.roomId}: skip vote passed (${this.voteCount()}/${n})`, { roomId: this.roomId });
      this.dispatch({ type: 'skip', system: true, cmdId: `vote-${seq}` }).catch(() => {});
    }
  }

  checkHost() {
    const conn = this.connected();
    if (conn.size === 0 || conn.has(this.state.hostId)) {
      clearTimeout(this.hostGraceTimer);
      this.hostGraceTimer = null;
      return;
    }
    if (this.hostGraceTimer) return;
    this.hostGraceTimer = setTimeout(() => {
      this.hostGraceTimer = null;
      const candidates = [...this.connected().entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt);
      if (candidates.length === 0 || candidates.some(([id]) => id === this.state.hostId)) return;
      const [newHost, info] = candidates[0];
      this.cluster.log('host', `${this.roomId}: host gone for ${this.config.hostGraceMs / 1000}s, role moves to ${info.name}`, { roomId: this.roomId });
      this.dispatch({ type: 'setHost', hostId: newHost, system: true, cmdId: `host-${this.state.version}` }).catch(() => {});
    }, this.config.hostGraceMs);
  }

  flushPresence() {
    if (!this.presenceDirty || !this.alive || this.node.status !== 'up') return;
    const conn = this.connected();
    // In a big room someone is always joining or leaving; presence to every listener every second would
    // cost more than all room commands together. Large rooms get presence at most every 5 s.
    const minGap = conn.size > LARGE_ROOM ? LARGE_ROOM_PRESENCE_MS : 0;
    if (Date.now() - this.lastPresenceAt < minGap) return;
    this.lastPresenceAt = Date.now();
    this.presenceDirty = false;
    const members = [...conn.entries()]
      .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
      .slice(0, 50) // large rooms: send the count and the first 50, never 5,000 names per update
      .map(([userId, m]) => ({ userId, name: m.name }));
    this.cluster.bus.publish(topic(this.roomId), {
      t: 'presence',
      count: conn.size,
      members,
      votes: this.voteCount(),
      votesNeeded: votesNeeded(conn.size),
      trackSeq: this.state.trackSeq,
    });
  }

  stop() {
    this.alive = false;
    this.timers.forEach(clearInterval);
    clearTimeout(this.trackTimer);
    clearTimeout(this.hostGraceTimer);
  }
}

export class RoomServiceNode {
  constructor(id, cluster) {
    this.id = id;
    this.cluster = cluster;
    this.status = 'up'; // 'up' | 'down' (crashed) | 'frozen' (stop-the-world pause)
    this.actors = new Map();
    this.activating = new Map();
    this.frozen = null;
    this.renewTimer = setInterval(() => this.renewAll(), cluster.config.leaseRenewMs);
  }

  /** Every unit of work passes here: a frozen node blocks, a crashed node refuses. */
  gate() {
    if (this.status === 'down') return Promise.reject(new CommandError('node_down', `${this.id} is down`));
    if (this.status === 'frozen') return this.frozen.promise;
    return Promise.resolve();
  }

  async handle(roomId, cmd) {
    await this.gate();
    const actor = this.actors.get(roomId);
    if (!actor) throw new CommandError('not_owner', `${this.id} does not own ${roomId}`);
    return actor.dispatch(cmd);
  }

  async report(roomId, gatewayId, members, votes) {
    await this.gate();
    this.actors.get(roomId)?.report(gatewayId, members, votes);
  }

  owns(roomId) {
    return this.actors.has(roomId);
  }

  activate(roomId, init) {
    if (this.actors.has(roomId)) return Promise.resolve(true);
    if (!this.activating.has(roomId)) {
      const p = this.doActivate(roomId, init).finally(() => this.activating.delete(roomId));
      this.activating.set(roomId, p);
    }
    return this.activating.get(roomId);
  }

  async doActivate(roomId, init) {
    await this.gate();
    const { leases, store, config } = this.cluster;
    const lease = await leases.acquire(leaseKey(roomId), this.id, config.leaseTtlMs);
    if (!lease) return false; // someone else owns it
    const stored = await store.get(roomId);
    const base = stored || init;
    if (!base) {
      await leases.release(leaseKey(roomId), this.id, lease.epoch);
      throw new CommandError('no_such_room', 'Room not found');
    }
    // Taking over bumps the version too, so every client sees one new state with the new epoch.
    const state = { ...base, epoch: lease.epoch, version: base.version + 1 };
    const res = await store.casWrite(roomId, state);
    if (!res.ok) {
      await leases.release(leaseKey(roomId), this.id, lease.epoch);
      return false;
    }
    const actor = new RoomActor(this, state, lease);
    this.actors.set(roomId, actor);
    if (stored) {
      this.cluster.metrics.count('takeovers');
      this.cluster.log('takeover', `${this.id} took over ${roomId} (epoch ${lease.epoch}, v${state.version}). Listeners kept playing from the last anchor.`, { roomId });
    } else {
      this.cluster.log('lease', `${this.id} owns new room ${roomId} (epoch ${lease.epoch})`, { roomId });
    }
    actor.publishState('state');
    return true;
  }

  dropActor(roomId, reason) {
    const a = this.actors.get(roomId);
    if (!a) return;
    a.stop();
    this.actors.delete(roomId);
    if (reason !== 'crash') this.cluster.log('lease', `${this.id} gave up ${roomId} (${reason})`, { roomId });
  }

  async renewAll() {
    if (this.status !== 'up') return;
    const { leases, config } = this.cluster;
    for (const [roomId, actor] of this.actors) {
      const ok = await leases.renew(leaseKey(roomId), this.id, actor.lease.epoch, config.leaseTtlMs);
      if (ok) actor.lease.expiresAt = Date.now() + config.leaseTtlMs;
      else this.dropActor(roomId, 'lease lost');
    }
  }

  /** Process death: in-memory actors are gone, the lease simply stops being renewed. */
  crash() {
    if (this.status === 'down') return;
    this.status = 'down';
    for (const id of [...this.actors.keys()]) this.dropActor(id, 'crash');
    this.cluster.log('chaos', `${this.id} CRASHED. Its rooms keep playing on clients; leases expire in ${this.cluster.config.leaseTtlMs / 1000}s.`);
  }

  /** A long GC pause / VM stall: the node keeps its in-memory actors and wakes up believing it still owns them. */
  freeze(ms) {
    if (this.status !== 'up') return;
    this.status = 'frozen';
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    this.frozen = { promise, resolve };
    this.cluster.log('chaos', `${this.id} FROZEN for ${ms / 1000}s (simulated stop-the-world pause). It will wake up as a stale owner.`);
    setTimeout(() => {
      this.status = 'up';
      this.cluster.log('chaos', `${this.id} woke up. Any write it attempts now carries an old epoch.`);
      this.frozen.resolve();
      this.frozen = null;
    }, ms);
  }

  revive() {
    if (this.status !== 'down') return;
    this.status = 'up';
    this.cluster.log('chaos', `${this.id} restarted (empty, available for new placements).`);
  }

  stop() {
    clearInterval(this.renewTimer);
    for (const id of [...this.actors.keys()]) this.dropActor(id, 'shutdown');
  }
}
