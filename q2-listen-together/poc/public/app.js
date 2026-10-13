import { isNewer } from '/shared/anchor.js';
import { ClockSync, SyncPlayer, Transport } from './sync.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const ms = (v, digits = 0) => (v === null || v === undefined || Number.isNaN(v) ? '-' : `${v.toFixed(digits)} ms`);
const errClass = (v) => (v === null || v === undefined ? '' : Math.abs(v) <= 50 ? 'good' : Math.abs(v) <= 200 ? 'meh' : 'bad');

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------------------------------------------------------------- landing
const roomMatch = location.pathname.match(/^\/r\/([a-f0-9]+)/);
if (!roomMatch) {
  $('landing').hidden = false;
  $('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { roomId, token, userId, name } = await api('/api/rooms', { name: $('hostName').value, roomName: $('roomName').value });
    sessionStorage.setItem(`lt:${roomId}`, JSON.stringify({ token, userId, name, joinedAt: Date.now(), wantsAudio: true }));
    location.href = `/r/${roomId}`;
  });
} else {
  enterRoom(roomMatch[1]);
}

// ---------------------------------------------------------------- room
async function enterRoom(roomId) {
  let info;
  try {
    info = await api(`/api/rooms/${roomId}`);
  } catch {
    document.body.innerHTML = `<main class="landing"><div class="card narrow"><h2>Room not found</h2><p class="muted">The room may have been created on a server that has since restarted (room state lives in memory in this PoC).</p><a href="/">Create a new room</a></div></main>`;
    return;
  }
  $('room').hidden = false;
  $('roomTitle').textContent = info.roomName;
  document.title = `${info.roomName} · Listen Together`;
  $('shareLink').value = `${location.origin}/r/${roomId}`;
  $('copyLink').onclick = () => navigator.clipboard.writeText($('shareLink').value).then(() => toast('Link copied'));
  $('badNetLink').href = `/r/${roomId}?lag=300&jitter=80`;

  const key = `lt:${roomId}`;
  let me = JSON.parse(sessionStorage.getItem(key) || 'null');
  if (!me) {
    $('joinTitle').textContent = `Join "${info.roomName}"`;
    $('joinDialog').hidden = false;
    $('joinName').focus();
    me = await new Promise((resolve) =>
      $('joinForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const s = await api('/api/session', { name: $('joinName').value });
        const m = { token: s.token, userId: s.userId, name: s.name, joinedAt: Date.now(), wantsAudio: true };
        sessionStorage.setItem(key, JSON.stringify(m));
        $('joinDialog').hidden = true;
        resolve(m);
      }),
    );
  }
  new RoomClient(roomId, me).start();
}

class RoomClient {
  constructor(roomId, me) {
    this.roomId = roomId;
    this.me = me;
    const q = new URLSearchParams(location.search);
    this.lag = { lagMs: Number(q.get('lag')) || 0, jitterMs: Number(q.get('jitter')) || 0 };
    this.clock = new ClockSync();
    this.player = new SyncPlayer(this.clock);
    this.state = null;
    this.presence = null;
    this.catalog = [];
    this.pending = new Map(); // cmdId -> cmd, resent after a reconnect (idempotent on the server)
    this.applyLatencyMs = null;
    this.reportedJoin = false;
    this.lastBeat = -1;
    this.ops = null;
  }

  start() {
    window.__lt = this; // handle for bench/browser-sync.js and for poking around in devtools
    $('meName').textContent = this.me.name;
    $('mLag').textContent = this.lag.lagMs || this.lag.jitterMs ? `${this.lag.lagMs} ms lag, ${this.lag.jitterMs} ms jitter` : 'off';
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.transport = new Transport(wsUrl, this.lag, {
      open: () => this.onOpen(),
      message: (m) => this.onMessage(m),
      close: (ev) => this.setConn(false, ev.code === 4001 ? 'gateway restarting, reconnecting' : 'reconnecting'),
    });
    this.transport.connect();
    api('/api/catalog').then((c) => (this.catalog = c));
    this.bindUi();
    setInterval(() => this.ping(), 5000);
    setInterval(() => this.sendTelemetry(), 2000);
    setInterval(() => this.pollOps(), 1000);
    const frame = () => {
      this.renderFrame();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    setInterval(() => this.renderStats(), 250);
  }

  setConn(ok, text) {
    $('connDot').className = `dot ${ok ? 'ok' : ''}`;
    $('connText').textContent = text;
  }

  onOpen() {
    this.transport.send({ t: 'hello', roomId: this.roomId, token: this.me.token, joinedAt: this.me.joinedAt });
    // burst of pings to get a good clock estimate fast; the minimum-RTT sample wins
    for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 120);
  }

