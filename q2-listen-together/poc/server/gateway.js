// Realtime gateway: stateless WebSocket edge. It subscribes to a room topic only while it has a local
// listener in that room, so a 5,000-listener room costs the owner one publish, the bus one delivery
// per gateway, and each gateway one batched pass over its local sockets.

import { isNewer } from '../shared/anchor.js';
import { CLIENT_COMMANDS } from './roomLogic.js';
import { topic } from './roomService.js';

class TokenBucket {
  constructor(ratePerSec, burst) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
  }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const SLOW_SOCKET_BYTES = 256 * 1024; // drop soft-state messages to a slow socket beyond this
const DEAD_SOCKET_BYTES = 2 * 1024 * 1024; // close it beyond this; it reconnects and gets a snapshot

export class Gateway {
  /** @param backend see backend.js: direct calls in one process, IPC when the gateway is its own process */
  constructor(id, backend, config) {
    this.id = id;
    this.backend = backend;
    this.config = config;
    this.sessions = new Set();
    this.rooms = new Map(); // roomId -> { unsub, sessions:Set, lastState, lastStatePayload, lastPresencePayload, dirty }
    this.joinBuckets = new Map();
    this.draining = false;
    this.stats = { busDeliveries: 0, socketWrites: 0, droppedSoft: 0, slowClosed: 0 };
    this.fanoutMs = []; // time for one batched pass over the local sockets of a room
    let ticks = 0;
    this.reportTimer = setInterval(() => {
      ticks++;
      const full = ticks % Math.round(5000 / this.config.gatewayReportMs) === 0; // full refresh every ~5 s
      for (const [roomId, room] of this.rooms) if (room.dirty || full) this.sendReport(roomId, room);
    }, this.config.gatewayReportMs);
  }

  info() {
    const f = [...this.fanoutMs].sort((a, b) => a - b);
    const q = (p) => (f.length ? Math.round(f[Math.min(f.length - 1, Math.floor(p * f.length))] * 100) / 100 : null);
    return {
      id: this.id,
      draining: this.draining,
      fanoutMs: { p50: q(0.5), p99: q(0.99), max: q(1) },
      sockets: this.sessions.size,
      subscriptions: this.rooms.size,
      ...this.stats,
    };
  }

