import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Test timings are shortened so a whole game fits in a few seconds.
export const FAST = { MIN_DRAW_S: '2', CHOOSE_MS: '8000', TURN_END_MS: '300', GRACE_MS: '1500', DRAWER_GRACE_MS: '700', PERSIST: '0' };

export class TestServer {
  constructor(env = {}) { this.env = { ...FAST, ...env }; this.port = null; this.proc = null; }
  async start(port) {
    this.port = port || this.port || (await freePort());
    this.proc = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], {
      env: { ...process.env, ...this.env, PORT: String(this.port) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.log = '';
    this.proc.stdout.on('data', (d) => { this.log += d; });
    this.proc.stderr.on('data', (d) => { this.log += d; });
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(`http://127.0.0.1:${this.port}/healthz`); if (r.ok) return this; } catch { /* not up yet */ }
      await sleep(50);
    }
    throw new Error('server did not start: ' + this.log);
  }
  get url() { return `ws://127.0.0.1:${this.port}/ws`; }
  get http() { return `http://127.0.0.1:${this.port}`; }
  async stop(signal = 'SIGTERM') {
    if (!this.proc) return;
    const p = this.proc; this.proc = null;
    // Windows cannot deliver a catchable SIGTERM, so a graceful stop is requested over IPC there.
    if (signal === 'SIGTERM' && process.platform === 'win32' && p.connected) p.send('shutdown');
    else p.kill(signal);
    await Promise.race([once(p, 'exit'), sleep(2000)]);
    if (p.exitCode === null) p.kill('SIGKILL');
  }
}

export class Bot {
  constructor(url, name) { this.url = url; this.name = name; this.messages = []; this.waiters = []; this.me = null; this.token = null; this.view = null; this.players = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      this.messages.push(m);
      if (m.t === 'joined') { this.me = m.you.id; this.token = m.you.token; this.view = m.view; this.players = m.view.players; }
      if (m.t === 'state') this.view = m.view, this.players = m.view.players;
      if (m.t === 'players') this.players = m.players;
      this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.resolve(m); return false; } return true; });
    });
    this.closed = new Promise((r) => this.ws.on('close', r));
    await once(this.ws, 'open');
    return this;
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  mark() { return this.messages.length; }
  find(pred, since = 0) { for (let i = since; i < this.messages.length; i++) if (pred(this.messages[i])) return this.messages[i]; return null; }
  filter(pred, since = 0) { return this.messages.slice(since).filter(pred); }
  waitFor(pred, { timeout = 4000, since = 0 } = {}) {
    const hit = this.find(pred, since);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`${this.name}: timed out waiting for message`)); }, timeout);
    });
  }
  score(id) { const p = this.players.find((x) => x.id === (id || this.me)); return p ? p.score : undefined; }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// Create a room with `names.length` players and return the connected bots (the first is the host).
export async function makeRoom(server, names, settings = { rounds: 1, drawTime: 6, words: ['zebra', 'xylophone', 'quartz'] }) {
  const bots = [];
  const host = await new Bot(server.url, names[0]).connect();
  host.send({ t: 'create', name: names[0], settings });
  await host.waitFor((m) => m.t === 'joined');
  host.code = host.view.code;
  bots.push(host);
  for (const n of names.slice(1)) {
    const b = await new Bot(server.url, n).connect();
    b.send({ t: 'join', code: host.code, name: n });
    await b.waitFor((m) => m.t === 'joined');
    b.code = host.code;
    bots.push(b);
  }
  return bots;
}

// Start the game and drive it to the point where the drawer has picked `index` and drawing began.
// `which` is either an index into the three offered words, or the word itself (it must be among the offers).
export async function startAndPick(bots, which = 0) {
  const [host] = bots;
  const since = bots.map((b) => b.mark());
  host.send({ t: 'start' });
  const choosing = await host.waitFor((m) => m.t === 'state' && m.view.phase === 'choosing', { since: since[0] });
  const drawer = bots.find((b) => b.me === choosing.view.drawerId);
  const withChoices = await drawer.waitFor((m) => m.t === 'state' && m.view.phase === 'choosing' && m.view.choices);
  const index = typeof which === 'string' ? withChoices.view.choices.indexOf(which) : which;
  if (index < 0) throw new Error(`"${which}" was not among the offered words: ${withChoices.view.choices}`);
  const word = withChoices.view.choices[index];
  const m0 = bots.map((b) => b.mark());
  drawer.send({ t: 'pick', index });
  // allSettled: if one bot misses the message, report it once instead of leaving unhandled rejections behind.
  const settled = await Promise.allSettled(bots.map((b, i) => b.waitFor((m) => m.t === 'state' && m.view.phase === 'drawing', { since: m0[i] })));
  const bad = settled.find((r) => r.status === 'rejected');
  if (bad) throw bad.reason;
  // Use the word the server actually started the turn with (the drawer's view always has it).
  if (drawer.view.word !== word) throw new Error(`the server auto-picked "${drawer.view.word}" before our pick of "${word}" arrived`);
  return { drawer, guessers: bots.filter((b) => b !== drawer), word };
}

export function tmpFile(name) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scribble-')), name); }
