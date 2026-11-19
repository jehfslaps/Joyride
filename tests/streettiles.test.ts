// Run with: npx tsx tests/streettiles.test.ts
import assert from 'node:assert/strict';
import type { LngLat } from '../src/lib/geo';
import { destinationPoint } from '../src/lib/funroutes';
import { buildGraph, cheapestPath, nearestNode } from '../src/lib/streetgraph';
import { addJunctions, linesToWays } from '../src/lib/streettiles';

const o: LngLat = [-118.03, 33.97];
const at = (x: number, y: number): LngLat => destinationPoint(destinationPoint(o, 90, x), 0, y);
const line = (pts: [number, number][], tags: Record<string, string>, level = 0) => ({ pts: pts.map(([x, y]) => at(x, y)), tags, level });

// An east-west street; a north-south street crossing it with no shared point;
// a bridge over it; and a side street that ends 1 m short of the north-south one.
const lines = [
  line([[0, 0], [1000, 0]], { highway: 'secondary', name: 'Lambert Road' }),
  line([[400, -500], [400, 500]], { highway: 'residential', name: 'Elm St' }),
  line([[700, -500], [700, 500]], { highway: 'primary', name: 'Overpass' }, 1),
  line([[401, 300], [900, 300]], { highway: 'residential', name: 'Oak St' }),
];
addJunctions(lines);
const g = buildGraph(linesToWays(lines));
const find = (x: number, y: number) => nearestNode(g, at(x, y), 20)!;
const cost = (e: number) => g.edges[e].len;

// Lambert → Elm connects at the crossing.
const p1 = cheapestPath(g, find(0, 0), find(400, 500), cost);
assert.ok(p1, 'crossing streets connect');
assert.ok(p1!.reduce((s, e) => s + g.edges[e].len, 0) < 950, 'and the path turns at the crossing');
// The bridge doesn't connect to Lambert.
const p2 = cheapestPath(g, find(0, 0), find(700, 500), cost);
assert.equal(p2, null, 'a bridge is not a junction');
// Oak St (T-junction 1 m away) connects to Elm.
const p3 = cheapestPath(g, find(900, 300), find(400, -500), cost);
assert.ok(p3, 'a T-junction connects');
console.log('streettiles: all checks passed');
