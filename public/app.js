import { W, H, newModel, setModel, applyOp, renderAll } from './canvas.js';
import { Net } from './net.js';
import { Replay } from './replay.js';

const $ = (id) => document.getElementById(id);
// All user-supplied text goes through textContent, never innerHTML, so names and chat cannot inject markup.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const board = $('board');
const ctx = board.getContext('2d', { willReadFrequently: true });
const PALETTE = ['#000000', '#7f7f7f', '#ffffff', '#c1121f', '#ff6b6b', '#f77f00', '#ffd60a', '#2a9d8f',
  '#06d6a0', '#0077b6', '#4cc9f0', '#3a0ca3', '#7209b7', '#f72585', '#8d5524', '#ffcba4'];
const SIZES = [3, 6, 12, 22];
const AVATAR_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'];

const S = {
  name: localStorage.getItem('scribble:name') || '',
  wantRoom: null, // room we should be (re)joining whenever the socket opens
  inRoom: false,
  me: null,
  token: null,
  view: null,
  model: newModel(),
  expectedSeq: 1,
  tool: 'pen',
  color: '#000000',
  size: 6,
  stroke: null,
  overlayKey: '',
  replay: null,
  lastResync: 0,
  lastView: 0,
  pendingCreate: null,
};

// ---------------------------------------------------------------- rejoin tokens
// The token that proves "I am this player" lives in sessionStorage, so a refresh rejoins the same seat
// while a second tab in the same browser joins as a new player. A copy goes to localStorage with a
// heartbeat, so closing the tab and opening the link again within the grace period also gets the seat
// back, but only once no other open tab is still using it.
const TOKEN_KEY = (code) => 'scribble:token:' + code;
const tokens = {
  get(code) {
    try {
      const own = sessionStorage.getItem(TOKEN_KEY(code));
      if (own) return own;
      const shared = JSON.parse(localStorage.getItem(TOKEN_KEY(code)) || 'null');
      if (shared && Date.now() - shared.beat > 6000) return shared.token;
    } catch { /* storage unavailable */ }
    return null;
  },
  set(code, token) {
    try {
      sessionStorage.setItem(TOKEN_KEY(code), token);
      localStorage.setItem(TOKEN_KEY(code), JSON.stringify({ token, beat: Date.now() }));
    } catch { /* storage unavailable */ }
  },
  remove(code) {
    try { sessionStorage.removeItem(TOKEN_KEY(code)); localStorage.removeItem(TOKEN_KEY(code)); } catch { /* ignore */ }
  },
};
setInterval(() => { if (S.inRoom && S.view && S.token) tokens.set(S.view.code, S.token); }, 2000);

// ---------------------------------------------------------------- network
const net = new Net({
  onOpen() {
    $('banner').hidden = true;
    if (S.pendingCreate) { net.send(S.pendingCreate); S.pendingCreate = null; return; }
    // After any (re)connect, rejoin our room with the secret token. The server restores our seat and score.
    if (S.wantRoom && S.name) net.send({ t: 'join', code: S.wantRoom, name: S.name, token: tokens.get(S.wantRoom) });
  },
  onClose(code) {
    if (code === 4000) {
      $('banner').textContent = 'You opened this room in another tab. Close this one or reload it to play here.';
      $('banner').hidden = false;
      S.inRoom = false;
      return;
    }
    if (S.inRoom || S.wantRoom) $('banner').hidden = false;
  },
  onMessage: onMsg,
});
net.connect();