  ping() {
    this.transport.send({ t: 'ping', c: performance.timeOrigin + performance.now() });
  }

  send(type, extra = {}) {
    const cmdId = crypto.randomUUID().slice(0, 13);
    const cmd = { t: 'cmd', cmdId, type, ...extra };
    this.pending.set(cmdId, cmd);
    this.transport.send(cmd);
  }

  onMessage(m) {
    switch (m.t) {
      case 'pong':
        this.clock.onPong(m.c, m.s);
        break;
      case 'welcome':
        this.setConn(true, `connected via ${m.gateway}`);
        for (const cmd of this.pending.values()) this.transport.send(cmd); // same cmdId: applied at most once
        break;
      case 'retry': // join rate limited
        setTimeout(() => this.onOpen(), m.afterMs);
        break;
      case 'state':
        if (!isNewer(m.state, this.state)) return; // late, duplicate or reordered: ignore
        if (m.kind === 'state' && this.state && this.clock.ready) {
          this.applyLatencyMs = this.clock.serverNow() - m.publishedAt;
          this.applyFresh = true;
        }
        this.state = m.state;
        this.player.setState(m.state);
        this.renderState();
        break;
      case 'presence':
        this.presence = m;
        this.renderPresence();
        break;
      case 'ack':
        this.pending.delete(m.cmdId);
        if (!m.ok) toast(m.error || m.code);
        break;
      case 'error':
        if (m.fatal) {
          this.transport.close();
          sessionStorage.removeItem(`lt:${this.roomId}`);
          toast(`Error: ${m.code}`);
        }
        break;
    }
  }

  isHost() {
    return this.state && this.state.hostId === this.me.userId;
  }

  bindUi() {
    const enable = async () => {
      await this.player.enableAudio();
      $('audioGate').hidden = true;
    };
    $('btnAudio').onclick = enable;
    if (this.me.wantsAudio) {
      // the join/create click counts as a gesture only on the page where it happened; try, else show the button
      this.player.enableAudio().then(() => ($('audioGate').hidden = this.player.audioEnabled)).catch(() => {});
    }
    $('btnPlay').onclick = () => this.send(this.state?.playing ? 'pause' : 'play');
    $('btnSkip').onclick = () => this.send('skip');
    $('btnVote').onclick = () => {
      this.myVote = this.myVote === this.state?.trackSeq ? null : this.state?.trackSeq;
      this.transport.send({ t: 'vote', on: !!this.myVote, trackSeq: this.state?.trackSeq });
      this.renderPresence();
    };
    $('vol').oninput = (e) => this.player.setVolume(Number(e.target.value));
    $('progress').onclick = (e) => {
      if (!this.isHost() || !this.state?.track) return;
      const r = e.currentTarget.getBoundingClientRect();
      this.send('seek', { positionMs: ((e.clientX - r.left) / r.width) * this.state.track.durationMs });
    };
    let deb;
    $('search').oninput = (e) => {
      clearTimeout(deb);
      const q = e.target.value;
      deb = setTimeout(async () => {
        if (!q.trim()) return ($('results').innerHTML = '');
        const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (q !== $('search').value) return; // a newer keystroke won
        $('results').innerHTML = results
          .map((t) => `<li><span class="grow"><b>${esc(t.title)}</b> <span class="muted">· ${esc(t.artist)} · ${t.bpm} bpm</span></span><button class="sm" data-add="${t.id}">Add</button></li>`)
          .join('');
      }, 120); // debounce, as in the design
    };
    $('results').onclick = (e) => {
      const id = e.target.dataset?.add;
      if (!id) return;
      this.send('enqueue', { trackId: id });
      $('search').value = '';
      $('results').innerHTML = '';
    };
    $('queue').onclick = (e) => {
      const qid = e.target.dataset?.rm;
      if (qid) this.send('dequeue', { qid: Number(qid) });
    };
    $('nodes').onclick = (e) => this.chaos(e);
    $('gateways').onclick = (e) => this.chaos(e);
  }

