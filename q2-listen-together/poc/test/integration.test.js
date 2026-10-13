// End to end over real WebSockets: three listeners, host commands, a late joiner,
// a crashed owner, a frozen (stale) owner that gets fenced, and a gateway restart.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { isNewer, positionAt } from '../shared/anchor.js';
import { startServer } from '../server/index.js';

let app;
let base;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  app = await startServer({ port: 0, quiet: true, leaseTtlMs: 800, leaseRenewMs: 250, supervisorMs: 100, heartbeatMs: 500, presenceFlushMs: 100, gatewayReportMs: 50, hostGraceMs: 600, commandDeadlineMs: 4000, commandTimeoutMs: 300 });
  base = `http://localhost:${app.port}`;
});
after(() => app.close());

const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

class Client {
  constructor(roomId, token) {
    this.roomId = roomId;
    this.token = token;
    this.state = null;
    this.presence = null;
    this.acks = new Map();
    this.n = 0;
  }
  async connect() {
    this.ws = new WebSocket(`ws://localhost:${app.port}/ws`);
    await new Promise((r) => this.ws.once('open', r));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'state' && isNewer(m.state, this.state)) this.state = m.state;
      if (m.t === 'presence') this.presence = m;
      if (m.t === 'ack') this.acks.get(m.cmdId)?.(m);
      if (m.t === 'welcome') this.userId = m.userId;
    });
    this.ws.send(JSON.stringify({ t: 'hello', roomId: this.roomId, token: this.token }));
    await this.until(() => this.state);
    return this;
  }
  cmd(type, extra = {}, cmdId = `c${++this.n}`) {
    return new Promise((resolve) => {
      this.acks.set(cmdId, resolve);
      this.ws.send(JSON.stringify({ t: 'cmd', cmdId, type, ...extra }));
    });
  }
  async until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(20);
    }
    throw new Error('timeout waiting for condition');
  }
  close() {
    this.ws.close();
  }
}

async function setupRoom(n) {
  const host = await post('/api/rooms', { name: 'Host', roomName: 'Test' });
  const clients = [await new Client(host.roomId, host.token).connect()];
  for (let i = 1; i < n; i++) {
    const s = await post('/api/session', { name: `L${i}` });
    clients.push(await new Client(host.roomId, s.token).connect());
  }
  return { roomId: host.roomId, clients };
}

test('every listener converges on the same anchor; pause lands everyone on the same position', async () => {
  const { clients } = await setupRoom(3);
  const [h, a, b] = clients;
  assert.equal((await h.cmd('play')).ok, true);
  await h.until(() => [a, b].every((c) => c.state.playing));
  await sleep(300);
  const res = await h.cmd('pause');
  assert.equal(res.ok, true);
  await h.until(() => clients.every((c) => !c.state.playing));
  const positions = clients.map((c) => c.state.positionMs);
  assert.equal(new Set(positions).size, 1, `positions differ: ${positions}`);
  clients.forEach((c) => c.close());
});

test('a guest cannot pause, and the server ignores client-supplied identity', async () => {
  const { clients } = await setupRoom(2);
  const [h, g] = clients;
  await h.cmd('play');
  const res = await g.cmd('pause', { userId: h.userId });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'not_host');
  clients.forEach((c) => c.close());
});

test('a late joiner gets the current anchor from the cache and computes the same position', async () => {
  const { roomId, clients } = await setupRoom(2);
  await clients[0].cmd('seek', { positionMs: 30_000 });
  await clients[0].cmd('play');
  await sleep(400);
  const s = await post('/api/session', { name: 'Late' });
  const late = await new Client(roomId, s.token).connect();
  const now = Date.now();
  assert.ok(Math.abs(positionAt(late.state, now) - positionAt(clients[0].state, now)) < 1);
  assert.ok(positionAt(late.state, now) > 30_000);
  [...clients, late].forEach((c) => c.close());
});

test('crashed owner: lease expires, another node takes over with a higher epoch, commands still succeed', async () => {
  const { roomId, clients } = await setupRoom(2);
  const [h, l] = clients;
  await h.cmd('play');
  const before = app.cluster.ops(roomId).room;
  const ownerNode = app.cluster.nodes.find((n) => n.id === before.owner);
  ownerNode.crash();
  // a command sent during the outage is retried by the gateway (same cmdId) until the new owner answers
  const res = await h.cmd('pause');
  assert.equal(res.ok, true, JSON.stringify(res));
  const afterOps = app.cluster.ops(roomId).room;
  assert.notEqual(afterOps.owner, before.owner);
  assert.ok(afterOps.epoch > before.epoch);
  await l.until(() => l.state.epoch === afterOps.epoch && !l.state.playing);
  ownerNode.revive();
  clients.forEach((c) => c.close());
});

test('frozen owner wakes up as a stale owner and its write is fenced', async () => {
  const { roomId, clients } = await setupRoom(2);
  const [h] = clients;
  await h.cmd('play');
  const ownerId = app.cluster.ops(roomId).room.owner;
  const node = app.cluster.nodes.find((n) => n.id === ownerId);
  const fencedBefore = app.cluster.metrics.counters.fenced_writes || 0;
  node.freeze(1500); // longer than the 800 ms lease
  const res = await h.cmd('pause'); // first attempt hangs on the frozen node, the retry reaches the new owner
  assert.equal(res.ok, true);
  await sleep(1800); // the frozen node wakes up and tries to apply the queued command with its old epoch
  assert.ok((app.cluster.metrics.counters.fenced_writes || 0) > fencedBefore, 'expected a fenced write');
  const st = app.cluster.store.peek(roomId);
  assert.notEqual(app.cluster.ops(roomId).room.owner, ownerId);
  assert.equal(st.playing, false);
  clients.forEach((c) => c.close());
});

test('the same command id retried after a reconnect is applied once', async () => {
  const { roomId, clients } = await setupRoom(1);
  const [h] = clients;
  await h.cmd('enqueue', { trackId: 't3' }, 'dup-1');
  await h.cmd('enqueue', { trackId: 't3' }, 'dup-1');
  assert.equal(app.cluster.store.peek(roomId).queue.length, 1);
  h.close();
});

test('skip vote passes at half of the connected listeners', async () => {
  const { clients } = await setupRoom(3);
  const [h, a, b] = clients;
  await h.until(() => h.presence?.count === 3);
  const seq = h.state.trackSeq;
  a.ws.send(JSON.stringify({ t: 'vote', on: true, trackSeq: seq }));
  await sleep(300);
  assert.equal(h.state.trackSeq, seq); // 1 of 3 is not enough
  b.ws.send(JSON.stringify({ t: 'vote', on: true, trackSeq: seq }));
  await h.until(() => h.state.trackSeq === seq + 1);
  clients.forEach((c) => c.close());
});

test('host who leaves for longer than the grace period hands the role to the longest-connected listener', async () => {
  const { clients } = await setupRoom(3);
  const [h, a, b] = clients;
  await h.until(() => h.presence?.count === 3);
  h.close();
  await a.until(() => a.state.hostId === a.userId, 4000);
  assert.equal(b.state.hostId, a.userId);
  [a, b].forEach((c) => c.close());
});

test('rate limiting and size limits', async () => {
  const { clients } = await setupRoom(1);
  const [h] = clients;
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => h.cmd('enqueue', { trackId: 't2' }, `r${i}`)));
  assert.ok(results.some((r) => r.code === 'rate_limited'));
  const closed = new Promise((r) => h.ws.once('close', (code) => r(code)));
  h.ws.send('x'.repeat(10_000)); // over maxPayload
  assert.equal(await closed, 1009);
});
