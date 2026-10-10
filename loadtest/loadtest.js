// Load test: how many simultaneous rooms can ONE server process handle?
//
// Every room has 4 players. The drawer holds the pen down for the whole test and streams stroke
// points at 30 messages/second (4 points each), which is heavier than real play, where people lift
// the pen, think and pause. Guessers send an occasional chat line. We measure, per room count:
//   - stroke latency: time from the drawer sending a stroke message to each guesser receiving it
//     (all bots share one clock, so this is exact)
//   - server CPU, event-loop delay and memory, read from the server's own /api/metrics endpoint
//
// Usage:  node loadtest/loadtest.js [--steps 50,100,200,400] [--players 4] [--seconds 20] [--port 3300]
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const STEPS = (args.steps || '50,100,200,400').split(',').map(Number);
const PLAYERS = Number(args.players || 4);
const SECONDS = Number(args.seconds || 20);
const PORT = Number(args.port || 3300);
const MSGS_PER_SEC = 30, PTS_PER_MSG = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((arr.length * p) / 100))] : NaN);

async function startServer() {
  const proc = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), PERSIST: '0', MAX_CONN_PER_IP: '1000000', CREATE_PER_MIN_PER_IP: '1000000', MAX_ROOMS: '1000000', MAX_POINTS_PER_TURN: '10000000' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  // On hybrid CPUs, Windows tends to put a windowless background process on efficiency cores, which
  // makes results swing wildly between runs. High priority keeps the server (and the bots) on the
  // performance cores, like a real server process. Set LOADTEST_NORMAL_PRIORITY=1 to skip this.
  if (!process.env.LOADTEST_NORMAL_PRIORITY) {
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_HIGH); os.setPriority(os.constants.priority.PRIORITY_HIGH); } catch { /* needs elevated rights on some systems */ }
  }
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return proc; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
const metrics = async () => (await fetch(`http://127.0.0.1:${PORT}/api/metrics`)).json();

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// One room: 1 drawer + (PLAYERS-1) guessers.
async function setupRoom(i, state) {
  const url = `ws://127.0.0.1:${PORT}/ws`;
  const room = { sent: [], k: 0, drawer: null, closed: false };
  const sockets = [];
  const host = await connect(url);
  sockets.push(host);
  let code = null;
  const bots = [];

  const attach = (ws, name) => {
    const bot = { ws, name, id: null };
    bots.push(bot);
    ws.on('message', (data) => {
      const s = data.toString();
      if (s.startsWith('{"t":"op"')) {
        if (state.measuring && bot.id !== room.drawer) {
          const seq = Number(/"seq":(\d+)/.exec(s)[1]);
          const t0 = room.sent[seq];
          if (t0 !== undefined) { state.latencies.push(Date.now() - t0); state.delivered++; }
        }
        return;
      }
      if (s.startsWith('{"t":"joined"')) { const m = JSON.parse(s); bot.id = m.you.id; if (!code) code = m.view.code; return; }
      if (s.startsWith('{"t":"state"')) {
        const v = JSON.parse(s).view;
        if (v.phase === 'choosing' && v.drawerId === bot.id && v.choices) ws.send(JSON.stringify({ t: 'pick', index: 0 }));
        if (v.phase === 'drawing' && v.drawerId === bot.id && !bot.drawing) startDrawing(bot);
      }
    });
    ws.on('close', () => { if (!room.closed && state.measuring) state.dropped++; });
    ws.on('error', () => { state.errors++; });
    return bot;
  };

  const startDrawing = (bot) => {
    bot.drawing = true;
    room.drawer = bot.id;
    let x = 400, y = 300;
    const send = (o) => { room.k++; room.sent[room.k] = Date.now(); bot.ws.send(JSON.stringify(o)); };
    send({ t: 'ds', id: 'stroke1', tool: 'pen', color: '#000000', size: 6, x, y });
    bot.timer = setInterval(() => {
      const pts = [];
      for (let j = 0; j < PTS_PER_MSG; j++) {
        x = Math.max(0, Math.min(800, x + Math.round((Math.random() - 0.5) * 24)));
        y = Math.max(0, Math.min(600, y + Math.round((Math.random() - 0.5) * 24)));
        pts.push(x, y);
      }
      send({ t: 'dp', id: 'stroke1', pts });
    }, 1000 / MSGS_PER_SEC);
  };

  const hostBot = attach(host, `h${i}`);
  host.send(JSON.stringify({ t: 'create', name: `h${i}`, settings: { rounds: 1, drawTime: 180, words: ['alpha', 'bravo', 'charlie'] } }));
  while (!code) await sleep(5);
  for (let p = 1; p < PLAYERS; p++) {
    const ws = await connect(url);
    sockets.push(ws);
    attach(ws, `p${i}_${p}`);
    ws.send(JSON.stringify({ t: 'join', code, name: `p${i}_${p}` }));
  }
  while (bots.some((b) => !b.id)) await sleep(5);
  hostBot.ws.send(JSON.stringify({ t: 'start' }));
  // Guessers occasionally chat, to exercise that path as well.
  for (const b of bots.slice(1)) b.chat = setInterval(() => { if (b.ws.readyState === 1) b.ws.send(JSON.stringify({ t: 'chat', text: 'is it a cat?' })); }, 6000 + Math.random() * 2000);
  room.bots = bots;
  room.sockets = sockets;
  return room;
}

