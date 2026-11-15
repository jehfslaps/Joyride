// Talks to Mapbox: snapping recorded GPS onto real roads (Map Matching)
// and ordinary directions (used to get you onto, or back onto, a route).

import { MAPBOX_TOKEN } from '../config';
import { bearing, thin, type LngLat } from './geo';
import { RouteBuilder, turnAngle, type MapboxStep, type NavRoute } from './route';
import type { TrackPoint } from './storage';

const API = 'https://api.mapbox.com';
const MAX_COORDS = 100;
/** Spacing of points sent for matching; dense enough to catch every turn. */
const MATCH_SPACING_M = 35;

export const hasMapbox = () => MAPBOX_TOKEN.trim().startsWith('pk.');

export class MapboxError extends Error {}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    throw new MapboxError('Mapbox rejected the access token. Check the token in config.ts.');
  }
  if (!res.ok && res.status !== 422) throw new MapboxError(body?.message || `Mapbox error ${res.status}`);
  return body;
}

const fmt = (c: LngLat) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

/**
 * Splits a long trace into pieces of at most 100 points. Each split is made
 * where the road runs straight, so no turn falls on a seam.
 */
export function chunkIndices(coords: LngLat[], max = MAX_COORDS): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  while (start < coords.length - 1) {
    const hardEnd = Math.min(coords.length - 1, start + max - 1);
    if (hardEnd === coords.length - 1) {
      out.push([start, hardEnd]);
      break;
    }
    let best = hardEnd;
    let bestBend = Infinity;
    for (let i = Math.max(start + Math.floor(max * 0.7), start + 2); i <= hardEnd - 1; i++) {
      const bend = Math.abs(turnAngle(bearing(coords[i - 1], coords[i]), bearing(coords[i], coords[i + 1])));
      if (bend < bestBend) {
        bestBend = bend;
        best = i;
      }
    }
    out.push([start, best]);
    start = best;
  }
  return out;
}

async function matchPiece(coords: LngLat[], times: number[]): Promise<MapboxStep[] | null> {
  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    geometries: 'geojson',
    overview: 'full',
    steps: 'true',
    radiuses: coords.map(() => '25').join(';'),
    timestamps: times.map((t) => Math.round(t / 1000)).join(';'),
    waypoints: `0;${coords.length - 1}`,
  });
  const url = `${API}/matching/v5/mapbox/driving/${coords.map(fmt).join(';')}.json?${params}`;
  const body = await getJson(url);
  if (body.code !== 'Ok' || !Array.isArray(body.matchings) || body.matchings.length !== 1) return null;
  const m = body.matchings[0];
  if (typeof m.confidence === 'number' && m.confidence < 0.05) return null;
  const steps: MapboxStep[] = [];
  for (const leg of m.legs ?? []) steps.push(...(leg.steps ?? []));
  return steps.length ? steps : null;
}

/** Match one piece; if Mapbox can't, split it and try smaller halves, and fall back to the raw line. */
async function matchOrSplit(
  coords: LngLat[],
  times: number[],
  b: RouteBuilder,
  depth = 0,
): Promise<void> {
  let steps: MapboxStep[] | null = null;
  try {
    steps = await matchPiece(coords, times);
  } catch (e) {
    if (e instanceof MapboxError && /token/i.test(e.message)) throw e;
    steps = null;
  }
  if (steps) {
    b.addMapboxSteps(steps);
    return;
  }
  if (coords.length > 12 && depth < 3) {
    const mid = Math.floor(coords.length / 2);
    await matchOrSplit(coords.slice(0, mid + 1), times.slice(0, mid + 1), b, depth + 1);
    await matchOrSplit(coords.slice(mid), times.slice(mid), b, depth + 1);
    return;
  }
  b.addRawLine(coords);
}

/** Turns a recorded drive into a route with street names and turns. */
export async function buildRouteFromDrive(
  points: TrackPoint[],
  onProgress?: (fraction: number) => void,
): Promise<NavRoute> {
  const all: LngLat[] = points.map((p) => [p[0], p[1]]);
  const keep = thin(all, MATCH_SPACING_M);
  const coords = keep.map((i) => all[i]);
  const times = keep.map((i) => points[i][2]);
  const b = new RouteBuilder();

  if (!hasMapbox()) {
    b.addRawLine(coords);
    return b.finish('You have finished the drive');
  }

  const chunks = chunkIndices(coords);
  for (let k = 0; k < chunks.length; k++) {
    const [s, e] = chunks[k];
    await matchOrSplit(coords.slice(s, e + 1), times.slice(s, e + 1), b);
    onProgress?.((k + 1) / chunks.length);
  }
  return b.finish('You have finished the drive');
}

/**
 * Ordinary driving directions through the given points. Points listed in `via`
 * (by index) are passed through without stopping — used to make sure you join
 * a route facing the right way.
 */
export async function getDirections(points: LngLat[], via: number[] = []): Promise<NavRoute | null> {
  if (!hasMapbox() || points.length < 2) return null;
  const waypoints = points.map((_, i) => i).filter((i) => !via.includes(i));
  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    geometries: 'geojson',
    overview: 'full',
    steps: 'true',
  });
  if (via.length) params.set('waypoints', waypoints.join(';'));
  const url = `${API}/directions/v5/mapbox/driving/${points.map(fmt).join(';')}?${params}`;
  const body = await getJson(url);
  if (body.code !== 'Ok' || !body.routes?.length) return null;
  const b = new RouteBuilder();
  for (const leg of body.routes[0].legs ?? []) b.addMapboxSteps(leg.steps ?? []);
  const route = b.finish("You're on the route");
  return route.coords.length >= 2 ? route : null;
}

