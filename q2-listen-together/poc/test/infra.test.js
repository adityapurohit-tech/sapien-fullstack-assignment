import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeaseStore, StateStore } from '../server/infra.js';

test('a lease is exclusive until it expires, and every new holder gets a higher epoch', async () => {
  let now = 0;
  const leases = new LeaseStore(() => now);
  const a = await leases.acquire('room/x', 'A', 5000);
  assert.equal(a.epoch, 1);
  assert.equal(await leases.acquire('room/x', 'B', 5000), null);
  now = 4000;
  assert.equal(await leases.renew('room/x', 'A', 1, 5000), true);
  now = 8500;
  assert.equal(await leases.acquire('room/x', 'B', 5000), null); // renewed until 9000
  now = 9001;
  const b = await leases.acquire('room/x', 'B', 5000);
  assert.equal(b.epoch, 2);
  assert.equal(await leases.renew('room/x', 'A', 1, 5000), false); // the old holder cannot renew
});

test('fenced write: a stale owner cannot overwrite its successor', async () => {
  const store = new StateStore();
  assert.equal((await store.casWrite('r', { epoch: 1, version: 1 })).ok, true);
  assert.equal((await store.casWrite('r', { epoch: 1, version: 2 })).ok, true);
  // new owner takes over with epoch 2
  assert.equal((await store.casWrite('r', { epoch: 2, version: 3 })).ok, true);
  // old owner wakes from a pause and writes what it thinks is the next version
  const stale = await store.casWrite('r', { epoch: 1, version: 4 });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.current, { epoch: 2, version: 3 });
  // a write that skips or repeats a version is rejected too
  assert.equal((await store.casWrite('r', { epoch: 2, version: 3 })).ok, false);
  assert.equal((await store.casWrite('r', { epoch: 2, version: 5 })).ok, false);
  assert.equal(store.stats.rejected, 3);
});
