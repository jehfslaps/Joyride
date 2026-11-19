// Run with: npx tsx tests/funroutes.test.ts
import assert from 'node:assert/strict';
import { cumulative, distance, type LngLat } from '../src/lib/geo';
import {
  dedupe,
  describe,
  destinationPoint,
  highwayBlockPoints,
  isCulDeSac,
  isHighwayStep,
  isOddSpot,
  isQuietStreet,
  LEVELS,
  pickSpots,
  placeAlong,
  pointAlong,
  randomPointInBox,
  randomPointInRing,
  VisitedStreets,
  type Candidate,
  type RouteOption,
} from '../src/lib/funroutes';

const whittier: LngLat = [-118.0328, 33.9792];

let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// destinationPoint goes the right distance
for (const b of [0, 90, 180, 270, 33]) {
  const p = destinationPoint(whittier, b, 10000);
  assert.ok(Math.abs(distance(whittier, p) - 10000) < 5, `bearing ${b}`);
}

// ring and box points stay inside
for (let i = 0; i < 500; i++) {
  const d = distance(whittier, randomPointInRing(whittier, 8000, 32000, rand));
  assert.ok(d >= 7990 && d <= 32010, `ring ${d}`);
}
const box: [number, number, number, number] = [-118.1, 33.4, -117.4, 33.95];
for (let i = 0; i < 200; i++) {
  const [x, y] = randomPointInBox(box, rand);
  assert.ok(x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]);
}

// A straight 10 km route heading east.
const end = destinationPoint(whittier, 90, 10000);
const line: LngLat[] = Array.from({ length: 101 }, (_, i) => [whittier[0] + ((end[0] - whittier[0]) * i) / 100, whittier[1] + ((end[1] - whittier[1]) * i) / 100]);
const cum = cumulative(line);

// pointAlong / placeAlong: left of an eastbound line is north
const mid = pointAlong(line, cum, 5000);
assert.ok(Math.abs(distance(whittier, mid.at) - 5000) < 20);
assert.ok(Math.abs(mid.heading - 90) < 1);
const north = placeAlong(destinationPoint(mid.at, 0, 300), line, cum)!;
const south = placeAlong(destinationPoint(mid.at, 180, 300), line, cum)!;
assert.ok(Math.abs(north.along - 5000) < 30 && Math.abs(north.side - 300) < 15, `north ${JSON.stringify(north)}`);
assert.ok(Math.abs(south.side + 300) < 15, `south ${JSON.stringify(south)}`);

// pickSpots: in order, within reach, zig-zagging, with cul-de-sacs, preferring new streets
const cands: Candidate[] = [];
for (let m = 200; m < 9800; m += 70) {
  for (const side of [-1, 1]) {
    for (const off of [60, 200, 400, 800, 1600]) {
      const { at } = pointAlong(line, cum, m);
      const coord = destinationPoint(at, side > 0 ? 0 : 180, off);
      const kind = off === 400 && m % 490 === 200 ? 'culdesac' : 'street';
      cands.push({ coord, kind, name: '', along: m, side: side * off, isNew: off !== 200 });
    }
  }
}
cands.push({ coord: destinationPoint(mid.at, 0, 150), kind: 'odd', name: 'Hilltop Park', along: 5000, side: 150, isNew: true });
for (const [li, level] of LEVELS.entries()) {
  const spots = pickSpots(cands, 10000, level, rand);
  assert.ok(spots.length >= level.minSpots - 1 && spots.length <= 22, `level ${li} count ${spots.length}`);
  for (let i = 1; i < spots.length; i++) assert.ok(spots[i].along >= spots[i - 1].along, 'in order');
  for (const s of spots) {
    assert.ok(Math.abs(s.side) <= level.reach, 'within reach');
    if (s.kind !== 'odd') assert.ok(Math.abs(s.side) >= 90, 'not on the main road');
  }
  const flips = spots.slice(1).filter((s, i) => Math.sign(s.side) !== Math.sign(spots[i].side)).length;
  assert.ok(flips >= Math.floor((spots.length - 1) * 0.5), `zig-zag level ${li}: ${flips}/${spots.length - 1}`);
  assert.ok(spots.some((s) => s.kind === 'culdesac'), `cul-de-sac at level ${li}`);
}
const big = pickSpots(cands, 10000, LEVELS[4], rand);
assert.ok(big.length > pickSpots(cands, 10000, LEVELS[0], rand).length, 'longer levels pick more');
// New streets are preferred: off=200 streets are "old", so they should be rare at level 1.
let old = 0;
let tot = 0;
for (let i = 0; i < 40; i++) for (const s of pickSpots(cands, 10000, LEVELS[0], rand)) { tot++; if (!s.isNew) old++; }
assert.ok(old / tot < 0.45, `new preferred (${old}/${tot})`);

// Feature filters
assert.ok(isCulDeSac({ layer: 'road', cls: 'turning_circle' }));
assert.ok(isQuietStreet({ layer: 'road', cls: 'street', type: 'residential' }));
assert.ok(!isQuietStreet({ layer: 'road', cls: 'service', type: 'driveway' }));
assert.ok(!isQuietStreet({ layer: 'road', cls: 'street', type: 'parking_aisle' }));
assert.ok(isOddSpot({ layer: 'poi_label', cls: 'park_like', maki: 'park', name: 'Penn Park' }));
assert.ok(!isOddSpot({ layer: 'poi_label', cls: 'food_and_drink', maki: 'fast-food', name: 'Taco Spot' }));

// Highway detection: state routes on surface streets, not freeways
const step = (name: string, ref: string, classes: string[] = []) => ({
  name,
  ref,
  distance: 1200,
  geometry: { coordinates: line.slice(0, 13) },
  intersections: [{ classes }],
});
assert.ok(isHighwayStep(step('East Whittier Boulevard', 'CA 72')));
assert.ok(isHighwayStep(step('Pacific Coast Highway', '')));
assert.ok(!isHighwayStep(step('Pomona Freeway', 'CA 60', ['motorway'])));
assert.ok(!isHighwayStep(step('Greenleaf Avenue', '')));
assert.ok(highwayBlockPoints([step('Beach Boulevard', 'CA 39')]).length >= 3);

// Visited streets
const visited = new VisitedStreets([line.slice(0, 51)]);
assert.ok(visited.has(pointAlong(line, cum, 2000).at));
assert.ok(!visited.has(pointAlong(line, cum, 8000).at));
const share = visited.newShare(line)!;
assert.ok(share > 0.45 && share < 0.55, `new share ${share}`);
assert.equal(new VisitedStreets([]).newShare(line), null);

// Labels
assert.equal(describe(['Sunny Hills', 'La Habra Heights'], 3, ['Hillcrest Park']), 'Through Sunny Hills and La Habra Heights · 3 cul-de-sacs · passes Hillcrest Park');
assert.equal(describe([], 1, []), '1 cul-de-sac');

// dedupe: sorted, near-twins and fake-fun routes dropped
const r = (id: string, style: RouteOption['style'], min: number, km: number): RouteOption => ({
  id, style, level: 1, title: id, blurb: '', durationS: min * 60, distanceM: km * 1000, coords: [],
  via: [], through: [], passes: [], culDeSacs: 0, newShare: null, usesHighway: false,
});
const out = dedupe([r('s', 'weave', 52, 40), r('f', 'fastest', 38, 29), r('n', 'weave', 38.5, 30), r('s2', 'weave', 53, 40.5), r('l', 'weave', 102, 70)]);
assert.deepEqual(out.map((x) => x.id), ['f', 's', 'l']);

console.log('funroutes: all checks passed');
