import assert from 'node:assert/strict';
import { joined, toTrack, totals, type Piece } from '../src/lib/draft';
import { distance, type LngLat } from '../src/lib/geo';

const a: LngLat = [-118.03, 33.97];
const p1: Piece = { coords: [a, [-118.029, 33.97], [-118.028, 33.97]], durationS: 60, kind: 'draw', adjusted: false };
const p2: Piece = { coords: [[-118.028, 33.97], [-118.028, 33.971]], durationS: 30, kind: 'tap', adjusted: false };

const path = joined(a, [p1, p2]);
assert.equal(path.length, 4, 'joins pieces without repeating the shared points');
for (let i = 1; i < path.length; i++) assert.ok(distance(path[i - 1], path[i]) > 0.5);

const sum = totals([p1, p2]);
assert.equal(sum.durationS, 90);
assert.ok(sum.distanceM > 200 && sum.distanceM < 320, `distance ${sum.distanceM}`);

const t0 = 1_700_000_000_000;
const track = toTrack(a, [p1, p2], t0);
assert.equal(track.length, 4);
assert.equal(track[0][2], t0);
for (let i = 1; i < track.length; i++) assert.ok(track[i][2] > track[i - 1][2], 'times always go forward');
assert.ok(Math.abs(track[track.length - 1][2] - (t0 + 90_000)) < 1500, 'ends about when the estimate says');

console.log('draft: all checks passed');
