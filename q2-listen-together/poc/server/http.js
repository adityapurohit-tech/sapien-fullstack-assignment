// The edge: static files, the REST API and the WebSocket endpoint. It runs in every gateway process.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const mediaDir = join(root, '.media');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.json': 'application/json' };

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(Object.assign(new Error('Bad JSON'), { status: 400 }));
      }
    });
  });

function serveFile(res, base, rel, cache) {
  const file = join(base, normalize(rel));
  if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'content-length': statSync(file).size, 'cache-control': cache });
  createReadStream(file).pipe(res);
}

export function createEdge({ config, api, gateways }) {
  const orNotFound = (res, v) => (v ? json(res, v.error ? 404 : 200, v) : json(res, 404, { error: 'Not found' }));
  const routes = [
    ['GET', /^\/health$/, (req, res) => json(res, 200, { ok: true })],
    ['GET', /^\/api\/catalog$/, async (req, res) => json(res, 200, await api.catalog())],
    ['GET', /^\/api\/search$/, async (req, res, m, url) => json(res, 200, await api.search(url.searchParams.get('q')))],
    ['POST', /^\/api\/session$/, async (req, res) => json(res, 200, await api.createSession((await readBody(req)).name))],
    [
      'POST',
      /^\/api\/rooms$/,
      async (req, res) => {
        const b = await readBody(req);
        json(res, 200, await api.createRoom(b.name, b.roomName, b.token));
      },
    ],
    ['GET', /^\/api\/rooms\/([a-f0-9]{1,32})$/, async (req, res, m) => orNotFound(res, await api.roomInfo(m[1]))],
    ['GET', /^\/api\/rooms\/([a-f0-9]{1,32})\/ops$/, async (req, res, m) => json(res, 200, await api.ops(m[1]))],
    ['GET', /^\/metrics$/, async (req, res) => json(res, 200, await api.metrics())],
    // chaos controls: the PoC exists to demonstrate these failure modes (disable with ADMIN=0)
    [
      'POST',
      /^\/api\/admin\/nodes\/([\w-]+)\/(crash|freeze|revive)$/,
      async (req, res, m) => (config.admin ? orNotFound(res, await api.adminNode(m[1], m[2], (await readBody(req)).ms)) : json(res, 403, { error: 'disabled' })),
    ],
    ['POST', /^\/api\/admin\/gateways\/([\w-]+)\/restart$/, async (req, res, m) => (config.admin ? orNotFound(res, await api.adminGateway(m[1])) : json(res, 403, { error: 'disabled' }))],
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return await fn(req, res, m, url);
      }
      if (req.method !== 'GET') return json(res, 404, { error: 'Not found' });
      // content-addressed audio: the name is the hash, so it is cached forever (as on the CDN)
      if (url.pathname.startsWith('/media/')) return serveFile(res, mediaDir, url.pathname.slice(7), 'public, max-age=31536000, immutable');
      if (url.pathname === '/shared/anchor.js') return serveFile(res, join(root, 'shared'), 'anchor.js', 'no-cache');
      if (url.pathname === '/' || url.pathname.startsWith('/r/')) return serveFile(res, join(root, 'public'), 'index.html', 'no-cache');
      return serveFile(res, join(root, 'public'), url.pathname.slice(1), 'no-cache');
    } catch (err) {
      json(res, err.status || 500, { error: err.message, code: err.code });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: config.maxPayloadBytes, perMessageDeflate: false });
  let rr = 0;
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const live = gateways.filter((g) => !g.draining);
    const pool = live.length ? live : gateways;
    pool[rr++ % pool.length].attach(ws);
  });
  // drop dead TCP connections
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);

  return {
    server,
    listen: (port) => new Promise((r) => server.listen({ port, backlog: 4096 }, () => r(server.address().port))),
    close: async () => {
      clearInterval(pinger);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      gateways.forEach((g) => g.stop());
      await new Promise((r) => server.close(r));
    },
  };
}