function onMsg(m) {
  switch (m.t) {
    case 'joined':
      S.me = m.you.id;
      S.token = m.you.token;
      S.inRoom = true;
      S.wantRoom = m.view.code;
      tokens.set(m.view.code, m.you.token);
      history.replaceState(null, '', '/r/' + m.view.code);
      showScreen('room');
      $('chatLog').replaceChildren();
      for (const c of m.view.chat) addChat(c);
      S.overlayKey = '';
      setView(m.view);
      break;
    case 'state': setView(m.view); break;
    case 'players':
      if (!S.view) break;
      S.view.players = m.players;
      S.view.hostId = m.hostId;
      renderPlayers();
      renderOverlay();
      break;
    case 'hint': if (S.view) { S.view.hint = m.hint; renderHint(); } break;
    case 'chat': addChat(m); break;
    case 'op': onOp(m); break;
    case 'canvas':
      setModel(S.model, m.actions);
      renderAll(ctx, S.model.actions);
      S.expectedSeq = m.seq + 1;
      break;
    case 'secret':
      if (S.view) { S.view.word = m.word; renderHint(); renderChatPlaceholder(); }
      addChat({ kind: 'correct', text: `You guessed it! +${m.pts} points` });
      break;
    case 'replay': openReplay(m.turns); break;
    case 'notice': toast(m.text); addChat({ kind: 'notice', text: m.text }); break;
    case 'error': onError(m); break;
    case 'left': break;
  }
}

function onError(m) {
  if (m.code === 'no_room' || m.code === 'full') {
    if (S.wantRoom) tokens.remove(S.wantRoom);
    S.wantRoom = null;
    S.inRoom = false;
    S.view = null;
    showScreen('home');
    history.replaceState(null, '', '/');
    homeError(m.text);
  } else {
    toast(m.text);
    if (!S.inRoom) homeError(m.text);
  }
}

// A drawing operation from the drawer, in order. A gap in the sequence means we missed something
// (for example after a reconnect), so we ask the server for the whole canvas again.
function onOp(m) {
  if (m.seq < S.expectedSeq) return;
  if (m.seq > S.expectedSeq) {
    const now = Date.now();
    if (now - S.lastResync > 600) { S.lastResync = now; net.send({ t: 'resync' }); }
    return;
  }
  S.expectedSeq++;
  if (!applyOp(S.model, ctx, m.op)) net.send({ t: 'resync' });
}

// ---------------------------------------------------------------- screens
function showScreen(name) {
  $('home').hidden = name !== 'home';
  $('room').hidden = name !== 'room';
  if (name === 'home') { $('banner').hidden = true; }
}
function homeError(text) {
  const e = $('homeError');
  e.textContent = text || '';
  e.hidden = !text;
}
let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------------------------------------------------------------- home form
const roundsSel = $('setRounds'), timeSel = $('setTime');
for (let i = 1; i <= 10; i++) roundsSel.add(new Option(`${i} round${i > 1 ? 's' : ''}`, i, i === 3, i === 3));
for (const s of [20, 30, 45, 60, 80, 100, 120, 150, 180]) timeSel.add(new Option(`${s} seconds`, s, s === 80, s === 80));
$('homeName').value = S.name;

function validName() {
  const name = $('homeName').value.trim().replace(/\s+/g, ' ').slice(0, 20);
  if (!name) { homeError('Please enter your name first.'); $('homeName').focus(); return null; }
  S.name = name;
  localStorage.setItem('scribble:name', name);
  homeError('');
  return name;
}
$('btnCreate').onclick = () => {
  const name = validName();
  if (!name) return;
  const msg = { t: 'create', name, settings: { rounds: +roundsSel.value, drawTime: +timeSel.value, words: $('setWords').value } };
  if (net.open) net.send(msg); else S.pendingCreate = msg;
};
function joinFromForm() {
  const name = validName();
  if (!name) return;
  const code = $('joinCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) { homeError('Room codes are 6 characters.'); return; }
  S.wantRoom = code;
  net.send({ t: 'join', code, name, token: tokens.get(code) });
}
$('btnJoin').onclick = joinFromForm;
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromForm(); });
$('homeName').addEventListener('keydown', (e) => { if (e.key === 'Enter') (S.linkCode ? joinFromForm : $('btnCreate').onclick)(); });

