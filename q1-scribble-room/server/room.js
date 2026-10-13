import { cfg } from './config.js';
import { DEFAULT_WORDS } from './words.js';
import { stats } from './stats.js';
import { uid, secretToken, normalizeGuess, isCloseGuess, cleanText, clampInt, shuffle } from './util.js';

export const W = 800;
export const H = 600;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9]{1,12}$/;
const WORD_RE = /^[\p{L}\p{N}][\p{L}\p{N} '-]{0,28}[\p{L}\p{N}]$/u;
const LETTER_RE = /[\p{L}\p{N}]/u;
const HINT_FRACTIONS = [0.4, 0.65, 0.85];
const DRAWER_SHARE = 0.5;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export const DEFAULT_SETTINGS = { rounds: 3, drawTime: 80, words: null };

// Validate host-supplied settings. Anything out of range is clamped, anything malformed is ignored.
export function sanitizeSettings(input, prev = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...prev };
  if (!input || typeof input !== 'object') return s;
  if (Number.isFinite(Number(input.rounds))) s.rounds = clampInt(input.rounds, 1, 10);
  if (Number.isFinite(Number(input.drawTime))) s.drawTime = clampInt(input.drawTime, cfg.MIN_DRAW_S, cfg.MAX_DRAW_S);
  if (Array.isArray(input.words) || typeof input.words === 'string') {
    const raw = Array.isArray(input.words) ? input.words : input.words.split(/[\n,]/);
    const seen = new Set();
    const out = [];
    for (const w0 of raw.slice(0, 1000)) {
      const w = cleanText(String(w0), 30);
      if (!WORD_RE.test(w)) continue;
      const k = w.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(w);
      if (out.length >= 500) break;
    }
    s.words = out.length >= 3 ? out : null; // fewer than 3 usable words: fall back to the default list
  }
  return s;
}

export class Room {
  constructor(code, settings, hooks = {}) {
    this.code = code;
    this.settings = sanitizeSettings(settings, DEFAULT_SETTINGS);
    this.hooks = hooks;
    this.players = new Map(); // id -> player
    this.order = []; // ids in join order (also the drawing order)
    this.queue = []; // ids still to draw in the current round
    this.hostId = null;
    this.phase = 'lobby'; // lobby | choosing | drawing | turn_end | game_end
    this.round = 0;
    this.drawerId = null;
    this.word = null;
    this.choices = [];
    this.usedWords = new Set();
    this.hint = '';
    this.revealed = new Set();
    this.phaseEndsAt = 0;
    this.phaseTotalMs = 0;
    this.drawStart = 0;
    this.timers = {};
    this.turns = []; // finished drawings, kept for the end-of-game replay
    this.chat = []; // last public chat lines, for late joiners and reconnects
    this.lastTurn = null;
    this.ranking = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.resetCanvas();
  }

  // ---------------------------------------------------------------- helpers
  touch() {
    this.lastActivity = Date.now();
    if (this.hooks.dirty) this.hooks.dirty();
  }

  resetCanvas() {
    this.actions = []; // the current drawing, as a stack of strokes / fills / clears (undo pops it)
    this.strokeIdx = new Map(); // stroke id -> action
    this.seq = 0; // sequence number of the last drawing operation broadcast this turn
    this.log = []; // every operation with its timestamp, kept for the replay
    this.points = 0;
    this.fills = 0;
  }

  setTimer(name, ms, fn) {
    this.clearTimer(name);
    this.timers[name] = setTimeout(() => {
      delete this.timers[name];
      fn();
    }, Math.max(0, ms));
  }
  clearTimer(name) {
    if (this.timers[name]) {
      clearTimeout(this.timers[name]);
      delete this.timers[name];
    }
  }
  clearTurnTimers() {
    for (const n of ['phase', 'hint0', 'hint1', 'hint2', 'drawer', 'next', 'allGuessed']) this.clearTimer(n);
  }
  // Stops everything that drives a game, but leaves the reconnect grace timers of dropped players alone.
  clearGameTimers() {
    this.clearTurnTimers();
    this.clearTimer('solo');
  }

