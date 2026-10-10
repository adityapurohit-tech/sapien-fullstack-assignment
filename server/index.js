import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { cfg } from './config.js';
import { Room, sanitizeSettings, DEFAULT_SETTINGS } from './room.js';
import { roomCode, TokenBucket } from './util.js';
import { stats, snapshotMetrics } from './stats.js';

const rooms = new Map(); // code -> Room
const ipConns = new Map(); // ip -> open sockets
const ipCreate = new Map(); // ip -> token bucket for room creation
let dirty = false;
const hooks = { dirty: () => { dirty = true; } };

// ------------------------------------------------------------------ restore after a restart
function loadState() {
  if (!cfg.PERSIST || !fs.existsSync(cfg.DATA_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(cfg.DATA_FILE, 'utf8'));
    for (const o of saved.rooms || []) rooms.set(o.code, Room.fromJSON(o, hooks));
    console.log(`Restored ${rooms.size} room(s) from ${cfg.DATA_FILE}`);
  } catch (err) {
    console.error('Could not restore saved state, starting fresh:', err.message);
  }
}

function serializeState() {
  return JSON.stringify({ savedAt: Date.now(), rooms: [...rooms.values()].filter((r) => r.players.size > 0).map((r) => r.toJSON()) });
}
function saveStateSync() {
  if (!cfg.PERSIST) return;
  fs.mkdirSync(path.dirname(cfg.DATA_FILE), { recursive: true });
  const tmp = cfg.DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, serializeState());
  fs.renameSync(tmp, cfg.DATA_FILE); // atomic: a crash mid-write never leaves a half-written file
}
async function saveStateAsync() {
  fs.mkdirSync(path.dirname(cfg.DATA_FILE), { recursive: true });
  const tmp = cfg.DATA_FILE + '.tmp';
  await fs.promises.writeFile(tmp, serializeState());
  await fs.promises.rename(tmp, cfg.DATA_FILE);
}

// ------------------------------------------------------------------ HTTP (static client + small API)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.png': 'image/png',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  };
  if (pathname === '/healthz') return json(200, { ok: true });
  if (pathname === '/api/metrics') return json(200, snapshotMetrics({ rooms: rooms.size, sockets: wss.clients.size }));
  const m = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})$/);
  if (m) {
    const r = rooms.get(m[1].toUpperCase());
    return json(r ? 200 : 404, r ? { exists: true, players: r.players.size, phase: r.phase } : { exists: false });
  }
  // Room links look like /r/ABC234 and are all served by the same single page.
  let rel = pathname === '/' || /^\/r\/[A-Za-z0-9]{6}$/.test(pathname) ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(cfg.PUBLIC_DIR, rel));
  if (!file.startsWith(cfg.PUBLIC_DIR)) return json(403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(data);
  });
});

// ------------------------------------------------------------------ WebSocket
// perMessageDeflate is off: compressing tiny stroke messages costs more CPU and latency than it saves.
const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.MAX_SETTINGS_BYTES, perMessageDeflate: false });

const clientIp = (req) => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  // Reject cross-site WebSocket connections: a page on another origin must not be able to drive our server.
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); } } catch { return socket.destroy(); }
  }
  const ip = clientIp(req);
  if ((ipConns.get(ip) || 0) >= cfg.MAX_CONN_PER_IP) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => { ws.ip = ip; wss.emit('connection', ws, req); });
});

function violation(ws, why) {
  stats.violations++;
  const now = Date.now();
  if (now - ws.vWindow > 60000) { ws.vWindow = now; ws.violations = 0; }
  if (++ws.violations > 60) ws.close(1008, why || 'too many violations');
}

function reply(ws, obj) {
  if (ws.readyState === 1) { const s = JSON.stringify(obj); ws.send(s); stats.msgOut++; stats.bytesOut += s.length; }
}

wss.on('connection', (ws) => {
  ipConns.set(ws.ip, (ipConns.get(ws.ip) || 0) + 1);
  ws.alive = true;
  ws.violations = 0;
  ws.vWindow = Date.now();
  ws.lastSlowNotice = 0;
  ws.player = null;
  ws.room = null;
  // Separate token buckets, so a chat flood cannot starve drawing and vice versa. The client sends at most
  // ~60 drawing messages a second (one batch per frame, capped on high-refresh screens), well inside these.
  ws.buckets = { all: new TokenBucket(240, 160), chat: new TokenBucket(5, 1.25), draw: new TokenBucket(200, 120), cmd: new TokenBucket(10, 5) };
  if (ws._socket) ws._socket.setNoDelay(true); // send small stroke messages immediately

  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', () => {});
  ws.on('close', () => {
    const n = (ipConns.get(ws.ip) || 1) - 1;
    if (n <= 0) ipConns.delete(ws.ip); else ipConns.set(ws.ip, n);
    if (ws.player && ws.room) ws.room.onDisconnect(ws.player, ws);
  });
  ws.on('message', (data, isBinary) => {
    try { onMessage(ws, data, isBinary); } catch (err) {
      console.error('message handler error:', err);
      reply(ws, { t: 'error', code: 'server', text: 'Something went wrong.' });
    }
  });
});

