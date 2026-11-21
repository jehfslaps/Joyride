// Loads the street map for street-by-street routing from Mapbox's vector
// tiles (the mapbox-streets-v8 "road" layer at zoom 14), and works out where
// streets connect. Tiles store street lines, not junctions, so junctions are
// found from shared points, crossings and T-junctions (bridges and tunnels
// don't connect to the streets they pass over or under).
//
// The result is shaped like OpenStreetMap ways so buildGraph() can use it.

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { MAPBOX_TOKEN } from '../config';
import { project, type LngLat } from './geo';
import type { OsmWay } from './streetgraph';

const Z = 14;

const CLASS_TO_HIGHWAY: Record<string, string> = {
  trunk: 'trunk',
  trunk_link: 'trunk_link',
  primary: 'primary',
  primary_link: 'primary_link',
  secondary: 'secondary',
  secondary_link: 'secondary_link',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary_link',
  street: 'residential',
  street_limited: 'living_street',
};

function lngLatOfTile(x: number, y: number, z: number): LngLat {
  const n = Math.pow(2, z);
  const lng = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lng, lat];
}

function tileOf(p: LngLat, z: number): [number, number] {
  const n = Math.pow(2, z);
  const x = Math.floor(((p[0] + 180) / 360) * n);
  const r = (p[1] * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [x, y];
}

/** Zoom-14 tiles that lie within `halfWidthM` of the line. */
export function tilesAlong(line: LngLat[], halfWidthM: number): [number, number][] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of line) {
    const [x, y] = tileOf(p, Z);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const pad = Math.ceil(halfWidthM / 2000) + 1;
  const out: [number, number][] = [];
  for (let x = minX - pad; x <= maxX + pad; x++) {
    for (let y = minY - pad; y <= maxY + pad; y++) {
      const a = lngLatOfTile(x, y, Z);
      const b = lngLatOfTile(x + 1, y + 1, Z);
      const center: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const off = project(center, line)?.offset ?? Infinity;
      // Tile half-diagonal at this zoom is about 1.5 km around here.
      if (off <= halfWidthM + 1700) out.push([x, y]);
    }
  }
  return out;
}

interface Line {
  pts: LngLat[];
  tags: Record<string, string>;
  level: number; // 1 bridge, -1 tunnel, 0 ground
}

/** Clips a polyline (tile pixel coordinates) to the tile square, returning the pieces inside. */
function clipToTile(pts: { x: number; y: number }[], extent: number): { x: number; y: number }[][] {
  const pieces: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  const inside = (p: { x: number; y: number }) => p.x >= 0 && p.x <= extent && p.y >= 0 && p.y <= extent;
  const clipSeg = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    // Liang–Barsky
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const checks: [number, number][] = [
      [-dx, a.x],
      [dx, extent - a.x],
      [-dy, a.y],
      [dy, extent - a.y],
    ];
    for (const [p, q] of checks) {
      if (p === 0) {
        if (q < 0) return null;
      } else {
        const t = q / p;
        if (p < 0) {
          if (t > t1) return null;
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return null;
          if (t < t1) t1 = t;
        }
      }
    }
    return [
      { x: a.x + dx * t0, y: a.y + dy * t0 },
      { x: a.x + dx * t1, y: a.y + dy * t1 },
    ] as const;
  };
  for (let i = 1; i < pts.length; i++) {
    const seg = clipSeg(pts[i - 1], pts[i]);
    if (!seg) {
      if (cur.length > 1) pieces.push(cur);
      cur = [];
      continue;
    }
    if (!cur.length) cur.push(seg[0]);
    cur.push(seg[1]);
    if (!inside(pts[i])) {
      if (cur.length > 1) pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
}

/** Fetches a tile, trying again (up to 3 times) when the phone's connection hiccups or Mapbox says "slow down". */
async function fetchTile(url: string): Promise<Response> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404 || (res.status < 500 && res.status !== 429)) return res;
      last = new Error(`Street tile ${res.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  throw last;
}

async function loadTile(x: number, y: number): Promise<Line[]> {
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/${Z}/${x}/${y}.vector.pbf?access_token=${MAPBOX_TOKEN}`;
  const res = await fetchTile(url);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Street tile ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const tile = new VectorTile(new Pbf(buf));
  const layer = tile.layers.road;
  if (!layer) return [];
  const out: Line[] = [];
  const [w, n] = lngLatOfTile(x, y, Z);
  const [e, s] = lngLatOfTile(x + 1, y + 1, Z);
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2) continue;
    const props = f.properties as Record<string, any>;
    const highway = CLASS_TO_HIGHWAY[props.class];
    if (!highway) continue;
    const extent = f.extent;
    const level = props.structure === 'bridge' ? 1 : props.structure === 'tunnel' ? -1 : 0;
    const tags: Record<string, string> = { highway };
    if (props.name) tags.name = String(props.name);
    if (props.ref) tags.ref = String(props.ref);
    if (props.oneway === 'true' || props.oneway === true) tags.oneway = 'yes';
    for (const ring of f.loadGeometry()) {
      for (const piece of clipToTile(ring, extent)) {
        // Pixel → lng/lat (latitude via Web Mercator).
        const pts: LngLat[] = piece.map((p) => {
          const lng = w + (p.x / extent) * (e - w);
          const yMerc = (y + p.y / extent) / Math.pow(2, Z);
          const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * yMerc))) * 180) / Math.PI;
          return [lng, lat];
        });
        void n;
        void s;
        if (pts.length > 1) out.push({ pts, tags, level });
      }
    }
  }
  return out;
}

