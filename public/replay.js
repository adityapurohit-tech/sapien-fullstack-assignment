import { W, H, newModel, applyOp, clearCanvas } from './canvas.js';

// Plays back every drawing of the game stroke by stroke, from the timestamped operation log the
// server recorded. Long drawings are sped up so each one takes at most MAX_MS to watch.
const MAX_MS = 14000;

export class Replay {
  constructor(canvas, turns, ui) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.turns = turns;
    this.ui = ui; // { onLabel(text), onPlaying(bool) }
    this.i = 0;
    this.speed = 1;
    this.playing = false;
    this.raf = 0;
    this.load(0);
  }
  load(i) {
    cancelAnimationFrame(this.raf);
    this.i = Math.max(0, Math.min(this.turns.length - 1, i));
    const t = this.turns[this.i];
    this.model = newModel();
    clearCanvas(this.ctx);
    this.events = t.log;
    this.idx = 0;
    const total = this.events.length ? this.events[this.events.length - 1].dt : 0;
    this.scale = total > MAX_MS ? total / MAX_MS : 1;
    this.virtual = 0;
    this.done = false;
    this.ui.onLabel(`Round ${t.round} · ${t.drawerName} drew "${t.word}"  (${this.i + 1} of ${this.turns.length})`);
    if (this.playing) this.start();
  }
  start() {
    this.playing = true;
    this.ui.onPlaying(true);
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    const tick = (now) => {
      this.virtual += (now - this.last) * this.speed * this.scale;
      this.last = now;
      while (this.idx < this.events.length && this.events[this.idx].dt <= this.virtual) {
        applyOp(this.model, this.ctx, this.events[this.idx]);
        this.idx++;
      }
      if (this.idx >= this.events.length) {
        // Finished this drawing: pause briefly, then move to the next one.
        this.done = true;
        setTimeout(() => { if (this.playing && this.done) { if (this.i < this.turns.length - 1) this.load(this.i + 1); else this.pause(); } }, 1400);
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  pause() { this.playing = false; this.ui.onPlaying(false); cancelAnimationFrame(this.raf); }
  toggle() { if (this.playing) this.pause(); else { if (this.done) this.load(this.i); this.playing = true; this.start(); } }
  next() { this.load(this.i + 1); }
  prev() { this.load(this.i - 1); }
  setSpeed(s) { this.speed = s; }
  destroy() { cancelAnimationFrame(this.raf); this.playing = false; }
}
export { W, H };