// Opened through a shared link such as /r/ABC234: skip the create form.
const link = location.pathname.match(/^\/r\/([A-Za-z0-9]{6})$/);
if (link) {
  S.linkCode = link[1].toUpperCase();
  $('createBox').hidden = true;
  $('joinCode').value = S.linkCode;
  $('joinTitle').textContent = `You're invited to room ${S.linkCode}`;
  if (S.name && tokens.get(S.linkCode)) S.wantRoom = S.linkCode; // returning player: rejoin straight away
}

// ---------------------------------------------------------------- rendering
function setView(v) {
  S.view = v;
  if (net.rtt == null) net.offset = v.serverNow - Date.now(); // rough clock sync until the first ping answers
  setModel(S.model, v.canvas.actions);
  renderAll(ctx, S.model.actions);
  S.expectedSeq = v.canvas.seq + 1;
  renderTop();
  renderPlayers();
  renderOverlay();
  renderToolbar();
  renderChatPlaceholder();
}

const isDrawer = () => S.view && S.view.drawerId === S.me && S.view.phase === 'drawing';
const myPlayer = () => S.view.players.find((p) => p.id === S.me);

function renderTop() {
  const v = S.view;
  $('roundInfo').textContent = v.phase === 'lobby' ? 'Lobby' : `Round ${Math.min(v.round, v.rounds)} / ${v.rounds}`;
  renderHint();
}
function renderHint() {
  const v = S.view;
  const hint = $('hint'), label = $('hintLabel');
  if (v.phase === 'drawing') {
    if (v.word) { label.textContent = isDrawer() ? 'Draw this word' : 'The word is'; hint.textContent = v.word; }
    else { label.textContent = `Guess the word (${v.hint.replace(/[^\p{L}\p{N}_]/gu, '').length} letters)`; hint.textContent = [...v.hint].map((c) => (c === ' ' ? '   ' : c)).join(' '); }
  } else if (v.phase === 'choosing') { label.textContent = ''; hint.textContent = 'Choosing a word…'; }
  else if (v.phase === 'turn_end') { label.textContent = 'The word was'; hint.textContent = v.word || '—'; }
  else if (v.phase === 'game_end') { label.textContent = ''; hint.textContent = 'Game over'; }
  else { label.textContent = ''; hint.textContent = 'Waiting for the game to start'; }
}

