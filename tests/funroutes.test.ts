// Run with: npx tsx tests/funroutes.test.ts
import assert from 'node:assert/strict';
import { cumulative, distance, type LngLat } from '../src/lib/geo';
import {
  dedupe,
  describe,
  destinationPoint,
  highwayBlockPoints,
  isCulDeSac,
  isMainStreet,
  isHighwayStep,
  isOddSpot,
  isQuietStreet,
  LEVELS,
  pickSpots,
  pickWithinTime,
  placeAlong,
  straightStretches,
  stubSpots,
  swingAt,
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

// pickSpots: in order, zigzagging across the quick way, main streets at the peaks, cul-de-sacs, new streets first
const cands: Candidate[] = [];
for (let m = 100; m < 9900; m += 60) {
  for (const side of [-1, 1]) {
    for (const off of [60, 200, 300, 450, 650, 900, 1150, 1400, 1700]) {
      const { at } = pointAlong(line, cum, m);
      const coord = destinationPoint(at, side > 0 ? 0 : 180, off);
      const kind = off === 300 && m % 480 === 100 ? 'culdesac' : off >= 650 && m % 300 === 100 ? 'main' : 'street';
      cands.push({ coord, kind, name: '', along: m, side: side * off, isNew: off !== 200 });
    }
  }
}
cands.push({ coord: destinationPoint(mid.at, 0, 150), kind: 'odd', name: 'Hilltop Park', along: 5000, side: 150, isNew: true });
for (const [li, level] of LEVELS.entries()) {
  const spots = pickSpots(cands, 10000, level, rand);
  assert.ok(spots.length >= (9400 / level.spacing) * 0.6, `level ${li} count ${spots.length}`);
  for (let i = 1; i < spots.length; i++) assert.ok(spots[i].along >= spots[i - 1].along, 'in order');
  for (const sp of spots) if (sp.kind !== 'odd') assert.ok(Math.abs(sp.side) >= 90, 'not on the main road');
  // It really swings: crosses the quick way several times and reaches out near the full amplitude on both sides.
  const crossings = spots.slice(1).filter((sp, i) => Math.sign(sp.side) !== Math.sign(spots[i].side)).length;
  assert.ok(crossings >= Math.floor((9400 / level.wavelength) * 2 * 0.6), `level ${li} zigzags (${crossings} crossings)`);
  assert.ok(Math.max(...spots.map((sp) => sp.side)) > level.amplitude * 0.7, `level ${li} reaches left`);
  assert.ok(Math.min(...spots.map((sp) => sp.side)) < -level.amplitude * 0.7, `level ${li} reaches right`);
  assert.ok(spots.some((sp) => sp.kind === 'main'), `level ${li} comes out on other main streets`);
  assert.ok(spots.some((sp) => sp.kind === 'culdesac'), `level ${li} cul-de-sac`);
}
assert.ok(pickSpots(cands, 10000, LEVELS[4], rand).length > pickSpots(cands, 10000, LEVELS[0], rand).length * 1.6, 'deeper levels pick more');
let old = 0;
let tot = 0;
for (let i = 0; i < 30; i++) for (const sp of pickSpots(cands, 10000, LEVELS[1], rand)) { tot++; if (!sp.isNew) old++; }
assert.ok(old / tot < 0.25, `new streets preferred (${old}/${tot})`);

// swingAt: starts and ends on the quick way
assert.equal(swingAt(0, 10000, LEVELS[2], 0.25), 0);
assert.equal(swingAt(10000, 10000, LEVELS[2], 0.25), 0);

// straightStretches: a 2 km step gets side-street points, short ones don't
const longStep = { name: 'Colima Road', distance: 2000, geometry: { coordinates: line.slice(30, 51) } };
const shortStep = { name: 'Elm', distance: 300, geometry: { coordinates: line.slice(51, 54) } };
const gaps = straightStretches([{ name: 'start', distance: 3000, geometry: { coordinates: line.slice(0, 31) } }, longStep, shortStep], 500, 10000);
assert.ok(gaps.length >= 3, `straight stretches found (${gaps.length})`);
assert.equal(straightStretches([shortStep], 500, 10000).length, 0);

// Stubs: a route that pokes 200 m up a side street and comes straight back
const pokeAt = pointAlong(line, cum, 5000).at;
const tip = destinationPoint(pokeAt, 0, 200);
const poke: LngLat[] = [...line.slice(0, 51), destinationPoint(pokeAt, 0, 100), tip, destinationPoint(pokeAt, 0, 100), ...line.slice(50)];
assert.deepEqual([...stubSpots(poke, [{ coord: tip, kind: 'street', name: '' }])], [0]);
assert.deepEqual([...stubSpots(line, [{ coord: pokeAt, kind: 'street', name: '' }])], []);
assert.deepEqual([...stubSpots(poke, [{ coord: tip, kind: 'culdesac', name: '' }])], [], 'cul-de-sacs are meant to turn around');

// Feature filters
assert.ok(isCulDeSac({ layer: 'road', cls: 'turning_circle' }));
assert.ok(isMainStreet({ layer: 'road', cls: 'secondary', type: 'secondary' }));
assert.ok(!isMainStreet({ layer: 'road', cls: 'secondary', type: 'secondary_link' }));
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
  via: [], through: [], passes: [], culDeSacs: 0, newShare: null, usesHighway: false, highwayM: 0,
});
const out = dedupe([r('s', 'weave', 52, 40), r('f', 'fastest', 38, 29), r('n', 'weave', 38.5, 30), r('s2', 'weave', 53, 40.5), r('l', 'weave', 102, 70)]);
assert.deepEqual(out.map((x) => x.id), ['f', 's', 'l']);

// pickWithinTime: only spots under the limit, else the quickest flagged as too far
const spotsT: LngLat[] = [[0, 0], [1, 1], [2, 2], [3, 3]];
const timesT = [90 * 60, 40 * 60, null, 25 * 60];
for (let i = 0; i < 20; i++) {
  const got = pickWithinTime(spotsT, timesT, 45 * 60, rand)!;
  assert.ok(got.fits && got.durationS <= 45 * 60);
}
assert.deepEqual(pickWithinTime(spotsT, timesT, 20 * 60), { spot: [3, 3], durationS: 25 * 60, fits: false });
assert.equal(pickWithinTime(spotsT, [null, null, null, null], 60), null);

console.log('funroutes: all checks passed');
