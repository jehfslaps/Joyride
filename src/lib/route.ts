// A route the app can guide you along: one line plus the turns on it.

import { bearing, cumulative, distance, type LngLat } from './geo';

export type Modifier =
  | 'uturn'
  | 'sharp right'
  | 'right'
  | 'slight right'
  | 'straight'
  | 'slight left'
  | 'left'
  | 'sharp left';

export interface NavStep {
  /** Index into route.coords where this maneuver happens. */
  at: number;
  type: string; // depart, turn, continue, new name, merge, fork, roundabout, end of road, arrive, ...
  modifier: Modifier | null;
  instruction: string;
  /** Street you'll be on after the maneuver, if known. */
  name: string;
  exit?: number;
}

export interface NavRoute {
  coords: LngLat[];
  steps: NavStep[];
  distanceM: number;
  /** True when every part was matched to real roads with street names. */
  fullyMatched: boolean;
}

/** Raw Mapbox step (only the fields we use). */
export interface MapboxStep {
  name?: string;
  ref?: string;
  geometry: { coordinates: LngLat[] };
  maneuver: {
    type: string;
    modifier?: string;
    instruction?: string;
    bearing_before?: number;
    bearing_after?: number;
    location: LngLat;
    exit?: number;
  };
}

/** Builds a route by appending pieces (matched step lists or raw line segments). */
export class RouteBuilder {
  coords: LngLat[] = [];
  steps: NavStep[] = [];
  fullyMatched = true;
  private pendingJoin = false;

  /** Append steps from a Mapbox match or directions leg. */
  addMapboxSteps(src: MapboxStep[]) {
    src.forEach((s) => {
      const g = s.geometry.coordinates;
      if (g.length === 0) return;
      const at = this.append(g);
      const m = s.maneuver;
      const name = streetName(s);
      if (m.type === 'arrive') {
        // Only the very last arrive matters; it's added in finish().
        this.pendingJoin = true;
        return;
      }
      if (m.type === 'depart') {
        if (this.steps.length === 0) {
          this.steps.push({ at, type: 'depart', modifier: null, instruction: m.instruction || headOn(name), name });
        } else {
          // Piece boundary: if the road bends here, say so.
          this.addBoundaryTurn(at, name);
        }
        this.pendingJoin = false;
        return;
      }
      this.pendingJoin = false;
      this.steps.push({
        at,
        type: m.type,
        modifier: (m.modifier as Modifier) ?? null,
        instruction: m.instruction || describe(m.type, (m.modifier as Modifier) ?? null, name),
        name,
        exit: m.exit,
      });
    });
  }

  /** Append a raw stretch of GPS line (no street names); turns are worked out from its shape. */
  addRawLine(line: LngLat[]) {
    if (line.length < 2) return;
    this.fullyMatched = false;
    const at = this.append(line);
    if (this.steps.length === 0) {
      this.steps.push({ at, type: 'depart', modifier: null, instruction: 'Head out along the route', name: '' });
    } else {
      this.addBoundaryTurn(at, '');
    }
    for (const t of detectTurns(line)) {
      const idx = Math.min(this.coords.length - 1, at + t.index);
      this.steps.push({ at: idx, type: 'turn', modifier: t.modifier, instruction: describe('turn', t.modifier, ''), name: '' });
    }
  }

  finish(arriveText = 'You have arrived'): NavRoute {
    const coords = this.coords;
    this.steps.sort((a, b) => a.at - b.at);
    this.steps.push({ at: coords.length - 1, type: 'arrive', modifier: null, instruction: arriveText, name: '' });
    const cum = cumulative(coords);
    return { coords, steps: this.steps, distanceM: cum[cum.length - 1] ?? 0, fullyMatched: this.fullyMatched };
  }

