// Run with: npx tsx tests/streetgraph.test.ts
import assert from 'node:assert/strict';
import { distance, type LngLat } from '../src/lib/geo';
import { destinationPoint } from '../src/lib/funroutes';
import {
  bandAround,
  buildGraph,
  findDips,
  nearestNode,
  pathCoords,
  planRoute,
  quickEdges,
  quickPath,
  estimateS,
  spliceFor,
  streetRuns,
  STYLES,
  withDips,
  type OsmWay,
} from '../src/lib/streetgraph';

let seed = 5;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// A made-up town: x east (m), y north (m), from a corner in Whittier.
const corner: LngLat = [-118.03, 33.97];
const at = (x: number, y: number): LngLat => destinationPoint(destinationPoint(corner, 90, x), 0, y);
let nodeId = 1;
const nodes = new Map<string, number>();
const node = (x: number, y: number) => {
  const k = `${x},${y}`;
  if (!nodes.has(k)) nodes.set(k, nodeId++);
  return nodes.get(k)!;
};
let wayId = 1;
const ways: OsmWay[] = [];
const way = (pts: [number, number][], tags: Record<string, string>) => {
  ways.push({
    id: wayId++,
    nodes: pts.map(([x, y]) => node(x, y)),
    geometry: pts.map(([x, y]) => {
      const c = at(x, y);
      return { lat: c[1], lon: c[0] };
    }),
    tags,
  });
};
const xs = Array.from({ length: 41 }, (_, i) => i * 200); // 0..8000
const ys = Array.from({ length: 9 }, (_, i) => i * 200); // 0..1600
// Main road along y=0 (the quick way), a parallel bigger street at y=1600.
way(xs.map((x) => [x, 0] as [number, number]), { highway: 'primary', name: 'Whittier Boulevard', ref: 'CA 72' });
way(xs.map((x) => [x, 1600] as [number, number]), { highway: 'secondary', name: 'Lambert Road' });
// A connector at x=2000, residential grid elsewhere.
for (const x of xs) {
  if (x === 0 || x === 8000) continue;
  way(ys.map((y) => [x, y] as [number, number]), x === 2000 ? { highway: 'tertiary', name: 'Colima Road' } : { highway: 'residential', name: `North ${x} St` });
}
for (const y of ys) {
  if (y === 0 || y === 1600) continue;
  const row = xs.filter((x) => x > 0 && x < 8000);
  if (y === 400) row.splice(row.indexOf(3200), 0, 3100); // where Elm Court branches off
  way(row.map((x) => [x, y] as [number, number]), { highway: 'residential', name: `${y} Ave` });
}
// A cul-de-sac off 400 Ave, and a one-way street.
way([[3100, 400], [3100, 520], [3100, 640]], { highway: 'residential', name: 'Elm Court' });
way([[5000, 800], [5200, 800]], { highway: 'residential', name: 'One Way Ln', oneway: 'yes' });

const g = buildGraph(ways);
assert.ok(g.edges.length > 500, `graph has edges (${g.edges.length})`);
const quickLine: LngLat[] = xs.map((x) => at(x, 0));
const quick = quickEdges(g, quickLine);
assert.ok(quick.size >= 70 && quick.size <= 90, `quick way edges found (${quick.size})`);

const a = nearestNode(g, at(0, 0))!;
const b = nearestNode(g, at(8000, 0))!;
assert.ok(a != null && b != null);

