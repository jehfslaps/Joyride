// Street-by-street fun routes. Joyride loads every drivable street in a band
// around the trip (from OpenStreetMap), works out how they connect, and plans
// routes itself: a chain of real connecting streets that keeps heading toward
// the destination, leaves the main road the quick way uses, and swaps in
// parallel streets (Lambert, Leffingwell…) and the connectors between them
// (Colima, Santa Gertrudes, little side streets). Each route picks a
// different combination. Cul-de-sacs hanging off the route are added as
// in-and-out dips on the deeper routes.

import { cumulative, distance, project, thin, type LngLat } from './geo';

// ---- Loading streets ---------------------------------------------------------

export interface OsmWay {
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags: Record<string, string>;
}

const DRIVABLE = 'primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|trunk|trunk_link';
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

/** A band `halfWidthM` wide on each side of a line, as a closed polygon. */
export function bandAround(line: LngLat[], halfWidthM: number): LngLat[] {
  const keep = thin(line, Math.max(300, halfWidthM / 2)).map((i) => line[i]);
  if (keep.length < 2) keep.push(line[line.length - 1]);
  const left: LngLat[] = [];
  const right: LngLat[] = [];
  const kx = (lat: number) => Math.cos((lat * Math.PI) / 180) * 111320;
  const ky = 110540;
  const offset = (p: LngLat, dx: number, dy: number, m: number): LngLat => [p[0] + (dx * m) / kx(p[1]), p[1] + (dy * m) / ky];
  for (let i = 0; i < keep.length; i++) {
    const a = keep[Math.max(0, i - 1)];
    const b = keep[Math.min(keep.length - 1, i + 1)];
    let dx = (b[0] - a[0]) * kx(a[1]);
    let dy = (b[1] - a[1]) * ky;
    const n = Math.hypot(dx, dy) || 1;
    dx /= n;
    dy /= n;
    // Ends get pushed out a little too, so the start and destination sit inside.
    const ext = i === 0 ? -halfWidthM * 0.6 : i === keep.length - 1 ? halfWidthM * 0.6 : 0;
    const p = offset(keep[i], dx, dy, ext);
    left.push(offset(p, -dy, dx, halfWidthM));
    right.push(offset(p, dy, -dx, halfWidthM));
  }
  return [...left, ...right.reverse()];
}