  send(p, obj) {
    if (p.ws && p.ws.readyState === 1) {
      const s = JSON.stringify(obj);
      p.ws.send(s);
      stats.msgOut++;
      stats.bytesOut += s.length;
    }
  }
  broadcast(obj, exceptId = null) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.id !== exceptId && p.ws && p.ws.readyState === 1) {
        p.ws.send(s);
        stats.msgOut++;
        stats.bytesOut += s.length;
      }
    }
  }
  broadcastState() {
    for (const p of this.players.values()) if (p.connected) this.send(p, { t: 'state', view: this.viewFor(p) });
  }
  broadcastPlayers() {
    this.broadcast({ t: 'players', players: this.playersList(), hostId: this.hostId });
  }
  pushChat(entry) {
    this.chat.push(entry);
    if (this.chat.length > 40) this.chat.shift();
  }
  say(text, kind = 'system') {
    const entry = { kind, text };
    this.pushChat(entry);
    this.broadcast({ t: 'chat', ...entry });
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }
  isEmpty() {
    return this.connectedCount() === 0;
  }

  playersList() {
    return this.order
      .map((id) => this.players.get(id))
      .filter(Boolean)
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        guessed: this.phase === 'drawing' && p.guessed,
        drawer: p.id === this.drawerId && (this.phase === 'drawing' || this.phase === 'choosing'),
        host: p.id === this.hostId,
      }));
  }

  // What a given player is allowed to see. The secret word is only ever included for the drawer,
  // for players who already guessed it, or once the turn is over. Nothing else leaks it.
  viewFor(p) {
    const isDrawer = p.id === this.drawerId;
    const active = this.phase === 'drawing' || this.phase === 'choosing';
    const showWord = this.word && (this.phase === 'turn_end' || (this.phase === 'drawing' && (isDrawer || p.guessed)));
    return {
      code: this.code,
      you: p.id,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      rounds: this.settings.rounds,
      drawTime: this.settings.drawTime,
      customWords: this.settings.words ? this.settings.words.length : 0,
      words: p.id === this.hostId && this.settings.words ? this.settings.words : undefined,
      drawerId: active ? this.drawerId : null,
      players: this.playersList(),
      hint: this.phase === 'drawing' ? this.hint : '',
      endsAt: active ? this.phaseEndsAt : 0,
      serverNow: Date.now(),
      word: showWord ? this.word : undefined,
      choices: this.phase === 'choosing' && isDrawer ? this.choices : undefined,
      canvas: { seq: this.seq, actions: this.phase === 'drawing' ? this.actions : [] },
      chat: this.chat,
      lastTurn: this.phase === 'turn_end' ? this.lastTurn : null,
      ranking: this.phase === 'game_end' ? this.ranking : undefined,
      hasReplay: this.turns.length > 0,
    };
  }

  // ---------------------------------------------------------------- joining and leaving
  join(ws, rawName, token) {
    let p = token ? [...this.players.values()].find((x) => x.token === token) : null;
    let rejoined = false;
    if (p) {
      rejoined = true;
      if (p.ws && p.ws !== ws) {
        const old = p.ws;
        p.ws = null;
        old.player = null;
        try { old.close(4000, 'replaced by a newer connection'); } catch { /* already closed */ }
      }
      this.clearTimer('grace:' + p.id);
      p.connected = true;
      p.disconnectedAt = null;
      if (p.id === this.drawerId) this.clearTimer('drawer');
    } else {
      if (this.players.size >= cfg.MAX_PLAYERS) return { error: 'This room is full.' };
      let name = cleanText(rawName, 20) || 'Player';
      const taken = (n) => [...this.players.values()].some((x) => x.name.toLowerCase() === n.toLowerCase());
      if (taken(name)) {
        let i = 2;
        while (taken(`${name} ${i}`)) i++;
        name = `${name} ${i}`;
      }
      p = { id: uid(8), token: secretToken(), name, score: 0, guessed: false, guessPts: 0, connected: true, ws: null, disconnectedAt: null };
      this.players.set(p.id, p);
      this.order.push(p.id);
      // Someone who joins mid-game gets a turn to draw later in the current round.
      if (this.phase !== 'lobby' && this.phase !== 'game_end') this.queue.push(p.id);
      if (!this.hostId) this.hostId = p.id;
    }
    p.ws = ws;
    ws.player = p;
    ws.room = this;
    this.send(p, { t: 'joined', you: { id: p.id, token: p.token }, view: this.viewFor(p) });
    this.broadcastPlayers();
    if (!rejoined) this.say(`${p.name} joined.`);
    else this.say(`${p.name} is back.`);
    this.checkViability();
    this.touch();
    return { player: p };
  }

  onDisconnect(p, ws) {
    if (p.ws !== ws) return; // this socket was already replaced by a newer one
    p.connected = false;
    p.ws = null;
    p.disconnectedAt = Date.now();
    // Keep the seat and score for a grace period so a refresh or a flaky connection can rejoin.
    this.setTimer('grace:' + p.id, cfg.GRACE_MS, () => this.removePlayer(p, false));
    if (p.id === this.drawerId && (this.phase === 'drawing' || this.phase === 'choosing')) {
      // The turn waits briefly for the drawer to come back, then ends so the game never gets stuck.
      this.setTimer('drawer', cfg.DRAWER_GRACE_MS, () => {
        const d = this.players.get(this.drawerId);
        if (d && !d.connected && (this.phase === 'drawing' || this.phase === 'choosing')) this.endTurn('drawer_left');
      });
    }
    // Hand the host role to someone still here, so a host who dropped cannot leave the lobby stuck.
    if (this.hostId === p.id) {
      const next = this.order.map((id) => this.players.get(id)).find((x) => x && x.connected);
      if (next) {
        this.hostId = next.id;
        this.say(`${next.name} is now the host.`);
        if (this.phase === 'lobby' || this.phase === 'game_end') this.broadcastState(); // the host gets the settings panel
      }
    }
    this.broadcastPlayers();
    this.checkViability();
    this.touch();
  }

  removePlayer(p, explicit) {
    if (!this.players.has(p.id)) return;
    this.clearTimer('grace:' + p.id);
    const wasDrawer = p.id === this.drawerId && (this.phase === 'drawing' || this.phase === 'choosing');
    this.players.delete(p.id);
    this.order = this.order.filter((id) => id !== p.id);
    this.queue = this.queue.filter((id) => id !== p.id);
    if (p.ws) {
      const ws = p.ws;
      p.ws = null;
      ws.player = null;
      ws.room = null;
      if (explicit) { try { ws.send(JSON.stringify({ t: 'left' })); } catch { /* ignore */ } }
    }
    if (this.hostId === p.id) {
      const next = this.order.map((id) => this.players.get(id)).find((x) => x && x.connected) || this.players.get(this.order[0]);
      this.hostId = next ? next.id : null;
    }
    this.say(`${p.name} left.`);
    if (wasDrawer) this.endTurn('drawer_left');
    else this.checkAllGuessed();
    this.broadcastPlayers();
    this.checkViability();
    this.touch();
  }

  // If fewer than two people are connected during a game, wait one grace period for someone to
  // come back and then end the game cleanly instead of leaving it stuck.
  checkViability() {
    const inGame = this.phase !== 'lobby' && this.phase !== 'game_end';
    if (inGame && this.connectedCount() < 2) {
      if (!this.timers.solo) this.setTimer('solo', cfg.GRACE_MS, () => { if (this.connectedCount() < 2) this.endGame('not_enough_players'); });
    } else {
      this.clearTimer('solo');
    }
  }

  // ---------------------------------------------------------------- game flow
  startGame(p) {
    if (p.id !== this.hostId || this.phase !== 'lobby') return false;
    if (this.connectedCount() < 2) {
      this.send(p, { t: 'notice', text: 'You need at least 2 players to start.' });
      return true;
    }
    for (const q of this.players.values()) { q.score = 0; q.guessed = false; q.guessPts = 0; }
    this.usedWords.clear();
    this.turns = [];
    this.ranking = null;
    this.round = 0;
    this.queue = [];
    this.phase = 'turn_end'; // leave the lobby; advance() then picks the first drawer
    this.lastTurn = null;
    this.say('The game has started. Good luck!');
    this.advance();
    return true;
  }

  advance() {
    if (this.phase === 'lobby' || this.phase === 'game_end') return;
    for (;;) {
      while (this.queue.length) {
        const id = this.queue.shift();
        const p = this.players.get(id);
        if (p && p.connected) return this.startChoosing(p);
      }
      if (this.round >= this.settings.rounds) return this.endGame('complete');
      this.round++;
      this.queue = this.order.filter((id) => this.players.get(id)?.connected);
      if (!this.queue.length) return this.endGame('empty');
    }
  }

  pickWords() {
    const pool = (this.settings.words || DEFAULT_WORDS).filter((w) => !this.usedWords.has(w.toLowerCase()));
    const source = pool.length >= 3 ? pool : (this.usedWords.clear(), this.settings.words || DEFAULT_WORDS);
    return shuffle(source).slice(0, 3);
  }

  startChoosing(drawer) {
    this.clearTurnTimers();
    this.resetCanvas();
    for (const q of this.players.values()) { q.guessed = false; q.guessPts = 0; }
    this.drawerId = drawer.id;
    this.word = null;
    this.hint = '';
    this.revealed = new Set();
    this.lastTurn = null;
    this.choices = this.pickWords();
    this.phase = 'choosing';
    this.phaseTotalMs = cfg.CHOOSE_MS;
    this.phaseEndsAt = Date.now() + cfg.CHOOSE_MS;
    this.setTimer('phase', cfg.CHOOSE_MS, () => this.startDrawing(this.choices[Math.floor(Math.random() * this.choices.length)]));
    this.broadcastState();
    this.touch();
  }

  letterIndexes() {
    return [...this.word].map((ch, i) => (LETTER_RE.test(ch) ? i : -1)).filter((i) => i >= 0);
  }
  maxReveals() {
    return Math.min(3, Math.floor(this.letterIndexes().length / 2));
  }
  maskedHint() {
    return [...this.word].map((ch, i) => (LETTER_RE.test(ch) ? (this.revealed.has(i) ? ch : '_') : ch)).join('');
  }

  startDrawing(word) {
    if (this.phase !== 'choosing') return;
    this.clearTurnTimers();
    this.word = word;
    this.usedWords.add(word.toLowerCase());
    this.revealed = new Set();
    this.hint = this.maskedHint();
    this.phase = 'drawing';
    this.drawStart = Date.now();
    this.phaseTotalMs = this.settings.drawTime * 1000;
    this.phaseEndsAt = this.drawStart + this.phaseTotalMs;
    this.setTimer('phase', this.phaseTotalMs, () => this.endTurn('time'));
    this.scheduleHints(0);
    this.broadcastState();
    this.touch();
  }

  // Letters are revealed one at a time at 40%, 65% and 85% of the drawing time.
  scheduleHints(elapsedMs) {
    const max = this.maxReveals();
    for (let i = this.revealed.size; i < max; i++) {
      const at = Math.max(300, HINT_FRACTIONS[i] * this.phaseTotalMs - elapsedMs);
      this.setTimer('hint' + i, at, () => this.revealLetter());
    }
  }
  revealLetter() {
    if (this.phase !== 'drawing' || this.revealed.size >= this.maxReveals()) return;
    const free = this.letterIndexes().filter((i) => !this.revealed.has(i));
    if (!free.length) return;
    this.revealed.add(free[Math.floor(Math.random() * free.length)]);
    this.hint = this.maskedHint();
    this.broadcast({ t: 'hint', hint: this.hint });
    this.touch();
  }

  endTurn(reason) {
    if (this.phase !== 'drawing' && this.phase !== 'choosing') return;
    const wasDrawing = this.phase === 'drawing';
    this.clearTurnTimers();
    const drawer = this.players.get(this.drawerId);
    const deltas = [];
    if (wasDrawing) {
      const eligible = [...this.players.values()].filter((p) => p.id !== this.drawerId);
      const guessers = eligible.filter((p) => p.guessed);
      for (const g of guessers) deltas.push({ id: g.id, pts: g.guessPts });
      // The drawer earns half the average guess score across everyone who was guessing: a drawing only
      // half the room understood earns about half as much, and the drawer always earns less than a
      // guesser who got it, so a 2-player game is not an automatic tie.
      const drawerPts = guessers.length && eligible.length ? Math.round((DRAWER_SHARE * guessers.reduce((s, g) => s + g.guessPts, 0)) / eligible.length) : 0;
      if (drawer && drawerPts) { drawer.score += drawerPts; deltas.push({ id: drawer.id, pts: drawerPts, drawer: true }); }
      this.turns.push({ round: this.round, drawerName: drawer ? drawer.name : 'A player who left', word: this.word, log: this.log });
      if (this.turns.length > 150) this.turns.shift();
    }
    this.lastTurn = { word: wasDrawing ? this.word : null, drawerName: drawer ? drawer.name : null, deltas, reason };
    this.phase = 'turn_end';
    this.phaseEndsAt = Date.now() + (wasDrawing ? cfg.TURN_END_MS : 1500);
    this.broadcastState();
    this.setTimer('next', wasDrawing ? cfg.TURN_END_MS : 1500, () => this.advance());
    this.touch();
  }

  endGame(reason) {
    if (this.phase === 'lobby' || this.phase === 'game_end') return;
    this.clearGameTimers();
    this.phase = 'game_end';
    this.drawerId = null;
    this.word = null;
    this.ranking = [...this.players.values()].sort((a, b) => b.score - a.score).map((p) => ({ id: p.id, name: p.name, score: p.score }));
    if (reason === 'not_enough_players') this.say('The game ended because too many players left.');
    this.broadcastState();
    this.touch();
  }

  backToLobby(p) {
    if (p.id !== this.hostId || this.phase !== 'game_end') return;
    this.phase = 'lobby';
    this.round = 0;
    this.turns = [];
    this.ranking = null;
    this.queue = [];
    for (const q of this.players.values()) { q.score = 0; q.guessed = false; q.guessPts = 0; }
    this.resetCanvas();
    this.broadcastState();
    this.touch();
  }

  // ---------------------------------------------------------------- chat and guessing
  chatMsg(p, rawText) {
    const text = cleanText(rawText, cfg.MAX_CHAT_CHARS);
    if (!text) return true;
    if (this.phase === 'drawing') {
      if (p.id === this.drawerId) {
        this.send(p, { t: 'notice', text: "You can't chat while you're drawing." });
        return true;
      }
      const guess = normalizeGuess(text);
      const word = normalizeGuess(this.word);
      if (p.guessed) {
        // A player who already knows the word talks on a private channel, and can never type it.
        if (guess.includes(word)) {
          this.send(p, { t: 'notice', text: "Don't reveal the word." });
          return true;
        }
        const msg = { t: 'chat', kind: 'guessed', from: p.name, text };
        for (const q of this.players.values()) if (q.guessed || q.id === this.drawerId) this.send(q, msg);
        return true;
      }
      if (guess && guess === word) return this.correctGuess(p);
      const entry = { kind: 'chat', from: p.name, text };
      this.pushChat(entry);
      this.broadcast({ t: 'chat', ...entry });
      if (isCloseGuess(guess, word)) this.send(p, { t: 'chat', kind: 'close', text: 'close!' });
      return true;
    }
    const entry = { kind: 'chat', from: p.name, text };
    this.pushChat(entry);
    this.broadcast({ t: 'chat', ...entry });
    return true;
  }

  // Faster guesses are worth more: 500 points at the start of the turn, falling to 100 at the end.
  correctGuess(p) {
    const remaining = Math.max(0, this.phaseEndsAt - Date.now());
    const frac = Math.min(1, remaining / this.phaseTotalMs);
    const pts = Math.round(100 + 400 * frac);
    p.guessed = true;
    p.guessPts = pts;
    p.score += pts;
    this.say(`${p.name} guessed the word!`, 'correct');
    this.send(p, { t: 'secret', word: this.word, pts });
    this.broadcastPlayers();
    this.checkAllGuessed();
    this.touch();
    return true;
  }

  // The turn ends as soon as every guesser still seated has the word, including when the last player
  // still guessing leaves. A player who only dropped keeps their seat (and their chance to guess) for
  // the grace period, so a refresh never cuts the turn short.
  checkAllGuessed() {
    if (this.phase !== 'drawing') return;
    const guessers = [...this.players.values()].filter((q) => q.id !== this.drawerId);
    if (!guessers.some((q) => q.guessed)) return;
    if (guessers.some((q) => !q.guessed)) return;
    this.setTimer('allGuessed', 400, () => this.endTurn('all_guessed'));
  }

  // ---------------------------------------------------------------- drawing operations
  // Returns false for malformed input, which counts as a violation for the sender.
  drawOp(p, m) {
    if (this.phase !== 'drawing' || p.id !== this.drawerId) return true; // stale or late: ignore quietly
    let op;
    switch (m.t) {
      case 'ds': {
        if (!ID_RE.test(m.id || '') || this.strokeIdx.has(m.id)) return false;
        if (m.tool !== 'pen' && m.tool !== 'eraser') return false;
        if (!COLOR_RE.test(m.color || '') || !isInt(m.size, 1, 60) || !isInt(m.x, 0, W) || !isInt(m.y, 0, H)) return false;
        if (this.actions.length >= cfg.MAX_ACTIONS_PER_TURN || this.points >= cfg.MAX_POINTS_PER_TURN) return this.limitHit(p);
        op = { o: 'ds', id: m.id, tool: m.tool, color: m.color.toLowerCase(), size: m.size, x: m.x, y: m.y };
        break;
      }
      case 'dp': {
        const a = this.strokeIdx.get(m.id);
        if (!a || !a.open) return true;
        const pts = m.pts;
        if (!Array.isArray(pts) || pts.length < 2 || pts.length % 2 || pts.length > cfg.MAX_PTS_PER_MSG * 2) return false;
        for (let i = 0; i < pts.length; i += 2) if (!isInt(pts[i], 0, W) || !isInt(pts[i + 1], 0, H)) return false;
        if (this.points + pts.length / 2 > cfg.MAX_POINTS_PER_TURN) return this.limitHit(p);
        op = { o: 'dp', id: m.id, pts };
        break;
      }
      case 'de': {
        const a = this.strokeIdx.get(m.id);
        if (!a || !a.open) return true;
        op = { o: 'de', id: m.id };
        break;
      }
      case 'fill': {
        if (!isInt(m.x, 0, W - 1) || !isInt(m.y, 0, H - 1) || !COLOR_RE.test(m.color || '')) return false;
        if (this.fills >= cfg.MAX_FILLS_PER_TURN || this.actions.length >= cfg.MAX_ACTIONS_PER_TURN) return this.limitHit(p);
        op = { o: 'fill', x: m.x, y: m.y, color: m.color.toLowerCase() };
        break;
      }
      case 'clear':
        if (this.actions.length >= cfg.MAX_ACTIONS_PER_TURN) return this.limitHit(p);
        op = { o: 'clear' };
        break;
      case 'undo':
        if (!this.actions.length) return true;
        op = { o: 'undo' };
        break;
      default:
        return false;
    }
    this.applyOp(op);
    this.seq++;
    if (this.log.length < cfg.MAX_LOG_EVENTS) this.log.push({ dt: Date.now() - this.drawStart, ...op });
    this.broadcast({ t: 'op', seq: this.seq, op }, p.id); // the drawer already has it locally
    this.touch();
    return true;
  }

  limitHit(p) {
    this.send(p, { t: 'notice', text: 'Drawing limit reached for this turn.' });
    this.resyncDrawer(p);
    return true;
  }

  // The drawer paints optimistically. When the server refuses one of their operations (rate or size
  // limit), it sends back its own canvas so the drawer sees exactly what everyone else sees.
  resyncDrawer(p) {
    if (this.phase !== 'drawing' || p.id !== this.drawerId) return;
    const now = Date.now();
    if (p.lastResync && now - p.lastResync < 250) return;
    p.lastResync = now;
    this.send(p, { t: 'canvas', seq: this.seq, actions: this.actions });
  }

  applyOp(op) {
    switch (op.o) {
      case 'ds': {
        const a = { k: 's', id: op.id, tool: op.tool, color: op.color, size: op.size, pts: [op.x, op.y], open: true };
        this.actions.push(a);
        this.strokeIdx.set(op.id, a);
        this.points += 1;
        break;
      }
      case 'dp': {
        const a = this.strokeIdx.get(op.id);
        for (const v of op.pts) a.pts.push(v);
        this.points += op.pts.length / 2;
        break;
      }
      case 'de': this.strokeIdx.get(op.id).open = false; break;
      case 'fill': this.actions.push({ k: 'f', x: op.x, y: op.y, color: op.color }); this.fills++; break;
      case 'clear': this.actions.push({ k: 'c' }); break;
      case 'undo': {
        const a = this.actions.pop();
        if (a && a.k === 's') this.strokeIdx.delete(a.id);
        if (a && a.k === 'f') this.fills = Math.max(0, this.fills - 1);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- message router
  handle(p, m) {
    switch (m.t) {
      case 'chat': return this.chatMsg(p, m.text);
      case 'ds': case 'dp': case 'de': case 'fill': case 'clear': case 'undo': return this.drawOp(p, m);
      case 'pick': {
        if (this.phase !== 'choosing' || p.id !== this.drawerId) return true;
        if (!isInt(m.index, 0, this.choices.length - 1)) return false;
        this.startDrawing(this.choices[m.index]);
        return true;
      }
      case 'start': return this.startGame(p);
      case 'settings': {
        if (p.id !== this.hostId || (this.phase !== 'lobby')) return true;
        this.settings = sanitizeSettings(m, this.settings);
        this.broadcastState();
        this.touch();
        return true;
      }
      case 'restart': this.backToLobby(p); return true;
      case 'resync': this.send(p, { t: 'canvas', seq: this.seq, actions: this.phase === 'drawing' ? this.actions : [] }); return true;
      case 'get_replay': {
        if (this.phase !== 'game_end') return true;
        const now = Date.now();
        if (p.lastReplay && now - p.lastReplay < 4000) return true;
        p.lastReplay = now;
        this.send(p, { t: 'replay', turns: this.turns });
        return true;
      }
      case 'leave': this.removePlayer(p, true); return true;
      default: return false;
    }
  }

  // ---------------------------------------------------------------- persistence (server restarts)
  toJSON() {
    return {
      code: this.code,
      settings: this.settings,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      order: this.order,
      queue: this.queue,
      drawerId: this.drawerId,
      word: this.word,
      choices: this.choices,
      usedWords: [...this.usedWords],
      hint: this.hint,
      revealed: [...this.revealed],
      remainingMs: this.phase === 'drawing' || this.phase === 'choosing' ? Math.max(0, this.phaseEndsAt - Date.now()) : 0,
      phaseTotalMs: this.phaseTotalMs,
      actions: this.actions,
      seq: this.seq,
      log: this.log,
      points: this.points,
      fills: this.fills,
      turns: this.turns,
      chat: this.chat,
      lastTurn: this.lastTurn,
      ranking: this.ranking,
      players: [...this.players.values()].map((p) => ({ id: p.id, token: p.token, name: p.name, score: p.score, guessed: p.guessed, guessPts: p.guessPts })),
    };
  }

  static fromJSON(o, hooks) {
    const r = new Room(o.code, o.settings, hooks);
    Object.assign(r, {
      hostId: o.hostId, phase: o.phase, round: o.round, order: o.order, queue: o.queue, drawerId: o.drawerId, word: o.word,
      choices: o.choices, usedWords: new Set(o.usedWords), hint: o.hint, revealed: new Set(o.revealed), phaseTotalMs: o.phaseTotalMs,
      actions: o.actions, seq: o.seq, log: o.log, points: o.points, fills: o.fills, turns: o.turns, chat: o.chat,
      lastTurn: o.lastTurn, ranking: o.ranking,
    });
    r.strokeIdx = new Map(r.actions.filter((a) => a.k === 's').map((a) => [a.id, a]));
    for (const p of o.players) {
      r.players.set(p.id, { ...p, connected: false, ws: null, disconnectedAt: Date.now() });
    }
    // Nobody is connected right after a restart. Players keep their seat for a grace period and
    // the clocks resume from where they stopped; downtime does not count against the drawer.
    for (const p of r.players.values()) r.setTimer('grace:' + p.id, cfg.GRACE_MS, () => r.removePlayer(p, false));
    const now = Date.now();
    if (r.phase === 'choosing') {
      r.phaseEndsAt = now + o.remainingMs;
      r.setTimer('phase', o.remainingMs, () => r.startDrawing(r.choices[Math.floor(Math.random() * r.choices.length)]));
    } else if (r.phase === 'drawing') {
      r.phaseEndsAt = now + o.remainingMs;
      r.drawStart = now - (r.phaseTotalMs - o.remainingMs);
      r.setTimer('phase', o.remainingMs, () => r.endTurn('time'));
      r.scheduleHints(r.phaseTotalMs - o.remainingMs);
    } else if (r.phase === 'turn_end') {
      r.setTimer('next', 1500, () => r.advance());
    }
    if (r.phase === 'drawing' || r.phase === 'choosing') {
      r.setTimer('drawer', cfg.GRACE_MS, () => {
        const d = r.players.get(r.drawerId);
        if (d && !d.connected) r.endTurn('drawer_left');
      });
    }
    r.checkViability();
    return r;
  }
}
