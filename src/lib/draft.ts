// Draw a drive: turns what you draw on the map into a drivable path on real
// streets, piece by piece, so each stroke or tap can be undone and redone.
//
//  - A finger stroke is snapped onto the streets it traces (Mapbox Map Matching).
//  - A tap connects to the last point along real streets (Mapbox Directions).
//  - If a stroke can't be driven as drawn (wrong way down a one-way, a gap
//    between streets), the closest legal way is used and that piece is marked
//    "adjusted" so it can be shown.

import { MAPBOX_TOKEN } from '../config';
import { NO_RULES, routeThrough } from './funroutes';
import { cumulative, distance, lineLength, project, thin, type LngLat } from './geo';
import type { TrackPoint } from './storage';

export interface Piece {
  coords: LngLat[];
  durationS: number;
  kind: 'draw' | 'tap' | 'home';
  /** Joyride had to change it to follow legal streets. */
  adjusted: boolean;
}

/** Along real streets from `from` to `to`. */
export async function connect(from: LngLat, to: LngLat, kind: Piece['kind'] = 'tap'): Promise<Piece | null> {
  if (distance(from, to) < 5) return null;
  const r = await routeThrough([from, to], NO_RULES, false).catch(() => null);
  if (!r || r.coords.length < 2) return null;
  return { coords: r.coords, durationS: r.durationS, kind, adjusted: false };
}

/** One request to Map Matching (up to 100 points). */
async function match(points: LngLat[]): Promise<{ coords: LngLat[]; durationS: number } | null> {
  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    geometries: 'geojson',
    overview: 'full',
    tidy: 'true',
    radiuses: points.map(() => '35').join(';'),
    waypoints: `0;${points.length - 1}`,
  });
  const path = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
  const res = await fetch(`https://api.mapbox.com/matching/v5/mapbox/driving/${path}?${params}`);
  if (!res.ok) return null;
  const body: any = await res.json().catch(() => null);
  if (body?.code !== 'Ok' || !body.matchings?.length) return null;
  const coords: LngLat[] = [];
  let durationS = 0;
  for (const m of body.matchings) {
    const c: LngLat[] = m.geometry?.coordinates ?? [];
    coords.push(...(coords.length ? c.slice(1) : c));
    durationS += m.duration ?? 0;
  }
  return coords.length >= 2 ? { coords, durationS } : null;
}

/**
 * Snaps a finger stroke onto the streets it traces, starting from `from`
 * (the end of the drive so far), so the drive stays one connected path.
 */
export async function snapStroke(raw: LngLat[], from: LngLat | null): Promise<Piece[]> {
  if (raw.length < 2 || lineLength(raw) < 25) return [];
  const pieces: Piece[] = [];

  // A stroke that starts away from the end of the drive gets joined to it first.
  if (from && distance(from, raw[0]) > 40) {
    const join = await connect(from, raw[0], 'draw');
    if (join) pieces.push({ ...join, adjusted: false });
  }
  const start = pieces.length ? pieces[pieces.length - 1].coords.slice(-1)[0] : from;
  const sample = thin(raw, 25).map((i) => raw[i]);
  const pts = start && distance(start, sample[0]) <= 40 ? [start, ...sample.slice(1)] : sample;

  // Match in pieces of up to 100 points (Mapbox's limit), overlapping by one.
  const coords: LngLat[] = [];
  let durationS = 0;
  let failed = false;
  for (let i = 0; i < pts.length - 1; i += 99) {
    const m = await match(pts.slice(i, Math.min(pts.length, i + 100))).catch(() => null);
    if (!m) {
      failed = true;
      break;
    }
    coords.push(...(coords.length ? m.coords.slice(1) : m.coords));
    durationS += m.durationS;
  }

  if (failed || coords.length < 2) {
    // Couldn't trace it as drawn: route through points along the stroke instead.
    const via = thin(pts, 180).map((i) => pts[i]);
    const r = await routeThrough(via, NO_RULES, true).catch(() => null);
    if (!r) return pieces;
    pieces.push({ coords: r.coords, durationS: r.durationS, kind: 'draw', adjusted: true });
    return pieces;
  }

  // Adjusted: the street path strays well away from what was drawn (a one-way
  // the other way, a dead end, a gap), or is much longer than the drawing.
  const strays = coords.some((c, i) => i % 3 === 0 && (project(c, raw)?.offset ?? 0) > 60);
  const longer = lineLength(coords) > lineLength(raw) * 1.6 + 200;
  pieces.push({ coords, durationS, kind: 'draw', adjusted: strays || longer });
  return pieces;
}

/** The whole drive as one path (pieces joined end to end). */
export function joined(start: LngLat | null, pieces: Piece[]): LngLat[] {
  const out: LngLat[] = start ? [start] : [];
  for (const p of pieces) {
    for (const c of p.coords) {
      const last = out[out.length - 1];
      if (!last || distance(last, c) > 0.5) out.push(c);
    }
  }
  return out;
}

export function totals(pieces: Piece[]) {
  return {
    distanceM: pieces.reduce((a, p) => a + lineLength(p.coords), 0),
    durationS: pieces.reduce((a, p) => a + p.durationS, 0),
  };
}

/**
 * Turns the drawing into a saved drive's points, with made-up times that
 * follow each piece's estimated speed (so it plays back like a real drive).
 */
export function toTrack(start: LngLat | null, pieces: Piece[], startAt = Date.now()): TrackPoint[] {
  const out: TrackPoint[] = [];
  let t = startAt;
  if (start) out.push([start[0], start[1], t]);
  for (const p of pieces) {
    const cum = cumulative(p.coords);
    const len = cum[cum.length - 1] || 1;
    const t0 = t;
    p.coords.forEach((c, i) => {
      const at = Math.round(t0 + (cum[i] / len) * p.durationS * 1000);
      const last = out[out.length - 1];
      if (last && distance([last[0], last[1]], c) < 0.5) return;
      out.push([c[0], c[1], Math.max(at, (last?.[2] ?? 0) + 1)]);
    });
    t = t0 + p.durationS * 1000;
  }
  return out;
}