const DRAW_TYPES = new Set(['ds', 'dp', 'de', 'fill', 'undo', 'clear']);

function onMessage(ws, data, isBinary) {
  stats.msgIn++;
  if (isBinary) return violation(ws, 'binary not allowed');
  const len = data.length;
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return violation(ws); }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return violation(ws);
  // Everything except room creation and host settings is tiny; anything larger is rejected outright.
  if (len > cfg.MAX_MSG_BYTES && msg.t !== 'create' && msg.t !== 'settings') return violation(ws);
  if (!ws.buckets.all.take()) { stats.dropped++; return violation(ws, 'flooding'); }

  const t = msg.t;
  if (t === 'ping') return reply(ws, { t: 'pong', ts: msg.ts, now: Date.now() });
  if (t === 'chat') {
    if (!ws.buckets.chat.take()) {
      stats.dropped++;
      const now = Date.now();
      if (now - ws.lastSlowNotice > 2000) { ws.lastSlowNotice = now; reply(ws, { t: 'notice', text: "You're sending messages too fast." }); }
      return;
    }
  } else if (DRAW_TYPES.has(t)) {
    if (!ws.buckets.draw.take()) {
      stats.dropped++;
      // The drawer already painted this locally; send them the server's canvas so they never drift
      // away from what everyone else sees.
      if (ws.room && ws.player) ws.room.resyncDrawer(ws.player);
      return violation(ws);
    }
  } else if (!ws.buckets.cmd.take()) { stats.dropped++; return violation(ws); }

  if (t === 'create') return onCreate(ws, msg);
  if (t === 'join') return onJoin(ws, msg);
  if (!ws.room || !ws.player) return reply(ws, { t: 'error', code: 'not_in_room', text: 'Join a room first.' });
  if (ws.room.handle(ws.player, msg) === false) violation(ws);
}

function onCreate(ws, msg) {
  if (ws.room) return reply(ws, { t: 'error', code: 'already', text: 'Already in a room.' });
  let bucket = ipCreate.get(ws.ip);
  if (!bucket) { bucket = new TokenBucket(cfg.CREATE_PER_MIN_PER_IP, cfg.CREATE_PER_MIN_PER_IP / 60); ipCreate.set(ws.ip, bucket); }
  if (!bucket.take()) return reply(ws, { t: 'error', code: 'rate', text: 'You are creating rooms too quickly. Try again in a minute.' });
  if (rooms.size >= cfg.MAX_ROOMS) return reply(ws, { t: 'error', code: 'busy', text: 'The server is full right now.' });
  let code;
  do { code = roomCode(); } while (rooms.has(code));
  const room = new Room(code, sanitizeSettings(msg.settings, DEFAULT_SETTINGS), hooks);
  rooms.set(code, room);
  const r = room.join(ws, msg.name, null);
  if (r.error) { rooms.delete(code); reply(ws, { t: 'error', code: 'join', text: r.error }); }
}

function onJoin(ws, msg) {
  if (ws.room) return reply(ws, { t: 'error', code: 'already', text: 'Already in a room.' });
  const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const room = rooms.get(code);
  if (!room) return reply(ws, { t: 'error', code: 'no_room', text: 'That room does not exist (or has closed).' });
  const token = typeof msg.token === 'string' && msg.token.length <= 64 ? msg.token : null;
  const r = room.join(ws, msg.name, token);
  if (r.error) reply(ws, { t: 'error', code: 'full', text: r.error });
}

// Heartbeat: drop connections that stopped answering, so their players go through the normal grace path.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 20000).unref();

// Close rooms that have been empty for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.isEmpty() && now - room.lastActivity > cfg.ROOM_IDLE_MS) {
      room.clearGameTimers();
      for (const n of Object.keys(room.timers)) room.clearTimer(n);
      rooms.delete(code);
    }
  }
}, 30000).unref();

// Snapshot to disk shortly after anything changes, so a crash loses at most a couple of seconds.
if (cfg.PERSIST) {
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    saveStateAsync().catch((err) => console.error('save failed:', err.message));
  }, cfg.PERSIST_INTERVAL_MS).unref();
}

// Graceful shutdown: write a final snapshot and tell clients to reconnect.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, saving state and closing.`);
  try { saveStateSync(); } catch (err) { console.error('final save failed:', err.message); }
  for (const ws of wss.clients) { try { ws.close(1012, 'server restarting'); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Windows has no catchable SIGTERM: Ctrl+Break and closing the console window arrive as these instead,
// and a parent process (the tests, a process manager) can ask for a graceful stop over IPC.
process.on('SIGBREAK', () => shutdown('SIGBREAK'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('message', (m) => { if (m === 'shutdown') shutdown('IPC shutdown'); });

loadState();
server.listen(cfg.PORT, () => console.log(`Scribble room server listening on http://localhost:${cfg.PORT}`));