  async chaos(e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const [kind, id, act] = b.dataset.act.split(':');
    const path = kind === 'node' ? `/api/admin/nodes/${id}/${act}` : `/api/admin/gateways/${id}/restart`;
    await api(path, act === 'freeze' ? { ms: 8000 } : {});
    this.pollOps();
  }

  // ------------------------------------------------------------ rendering
  renderState() {
    const st = this.state;
    if (!st) return;
    $('trackTitle').textContent = st.track?.title || '-';
    $('trackArtist').textContent = st.track ? `${st.track.artist} · ${st.track.bpm} bpm` : '';
    $('tDur').textContent = fmt(st.track?.durationMs || 0);
    const host = this.isHost();
    $('meHost').hidden = !host;
    document.querySelectorAll('.host-only').forEach((b) => (b.disabled = !host));
    $('btnPlay').textContent = st.playing ? 'Pause' : 'Play';
    $('progress').style.cursor = host ? 'pointer' : 'default';
    $('queue').innerHTML = st.queue
      .map((q) => `<li><span class="grow"><b>${esc(q.title)}</b> <span class="muted">· added by ${esc(q.by)}</span></span>${host ? `<button class="sm" data-rm="${q.qid}">Remove</button>` : ''}</li>`)
      .join('');
    $('queueEmpty').hidden = st.queue.length > 0;
    const next = st.queue[0] ? this.catalog.find((t) => t.id === st.queue[0].trackId) : this.catalog[(this.catalog.findIndex((t) => t.id === st.track?.id) + 1) % (this.catalog.length || 1)];
    this.player.prefetch(next?.url); // next track's audio is fetched long before it is needed
    this.renderPresence();
  }

  renderPresence() {
    const p = this.presence;
    const voted = this.myVote && this.myVote === this.state?.trackSeq;
    $('btnVote').textContent = `${voted ? 'Voted' : 'Vote to skip'}${p ? ` (${p.trackSeq === this.state?.trackSeq ? p.votes : 0}/${p.votesNeeded})` : ''}`;
    $('btnVote').classList.toggle('primary', !!voted);
    $('listenerCount').textContent = p ? `(${p.count} connected)` : '';
    this.renderListeners();
  }

  renderListeners() {
    const p = this.presence;
    if (!p) return;
    const tele = this.ops?.room?.listeners || {};
    $('listeners').innerHTML = p.members
      .map((m) => {
        const t = tele[m.userId] || {};
        const host = this.state?.hostId === m.userId ? ' <span class="badge host">HOST</span>' : '';
        const you = m.userId === this.me.userId ? ' <span class="muted">(you)</span>' : '';
        const lag = t.simLagMs ? ` <span class="muted small">sim ${t.simLagMs} ms</span>` : '';
        return `<tr><td>${esc(m.name)}${host}${you}</td><td class="mono ${errClass(t.syncErrMs)}">${t.syncErrMs === null || t.syncErrMs === undefined ? '-' : `${t.syncErrMs > 0 ? '+' : ''}${t.syncErrMs.toFixed(0)} ms`}</td><td class="mono">${ms(t.rttMs)}${lag}</td><td class="small">${esc(t.state || '-')}</td></tr>`;
      })
      .join('');
  }

  renderFrame() {
    const st = this.state;
    if (!st || !st.track) return;
    const pos = this.player.displayPos();
    $('progressFill').style.width = `${Math.min(100, (100 * pos) / st.track.durationMs)}%`;
    $('tPos').textContent = fmt(pos);
    const beatMs = 60000 / st.track.bpm;
    const beatIdx = Math.floor(pos / beatMs);
    const beatEl = $('beat');
    const audible = st.playing && this.player.status !== 'starting';
    if (audible && beatIdx !== this.lastBeat && pos - beatIdx * beatMs < 120) {
      this.lastBeat = beatIdx;
      beatEl.className = `beat on ${beatIdx % 4 === 0 ? 'down' : ''}`;
      setTimeout(() => (beatEl.className = 'beat'), 90);
    }
    $('beatText').textContent = `bar ${Math.floor(beatIdx / 4) + 1} · beat ${(beatIdx % 4) + 1}`;
  }