// ---- Finding junctions ----------------------------------------------------------------

const SNAP_M = 1.5;
const T_SNAP_M = 3;

/** Grid key for snapping points closer than ~1.5 m together. */
function keyOf(p: LngLat): string {
  const ky = 110540;
  const kx = Math.cos((p[1] * Math.PI) / 180) * 111320;
  return `${Math.round((p[0] * kx) / SNAP_M)}:${Math.round((p[1] * ky) / SNAP_M)}`;
}

function meters(p: LngLat, lat0: number): [number, number] {
  return [p[0] * Math.cos((lat0 * Math.PI) / 180) * 111320, p[1] * 110540];
}

/**
 * Inserts a vertex wherever two ground-level street lines cross, and where a
 * line's end touches the middle of another (a T-junction), so they share a
 * point and buildGraph() treats it as a junction.
 */
export function addJunctions(lines: Line[]): void {
  if (!lines.length) return;
  const lat0 = lines[0].pts[0][1];
  const CELL = 60;
  type Seg = { li: number; si: number };
  const grid = new Map<string, Seg[]>();
  const cellsOf = (a: [number, number], b: [number, number]) => {
    const out: string[] = [];
    const x0 = Math.floor(Math.min(a[0], b[0]) / CELL);
    const x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    const y0 = Math.floor(Math.min(a[1], b[1]) / CELL);
    const y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x}:${y}`);
    return out;
  };
  const m = lines.map((l) => l.pts.map((p) => meters(p, lat0)));
  lines.forEach((l, li) => {
    for (let si = 1; si < l.pts.length; si++) {
      for (const c of cellsOf(m[li][si - 1], m[li][si])) {
        let list = grid.get(c);
        if (!list) grid.set(c, (list = []));
        list.push({ li, si });
      }
    }
  });
  // Points to insert: line index → list of [segment index, t, point].
  const inserts = new Map<number, [number, number, LngLat][]>();
  const addInsert = (li: number, si: number, t: number, p: LngLat) => {
    let list = inserts.get(li);
    if (!list) inserts.set(li, (list = []));
    list.push([si, t, p]);
  };
  const seen = new Set<string>();
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i];
        const B = list[j];
        if (A.li === B.li) continue;
        if (lines[A.li].level !== lines[B.li].level) continue;
        const pair = A.li < B.li ? `${A.li}:${A.si}:${B.li}:${B.si}` : `${B.li}:${B.si}:${A.li}:${A.si}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const p1 = m[A.li][A.si - 1];
        const p2 = m[A.li][A.si];
        const q1 = m[B.li][B.si - 1];
        const q2 = m[B.li][B.si];
        const rx = p2[0] - p1[0];
        const ry = p2[1] - p1[1];
        const sx = q2[0] - q1[0];
        const sy = q2[1] - q1[1];
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((q1[0] - p1[0]) * sy - (q1[1] - p1[1]) * sx) / den;
        const u = ((q1[0] - p1[0]) * ry - (q1[1] - p1[1]) * rx) / den;
        if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) continue;
        const a = lines[A.li].pts;
        const pt: LngLat = [a[A.si - 1][0] + (a[A.si][0] - a[A.si - 1][0]) * t, a[A.si - 1][1] + (a[A.si][1] - a[A.si - 1][1]) * t];
        addInsert(A.li, A.si, t, pt);
        addInsert(B.li, B.si, u, pt);
      }
    }
  }
  // T-junctions: a line end within a few meters of another line's middle.
  lines.forEach((l, li) => {
    for (const end of [0, l.pts.length - 1]) {
      const pe = m[li][end];
      const c = `${Math.floor(pe[0] / CELL)}:${Math.floor(pe[1] / CELL)}`;
      let best: { li: number; si: number; t: number; d: number } | null = null;
      for (const s of grid.get(c) ?? []) {
        if (s.li === li || lines[s.li].level !== l.level) continue;
        const a = m[s.li][s.si - 1];
        const b = m[s.li][s.si];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const L = dx * dx + dy * dy;
        if (!L) continue;
        const t = Math.max(0, Math.min(1, ((pe[0] - a[0]) * dx + (pe[1] - a[1]) * dy) / L));
        const d = Math.hypot(a[0] + dx * t - pe[0], a[1] + dy * t - pe[1]);
        if (d <= T_SNAP_M && (!best || d < best.d)) best = { li: s.li, si: s.si, t, d };
      }
      if (best && best.d > 0.01) {
        const a = lines[best.li].pts;
        const pt: LngLat = [a[best.si - 1][0] + (a[best.si][0] - a[best.si - 1][0]) * best.t, a[best.si - 1][1] + (a[best.si][1] - a[best.si - 1][1]) * best.t];
        addInsert(best.li, best.si, best.t, pt);
        l.pts[end] = pt; // pull the end onto the other street
      }
    }
  });
  for (const [li, list] of inserts) {
    list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const pts = lines[li].pts;
    const out: LngLat[] = [pts[0]];
    let k = 0;
    for (let si = 1; si < pts.length; si++) {
      while (k < list.length && list[k][0] === si) {
        const [, t, p] = list[k++];
        if (t > 1e-6 && t < 1 - 1e-6) out.push(p);
      }
      out.push(pts[si]);
    }
    lines[li].pts = out;
  }
}

