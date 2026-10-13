// The control plane: placement of rooms on nodes, the supervisor that re-places orphaned rooms,
// and command routing with retries. In production these are separate services; here they share a
// process, but every interaction goes through the same async interfaces.

import { randomBytes, createHash } from 'node:crypto';
import { Bus, LeaseStore, StateStore } from './infra.js';
import { Metrics } from './metrics.js';
import { CommandError, initialState } from './roomLogic.js';
import { leaseKey, RoomServiceNode } from './roomService.js';

const RETRYABLE = new Set(['node_down', 'not_owner', 'timeout']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Cluster {
  constructor(config, catalog) {
    this.config = config;
    this.catalog = catalog;
    this.leases = new LeaseStore();
    this.store = new StateStore();
    this.bus = new Bus();
    this.metrics = new Metrics();
    this.events = [];
    this.eventSeq = 0;
    this.sessions = new Map(); // token -> { userId, name }
    this.nodes = Array.from({ length: config.roomNodes }, (_, i) => new RoomServiceNode(`room-node-${i + 1}`, this));
    this.supervisor = setInterval(() => this.supervise(), config.supervisorMs);
  }

  log(type, msg, data = {}) {
    const ev = { seq: ++this.eventSeq, at: Date.now(), type, msg, ...data };
    this.events.push(ev);
    if (this.events.length > 500) this.events.shift();
    if (!this.config.quiet) console.log(`[${new Date(ev.at).toISOString().slice(11, 23)}] ${type.padEnd(8)} ${msg}`);
  }

  createSession(name) {
    const token = randomBytes(18).toString('base64url');
    const session = { userId: `u_${randomBytes(5).toString('hex')}`, name: String(name || 'Listener').trim().slice(0, 24) || 'Listener' };
    this.sessions.set(token, session);
    return { token, ...session };
  }

  async createRoom(roomName, hostSession) {
    const roomId = randomBytes(4).toString('hex');
    const init = initialState({
      roomId,
      roomName: String(roomName || 'Listening room').trim().slice(0, 40) || 'Listening room',
      hostId: hostSession.userId,
      track: this.catalog[0],
    });
    const node = this.place(roomId);
    if (!node) throw new CommandError('unavailable', 'No room node available');
    await node.activate(roomId, init);
    return roomId;
  }

  /** Rendezvous hashing over healthy nodes: stable placement, minimal movement when a node leaves. */
  place(roomId) {
    const healthy = this.nodes.filter((n) => n.status === 'up');
    let best = null;
    let bestScore = '';
    for (const n of healthy) {
      const score = createHash('sha1').update(`${n.id}/${roomId}`).digest('hex');
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    return best;
  }

  /** Lease cache lookup; if nobody holds the lease, place and activate the room. */
  async resolveOwner(roomId) {
    const lease = this.leases.peek(leaseKey(roomId));
    if (lease) return this.nodes.find((n) => n.id === lease.holder);
    if (!this.store.peek(roomId)) throw new CommandError('no_such_room', 'Room not found');
    const node = this.place(roomId);
    if (!node) throw new CommandError('node_down', 'No healthy room node');
    await node.activate(roomId);
    const now = this.leases.peek(leaseKey(roomId));
    return now ? this.nodes.find((n) => n.id === now.holder) : null;
  }

  /** Watches for rooms whose owner's lease expired (crash, freeze) and re-places them. */
  async supervise() {
    for (const roomId of this.store.keys()) {
      if (this.leases.peek(leaseKey(roomId))) continue;
      try {
        await this.resolveOwner(roomId);
      } catch {
        /* retried on the next tick */
      }
    }
  }

  /** Gateway -> owner, with a per-attempt timeout and a total deadline; the same cmdId on every retry. */
  async routeCommand(roomId, cmd) {
    const deadline = Date.now() + this.config.commandDeadlineMs;
    let attempt = 0;
    for (;;) {
      try {
        const node = await this.resolveOwner(roomId);
        if (!node) throw new CommandError('not_owner', 'No owner yet');
        return await withTimeout(node.handle(roomId, cmd), this.config.commandTimeoutMs);
      } catch (err) {
        const code = err.code || 'internal';
        if (!RETRYABLE.has(code) || Date.now() > deadline) throw err;
        attempt++;
        this.metrics.count('cmd_retries');
        const backoff = Math.min(1000, 100 * 2 ** attempt);
        await sleep(backoff / 2 + Math.random() * (backoff / 2)); // jittered, so retries do not stampede
      }
    }
  }

  async reportPresence(roomId, gatewayId, members, votes) {
    try {
      const node = await this.resolveOwner(roomId);
      if (node) await withTimeout(node.report(roomId, gatewayId, members, votes), this.config.commandTimeoutMs);
      return true;
    } catch {
      return false; // soft state: the gateway resends on its next tick
    }
  }

  /** Ops view for the chaos panel and /metrics. */
  ops(roomId, gateways = []) {
    const lease = roomId ? this.leases.peek(leaseKey(roomId)) : null;
    const st = roomId ? this.store.peek(roomId) : null;
    return {
      now: Date.now(),
      room: roomId
        ? {
            roomId,
            owner: lease?.holder || null,
            epoch: st?.epoch ?? null,
            version: st?.version ?? null,
            leaseExpiresInMs: lease ? lease.expiresAt - Date.now() : null,
            listeners: this.metrics.roomListeners(roomId),
          }
        : undefined,
      nodes: this.nodes.map((n) => ({ id: n.id, status: n.status, rooms: n.actors.size })),
      gateways,
      store: this.store.stats,
      bus: this.bus.stats,
      events: this.events.filter((e) => !roomId || !e.roomId || e.roomId === roomId).slice(-40),
    };
  }

  stop() {
    clearInterval(this.supervisor);
    this.nodes.forEach((n) => n.stop());
  }
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => (t = setTimeout(() => rej(new CommandError('timeout', 'Owner did not answer in time')), ms))),
  ]);
}
