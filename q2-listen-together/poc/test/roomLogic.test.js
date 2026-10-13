import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNewer, positionAt } from '../shared/anchor.js';
import { initialState, reduce, votesNeeded } from '../server/roomLogic.js';

const catalog = [
  { id: 't1', title: 'A', artist: 'x', bpm: 100, durationMs: 60_000, url: '/a' },
  { id: 't2', title: 'B', artist: 'x', bpm: 100, durationMs: 90_000, url: '/b' },
  { id: 't3', title: 'C', artist: 'x', bpm: 100, durationMs: 30_000, url: '/c' },
];
const ctx = { catalog, config: { startLeadMs: 400, resumeLeadMs: 250, maxQueue: 3 } };
const fresh = () => ({ ...initialState({ roomId: 'r', roomName: 'R', hostId: 'host', track: catalog[0] }), epoch: 1, version: 1 });
const host = (type, extra = {}) => ({ type, userId: 'host', cmdId: `${type}-${Math.random()}`, ...extra });

test('position is derived from the anchor, never streamed', () => {
  const s = { track: catalog[0], playing: true, positionMs: 1000, serverTimeMs: 10_000 };
  assert.equal(positionAt(s, 10_000), 1000);
  assert.equal(positionAt(s, 12_500), 3500);
  assert.equal(positionAt(s, 9_600), 600); // before the anchor time: earlier position
  assert.equal(positionAt({ ...s, serverTimeMs: 11_000, positionMs: 0 }, 10_600), -400); // scheduled start in 400 ms
  assert.equal(positionAt(s, 1e9), 60_000); // capped at duration
  assert.equal(positionAt({ ...s, playing: false }, 99_999), 1000);
});

test('play is scheduled with a lead, pause carries the final position computed once on the server', () => {
  let s = reduce(fresh(), host('play'), 10_000, ctx).state;
  assert.equal(s.playing, true);
  assert.equal(s.serverTimeMs, 10_250);
  assert.equal(s.version, 2);
  s = reduce(s, host('pause'), 15_250, ctx).state;
  assert.equal(s.playing, false);
  assert.equal(s.positionMs, 5000);
  assert.equal(s.version, 3);
});

test('pausing before a scheduled start keeps the start position', () => {
  let s = reduce(fresh(), host('seek', { positionMs: 20_000 }), 0, ctx).state;
  s = reduce(s, host('play'), 1000, ctx).state; // starts at 1250
  s = reduce(s, host('pause'), 1100, ctx).state;
  assert.equal(s.positionMs, 20_000);
});

test('only the host can control playback; anyone can enqueue', () => {
  assert.throws(() => reduce(fresh(), { type: 'pause', userId: 'guest', cmdId: 'c1' }, 0, ctx), { code: 'not_host' });
  assert.throws(() => reduce(fresh(), { type: 'play', userId: 'guest', cmdId: 'c2' }, 0, ctx), { code: 'not_host' });
  const s = reduce(fresh(), { type: 'enqueue', trackId: 't3', userId: 'guest', userName: 'G', cmdId: 'c3' }, 0, ctx).state;
  assert.deepEqual(s.queue.map((q) => q.trackId), ['t3']);
});

test('a retried command id is applied exactly once', () => {
  const cmd = { type: 'enqueue', trackId: 't2', userId: 'guest', cmdId: 'same' };
  const a = reduce(fresh(), cmd, 0, ctx);
  const b = reduce(a.state, cmd, 5, ctx);
  assert.equal(b.duplicate, true);
  assert.equal(b.state.queue.length, 1);
  assert.equal(b.state.version, a.state.version);
});

test('skip takes the queue head, starts with a lead and bumps trackSeq; empty queue autoplays', () => {
  let s = reduce(fresh(), { type: 'enqueue', trackId: 't3', userId: 'g', cmdId: 'e' }, 0, ctx).state;
  s = reduce(s, host('skip'), 1000, ctx).state;
  assert.equal(s.track.id, 't3');
  assert.equal(s.trackSeq, 2);
  assert.equal(s.serverTimeMs, 1400);
  assert.equal(s.queue.length, 0);
  s = reduce(s, host('skip'), 2000, ctx).state;
  assert.equal(s.track.id, 't1'); // wraps around the catalogue
});

test('a stale trackEnded timer is ignored', () => {
  let s = reduce(fresh(), host('skip'), 0, ctx).state; // trackSeq 2
  const r = reduce(s, { type: 'trackEnded', trackSeq: 1, system: true }, 10, ctx);
  assert.equal(r.changed, false);
  s = reduce(s, { type: 'trackEnded', trackSeq: 2, system: true }, 10, ctx).state;
  assert.equal(s.trackSeq, 3);
});

test('queue is bounded', () => {
  let s = fresh();
  for (let i = 0; i < 3; i++) s = reduce(s, { type: 'enqueue', trackId: 't2', userId: 'g', cmdId: `q${i}` }, 0, ctx).state;
  assert.throws(() => reduce(s, { type: 'enqueue', trackId: 't2', userId: 'g', cmdId: 'q9' }, 0, ctx), { code: 'queue_full' });
});

test('ordering: epoch first, then version', () => {
  assert.equal(isNewer({ epoch: 2, version: 1 }, { epoch: 1, version: 50 }), true);
  assert.equal(isNewer({ epoch: 1, version: 49 }, { epoch: 1, version: 50 }), false);
  assert.equal(isNewer({ epoch: 1, version: 50 }, { epoch: 1, version: 50 }), false);
});

test('skip needs half of connected listeners', () => {
  assert.equal(votesNeeded(1), 1);
  assert.equal(votesNeeded(2), 1);
  assert.equal(votesNeeded(3), 2);
  assert.equal(votesNeeded(5000), 2500);
});