/** Every drivable street inside the polygon, from OpenStreetMap (Overpass). */
export async function fetchStreets(poly: LngLat[], timeoutS = 25): Promise<OsmWay[]> {
  const polyStr = poly.map((p) => `${p[1].toFixed(5)} ${p[0].toFixed(5)}`).join(' ');
  const query = `[out:json][timeout:${timeoutS}];way["highway"~"^(${DRIVABLE})$"]["access"!~"^(private|no)$"]["area"!="yes"](poly:"${polyStr}");out geom;`;
  let lastError: unknown = null;
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Joyride/1.0 (https://github.com/jehfslaps/Joyride)' },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const body = await res.json();
      const ways = (body?.elements ?? []).filter((e: any) => e.type === 'way' && e.geometry?.length === e.nodes?.length);
      if (ways.length) return ways as OsmWay[];
      throw new Error('Overpass returned no streets');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not load streets');
}

// ---- The street network -------------------------------------------------------------

export type StreetClass = 'primary' | 'secondary' | 'tertiary' | 'unclassified' | 'residential' | 'living_street' | 'trunk' | 'link';

export interface Edge {
  from: number;
  to: number;
  coords: LngLat[];
  len: number;
  cls: StreetClass;
  name: string;
  /** A numbered state or US route on a surface street (CA 72 Whittier Blvd, CA 39 Beach Blvd). */
  highway: boolean;
  wayId: number;
}

export interface Graph {
  coords: LngLat[];
  /** Outgoing edge indices for each node. */
  out: number[][];
  edges: Edge[];
  /** How many streets meet at each node (ignoring direction). 1 = a dead end. */
  degree: number[];
}

function classOf(highway: string): StreetClass {
  if (highway.endsWith('_link')) return 'link';
  return (['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'trunk'].includes(highway) ? highway : 'residential') as StreetClass;
}

/** Turns OSM ways into a routable network: split at every shared node, one-ways respected. */
export function buildGraph(ways: OsmWay[]): Graph {
  const uses = new Map<number, number>();
  for (const w of ways) w.nodes.forEach((n, i) => uses.set(n, (uses.get(n) ?? 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
  const index = new Map<number, number>();
  const coords: LngLat[] = [];
  const out: number[][] = [];
  const nbrs: Set<number>[] = [];
  const nodeOf = (id: number, c: LngLat) => {
    let i = index.get(id);
    if (i === undefined) {
      i = coords.length;
      index.set(id, i);
      coords.push(c);
      out.push([]);
      nbrs.push(new Set());
    }
    return i;
  };
  const edges: Edge[] = [];
  for (const w of ways) {
    const t = w.tags ?? {};
    const cls = classOf(t.highway ?? 'residential');
    const name = t.name ?? t.ref ?? '';
    const highway = /\b(CA|US|SR)[\s-]?\d+/i.test(t.ref ?? '') && cls !== 'link';
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' ? 1 : t.oneway === '-1' ? -1 : 0;
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (i < w.nodes.length - 1 && (uses.get(w.nodes[i]) ?? 0) < 2) continue;
      const piece: LngLat[] = w.geometry.slice(start, i + 1).map((g) => [g.lon, g.lat]);
      const a = nodeOf(w.nodes[start], piece[0]);
      const b = nodeOf(w.nodes[i], piece[piece.length - 1]);
      if (a !== b) {
        const len = cumulative(piece)[piece.length - 1];
        nbrs[a].add(b);
        nbrs[b].add(a);
        if (oneway >= 0) {
          out[a].push(edges.length);
          edges.push({ from: a, to: b, coords: piece, len, cls, name, highway, wayId: w.id });
        }
        if (oneway <= 0) {
          out[b].push(edges.length);
          edges.push({ from: b, to: a, coords: [...piece].reverse(), len, cls, name, highway, wayId: w.id });
        }
      }
      start = i;
    }
  }
  return { coords, out, edges, degree: nbrs.map((s) => s.size) };
}

/** The node nearest a point that has a way out (and in), within `maxM`. */
export function nearestNode(g: Graph, p: LngLat, maxM = 400): number | null {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < g.coords.length; i++) {
    if (!g.out[i].length) continue;
    const d = distance(g.coords[i], p);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best >= 0 && bd <= maxM ? best : null;
}

// ---- Planning a route ----------------------------------------------------------------

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k;
    const v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Cheapest path from `a` to `b` (edge indices), where `cost(e)` is each edge's price. */
export function cheapestPath(g: Graph, a: number, b: number, cost: (e: number) => number): number[] | null {
  const dist = new Float64Array(g.coords.length).fill(Infinity);
  const via = new Int32Array(g.coords.length).fill(-1);
  dist[a] = 0;
  const heap = new Heap();
  heap.push(0, a);
  while (heap.size) {
    const [d, n] = heap.pop();
    if (d > dist[n]) continue;
    if (n === b) break;
    for (const e of g.out[n]) {
      const nd = d + cost(e);
      const to = g.edges[e].to;
      if (nd < dist[to]) {
        dist[to] = nd;
        via[to] = e;
        heap.push(nd, to);
      }
    }
  }
  if (via[b] < 0 && a !== b) return null;
  const path: number[] = [];
  for (let n = b; n !== a; n = g.edges[via[n]].from) path.push(via[n]);
  return path.reverse();
}

export interface Style {
  /** Extra price on the streets the quick way uses (×), to make the route find parallel ones. */
  offQuick: number;
  /** Price per class (×). Lower on small streets for the more granular routes. */
  cls: Record<StreetClass, number>;
  /** How much each street's price is randomly nudged, so routes hop between streets differently. */
  noise: number;
  /** Price for moving away from the destination (per meter lost). */
  backtrack: number;
  /** Cul-de-sac dips to add. */
  culDeSacs: number;
  title: string;
}

export const STYLES: Style[] = [
  {
    title: 'A few side streets',
    offQuick: 2.2,
    cls: { primary: 1, secondary: 1, tertiary: 1.05, unclassified: 1.15, residential: 1.35, living_street: 1.6, trunk: 1.3, link: 1.2 },
    noise: 0.15,
    backtrack: 4,
    culDeSacs: 1,
  },
  {
    title: 'Parallel streets',
    offQuick: 3,
    cls: { primary: 1.05, secondary: 1, tertiary: 1, unclassified: 1.05, residential: 1.12, living_street: 1.3, trunk: 1.5, link: 1.3 },
    noise: 0.25,
    backtrack: 3.5,
    culDeSacs: 2,
  },
  {
    title: 'Neighborhood staircase',
    offQuick: 4,
    cls: { primary: 1.3, secondary: 1.15, tertiary: 1, unclassified: 0.95, residential: 0.95, living_street: 1.05, trunk: 2, link: 1.5 },
    noise: 0.35,
    backtrack: 3,
    culDeSacs: 3,
  },
  {
    title: 'Little streets',
    offQuick: 5,
    cls: { primary: 1.7, secondary: 1.4, tertiary: 1.12, unclassified: 0.9, residential: 0.85, living_street: 0.95, trunk: 2.5, link: 1.8 },
    noise: 0.45,
    backtrack: 2.6,
    culDeSacs: 5,
  },
  {
    title: 'Every nook',
    offQuick: 6,
    cls: { primary: 2.2, secondary: 1.7, tertiary: 1.3, unclassified: 0.85, residential: 0.78, living_street: 0.85, trunk: 3, link: 2 },
    noise: 0.55,
    backtrack: 2.2,
    culDeSacs: 8,
  },
];

export interface PlanOptions {
  noHighways: boolean;
  rand: () => number;
  /** Edges used by routes already planned (to make this one different), with how many times. */
  used?: Map<number, number>;
}

/** Edges that lie along the quick way (so the fun route treats them as the road to get off). */
export function quickEdges(g: Graph, quick: LngLat[]): Set<number> {
  const out = new Set<number>();
  if (quick.length < 2) return out;
  // Fast prefilter: a grid of the quick way's points.
  const cell = (p: LngLat) => `${Math.round(p[0] * 2000)}:${Math.round(p[1] * 2000)}`;
  const grid = new Set<string>();
  const dense = thin(quick, 20).map((i) => quick[i]);
  for (const p of dense) {
    const [x, y] = cell(p).split(':').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) grid.add(`${x + dx}:${y + dy}`);
  }
  g.edges.forEach((e, i) => {
    const mid = e.coords[Math.floor(e.coords.length / 2)];
    if (!grid.has(cell(mid))) return;
    const a = project(e.coords[0], quick)?.offset ?? 1e9;
    const b = project(e.coords[e.coords.length - 1], quick)?.offset ?? 1e9;
    const m = project(mid, quick)?.offset ?? 1e9;
    if (a < 30 && b < 30 && m < 30) out.add(i);
  });
  return out;
}

/** Plans one route from node `a` to node `b` in the given style. */
export function planRoute(g: Graph, a: number, b: number, style: Style, quick: Set<number>, opts: PlanOptions): number[] | null {
  const dest = g.coords[b];
  const toDest = g.coords.map((c) => distance(c, dest));
  const streetNoise = new Map<string, number>();
  const nudge = (name: string) => {
    let v = streetNoise.get(name);
    if (v === undefined) {
      v = 1 + (opts.rand() * 2 - 1) * style.noise;
      streetNoise.set(name, v);
    }
    return v;
  };
  const cost = (i: number) => {
    const e = g.edges[i];
    let c = e.len * style.cls[e.cls] * nudge(e.name || `#${e.wayId}`);
    if (quick.has(i)) c *= style.offQuick;
    if (opts.noHighways && e.highway) c *= 25;
    const lost = toDest[e.to] - toDest[e.from];
    if (lost > 0) c += lost * style.backtrack;
    const reused = opts.used?.get(i) ?? 0;
    if (reused) c *= 1 + 0.9 * reused;
    return c + 4; // a little for every intersection crossed
  };
  return cheapestPath(g, a, b, cost);
}

// ---- Cul-de-sacs ------------------------------------------------------------------------

export interface Dip {
  /** Index in the path after which the dip happens. */
  after: number;
  /** Edges into the cul-de-sac and back out. */
  edges: number[];
  tip: LngLat;
}

/**
 * Dead-end residential streets (cul-de-sacs, courts) branching off the path:
 * up to `count` of them, spread along the route, each driven in and back out.
 */
export function findDips(g: Graph, path: number[], count: number, rand: () => number): Dip[] {
  if (count <= 0) return [];
  const options: Dip[] = [];
  const onPath = new Set(path.map((e) => g.edges[e].to));
  path.forEach((pe, k) => {
    const at = g.edges[pe].to;
    for (const e of g.out[at]) {
      const first = g.edges[e];
      if (onPath.has(first.to) || (first.cls !== 'residential' && first.cls !== 'living_street' && first.cls !== 'unclassified')) continue;
      // Follow the street while nothing branches off, until it ends.
      const chain = [e];
      let node = first.to;
      let len = first.len;
      let prev = at;
      while (g.degree[node] === 2 && len < 320) {
        const next = g.out[node].find((x) => g.edges[x].to !== prev);
        if (next === undefined) break;
        chain.push(next);
        len += g.edges[next].len;
        prev = node;
        node = g.edges[next].to;
      }
      if (g.degree[node] !== 1 || len < 50 || len > 320) continue;
      // The way back out: the same edges reversed (two-way streets only).
      const back: number[] = [];
      for (let i = chain.length - 1; i >= 0; i--) {
        const ce = g.edges[chain[i]];
        const rev = g.out[ce.to].find((x) => g.edges[x].to === ce.from && g.edges[x].wayId === ce.wayId);
        if (rev === undefined) break;
        back.push(rev);
      }
      if (back.length !== chain.length) continue;
      options.push({ after: k, edges: [...chain, ...back], tip: g.coords[node] });
    }
  });
  if (!options.length) return [];
  // Spread them out along the route.
  const step = Math.max(1, Math.floor(path.length / (count + 1)));
  const out: Dip[] = [];
  for (let n = 1; n <= count; n++) {
    const target = n * step;
    // The options nearest this point along the route, picking among the closest few.
    const near = options
      .filter((o) => Math.abs(o.after - target) <= step && !out.includes(o) && !out.some((x) => Math.abs(x.after - o.after) < 3))
      .sort((x, y) => Math.abs(x.after - target) - Math.abs(y.after - target))
      .slice(0, 3);
    if (near.length) out.push(near[Math.floor(rand() * near.length)]);
  }
  return out.sort((x, y) => x.after - y.after);
}

/** The full sequence of edges, with the dips spliced in. */
export function withDips(path: number[], dips: Dip[]): number[] {
  const out: number[] = [];
  let d = 0;
  path.forEach((e, k) => {
    out.push(e);
    while (d < dips.length && dips[d].after === k) out.push(...dips[d++].edges);
  });
  return out;
}

export function pathCoords(g: Graph, path: number[]): LngLat[] {
  const out: LngLat[] = [];
  for (const e of path) {
    const c = g.edges[e].coords;
    out.push(...(out.length ? c.slice(1) : c));
  }
  return out;
}

/** The named streets a path uses, in order, with how far it drives on each run. */
export function streetRuns(g: Graph, path: number[]): { name: string; cls: StreetClass; len: number }[] {
  const runs: { name: string; cls: StreetClass; len: number }[] = [];
  for (const e of path) {
    const { name, cls, len } = g.edges[e];
    const last = runs[runs.length - 1];
    if (last && last.name === name) last.len += len;
    else runs.push({ name, cls, len });
  }
  return runs;
}

// ---- Shorter routes: the quick way, with side-street stretches -------------------------

/** The quick way as a path through the street graph (sticks to the quick way's streets). */
export function quickPath(g: Graph, a: number, b: number, quick: Set<number>, noHighways: boolean): number[] | null {
  return cheapestPath(g, a, b, (i) => {
    const e = g.edges[i];
    let c = e.len * (quick.has(i) ? 1 : 2.5);
    if (noHighways && e.highway) c *= 25;
    return c + 1;
  });
}

/** Rough speeds (m/s) per street class, for comparing routes before asking Mapbox. */
const SPEED: Record<StreetClass, number> = {
  trunk: 15, primary: 12.5, secondary: 11.5, tertiary: 10.5, unclassified: 9, residential: 8, living_street: 5.5, link: 10,
};

/** A rough drive time for a path, in seconds: street speeds plus a little for each turn. */
export function estimateS(g: Graph, path: number[]): number {
  let s = 0;
  let last = '';
  for (const i of path) {
    const e = g.edges[i];
    s += e.len / SPEED[e.cls];
    const name = e.name || `#${e.wayId}`;
    if (name !== last) s += 7;
    last = name;
  }
  return s;
}

/** A small random number generator with its own seed, so the same seed plans the same streets. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Spliced {
  path: number[];
  /** Where each side-street stretch sits in `path` (edge index range, end exclusive). */
  stretches: { from: number; to: number }[];
}

/**
 * The quick way with `share` of its length (0–1) swapped for side streets,
 * in a few stretches spread along the trip. `shift` (0–1) moves the stretches
 * a little, so variants differ.
 */
export function splice(
  g: Graph,
  qpath: number[],
  share: number,
  style: Style,
  quick: Set<number>,
  opts: { noHighways: boolean; seed: number; shift?: number; used?: Map<number, number> },
): Spliced {
  const cum: number[] = [0];
  for (const e of qpath) cum.push(cum[cum.length - 1] + g.edges[e].len);
  const total = cum[cum.length - 1];
  const funM = total * Math.min(0.95, Math.max(0, share));
  const n = Math.max(1, Math.min(5, Math.ceil(funM / 3500)));
  const each = funM / n;
  const at = (m: number) => {
    let i = 0;
    while (i < qpath.length && cum[i + 1] <= m) i++;
    return Math.min(i, qpath.length);
  };
  const shift = ((opts.shift ?? 0.5) - 0.5) * 0.5;
  const windows: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const mid = ((k + 0.5 + shift) / n) * total;
    const s = at(Math.max(0, mid - each / 2));
    const t = at(Math.min(total, mid + each / 2));
    if (t - s < 2) continue;
    if (windows.length && s <= windows[windows.length - 1][1]) continue;
    windows.push([s, t]);
  }
  const rand = seeded(opts.seed);
  const out: number[] = [];
  const stretches: { from: number; to: number }[] = [];
  let pos = 0;
  for (const [s, t] of windows) {
    out.push(...qpath.slice(pos, s));
    const u = s === 0 ? g.edges[qpath[0]].from : g.edges[qpath[s - 1]].to;
    const v = g.edges[qpath[t - 1]].to;
    const piece = planRoute(g, u, v, style, quick, { noHighways: opts.noHighways, rand, used: opts.used });
    if (piece && piece.length) {
      stretches.push({ from: out.length, to: out.length + piece.length });
      out.push(...piece);
    } else {
      out.push(...qpath.slice(s, t));
    }
    pos = t;
  }
  out.push(...qpath.slice(pos));
  return { path: out, stretches };
}

/**
 * The spliced route whose rough drive time is closest to `extraS` seconds more
 * than the quick way's (found by trying more or less side street).
 */
export function spliceFor(
  g: Graph,
  qpath: number[],
  extraS: number,
  style: Style,
  quick: Set<number>,
  opts: { noHighways: boolean; seed: number; shift?: number; used?: Map<number, number> },
): Spliced & { extraS: number } {
  const base = estimateS(g, qpath);
  let lo = 0.04;
  let hi = 0.95;
  let best: (Spliced & { extraS: number }) | null = null;
  for (let it = 0; it < 6; it++) {
    const share = (lo + hi) / 2;
    const r = splice(g, qpath, share, style, quick, opts);
    const extra = estimateS(g, r.path) - base;
    if (!best || Math.abs(extra - extraS) < Math.abs(best.extraS - extraS)) best = { ...r, extraS: extra };
    if (Math.abs(extra - extraS) < extraS * 0.08) break;
    if (extra < extraS) lo = share;
    else hi = share;
  }
  return best!;
}
