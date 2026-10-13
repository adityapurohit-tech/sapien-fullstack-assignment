// Real-browser sync test: several headless Chrome/Edge tabs join one room and play real audio through
// Web Audio. Every 250 ms each tab reports the position its audio output is producing versus the
// position the room anchor says it should be at. One tab runs behind a simulated bad network.
// The script drives the scenario a user would: play, seek, pause/resume, a late joiner, an owner crash,
// and a gateway restart.
//
//   node bench/browser-sync.js                  (finds Chrome or Edge; or set BROWSER=path)

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { percentile } from '../shared/anchor.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 3997;
const CDP_PORT = 9333;
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.id = 0;
    this.pending = new Map();
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  open() {
    return new Promise((r) => this.ws.once('open', r));
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const post = (p, body = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

async function main() {
  const browserPath = BROWSERS.find((p) => existsSync(p));
  if (!browserPath) throw new Error('No Chrome/Edge found; set BROWSER=/path/to/chrome');

  const server = spawn(process.execPath, [join(here, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), QUIET: '1', GATEWAY_PROCESSES: '2', LEASE_TTL_MS: '3000', LEASE_RENEW_MS: '1000' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await sleep(100);
  }

  const profile = mkdtempSync(join(tmpdir(), 'lt-browser-'));
  const browser = spawn(browserPath, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1400,1000'], { stdio: 'ignore' });
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    } catch {
      await sleep(100);
    }
  }
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.open();

  const room = await post('/api/rooms', { name: 'Host', roomName: 'Browser sync test' });
  const roomUrl = `${base}/r/${room.roomId}`;

  async function openTab(label, me, query = '') {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const ev = (expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId).then((r) => r.result.value);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: `${base}/health` }, sessionId);
    await sleep(300);
    await ev(`sessionStorage.setItem('lt:${room.roomId}', ${JSON.stringify(JSON.stringify({ ...me, joinedAt: Date.now(), wantsAudio: true }))})`);
    await cdp.send('Page.navigate', { url: roomUrl + query }, sessionId);
    for (let i = 0; i < 100; i++) {
      if (await ev(`!!(window.__lt && window.__lt.state && window.__lt.clock.ready)`).catch(() => false)) break;
      await sleep(100);
    }
    await ev(`window.__lt.player.enableAudio().then(() => window.__lt.player.audioEnabled)`);
    return { label, sessionId, ev, targetId };
  }

  const listener = async (name) => {
    const s = await post('/api/session', { name });
    return { token: s.token, userId: s.userId, name: s.name };
  };

  console.log(`\nBrowser sync test (${browserPath.split(/[\\/]/).pop()}), room ${roomUrl}\n`);
  const tabs = [];
  tabs.push(await openTab('host', { token: room.token, userId: room.userId, name: 'Host' }));
  tabs.push(await openTab('listener-2', await listener('Asha')));
  tabs.push(await openTab('listener-3', await listener('Ben')));
  tabs.push(await openTab('bad-network (300 ms lag, 80 ms jitter)', await listener('Chen'), '?lag=300&jitter=80'));
  const host = tabs[0];

  const samples = new Map(tabs.map((t) => [t.label, []]));
  let phase = 'idle';
  const phaseSamples = {};
  const selfSamples = {};
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      await Promise.all(
        tabs.map(async (t) => {
          // Self-reported error uses the tab's *estimated* server clock, so it cannot see its own clock error.
          // Browser and server run on this one machine, so the true offset is 0: 'truth' uses that instead.
          const r = await t.ev(`(() => { const lt = window.__lt, p = lt.player, st = lt.state;
            if (!p.ctx || !p.src || p.status !== 'playing') return { err: null };
            const { ct, localT } = p.outputStamp(); const heard = p.heardPos(ct);
            const expectedTrue = st.playing ? Math.min(st.positionMs + (localT - st.serverTimeMs), st.track.durationMs) : st.positionMs;
            return { err: p.errMs, truth: heard === null ? null : heard - expectedTrue, offset: lt.clock.offset, status: p.status }; })()`).catch(() => null);
          if (!r || r.err === null || r.truth === null) return;
          if (!samples.has(t.label)) samples.set(t.label, []);
          samples.get(t.label).push(r.truth);
          (selfSamples[t.label] ||= []).push(r.err);
          (phaseSamples[phase] ||= []).push(Math.abs(r.truth));
          t.last = r;
        }),
      );
      await sleep(250);
    }
  })();

  const click = (id) => host.ev(`document.getElementById('${id}').click()`);
  const step = async (name, fn, wait) => {
    phase = name;
    console.log(`  - ${name}`);
    await fn();
    await sleep(wait);
  };

  await step('play', () => click('btnPlay'), 8000);
  await step('host seeks to 0:40', () => host.ev(`window.__lt.send('seek', { positionMs: 40000 })`), 6000);
  await step('pause, then resume', async () => {
    await click('btnPlay');
    await sleep(1500);
    await click('btnPlay');
  }, 6000);
  let late;
  await step('late joiner opens the link mid-song', async () => {
    late = await openTab('late-joiner', await listener('Dev'));
    tabs.push(late);
  }, 6000);
  const ownerBefore = (await (await fetch(`${base}/api/rooms/${room.roomId}/ops`)).json()).room;
  await step(`owner node (${ownerBefore.owner}) crashes`, () => post(`/api/admin/nodes/${ownerBefore.owner}/crash`), 7000);
  const ownerAfter = (await (await fetch(`${base}/api/rooms/${room.roomId}/ops`)).json()).room;
  await step('host skips during recovery window / after takeover', () => click('btnSkip'), 6000);
  await step('gateway gw-1 restarts (deploy)', () => post('/api/admin/gateways/gw-1/restart'), 7000);

  sampling = false;
  await sampler;

  // screenshot of the host view for the README
  const shotDir = join(here, '..', '..', 'docs', 'screenshots');
  mkdirSync(shotDir, { recursive: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, host.sessionId);
  await host.ev(`window.__lt.pollOps()`);
  await sleep(600);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, host.sessionId);
  writeFileSync(join(shotDir, 'room-host.png'), Buffer.from(shot.data, 'base64'));

  const finalStates = await Promise.all(tabs.map((t) => t.ev(`(() => { const p = window.__lt.player; return { status: p.status, nudges: p.nudges, seeks: p.seeks, joinToSyncMs: p.joinToSyncMs, epoch: window.__lt.state.epoch, version: window.__lt.state.version, track: window.__lt.state.track.title }; })()`)));
  const r = (x) => (x === null ? null : Math.round(x * 10) / 10);
  const perTab = tabs.map((t, i) => {
    const abs = (samples.get(t.label) || []).map(Math.abs).sort((a, b) => a - b);
    const self = (selfSamples[t.label] || []).map(Math.abs).sort((a, b) => a - b);
    return {
      tab: t.label,
      samples: abs.length,
      trueErrorMs: { p50: r(percentile(abs, 50)), p95: r(percentile(abs, 95)), max: r(abs.at(-1) ?? null) },
      selfReportedErrorMs: { p50: r(percentile(self, 50)), p95: r(percentile(self, 95)) },
      within200: abs.length ? `${((100 * abs.filter((x) => x <= 200).length) / abs.length).toFixed(1)}%` : null,
      ...finalStates[i],
    };
  });
  const byPhase = Object.fromEntries(Object.entries(phaseSamples).map(([k, v]) => [k, { samples: v.length, p50: r(percentile(v.sort((a, b) => a - b), 50)), p95: r(percentile(v, 95)), max: r(v.at(-1)) }]));
  const result = {
    when: new Date().toISOString(),
    browser: version.Browser,
    note: 'true error = position the tab audio output is producing minus the position the anchor implies on the real (shared) clock; self-reported = the same against the tab own clock estimate. Sampled every 250 ms while playing. joinToSyncMs is only meaningful for the late joiner (others joined before play).',
    failover: { ownerBefore: ownerBefore.owner, epochBefore: ownerBefore.epoch, ownerAfter: ownerAfter.owner, epochAfter: ownerAfter.epoch },
    perTab,
    byPhase,
  };
  console.log('\n' + JSON.stringify(result, null, 2));
  writeFileSync(join(here, 'results-browser-sync.json'), JSON.stringify(result, null, 2));
  console.log(`\nSaved bench/results-browser-sync.json and docs/screenshots/room-host.png`);

  await cdp.send('Browser.close').catch(() => {});
  browser.kill();
  server.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