function renderPlayers() {
  const v = S.view;
  const list = v.phase === 'lobby' ? v.players : [...v.players].sort((a, b) => b.score - a.score);
  const box = $('players');
  box.replaceChildren();
  list.forEach((p) => {
    const row = el('div', 'player' + (p.id === S.me ? ' me' : '') + (p.connected ? '' : ' offline') + (p.drawer ? ' drawer' : ''));
    const av = el('div', 'avatar', (p.name[0] || '?').toUpperCase());
    av.style.background = AVATAR_COLORS[[...p.name].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
    const mid = el('div');
    mid.append(el('div', 'name', p.name + (p.id === S.me ? ' (you)' : '')));
    const badges = [p.host ? '👑 host' : '', p.drawer ? '✏️ drawing' : '', p.guessed ? '✔ guessed' : '', p.connected ? '' : 'offline'].filter(Boolean).join(' · ');
    mid.append(el('div', 'badges', badges));
    row.append(av, mid, el('div', 'score', String(p.score)));
    box.append(row);
  });
}

// ---- overlay (lobby, word choice, turn summary, final results). Rebuilt only when the situation changes,
// so a host typing a custom word list is never interrupted.
function overlayKeyFor(v) {
  switch (v.phase) {
    case 'lobby': return 'lobby:' + (v.hostId === S.me);
    case 'choosing': return `choosing:${v.round}:${v.drawerId}:${(v.choices || []).join('|')}`;
    case 'turn_end': return `turn_end:${v.round}:${v.lastTurn ? v.lastTurn.drawerName + v.lastTurn.word : ''}`;
    case 'game_end': return 'game_end:' + (v.hostId === S.me);
    default: return 'none';
  }
}
function renderOverlay() {
  const v = S.view;
  const key = overlayKeyFor(v);
  const ov = $('overlay');
  if (key === S.overlayKey) { updateOverlayDynamic(); return; }
  S.overlayKey = key;
  ov.replaceChildren();
  if (v.phase === 'drawing') { ov.hidden = true; return; }
  ov.hidden = false;
  const panel = el('div', 'panel');
  ov.append(panel);
  const nameOf = (id) => (v.players.find((p) => p.id === id) || {}).name || 'A player';

  if (v.phase === 'lobby') buildLobby(panel);
  else if (v.phase === 'choosing') {
    if (v.drawerId === S.me && v.choices) {
      panel.append(el('h3', '', 'Pick a word to draw'));
      const row = el('div', 'wordbtns');
      v.choices.forEach((w, i) => { const b = el('button', 'primary', w); b.onclick = () => net.send({ t: 'pick', index: i }); row.append(b); });
      panel.append(row, el('div', 'muted', 'A word is chosen for you when the timer runs out.'));
    } else panel.append(el('h3', '', `${nameOf(v.drawerId)} is choosing a word…`), el('div', 'muted', 'Get ready to guess!'));
    panel.append(Object.assign(el('div', 'muted small'), { id: 'ovTimer' }));
  } else if (v.phase === 'turn_end') {
    const lt = v.lastTurn || {};
    if (lt.word) {
      const title = lt.reason === 'all_guessed' ? 'Everyone guessed it!' : 'Time\u2019s up!';
      panel.append(el('h3', '', title), el('div', 'muted', 'The word was'), el('div', 'bigword', lt.word));
    }
    else panel.append(el('h3', '', `${lt.drawerName || 'The drawer'} left the turn`), el('div', 'muted', 'Moving on to the next player…'));
    const reasons = { drawer_left: 'The drawer left.' };
    if (reasons[lt.reason]) panel.append(el('div', 'muted', reasons[lt.reason]));
    const box = el('div', 'deltas');
    (lt.deltas || []).forEach((d) => { const r = el('div', '', nameOf(d.id) + (d.drawer ? ' (drawer)' : '')); r.append(el('span', 'pts', `+${d.pts}`)); box.append(r); });
    if (!(lt.deltas || []).length && lt.word) box.append(el('div', 'muted', 'Nobody guessed this one.'));
    panel.append(box);
  } else if (v.phase === 'game_end') {
    panel.append(el('h3', '', '🏆 Game over'));
    const rank = el('div', 'rank');
    (v.ranking || []).forEach((r, i) => { const d = el('div', '', `${['🥇', '🥈', '🥉'][i] || i + 1 + '.'} ${r.name}`); d.append(el('b', '', String(r.score))); rank.append(d); });
    panel.append(rank);
    const btns = el('div', 'btnrow');
    if (v.hasReplay) { const b = el('button', 'primary', '▶ Watch the replay'); b.onclick = () => net.send({ t: 'get_replay' }); btns.append(b); }
    if (v.hostId === S.me) { const b = el('button', '', 'Play again'); b.onclick = () => net.send({ t: 'restart' }); btns.append(b); }
    else btns.append(el('div', 'muted', 'Waiting for the host to start a new game.'));
    panel.append(btns);
  }
  updateOverlayDynamic();
}

function buildLobby(panel) {
  const v = S.view;
  const host = v.hostId === S.me;
  panel.classList.add('left');
  panel.append(el('h3', '', `Room ${v.code}`));
  panel.append(el('div', 'muted', 'Share this link. Friends can join from any browser.'));
  const inv = el('div', 'invite');
  const inp = el('input');
  inp.readOnly = true;
  inp.value = `${location.origin}/r/${v.code}`;
  inp.onfocus = () => inp.select();
  const cp = el('button', '', 'Copy');
  cp.onclick = copyInvite;
  inv.append(inp, cp);
  panel.append(inv);

  if (host) {
    const row = el('div', 'row');
    const r = el('label', 'field', 'Rounds'); const rs = el('select'); for (let i = 1; i <= 10; i++) rs.add(new Option(i, i)); rs.id = 'lbRounds'; r.append(rs);
    const t = el('label', 'field', 'Draw time (seconds)'); const ts = el('select'); for (const s of [20, 30, 45, 60, 80, 100, 120, 150, 180]) ts.add(new Option(s, s)); ts.id = 'lbTime'; t.append(ts);
    row.append(r, t);
    const wl = el('label', 'field', 'Custom words ');
    wl.append(el('span', 'muted', '(3 or more; leave empty for the built-in list)'));
    const wa = el('textarea'); wa.rows = 3; wa.id = 'lbWords'; wl.append(wa);
    panel.append(row, wl);
    const push = () => net.send({ t: 'settings', rounds: +rs.value, drawTime: +ts.value, words: wa.value });
    rs.onchange = push; ts.onchange = push; wa.onblur = push;
  } else {
    panel.append(Object.assign(el('div', 'muted'), { id: 'lbInfo' }));
  }
  panel.append(Object.assign(el('div', 'muted'), { id: 'lbCount' }));
  const btns = el('div', 'btnrow');
  if (host) { const go = el('button', 'primary', 'Start game'); go.id = 'lbStart'; go.onclick = () => net.send({ t: 'start' }); btns.append(go); }
  else btns.append(el('div', 'muted', 'Waiting for the host to start the game…'));
  panel.append(btns);
}

function updateOverlayDynamic() {
  const v = S.view;
  if (v.phase === 'lobby') {
    const connected = v.players.filter((p) => p.connected).length;
    const cnt = $('lbCount');
    if (cnt) cnt.textContent = `${connected} player${connected === 1 ? '' : 's'} in the room${connected < 2 ? ' · you need at least 2 to start' : ''}`;
    const go = $('lbStart');
    if (go) go.disabled = connected < 2;
    const rs = $('lbRounds'), ts = $('lbTime'), wa = $('lbWords');
    if (rs && document.activeElement !== rs) rs.value = v.rounds;
    if (ts && document.activeElement !== ts) ts.value = v.drawTime;
    if (wa && document.activeElement !== wa && v.words) wa.value = v.words.join(', ');
    const info = $('lbInfo');
    if (info) info.textContent = `${v.rounds} round${v.rounds === 1 ? '' : 's'} · ${v.drawTime}s per drawing · ${v.customWords ? v.customWords + ' custom words' : 'built-in word list'}`;
  }
}

function copyInvite() {
  const url = `${location.origin}/r/${S.view.code}`;
  const done = () => toast('Invite link copied');
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => toast(url));
  else toast(url);
}
$('btnCopy').onclick = () => S.view && copyInvite();
$('btnLeave').onclick = () => {
  if (!S.view) return;
  net.send({ t: 'leave' });
  tokens.remove(S.view.code);
  S.wantRoom = null; S.inRoom = false; S.view = null;
  showScreen('home');
  history.replaceState(null, '', '/');
  $('createBox').hidden = false;
  $('joinTitle').textContent = 'Join with a code';
};

