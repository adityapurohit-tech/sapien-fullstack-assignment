// The client sync engine from the design doc:
//   1. ClockSync  - NTP-style pings, keep the sample with the smallest round trip.
//   2. SyncPlayer - derive the position from the room anchor, schedule audio on the Web Audio clock,
//                   compensate output latency, and correct drift (ignore / nudge rate / hard seek).
// Transport adds an optional simulated bad network (?lag=300&jitter=80) to show it still holds.

import { positionAt } from '/shared/anchor.js';

export const localNow = () => performance.timeOrigin + performance.now();

const IGNORE_MS = 30; // below this, do nothing
const SEEK_MS = 250; // above this, hard seek; in between, nudge the playback rate
const MAX_RATE_DELTA = 0.02; // at most 2% faster or slower
const CONVERGE_S = 3; // aim to remove an error over ~3 s

export class Transport {
  constructor(url, { lagMs = 0, jitterMs = 0 } = {}, handlers) {
    this.url = url;
    this.lagMs = lagMs;
    this.jitterMs = jitterMs;
    this.h = handlers;
    this.ws = null;
    this.attempt = 0;
    this.closedByUs = false;
  }

  // asymmetric one-way delays (40% up, 60% down) plus exponential jitter; messages can overtake each other
  delay(share) {
    if (!this.lagMs && !this.jitterMs) return 0;
    return this.lagMs * share - Math.log(1 - Math.random()) * this.jitterMs * share;
  }

  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.h.open();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const d = this.delay(0.6);
      d > 0 ? setTimeout(() => this.h.message(msg), d) : this.h.message(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.h.close(ev);
      if (this.closedByUs || ev.code === 4400) return;
      // jittered exponential backoff, so a restarted gateway is not hit by everyone at once
      const base = Math.min(5000, 250 * 2 ** this.attempt++);
      setTimeout(() => this.connect(), base / 2 + Math.random() * (base / 2));
    };
  }

  send(obj) {
    const go = () => this.ws && this.ws.readyState === 1 && this.ws.send(JSON.stringify(obj));
    const d = this.delay(0.4);
    d > 0 ? setTimeout(go, d) : go();
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }
}

export class ClockSync {
  constructor() {
    this.samples = [];
    this.offset = 0; // server clock - local clock, ms
    this.bestRtt = null;
  }

  onPong(c, s) {
    const now = localNow();
    const rtt = now - c;
    // error of this estimate is at most rtt/2 (if the whole trip was spent in one direction)
    this.samples.push({ rtt, offset: s - (c + rtt / 2) });
    if (this.samples.length > 12) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    this.bestRtt = best.rtt;
  }

  get ready() {
    return this.samples.length >= 3;
  }

  get uncertainty() {
    return this.bestRtt === null ? null : this.bestRtt / 2;
  }

  serverNow() {
    return localNow() + this.offset;
  }
}

