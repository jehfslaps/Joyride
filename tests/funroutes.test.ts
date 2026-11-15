// Run with: npx tsx tests/funroutes.test.ts
import assert from 'node:assert/strict';
import { distance, type LngLat } from '../src/lib/geo';
import { dedupe, destinationPoint, detourControlPoints, randomPointInBox, randomPointInRing, sidewaysMeters, type RouteOption } from '../src/lib/funroutes';

const whittier: LngLat = [-118.0328, 33.9792];
const laguna: LngLat = [-117.7831, 33.5427];

// destinationPoint goes the right distance
for (const b of [0, 90, 180, 270, 33]) {
  const p = destinationPoint(whittier, b, 10000);
  assert.ok(Math.abs(distance(whittier, p) - 10000) < 5, `bearing ${b}`);
}

// ring points stay inside the ring
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let i = 0; i < 500; i++) {
  const p = randomPointInRing(whittier, 8000, 32000, rand);
  const d = distance(whittier, p);
  assert.ok(d >= 7990 && d <= 32010, `ring ${d}`);
}

// box points stay inside the box
const box: [number, number, number, number] = [-118.1, 33.4, -117.4, 33.95];
for (let i = 0; i < 200; i++) {
  const [x, y] = randomPointInBox(box, rand);
  assert.ok(x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]);
}

// control points sit off to the side, between the ends
const trip = distance(whittier, laguna);
const ctrl = detourControlPoints(whittier, laguna, 8000, 2, rand);
assert.equal(ctrl.length, 2);
for (const c of ctrl) {
  assert.ok(distance(whittier, c) < trip + 10000);
  assert.ok(distance(laguna, c) < trip + 10000);
}
assert.ok(sidewaysMeters(500, 0.18) >= 1200, 'short trips still detour');

// dedupe: sorted, near-twins and fake-fun routes dropped
const r = (id: string, style: RouteOption['style'], min: number, km: number): RouteOption => ({ id, style, title: id, blurb: '', durationS: min * 60, distanceM: km * 1000, coords: [] });
const out = dedupe([r('s', 'scenic', 52, 40), r('f', 'fastest', 38, 29), r('n', 'neighborhoods', 39, 30), r('s2', 'scenic', 53, 40.5), r('l', 'landmarks', 102, 70)]);
assert.deepEqual(out.map((x) => x.id), ['f', 's', 'l']);

console.log('funroutes: all checks passed');