// ---- timer
setInterval(() => {
  const v = S.view;
  if (!v) return;
  const t = $('timer');
  const active = v.phase === 'drawing' || v.phase === 'choosing';
  if (!active) { t.textContent = '–'; t.classList.remove('urgent'); return; }
  const left = Math.max(0, Math.ceil((v.endsAt - net.now()) / 1000));
  t.textContent = left;
  t.classList.toggle('urgent', v.phase === 'drawing' && left <= 10);
  const ov = $('ovTimer');
  if (ov && v.phase === 'choosing') ov.textContent = `${left}s`;
  $('rtt').textContent = net.rtt != null ? `${net.rtt} ms` : '';
}, 200);

// ---------------------------------------------------------------- chat
function addChat(m) {
  const log = $('chatLog');
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const row = el('div', 'msg ' + (m.kind || 'chat'));
  if (m.kind === 'chat') { row.append(el('span', 'from', m.from + ': '), document.createTextNode(m.text)); }
  else if (m.kind === 'guessed') { row.append(el('span', 'from', m.from + ' (knows the word): '), document.createTextNode(m.text)); }
  else row.textContent = m.text;
  log.append(row);
  while (log.children.length > 200) log.firstChild.remove();
  if (near) log.scrollTop = log.scrollHeight;
}
function renderChatPlaceholder() {
  const v = S.view, inp = $('chatInput');
  if (!v) return;
  if (isDrawer()) { inp.disabled = true; inp.placeholder = 'You are drawing, so chat is off.'; }
  else if (v.phase === 'drawing' && v.word) { inp.disabled = false; inp.placeholder = 'You know the word. Chat with others who do.'; }
  else { inp.disabled = false; inp.placeholder = v.phase === 'drawing' ? 'Type your guess here…' : 'Say something…'; }
}
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('chatInput');
  const text = inp.value.trim();
  if (text) net.send({ t: 'chat', text });
  inp.value = '';
});

