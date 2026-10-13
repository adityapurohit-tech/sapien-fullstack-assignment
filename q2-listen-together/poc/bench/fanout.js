// Fan-out benchmark: how long does one room command take to reach every listener, and what does it
// cost the server? Spawns the server as separate processes (core + gateway processes), connects real
// WebSocket listeners from several worker threads, and has each room's host alternate play / pause.
//
//   node bench/fanout.js                              one room, 5,000 listeners (the design's worst case)
//   node bench/fanout.js --rooms 1000 --listeners 5   many small rooms
//   node bench/fanout.js --gateways 8                 more gateway processes
//   node bench/fanout.js --url http://host:3000       against a server you started yourself
//
// Latency = (time the listener socket receives the state) - (publishedAt stamped by the room owner).
// Client and server share one machine and clock, so this is the server-side path
// (owner -> bus -> gateway -> socket), without the internet leg.

import { spawn } from 'node:child_process';
import { Agent, request } from 'node:http';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import WebSocket from 'ws';
import { percentile } from '../shared/anchor.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ listener worker thread
if (!isMainThread) {
  const { wsUrl, jobs } = workerData;
  const arrivals = {}; // key -> [latency, receivedAt][]
  let deferred = 0;
  let retries = 0;
  const sockets = [];
  const connectOne = (roomId, token, attempt = 0) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      let joined = false;
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', roomId, token })));
      ws.on('error', (err) => {
        if (joined || attempt >= 8) return reject(err);
        retries++; // like a real client: jittered backoff (e.g. the accept backlog was momentarily full)
        setTimeout(() => connectOne(roomId, token, attempt + 1).then(resolve, reject), 100 * 2 ** attempt * (0.5 + Math.random()));
      });
      ws.on('message', (data) => {
        const now = Date.now();
        const m = JSON.parse(data);
        if (m.t === 'retry') {
          deferred++;
          return setTimeout(() => ws.send(JSON.stringify({ t: 'hello', roomId, token })), m.afterMs);
        }
        if (m.t !== 'state') return;
        if (!joined) {
          joined = true;
          return resolve(ws);
        }
        if (m.kind !== 'state') return;
        const key = `${roomId}/${m.state.epoch}.${m.state.version}`;
        (arrivals[key] ||= []).push([now - m.publishedAt, now]);
      });
    });
  for (let i = 0; i < jobs.length; i += 100) sockets.push(...(await Promise.all(jobs.slice(i, i + 100).map(([r, t]) => connectOne(r, t)))));
  parentPort.postMessage({ t: 'ready', deferred, retries });
  parentPort.on('message', (m) => {
    if (m === 'report') {
      parentPort.postMessage({ t: 'report', arrivals });
      for (const ws of sockets) ws.terminate();
      setTimeout(() => process.exit(0), 100);
    }
  });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// ------------------------------------------------------------------ orchestrator
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
  const LISTENERS = Number(args.listeners || 5000); // per room
  const ROOMS = Number(args.rooms || 1);
  const COMMANDS = Number(args.commands || 20);
  const INTERVAL = Number(args.interval || 500);
  const PORT = Number(args.port || 3999);
  const THREADS = Number(args.threads || Math.min(8, Math.max(2, Math.floor(cpus().length / 2))));

  let server = null;
  let base = args.url;
  if (!base) {
    base = `http://127.0.0.1:${PORT}`;
    server = spawn(process.execPath, [join(here, '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(PORT), QUIET: '1', JOIN_RATE_PER_SEC: args.joinRate || '500', GATEWAY_PROCESSES: args.gateways ?? '4' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {}
      await sleep(100);
    }
    await sleep(500);
  }
  const wsUrl = base.replace(/^http/, 'ws') + '/ws';
  // a few keep-alive connections for setup, so 10,000 session requests do not exhaust ephemeral ports
  const agent = new Agent({ keepAlive: true, maxSockets: 16 });
  const post = (p, body) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request(base + p, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve(JSON.parse(buf)));
      });
      req.on('error', reject);
      req.end(data);
    });
  const metrics = () => fetch(`${base}/metrics`).then((r) => r.json());

  console.log(`\nFan-out benchmark: ${ROOMS} room(s) x ${LISTENERS} listeners = ${ROOMS * LISTENERS} sockets, ${COMMANDS} commands per room, ${THREADS} client threads\n`);

  // rooms and sessions
  const rooms = [];
  for (let r = 0; r < ROOMS; r += 50) rooms.push(...(await Promise.all(Array.from({ length: Math.min(50, ROOMS - r) }, (_, k) => post('/api/rooms', { name: `host${r + k}`, roomName: `bench ${r + k}` })))));
  const total = ROOMS * LISTENERS;
  const tokens = [];
  for (let i = 0; i < total; i += 100) tokens.push(...(await Promise.all(Array.from({ length: Math.min(100, total - i) }, (_, k) => post('/api/session', { name: `l${i + k}` })))).map((b) => b.token));

  // hosts (main thread)
  const hosts = [];
  for (const room of rooms) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    await new Promise((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', roomId: room.roomId, token: room.token })));
      ws.on('message', function first(d) {
        if (JSON.parse(d).t === 'state') {
          ws.off('message', first);
          resolve();
        }
      });
    });
    hosts.push(ws);
  }

  // listeners (worker threads), interleaved so each thread has a share of every room
  const jobs = [];
  for (let r = 0; r < ROOMS; r++) for (let l = 0; l < LISTENERS; l++) jobs.push([rooms[r].roomId, tokens[r * LISTENERS + l]]);
  const slices = Array.from({ length: THREADS }, (_, t) => jobs.filter((_, i) => i % THREADS === t));
  const joinStart = Date.now();
  const workers = slices.map((s) => new Worker(fileURLToPath(import.meta.url), { workerData: { wsUrl, jobs: s } }));
  const ready = await Promise.all(workers.map((w) => new Promise((r) => w.on('message', (m) => m.t === 'ready' && r(m)))));
  const joinMs = Date.now() - joinStart;
  const deferred = ready.reduce((s, r) => s + r.deferred, 0);
  const connectRetries = ready.reduce((s, r) => s + r.retries, 0);
  console.log(`  ${total} listeners joined in ${(joinMs / 1000).toFixed(1)} s (${deferred} joins deferred by the per-room join rate limit, ${connectRetries} TCP connect retries)`);
  await sleep(2500); // let presence settle

  // command phase
  const m0 = await metrics();
  const t0 = Date.now();
  for (let c = 0; c < COMMANDS; c++) {
    const type = c % 2 === 0 ? 'play' : 'pause'; // rooms start paused
    await Promise.all(
      hosts.map(
        (ws) =>
          new Promise((resolve) => {
            const cmdId = `b${c}`;
            const onMsg = (d) => {
              const m = JSON.parse(d);
              if (m.t === 'ack' && m.cmdId === cmdId) {
                ws.off('message', onMsg);
                resolve();
              }
            };
            ws.on('message', onMsg);
            ws.send(JSON.stringify({ t: 'cmd', cmdId, type }));
          }),
      ),
    );
    await sleep(INTERVAL);
  }
  await sleep(1000);
  const m1 = await metrics();
  const elapsedS = (Date.now() - t0) / 1000;

  // collect
  const reports = await Promise.all(workers.map((w) => new Promise((r) => w.on('message', (m) => m.t === 'report' && r(m.arrivals)), w.postMessage('report'))));
  const merged = new Map();
  for (const rep of reports) for (const [k, v] of Object.entries(rep)) merged.set(k, (merged.get(k) || []).concat(v));
  const all = [];
  const spreads = [];
  const lastArrival = [];
  let complete = 0;
  for (const v of merged.values()) {
    const lat = v.map((x) => x[0]);
    const times = v.map((x) => x[1]).sort((a, b) => a - b);
    all.push(...lat);
    spreads.push(times.at(-1) - times[0]);
    lastArrival.push(Math.max(...lat));
    if (v.length === LISTENERS) complete++;
  }
  all.sort((a, b) => a - b);
  spreads.sort((a, b) => a - b);
  lastArrival.sort((a, b) => a - b);

  const cpuOf = (m) => m.process.cpu.user + m.process.cpu.system + m.gateways.reduce((s, g) => s + (g.cpu ? g.cpu.user + g.cpu.system : 0), 0);
  const cpuMs = (cpuOf(m1) - cpuOf(m0)) / 1000;
  const coreCpuMs = (m1.process.cpu.user + m1.process.cpu.system - (m0.process.cpu.user + m0.process.cpu.system)) / 1000;
  const writes = m1.gateways.reduce((s, g) => s + g.socketWrites, 0) - m0.gateways.reduce((s, g) => s + g.socketWrites, 0);
  const result = {
    when: new Date().toISOString(),
    machine: `${process.platform} ${process.arch}, ${cpus()[0].model}, ${cpus().length} threads, node ${process.version}; client and server on the same machine`,
    rooms: ROOMS,
    listenersPerRoom: LISTENERS,
    sockets: ROOMS * LISTENERS + ROOMS,
    gatewayProcesses: m1.gateways.length,
    clientThreads: THREADS,
    commandsPerRoom: COMMANDS,
    joinSeconds: Math.round(joinMs / 100) / 10,
    joinsDeferred: deferred,
    connectRetries,
    stateMessagesExpected: ROOMS * COMMANDS,
    stateMessagesFullyDelivered: complete,
    deliveryLatencyMs: { p50: percentile(all, 50), p95: percentile(all, 95), p99: percentile(all, 99), max: all.at(-1) },
    lastListenerLatencyMs: { p50: percentile(lastArrival, 50), p95: percentile(lastArrival, 95), max: lastArrival.at(-1) },
    arrivalSpreadMs: { p50: percentile(spreads, 50), p95: percentile(spreads, 95), max: spreads.at(-1) },
    serverCpuPctOfOneCore: Math.round((cpuMs / (elapsedS * 1000)) * 1000) / 10,
    coreProcessCpuPctOfOneCore: Math.round((coreCpuMs / (elapsedS * 1000)) * 1000) / 10,
    socketWritesDuringPhase: writes,
    serverCpuUsPerSocketWrite: writes ? Math.round(((cpuMs * 1000) / writes) * 10) / 10 : null,
    gatewayFanoutMs: m1.gateways.map((g) => ({ id: g.id, sockets: g.sockets, ...g.fanoutMs })),
    serverRssMB: m1.process.rssMB + m1.gateways.reduce((s, g) => s + (g.rssMB || 0), 0),
    coreRssMB: m1.process.rssMB,
    busPublished: m1.bus.published - m0.bus.published,
    busDelivered: m1.bus.delivered - m0.bus.delivered,
  };
  console.log(JSON.stringify(result, null, 2));
  const out = args.out || join(here, `results-${ROOMS}x${LISTENERS}.json`);
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nSaved ${out}`);
  for (const ws of hosts) ws.terminate();
  if (server) server.kill();
  process.exit(0);
}
