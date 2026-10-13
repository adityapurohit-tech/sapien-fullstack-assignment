// A tiny generated catalogue, so the PoC ships no copyrighted audio and needs no downloads.
// Every track is a click track over a chord pad: when two devices are out of sync you *hear* it
// as a doubled click ("flam"), which makes the sync quality obvious in a screen recording.
// Files are named by content hash and served as immutable, as the design does for CDN segments.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RATE = 22050;

const SPECS = [
  { title: 'Morning Grid', artist: 'Clicktrack Ensemble', bpm: 96, seconds: 95, root: 220.0 },
  { title: 'Metro Lines', artist: 'Clicktrack Ensemble', bpm: 120, seconds: 80, root: 196.0 },
  { title: 'Night Shift', artist: 'Phase Locked', bpm: 84, seconds: 110, root: 174.61 },
  { title: 'Tempo Rubato', artist: 'Phase Locked', bpm: 132, seconds: 75, root: 246.94 },
  { title: 'Slow Anchor', artist: 'The Epochs', bpm: 72, seconds: 100, root: 164.81 },
  { title: 'Fencing Token', artist: 'The Epochs', bpm: 108, seconds: 90, root: 207.65 },
  { title: 'Drift Control', artist: 'Lease & Renew', bpm: 100, seconds: 85, root: 185.0 },
  { title: 'Late Joiner', artist: 'Lease & Renew', bpm: 116, seconds: 70, root: 233.08 },
];

// I - vi - IV - V in semitones from the root
const PROGRESSION = [
  [0, 4, 7],
  [-3, 0, 4],
  [-7, -3, 0],
  [-5, -1, 2],
];

function synth({ bpm, seconds, root }) {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  const beatLen = (60 / bpm) * RATE;
  const barLen = beatLen * 4;
  for (let i = 0; i < n; i++) {
    const bar = Math.floor(i / barLen);
    const chord = PROGRESSION[bar % PROGRESSION.length];
    const t = i / RATE;
    // soft pad with a short fade at each bar change
    const inBar = (i % barLen) / RATE;
    const env = Math.min(1, inBar / 0.05) * 0.12;
    let s = 0;
    for (const semi of chord) s += Math.sin(2 * Math.PI * root * Math.pow(2, semi / 12) * t);
    s *= env / chord.length;
    // click on every beat, higher and louder on the downbeat
    const beatPos = i % beatLen;
    if (beatPos < RATE * 0.03) {
      const downbeat = Math.floor(i / beatLen) % 4 === 0;
      const f = downbeat ? 1760 : 1175;
      const e = Math.exp(-beatPos / (RATE * 0.006));
      s += Math.sin(2 * Math.PI * f * (beatPos / RATE)) * e * (downbeat ? 0.7 : 0.45);
    }
    out[i] = Math.max(-1, Math.min(1, s));
  }
  // fade out over the last second
  for (let i = Math.max(0, n - RATE); i < n; i++) out[i] *= (n - i) / RATE;
  return out;
}

function toWav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
  return buf;
}

/** Builds (or reuses) the audio files and returns the catalogue. */
export function buildCatalog(dir) {
  mkdirSync(dir, { recursive: true });
  const existing = new Set(readdirSync(dir));
  return SPECS.map((spec, idx) => {
    const id = `t${idx + 1}`;
    // the hash of the spec stands in for the hash of the audio: same input, same bytes
    const hash = createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
    const file = `${hash}.wav`;
    if (!existing.has(file) || !existsSync(join(dir, file))) writeFileSync(join(dir, file), toWav(synth(spec)));
    return {
      id,
      title: spec.title,
      artist: spec.artist,
      bpm: spec.bpm,
      durationMs: spec.seconds * 1000,
      url: `/media/${file}`,
    };
  });
}

/** Search-as-you-type over the catalogue: prefix match on any word of title or artist. */
export function searchCatalog(catalog, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return catalog;
  return catalog.filter((t) =>
    `${t.title} ${t.artist}`
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.startsWith(needle)) || `${t.title} ${t.artist}`.toLowerCase().includes(needle),
  );
}