  renderStats() {
    const p = this.player;
    const st = this.state;
    let label = p.status;
    if (st && st.playing && p.status === 'starting') {
      const wait = st.serverTimeMs - this.clock.serverNow();
      if (wait > 0) label = `starting in ${Math.round(wait)} ms`;
    }
    $('playState').textContent = label;
    $('mErr').textContent = p.errMs === null ? '-' : `${p.errMs > 0 ? '+' : ''}${p.errMs.toFixed(0)}`;
    $('mErr').className = errClass(p.errMs);
    $('mOffset').textContent = this.clock.ready ? ms(this.clock.offset, 1) : 'measuring';
    $('mRtt').textContent = ms(this.clock.bestRtt, 1);
    $('mUnc').textContent = ms(this.clock.uncertainty, 1);
    $('mOut').textContent = p.audioEnabled ? ms(p.outputLatencyMs()) : 'audio off';
    $('mCorr').textContent = `${p.nudges} / ${p.seeks}`;
    $('mApply').textContent = ms(this.applyLatencyMs);
    $('mJoin').textContent = p.joinToSyncMs !== null ? ms(p.joinToSyncMs) : p.joinedWhilePlaying === false ? 'joined before play' : '-';
    $('mVer').textContent = st ? `epoch ${st.epoch} · v${st.version}` : '-';
  }

  sendTelemetry() {
    if (!this.state) return;
    const p = this.player;
    const t = {
      t: 'telemetry',
      syncErrMs: p.errMs,
      rttMs: this.clock.bestRtt,
      offsetUncertaintyMs: this.clock.uncertainty,
      outputLatencyMs: p.outputLatencyMs(),
      nudges: p.nudges,
      seeks: p.seeks,
      state: p.status,
      simLagMs: this.lag.lagMs || null,
      applyLatencyMs: this.applyFresh ? this.applyLatencyMs : null, // each sample reported once
    };
    this.applyFresh = false;
    if (p.joinToSyncMs !== null && !this.reportedJoin) {
      t.joinToSyncMs = p.joinToSyncMs;
      this.reportedJoin = true;
    }
    this.transport.send(t);
  }

  async pollOps() {
    try {
      this.ops = await api(`/api/rooms/${this.roomId}/ops`);
    } catch {
      return;
    }
    const o = this.ops;
    const r = o.room;
    $('oOwner').textContent = r.owner || 'none (lease expired, re-placing)';
    $('oEpoch').textContent = `${r.epoch} / v${r.version}`;
    $('oLease').textContent = r.leaseExpiresInMs === null ? '-' : `${(r.leaseExpiresInMs / 1000).toFixed(1)} s`;
    $('nodes').innerHTML =
      '<h4>Room Service nodes</h4>' +
      o.nodes
        .map(
          (n) => `<div class="node ${n.id === r.owner ? 'owner' : ''}"><span class="name">${n.id}${n.id === r.owner ? ' <span class="muted small">owner</span>' : ''}</span>
          <span class="pill ${n.status}">${n.status}</span><span class="muted small">${n.rooms} rooms</span>
          <button class="sm danger" data-act="node:${n.id}:crash" ${n.status !== 'up' ? 'disabled' : ''}>Crash</button>
          <button class="sm" data-act="node:${n.id}:freeze" ${n.status !== 'up' ? 'disabled' : ''}>Freeze 8 s</button>
          <button class="sm" data-act="node:${n.id}:revive" ${n.status !== 'down' ? 'disabled' : ''}>Restart</button></div>`,
        )
        .join('');
    $('gateways').innerHTML =
      '<h4>Gateways</h4>' +
      o.gateways
        .map(
          (g) => `<div class="node"><span class="name">${g.id}</span>${g.draining ? '<span class="pill drain">draining</span>' : '<span class="pill">up</span>'}
          <span class="muted small">${g.sockets} sockets · ${g.subscriptions} room topics · ${g.busDeliveries} bus msgs → ${g.socketWrites} socket writes</span>
          <button class="sm" data-act="gw:${g.id}:restart">Restart (deploy)</button></div>`,
        )
        .join('');
    $('events').innerHTML = o.events
      .slice()
      .reverse()
      .map((e) => `<li class="${e.type}"><span>${new Date(e.at).toLocaleTimeString()}</span> <b>${esc(e.type)}</b> ${esc(e.msg)}</li>`)
      .join('');
    this.renderListeners();
  }
}