async function runStep(rooms) {
  const proc = await startServer();
  const state = { measuring: false, latencies: [], delivered: 0, errors: 0, dropped: 0 };
  const idleRss = (await metrics()).rssMB; // memory of an empty server, to isolate the cost of the rooms
  const live = [];
  const t0 = Date.now();
  // Create rooms at a steady pace, as real players arriving would.
  const batch = 10;
  for (let i = 0; i < rooms; i += batch) {
    await Promise.all(Array.from({ length: Math.min(batch, rooms - i) }, (_, j) => setupRoom(i + j, state).then((r) => live.push(r))));
    await sleep(40);
  }
  const setupMs = Date.now() - t0;
  await sleep(3000); // let everything settle into the drawing phase
  await metrics();   // reset the server's counters
  state.measuring = true;
  const series = [];
  for (let s = 0; s < SECONDS; s++) { await sleep(1000); series.push(await metrics()); }
  state.measuring = false;
  const lat = state.latencies.sort((a, b) => a - b);
  const drawers = live.filter((r) => r.drawer).length;
  const result = {
    rooms,
    drawingRooms: drawers,
    sockets: series[series.length - 1].sockets,
    seconds: SECONDS,
    delivered: state.delivered,
    latencyMs: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat[lat.length - 1] },
    serverCpuAvg: +(series.reduce((a, m) => a + m.cpuPercent, 0) / series.length).toFixed(1),
    serverCpuMax: Math.max(...series.map((m) => m.cpuPercent)),
    loopDelayP99ms: Math.max(...series.map((m) => m.loopDelayP99ms)),
    msgOutPerSec: Math.round(series.reduce((a, m) => a + m.msgOutPerSec, 0) / series.length),
    rssMB: series[series.length - 1].rssMB,
    kbPerRoom: +(((series[series.length - 1].rssMB - idleRss) * 1024) / rooms).toFixed(0),
    dropped: state.dropped,
    errors: state.errors,
    setupSeconds: +(setupMs / 1000).toFixed(1),
  };
  for (const r of live) { r.closed = true; for (const b of r.bots) { clearInterval(b.timer); clearInterval(b.chat); } for (const s of r.sockets) s.terminate(); }
  proc.kill('SIGKILL');
  await sleep(800);
  return result;
}

console.log(`Load test: ${PLAYERS} players per room, drawer streams ${MSGS_PER_SEC} msgs/s x ${PTS_PER_MSG} points, ${SECONDS}s measured per step`);
console.log(`Machine: ${os.cpus().length} vCPU ${os.cpus()[0].model.trim()}, ${Math.round(os.totalmem() / 1073741824)} GB RAM, Node ${process.version}`);
console.log('Note: the bots run on the same machine as the server, so they compete with it for CPU. Real capacity is therefore at least this high.\n');
const results = [];
for (const n of STEPS) {
  process.stdout.write(`rooms=${n} ... `);
  try {
    const r = await runStep(n);
    results.push(r);
    console.log(`p50 ${r.latencyMs.p50}ms  p95 ${r.latencyMs.p95}ms  p99 ${r.latencyMs.p99}ms  max ${r.latencyMs.max}ms | server CPU avg ${r.serverCpuAvg}% (max ${r.serverCpuMax}%) | loop p99 ${r.loopDelayP99ms}ms | ${r.sockets} sockets | ${r.msgOutPerSec} msg/s out | RSS ${r.rssMB} MB | dropped ${r.dropped}`);
  } catch (err) {
    console.log('failed:', err.message);
    break;
  }
}
fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify({ when: new Date().toISOString(), machine: `${os.cpus().length} vCPU, Node ${process.version}`, players: PLAYERS, seconds: SECONDS, results }, null, 2));
console.log('\nSaved loadtest/results.json');
process.exit(0);