/** Turns street lines into OSM-like ways whose shared points have shared node ids. */
export function linesToWays(lines: Line[]): OsmWay[] {
  const ids = new Map<string, number>();
  let next = 1;
  const idOf = (p: LngLat) => {
    const k = keyOf(p);
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = next++));
    return id;
  };
  const ways: OsmWay[] = [];
  lines.forEach((l, i) => {
    const nodes: number[] = [];
    const geometry: { lat: number; lon: number }[] = [];
    for (const p of l.pts) {
      const id = idOf(p);
      if (nodes[nodes.length - 1] === id) continue;
      nodes.push(id);
      geometry.push({ lat: p[1], lon: p[0] });
    }
    if (nodes.length > 1) ways.push({ id: i + 1, nodes, geometry, tags: l.tags });
  });
  return ways;
}

/** The street map within `halfWidthM` of the line, from Mapbox, ready for buildGraph(). */
export async function streetsFromTiles(line: LngLat[], halfWidthM: number): Promise<OsmWay[]> {
  const tiles = tilesAlong(line, halfWidthM);
  const lines: Line[] = [];
  let failed = 0;
  for (let i = 0; i < tiles.length; i += 8) {
    const batch = await Promise.all(
      tiles.slice(i, i + 8).map(([x, y]) =>
        loadTile(x, y).catch(() => {
          failed++;
          return [] as Line[];
        }),
      ),
    );
    for (const b of batch) lines.push(...b);
  }
  // A few missing tiles at the edges are fine (the route just won't wander
  // there); too many and the map would have holes, so let the caller fall back.
  if (failed > Math.max(1, tiles.length * 0.12)) throw new Error(`${failed} of ${tiles.length} street tiles failed`);
  addJunctions(lines);
  return linesToWays(lines);
}