  /** Appends a line, merging the shared first point. Returns the index of the line's first point. */
  private append(line: LngLat[]): number {
    if (this.coords.length > 0 && distance(this.coords[this.coords.length - 1], line[0]) < 2) {
      const at = this.coords.length - 1;
      for (let k = 1; k < line.length; k++) this.coords.push(line[k]);
      return at;
    }
    const at = this.coords.length;
    for (const c of line) this.coords.push(c);
    return at;
  }

  private addBoundaryTurn(at: number, name: string) {
    const c = this.coords;
    if (at < 1 || at >= c.length - 1) return;
    const before = lookBehind(c, at, 25);
    const after = lookAhead(c, at, 25);
    if (!before || !after) return;
    const mod = modifierFromAngle(turnAngle(bearing(before, c[at]), bearing(c[at], after)));
    if (mod === 'straight') return;
    this.steps.push({ at, type: 'turn', modifier: mod, instruction: describe('turn', mod, name), name });
  }
}

function streetName(s: MapboxStep): string {
  const n = (s.name ?? '').trim();
  const r = (s.ref ?? '').trim();
  if (n && r) return `${n} (${r})`;
  return n || r;
}

function headOn(name: string) {
  return name ? `Head out on ${name}` : 'Head out along the route';
}

export function describe(type: string, mod: Modifier | null, name: string): string {
  const onto = name ? ` onto ${name}` : '';
  if (type === 'arrive') return 'You have arrived';
  if (mod === 'uturn') return `Make a U-turn${onto}`;
  if (!mod || mod === 'straight') return name ? `Continue on ${name}` : 'Continue straight';
  const verb = mod.startsWith('slight') ? 'Bear' : mod.startsWith('sharp') ? 'Make a sharp' : 'Turn';
  const dir = mod.replace('slight ', '').replace('sharp ', '');
  return `${verb} ${dir}${onto}`;
}

/** Signed change in heading, -180..180 (positive = right). */
export function turnAngle(b1: number, b2: number): number {
  let d = b2 - b1;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export function modifierFromAngle(a: number): Modifier {
  const x = Math.abs(a);
  const side = a > 0 ? 'right' : 'left';
  if (x < 25) return 'straight';
  if (x < 55) return `slight ${side}` as Modifier;
  if (x < 135) return side as Modifier;
  if (x < 165) return `sharp ${side}` as Modifier;
  return 'uturn';
}

function lookBehind(c: LngLat[], i: number, meters: number): LngLat | null {
  let d = 0;
  for (let k = i - 1; k >= 0; k--) {
    d += distance(c[k], c[k + 1]);
    if (d >= meters) return c[k];
  }
  return i > 0 ? c[0] : null;
}

function lookAhead(c: LngLat[], i: number, meters: number): LngLat | null {
  let d = 0;
  for (let k = i + 1; k < c.length; k++) {
    d += distance(c[k - 1], c[k]);
    if (d >= meters) return c[k];
  }
  return i < c.length - 1 ? c[c.length - 1] : null;
}

/** Finds turns in a raw GPS line by comparing the heading ~30 m before and after each point. */
export function detectTurns(line: LngLat[]): { index: number; modifier: Modifier }[] {
  const out: { index: number; modifier: Modifier; strength: number }[] = [];
  for (let i = 1; i < line.length - 1; i++) {
    const a = lookBehind(line, i, 30);
    const b = lookAhead(line, i, 30);
    if (!a || !b) continue;
    const ang = turnAngle(bearing(a, line[i]), bearing(line[i], b));
    if (Math.abs(ang) < 50) continue;
    const last = out[out.length - 1];
    if (last && distance(line[last.index], line[i]) < 40) {
      if (Math.abs(ang) > last.strength) {
        last.index = i;
        last.modifier = modifierFromAngle(ang);
        last.strength = Math.abs(ang);
      }
      continue;
    }
    out.push({ index: i, modifier: modifierFromAngle(ang), strength: Math.abs(ang) });
  }
  return out.map(({ index, modifier }) => ({ index, modifier }));
}