// ---------------------------------------------------------------- toolbar and drawing
function buildToolbar() {
  const tb = $('toolbar');
  const tools = el('div', 'tools');
  [['pen', '✏️ Pen'], ['eraser', '🧽 Eraser'], ['fill', '🪣 Fill']].forEach(([id, label]) => {
    const b = el('button', 'tool' + (id === S.tool ? ' active' : ''), label);
    b.dataset.tool = id;
    b.onclick = () => { S.tool = id; refreshToolbar(); };
    tools.append(b);
  });
  const pal = el('div', 'palette');
  PALETTE.forEach((c) => {
    const b = el('button', 'swatch' + (c === S.color ? ' active' : ''));
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    b.onclick = () => { S.color = c; if (S.tool === 'eraser') S.tool = 'pen'; refreshToolbar(); };
    pal.append(b);
  });
  const custom = el('input');
  custom.type = 'color';
  custom.value = S.color;
  custom.title = 'Custom colour';
  custom.oninput = () => { S.color = custom.value; if (S.tool === 'eraser') S.tool = 'pen'; refreshToolbar(); };
  custom.id = 'customColor';
  const sizes = el('div', 'sizes');
  SIZES.forEach((s) => {
    const b = el('button', 'size' + (s === S.size ? ' active' : ''));
    const dot = el('span');
    dot.style.width = dot.style.height = Math.min(s, 20) + 'px';
    b.append(dot);
    b.dataset.size = s;
    b.title = `Brush size ${s}`;
    b.onclick = () => { S.size = s; refreshToolbar(); };
    sizes.append(b);
  });
  const actions = el('div', 'actions');
  const undo = el('button', '', '↩ Undo'); undo.onclick = doUndo; undo.id = 'btnUndo';
  const clr = el('button', '', '🗑 Clear'); clr.onclick = doClear; clr.id = 'btnClear';
  actions.append(undo, clr);
  tb.append(tools, pal, custom, sizes, actions);
}
function refreshToolbar() {
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === S.tool);
  for (const b of document.querySelectorAll('.swatch')) b.classList.toggle('active', b.dataset.color === S.color && S.tool !== 'eraser');
  for (const b of document.querySelectorAll('.size')) b.classList.toggle('active', +b.dataset.size === S.size);
  const cc = $('customColor');
  if (cc && /^#[0-9a-f]{6}$/i.test(S.color)) cc.value = S.color;
}
function renderToolbar() {
  const on = isDrawer();
  $('toolbar').classList.toggle('off', !on);
  board.classList.toggle('can-draw', on);
}
buildToolbar();

const rid = () => Math.random().toString(36).slice(2, 10);
function pos(e) {
  const r = board.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) * W) / r.width);
  const y = Math.round(((e.clientY - r.top) * H) / r.height);
  return { x: Math.max(0, Math.min(W, x)), y: Math.max(0, Math.min(H, y)) };
}

