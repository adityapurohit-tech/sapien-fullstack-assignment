// The observability section of the design, in miniature: client-measured sync error is the
// headline metric, then command-to-apply latency, corrections, late-join time and control-plane counters.

import { percentile } from '../shared/anchor.js';

const WINDOW_MS = 120_000;
const MAX_SAMPLES = 20_000;

class Series {
  constructor() {
    this.samples = [];
  }
  add(v) {
    this.samples.push([Date.now(), v]);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }
  summary() {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.samples.length && this.samples[0][0] < cutoff) this.samples.shift();
    const vals = this.samples.map((s) => s[1]).sort((a, b) => a - b);
    const r = (x) => (x === null ? null : Math.round(x * 10) / 10);
    return { n: vals.length, p50: r(percentile(vals, 50)), p95: r(percentile(vals, 95)), p99: r(percentile(vals, 99)), max: r(vals.at(-1) ?? null) };
  }
}

export class Metrics {
  constructor() {
    this.series = {
      sync_error_abs_ms: new Series(),
      apply_latency_ms: new Series(),
      join_to_sync_ms: new Series(),
      rtt_ms: new Series(),
      clock_uncertainty_ms: new Series(),
    };
    this.counters = {};
    this.listeners = new Map(); // roomId -> Map(userId -> latest telemetry)
    this.within = { total: 0, ok200: 0, ok100: 0 };
  }

  count(name, by = 1) {
    this.counters[name] = (this.counters[name] || 0) + by;
  }

  telemetry(roomId, userId, name, t) {
    const num = (x) => (Number.isFinite(x) ? x : null);
    const rec = {
      name,
      syncErrMs: num(t.syncErrMs),
      rttMs: num(t.rttMs),
      offsetUncertaintyMs: num(t.offsetUncertaintyMs),
      outputLatencyMs: num(t.outputLatencyMs),
      nudges: num(t.nudges),
      seeks: num(t.seeks),
      simLagMs: num(t.simLagMs),
      state: String(t.state || '').slice(0, 20),
      at: Date.now(),
    };
    if (!this.listeners.has(roomId)) this.listeners.set(roomId, new Map());
    this.listeners.get(roomId).set(userId, rec);
    if (rec.syncErrMs !== null && rec.state === 'playing') {
      const abs = Math.abs(rec.syncErrMs);
      this.series.sync_error_abs_ms.add(abs);
      this.within.total++;
      if (abs <= 200) this.within.ok200++;
      if (abs <= 100) this.within.ok100++;
    }
    if (rec.rttMs !== null) this.series.rtt_ms.add(rec.rttMs);
    if (rec.offsetUncertaintyMs !== null) this.series.clock_uncertainty_ms.add(rec.offsetUncertaintyMs);
    if (num(t.applyLatencyMs) !== null) this.series.apply_latency_ms.add(t.applyLatencyMs);
    if (num(t.joinToSyncMs) !== null) this.series.join_to_sync_ms.add(t.joinToSyncMs);
  }

  forgetListener(roomId, userId) {
    this.listeners.get(roomId)?.delete(userId);
  }

  roomListeners(roomId) {
    const m = this.listeners.get(roomId);
    if (!m) return {};
    const fresh = Date.now() - 10_000;
    return Object.fromEntries([...m].filter(([, v]) => v.at > fresh));
  }

  snapshot() {
    const s = Object.fromEntries(Object.entries(this.series).map(([k, v]) => [k, v.summary()]));
    const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
    return {
      window_s: WINDOW_MS / 1000,
      ...s,
      listeners_within_100ms_pct: pct(this.within.ok100, this.within.total),
      listeners_within_200ms_pct: pct(this.within.ok200, this.within.total),
      counters: this.counters,
    };
  }
}