const used = new Map<number, number>();
const routes: number[][] = [];
for (const style of STYLES) {
  const path = planRoute(g, a, b, style, quick, { noHighways: false, rand, used })!;
  assert.ok(path && path.length, `${style.title}: found a route`);
  for (const e of path) used.set(e, (used.get(e) ?? 0) + 1);
  // Connected, start to end.
  for (let i = 1; i < path.length; i++) assert.equal(g.edges[path[i - 1]].to, g.edges[path[i]].from, 'edges connect');
  assert.equal(g.edges[path[0]].from, a);
  assert.equal(g.edges[path[path.length - 1]].to, b);
  // Off the quick way for most of it.
  const offLen = path.filter((e) => !quick.has(e)).reduce((s, e) => s + g.edges[e].len, 0);
  const allLen = path.reduce((s, e) => s + g.edges[e].len, 0);
  assert.ok(offLen / allLen > 0.6, `${style.title}: mostly off the main road (${Math.round((offLen / allLen) * 100)}%)`);
  // Keeps heading east: never more than a block of going back west.
  const coords = pathCoords(g, path);
  let maxBack = 0;
  let furthest = -Infinity;
  for (const c of coords) {
    const x = distance([corner[0], c[1]], c) * Math.sign(c[0] - corner[0]);
    furthest = Math.max(furthest, x);
    maxBack = Math.max(maxBack, furthest - x);
  }
  assert.ok(maxBack < 260, `${style.title}: no doubling back (${Math.round(maxBack)} m)`);
  // One-ways respected.
  for (const e of path) {
    const ed = g.edges[e];
    if (ed.name === 'One Way Ln') assert.ok(ed.coords[0][0] < ed.coords[ed.coords.length - 1][0], 'one-way driven the right way');
  }
  routes.push(path);
}
// Different styles take different streets.
const sig = (p: number[]) => streetRuns(g, p).map((r) => r.name).join('>');
assert.ok(new Set(routes.map(sig)).size >= 4, 'routes use different combinations of streets');
// Deeper styles use more little streets.
const small = (p: number[]) => streetRuns(g, p).filter((r) => r.cls === 'residential').length;
assert.ok(small(routes[4]) > small(routes[0]), `deeper routes take more little streets (${small(routes[0])} → ${small(routes[4])})`);

// Cul-de-sac: Elm Court is found and driven in and back out.
const viaElm = planRoute(g, nearestNode(g, at(2800, 400))!, nearestNode(g, at(3600, 400))!, STYLES[0], new Set(), { noHighways: false, rand })!;
const dips = findDips(g, viaElm, 1, rand);
assert.equal(dips.length, 1, 'cul-de-sac found');
const full = withDips(viaElm, dips);
for (let i = 1; i < full.length; i++) assert.equal(g.edges[full[i - 1]].to, g.edges[full[i]].from, 'dip connects');
assert.ok(full.some((e) => g.edges[e].name === 'Elm Court'), 'drives Elm Court');

// The band covers both ends and the parallel street.
const band = bandAround(quickLine, 1800);
assert.ok(band.length >= 6);

// Shorter routes: the quick way with side-street stretches, sized to a time budget.
const qp = quickPath(g, a, b, quick, false)!;
assert.ok(qp && qp.every((e) => quick.has(e)), 'quick path follows the quick way');
const qS = estimateS(g, qp);
let lastExtra = 0;
for (const want of [60, 150, 300]) {
  const r = spliceFor(g, qp, want, STYLES[1], quick, { noHighways: false, seed: 42 });
  for (let i = 1; i < r.path.length; i++) assert.equal(g.edges[r.path[i - 1]].to, g.edges[r.path[i]].from, 'spliced route connects');
  assert.equal(g.edges[r.path[0]].from, a);
  assert.equal(g.edges[r.path[r.path.length - 1]].to, b);
  assert.ok(r.stretches.length >= 1, 'has side-street stretches');
  const got = estimateS(g, r.path) - qS;
  assert.ok(Math.abs(got - want) < Math.max(60, want * 0.35), `extra time near ${want} s (got ${Math.round(got)} s)`);
  assert.ok(got > lastExtra, 'bigger budget, more side streets');
  lastExtra = got;
  const onMain = r.path.filter((e) => quick.has(e)).length / r.path.length;
  if (want === 60) assert.ok(onMain > 0.5, `a little detour stays mostly on the main road (${Math.round(onMain * 100)}%)`);
}

console.log('streetgraph: all checks passed');