function startStroke(x, y) {
  const id = rid();
  const op = { o: 'ds', id, tool: S.tool === 'eraser' ? 'eraser' : 'pen', color: S.color, size: S.size, x, y };
  applyOp(S.model, ctx, op); // draw locally at once; the server relays it to everyone else
  net.send({ t: 'ds', id, tool: op.tool, color: op.color, size: op.size, x, y });
  S.stroke = { id, buf: [], lx: x, ly: y, lastFlush: performance.now() };
  requestAnimationFrame(flushLoop);
}
// Points are collected as the pointer moves and sent in one batch per animation frame (about 60 per
// second), which keeps the message rate low while strokes still look smooth to everyone else.
// Frames come faster than 60 a second on high-refresh screens, so batches are also spaced at least
// 16 ms apart; that keeps every drawer comfortably inside the server's rate limit.
function flushLoop(now) {
  const s = S.stroke;
  if (!s) return;
  if (now - s.lastFlush >= 16) { s.lastFlush = now; flush(); }
  if (S.stroke === s) requestAnimationFrame(flushLoop);
}
function flush() {
  const s = S.stroke;
  if (!s || !s.buf.length) return;
  while (s.buf.length) net.send({ t: 'dp', id: s.id, pts: s.buf.splice(0, 128) });
}
function addPoint(p) {
  const s = S.stroke;
  if (!s || (Math.abs(p.x - s.lx) < 1 && Math.abs(p.y - s.ly) < 1)) return;
  s.buf.push(p.x, p.y);
  s.lx = p.x; s.ly = p.y;
  applyOp(S.model, ctx, { o: 'dp', id: s.id, pts: [p.x, p.y] });
}
function endStroke() {
  const s = S.stroke;
  if (!s) return;
  flush();
  net.send({ t: 'de', id: s.id });
  applyOp(S.model, ctx, { o: 'de', id: s.id });
  S.stroke = null;
}
board.addEventListener('pointerdown', (e) => {
  if (!isDrawer() || e.button > 0) return;
  e.preventDefault();
  const { x, y } = pos(e);
  if (S.tool === 'fill') {
    const op = { o: 'fill', x: Math.min(x, W - 1), y: Math.min(y, H - 1), color: S.color };
    applyOp(S.model, ctx, op);
    net.send({ t: 'fill', x: op.x, y: op.y, color: op.color });
    return;
  }
  board.setPointerCapture(e.pointerId);
  startStroke(x, y);
});
board.addEventListener('pointermove', (e) => {
  if (!S.stroke) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs.length ? evs : [e]) addPoint(pos(ev));
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) board.addEventListener(type, endStroke);

function doUndo() {
  if (!isDrawer() || !S.model.actions.length) return;
  endStroke();
  applyOp(S.model, ctx, { o: 'undo' });
  net.send({ t: 'undo' });
}
function doClear() {
  if (!isDrawer()) return;
  endStroke();
  applyOp(S.model, ctx, { o: 'clear' });
  net.send({ t: 'clear' });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); doUndo(); }
});

// ---------------------------------------------------------------- replay
function openReplay(turns) {
  if (!turns.length) { toast('Nothing to replay.'); return; }
  const modal = $('replayModal');
  modal.hidden = false;
  if (S.replay) S.replay.destroy();
  const rp = new Replay($('replayBoard'), turns, {
    onLabel: (t) => { $('replayLabel').textContent = t; },
    onPlaying: (p) => { $('rpPlay').textContent = p ? 'Pause' : 'Play'; },
  });
  S.replay = rp;
  rp.start();
  $('rpPlay').onclick = () => rp.toggle();
  $('rpNext').onclick = () => rp.next();
  $('rpPrev').onclick = () => rp.prev();
  $('rpSpeed').onchange = (e) => rp.setSpeed(+e.target.value);
  $('rpClose').onclick = () => { rp.destroy(); modal.hidden = true; };
}

// Small hooks used by the automated browser test.
window.__scribble = { S, net };