export class SyncPlayer {
  constructor(clock) {
    this.clock = clock;
    this.ctx = null;
    this.gain = null;
    this.buffers = new Map();
    this.state = null;
    this.src = null; // { node, url, trackSeq, segCtx, segOffset, rate }
    this.status = 'idle';
    this.errMs = null;
    this.nudges = 0;
    this.seeks = 0;
    this.joinedAt = localNow();
    this.joinToSyncMs = null;
    this.joinReported = false;
    this.inNudge = false;
    this.volume = 0.8;
    this.timer = setInterval(() => this.tick(), 200);
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  async enableAudio() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    this.joinedAt = localNow();
    this.tick();
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  get audioEnabled() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  outputLatencyMs() {
    if (!this.ctx) return null;
    return Math.round(((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000);
  }

  setState(state) {
    // join-to-sync is only meaningful for someone who joins a room that is already playing
    if (!this.state) this.joinedWhilePlaying = state.playing;
    this.state = state;
    this.tick();
  }

  load(url) {
    if (!this.buffers.has(url)) {
      const p = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => this.ctx.decodeAudioData(b));
      p.catch(() => this.buffers.delete(url));
      this.buffers.set(url, p);
      if (this.buffers.size > 4) this.buffers.delete(this.buffers.keys().next().value);
    }
    return this.buffers.get(url);
  }

  prefetch(url) {
    if (this.ctx && url) this.load(url).catch(() => {});
  }

  /**
   * Maps "what the speaker is outputting right now" to local wall time.
   * getOutputTimestamp already includes output latency (Bluetooth etc.); otherwise subtract it ourselves.
   */
  outputStamp() {
    const ctx = this.ctx;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime > 0 && ts.performanceTime > 0) return { ct: ts.contextTime, localT: performance.timeOrigin + ts.performanceTime };
    }
    return { ct: ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0), localT: localNow() };
  }

  /** Position (ms) the speaker is producing at context time ct. */
  heardPos(ct) {
    const s = this.src;
    if (!s || ct < s.segCtx) return null;
    return (s.segOffset + (ct - s.segCtx) * s.rate) * 1000;
  }

  /** Position the listener should be hearing now, from the anchor alone. */
  expectedPos() {
    return this.state ? positionAt(this.state, this.clock.serverNow()) : 0;
  }

  /** The position this device is actually producing (for the UI). */
  displayPos() {
    if (this.ctx && this.src) {
      const p = this.heardPos(this.outputStamp().ct);
      if (p !== null) return p;
    }
    return Math.max(0, this.expectedPos());
  }

  stop() {
    if (this.src) {
      try {
        this.src.node.stop();
      } catch {}
      this.src.node.disconnect();
      this.src = null;
    }
    this.inNudge = false;
  }

  async start(buffer, state) {
    this.stop();
    const ctx = this.ctx;
    const { ct, localT } = this.outputStamp();
    const serverAtStamp = localT + this.clock.offset;
    // schedule a little ahead; a sample scheduled at ctx time W is heard at wall time localT + (W - ct)
    let when = ctx.currentTime + 0.06;
    let offsetMs = positionAt(state, serverAtStamp + (when - ct) * 1000);
    if (offsetMs < 0) {
      // scheduled start (skip/seek/resume lead): wait for it, so everyone starts on the same sample
      when += -offsetMs / 1000;
      offsetMs = 0;
    }
    if (offsetMs >= buffer.duration * 1000 - 20) return;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    node.start(when, offsetMs / 1000);
    this.src = { node, url: state.track.url, trackSeq: state.trackSeq, segCtx: when, segOffset: offsetMs / 1000, rate: 1 };
  }

  setRate(rate) {
    const s = this.src;
    const now = this.ctx.currentTime;
    if (now >= s.segCtx) {
      s.segOffset += (now - s.segCtx) * s.rate;
      s.segCtx = now;
    }
    s.rate = rate;
    s.node.playbackRate.setValueAtTime(rate, now);
  }

  async tick() {
    const st = this.state;
    if (!st || !st.track) return;
    if (!this.ctx || this.ctx.state !== 'running') {
      this.status = st.playing ? (positionAt(st, this.clock.serverNow()) < 0 ? 'starting' : 'playing (muted)') : 'paused';
      this.errMs = null;
      return;
    }
    if (!st.playing) {
      this.stop();
      this.status = 'paused';
      this.errMs = null;
      return;
    }
    let buffer;
    const pending = this.load(st.track.url);
    this.status = this.src ? this.status : 'buffering';
    try {
      buffer = await pending;
    } catch {
      this.status = 'error loading audio';
      return;
    }
    if (this.state !== st) return; // a newer state arrived while we awaited

    const s = this.src;
    if (!s || s.trackSeq !== st.trackSeq || s.url !== st.track.url || s.anchorVersion !== `${st.epoch}.${st.serverTimeMs}.${st.positionMs}`) {
      // new track, or the anchor itself moved (seek, resume): (re)schedule from the anchor
      const sameAnchor = s && s.trackSeq === st.trackSeq && Math.abs(this.heardPos(this.outputStamp().ct) - this.expectedPos()) < IGNORE_MS;
      if (!sameAnchor) {
        await this.start(buffer, st);
        if (!this.src) return;
      }
      this.src.anchorVersion = `${st.epoch}.${st.serverTimeMs}.${st.positionMs}`;
    }

    const { ct, localT } = this.outputStamp();
    const heard = this.heardPos(ct);
    const expected = positionAt(st, localT + this.clock.offset);
    if (heard === null || expected < 0) {
      this.status = 'starting';
      this.errMs = null;
      return;
    }
    const err = heard - expected; // > 0: we are ahead of the room
    this.errMs = err;
    this.status = 'playing';
    const abs = Math.abs(err);
    if (abs > SEEK_MS) {
      this.seeks++;
      await this.start(buffer, st);
      if (this.src) this.src.anchorVersion = `${st.epoch}.${st.serverTimeMs}.${st.positionMs}`;
    } else if (abs > IGNORE_MS) {
      if (!this.inNudge) this.nudges++;
      this.inNudge = true;
      const delta = Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, -err / 1000 / CONVERGE_S));
      this.setRate(1 + delta);
    } else if (this.inNudge && abs < 8) {
      this.inNudge = false;
      this.setRate(1);
    }
    if (this.joinToSyncMs === null && this.joinedWhilePlaying && abs <= IGNORE_MS) this.joinToSyncMs = Math.round(localNow() - this.joinedAt);
  }
}
