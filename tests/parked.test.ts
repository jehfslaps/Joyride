// Run with: npx tsx tests/parked.test.ts
import assert from 'node:assert/strict';
import type { LngLat } from '../src/lib/geo';
import { destinationPoint } from '../src/lib/funroutes';
import { AUTO_STOP_AFTER_MS, fresh, step } from '../src/lib/parkedLogic';

const home: LngLat = [-118.03, 33.97];
const min = 60 * 1000;
const t0 = 1_800_000_000_000;

// Driving: every fix far from the last anchor counts as moving.
let s = fresh();
assert.equal(step(s, home, t0).kind, 'moved');
assert.equal(step(s, destinationPoint(home, 90, 200), t0 + 20_000).kind, 'moved');
// Parked: GPS drift within ~60 m doesn't count as moving.
const spot = destinationPoint(home, 90, 200);
const parkedAt = s.since;
for (let m = 1; m < 15; m++) assert.equal(step(s, destinationPoint(spot, m * 40, 20), t0 + 20_000 + m * min).kind, 'none', `minute ${m}`);
// 15 minutes parked: stop, trimming everything after arriving.
const d = step(s, spot, parkedAt + AUTO_STOP_AFTER_MS);
assert.deepEqual(d, { kind: 'auto-stop', trimAfter: parkedAt });

// Keep recording: no auto-stop during this stop.
s = fresh();
step(s, home, t0);
s.keptAt = t0 + 11 * min;
assert.equal(step(s, home, t0 + 40 * min).kind, 'none');
// …and moving again clears it.
assert.equal(step(s, destinationPoint(home, 0, 500), t0 + 41 * min).kind, 'moved');
assert.equal(s.keptAt, null);

// The phone slept while parked (no fixes), then you drove off: that stop still ended the drive.
s = fresh();
step(s, home, t0);
assert.deepEqual(step(s, destinationPoint(home, 0, 800), t0 + 40 * min), { kind: 'auto-stop', trimAfter: t0 });
// A short stop (a long red light) doesn't.
s = fresh();
step(s, home, t0);
assert.equal(step(s, destinationPoint(home, 0, 800), t0 + 4 * min).kind, 'moved');

console.log('parked: all checks passed');