  attach(ws) {
    const session = { ws, userId: null, name: null, roomId: null, joinedAt: Date.now(), cmdBucket: new TokenBucket(this.config.cmdRatePerSec, this.config.cmdRatePerSec * 2), vote: null };
    this.sessions.add(session);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return this.send(session, { t: 'error', code: 'bad_json' });
      }
      this.onMessage(session, msg).catch((err) => this.send(session, { t: 'error', code: 'internal', message: err.message }));
    });
    ws.on('close', () => this.detach(session));
    ws.on('error', () => {});
  }

  send(session, obj) {
    if (session.ws.readyState === 1) session.ws.send(JSON.stringify(obj));
  }

  async onMessage(session, msg) {
    switch (msg.t) {
      case 'ping': // clock sync: answered here, by the edge, as fast as possible
        return this.send(session, { t: 'pong', c: msg.c, s: Date.now() });
      case 'hello':
        return this.hello(session, msg);
      case 'cmd':
        return this.command(session, msg);
      case 'vote':
        return this.vote(session, msg);
      case 'telemetry':
        if (session.roomId) this.backend.telemetry(session.roomId, session.userId, session.name, msg);
        return;
      default:
        return this.send(session, { t: 'error', code: 'bad_type' });
    }
  }

  async hello(session, msg) {
    if (session.roomId) return;
    const auth = await this.backend.auth(msg.token);
    if (!auth) return this.send(session, { t: 'error', code: 'bad_token', fatal: true });
    const roomId = String(msg.roomId || '').slice(0, 32);
    let room = this.rooms.get(roomId);
    if (!room && !(await this.backend.snapshot(roomId))) return this.send(session, { t: 'error', code: 'no_such_room', fatal: true });

    // Per-room join rate limit with jittered retry: 5,000 people clicking a link at once queue politely.
    if (!this.joinBuckets.has(roomId)) this.joinBuckets.set(roomId, new TokenBucket(this.config.joinRatePerSec, this.config.joinRatePerSec));
    if (!this.joinBuckets.get(roomId).take()) {
      this.backend.count('joins_deferred');
      return this.send(session, { t: 'retry', afterMs: 200 + Math.round(Math.random() * 800) });
    }

    Object.assign(session, { userId: auth.userId, name: auth.name, roomId, joinedAt: Number(msg.joinedAt) || Date.now() });
    room = this.rooms.get(roomId);
    if (!room) {
      room = { sessions: new Set(), lastState: null, lastStatePayload: null, lastPresencePayload: null, dirty: true };
      room.unsub = this.backend.subscribe(topic(roomId), (payload, m) => this.deliver(roomId, payload, m));
      this.rooms.set(roomId, room);
    }
    room.sessions.add(session);
    room.dirty = true;
    this.send(session, { t: 'welcome', userId: auth.userId, name: auth.name, gateway: this.id, serverTime: Date.now(), config: { startLeadMs: this.config.startLeadMs, hostGraceMs: this.config.hostGraceMs } });

    // Snapshot for the late joiner comes from a cache (this gateway, else the state store), never from the owner.
    // Subscribed first, read second: nothing published in between can be missed.
    const payload = room.lastStatePayload || (await this.backend.snapshot(roomId));
    // Keep the snapshot as this gateway's view of the room too. Skip votes are counted against
    // lastState.trackSeq, and a paused room publishes no heartbeats, so without this the votes cast
    // through a gateway that has only seen the snapshot would be dropped.
    if (payload && !room.lastStatePayload) {
      try {
        const m = JSON.parse(payload);
        if (m.t === 'state' && m.state && isNewer(m.state, room.lastState)) { room.lastState = m.state; room.lastStatePayload = payload; }
      } catch { /* not a state message; the next bus delivery fills it in */ }
    }
    if (payload && session.ws.readyState === 1) session.ws.send(payload);
    if (room.lastPresencePayload && session.ws.readyState === 1) session.ws.send(room.lastPresencePayload);
    this.backend.count('joins');
  }

  deliver(roomId, payload, msg) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.stats.busDeliveries++;
    const soft = msg.t === 'presence';
    if (msg.t === 'state') {
      if (room.lastState && !isNewer(msg.state, room.lastState) && msg.kind !== 'heartbeat') return;
      if (!room.lastState || isNewer(msg.state, room.lastState)) {
        // A new epoch means a new owner: send it our member list right away so soft state is rebuilt.
        if (room.lastState && msg.state.epoch !== room.lastState.epoch) room.dirty = true;
        room.lastState = msg.state;
        room.lastStatePayload = payload;
      }
      // reset local votes when the track changes
      for (const s of room.sessions) if (s.vote && s.vote !== msg.state.trackSeq) s.vote = null;
    } else if (soft) {
      room.lastPresencePayload = payload;
    }
    const t0 = performance.now();
    const frame = Buffer.from(payload); // encode once, not once per socket
    for (const s of room.sessions) {
      const ws = s.ws;
      if (ws.readyState !== 1) continue;
      if (ws.bufferedAmount > DEAD_SOCKET_BYTES) {
        this.stats.slowClosed++;
        ws.close(4002, 'too slow');
        continue;
      }
      if (soft && ws.bufferedAmount > SLOW_SOCKET_BYTES) {
        this.stats.droppedSoft++;
        continue;
      }
      ws.send(frame, { binary: false, compress: false });
      this.stats.socketWrites++;
    }
    if (msg.t === 'state' && msg.kind === 'state') {
      this.fanoutMs.push(performance.now() - t0);
      if (this.fanoutMs.length > 500) this.fanoutMs.shift();
    }
  }

  async command(session, msg) {
    const cmdId = String(msg.cmdId || '').slice(0, 64);
    const reply = (o) => this.send(session, { t: 'ack', cmdId, ...o });
    if (!session.roomId) return reply({ ok: false, code: 'not_joined' });
    if (!cmdId) return reply({ ok: false, code: 'bad_request', error: 'cmdId required' });
    if (!CLIENT_COMMANDS.has(msg.type)) return reply({ ok: false, code: 'bad_request', error: 'Unknown command' });
    if (!session.cmdBucket.take()) {
      this.backend.count('cmd_rate_limited');
      return reply({ ok: false, code: 'rate_limited', error: 'Slow down' });
    }
    // identity comes from the authenticated session, never from the message
    const cmd = { cmdId: `${session.userId}:${cmdId}`, type: msg.type, userId: session.userId, userName: session.name };
    if (msg.type === 'seek') cmd.positionMs = Number(msg.positionMs);
    if (msg.type === 'enqueue') cmd.trackId = String(msg.trackId || '').slice(0, 32);
    if (msg.type === 'dequeue') cmd.qid = Number(msg.qid);
    try {
      const res = await this.backend.routeCommand(session.roomId, cmd);
      reply({ ok: true, ...res });
    } catch (err) {
      reply({ ok: false, code: err.code || 'internal', error: err.message });
    }
  }

  /** Votes are counted here and forwarded in batches, so 5,000 votes are not 5,000 messages to the owner. */
  vote(session, msg) {
    const room = session.roomId && this.rooms.get(session.roomId);
    if (!room || !session.cmdBucket.take()) return;
    session.vote = msg.on ? Number(msg.trackSeq) : null;
    room.dirty = true;
  }

  async sendReport(roomId, room) {
    room.dirty = false;
    const members = [];
    const voters = [];
    const seq = room.lastState?.trackSeq;
    const seen = new Set();
    for (const s of room.sessions) {
      if (seen.has(s.userId)) continue;
      seen.add(s.userId);
      members.push({ userId: s.userId, name: s.name, joinedAt: s.joinedAt });
      if (s.vote && s.vote === seq) voters.push(s.userId);
    }
    const ok = await this.backend.reportPresence(roomId, this.id, members, { trackSeq: seq, voters });
    if (!ok) room.dirty = true;
    if (room.sessions.size === 0 && ok) {
      room.unsub();
      this.rooms.delete(roomId);
    }
  }

  detach(session) {
    this.sessions.delete(session);
    const room = session.roomId && this.rooms.get(session.roomId);
    if (!room) return;
    room.sessions.delete(session);
    room.dirty = true;
  }

  /** Rolling deploy: stop taking sockets, tell clients to reconnect (they come back with their token). */
  restart(drainMs = 3000) {
    this.draining = true;
    const n = this.sessions.size;
    for (const s of [...this.sessions]) s.ws.close(4001, 'gateway restarting');
    this.backend.log('chaos', `${this.id} restarting: ${n} sockets told to reconnect (jittered). Rooms are not affected.`);
    setTimeout(() => {
      this.draining = false;
      this.backend.log('chaos', `${this.id} back in rotation.`);
    }, drainMs);
  }

  stop() {
    clearInterval(this.reportTimer);
    for (const room of this.rooms.values()) room.unsub();
  }
}
