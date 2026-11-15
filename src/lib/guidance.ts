// Follows your position along a route: how far along you are, which turn is
// next, whether you've drifted off, and what to say out loud.
// Pure logic with no phone APIs, so it can be tested on its own.

import {
  alongLine,
  cumulative,
  indexAtDistance,
  project,
  spokenDistance,
  type LngLat,
} from './geo';
import type { NavRoute, NavStep } from './route';

const OFF_ROUTE_M = 45;
const OFF_ROUTE_HARD_M = 90;
const ARRIVED_M = 35;

export interface GuidanceState {
  /** Where you are, snapped onto the route. */
  snapped: LngLat;
  offsetM: number;
  offRoute: boolean;
  progressM: number;
  remainingM: number;
  next: NavStep | null;
  nextIndex: number;
  distToNextM: number;
  /** The turn right after `next`, when it comes quickly (for "then turn right"). */
  then: NavStep | null;
  arrived: boolean;
}

export function isAnnounced(s: NavStep): boolean {
  if (s.type === 'arrive' || s.type === 'depart') return true;
  if (['turn', 'end of road', 'fork', 'merge', 'on ramp', 'off ramp', 'roundabout', 'rotary', 'roundabout turn', 'exit roundabout', 'exit rotary'].includes(s.type)) {
    return s.modifier !== 'straight' || s.type !== 'turn';
  }
  // "continue" / "new name": only worth saying when the road actually bends.
  return s.modifier != null && s.modifier !== 'straight' && !s.modifier.startsWith('slight');
}

export class Guidance {
  readonly route: NavRoute;
  readonly cum: number[];
  readonly stepAt: number[]; // meters along route of each step
  readonly announced: NavStep[];
  private progressM = 0;
  private offCount = 0;
  private started = false;

  constructor(route: NavRoute, startAtM = 0) {
    this.route = route;
    this.cum = cumulative(route.coords);
    this.announced = route.steps.filter(isAnnounced);
    this.stepAt = this.announced.map((s) => this.cum[Math.min(s.at, this.cum.length - 1)]);
    this.progressM = startAtM;
    this.started = startAtM > 0;
  }

  get totalM() {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  /** Closest point on the whole route (used to pick where to join). */
  nearest(p: LngLat): { point: LngLat; atM: number; offsetM: number } | null {
    const pr = project(p, this.route.coords);
    if (!pr) return null;
    return { point: pr.point, atM: alongLine(pr, this.route.coords, this.cum), offsetM: pr.offset };
  }

  /** Point and heading-target a little further along the route from `m`. */
  pointAt(m: number): LngLat {
    const i = indexAtDistance(this.cum, Math.max(0, Math.min(this.totalM, m)));
    return this.route.coords[i];
  }

  /** Start tracking from this far into the route. */
  setProgress(m: number) {
    this.progressM = Math.max(0, Math.min(this.totalM, m));
    this.started = true;
    this.offCount = 0;
  }

  /**
   * Feed a position. `allowJump` lets progress leap ahead if you've clearly
   * skipped part of the route; it's off while you're still driving to it.
   */
  update(p: LngLat, allowJump = true): GuidanceState {
    const coords = this.route.coords;
    // Look near where we were, mostly ahead, so a route that crosses itself
    // doesn't confuse us.
    const from = Math.max(0, indexAtDistance(this.cum, this.progressM - 60) - 1);
    const to = indexAtDistance(this.cum, this.progressM + (this.started ? 1200 : this.totalM));
    let pr = project(p, coords, from, Math.max(from + 1, to));
    if (allowJump && (!pr || pr.offset > OFF_ROUTE_M)) {
      // Maybe you skipped ahead (or this is the first fix): check everything ahead.
      const ahead = project(p, coords, from, coords.length - 1);
      if (ahead && ahead.offset < 25 && (!pr || ahead.offset < pr.offset)) pr = ahead;
    }
    if (!pr) {
      return this.state([coords[0][0], coords[0][1]], Infinity);
    }
    const along = alongLine(pr, coords, this.cum);
    if (pr.offset <= OFF_ROUTE_M) {
      // Never move backwards much: GPS wobble shouldn't replay old turns.
      if (along > this.progressM - 15) this.progressM = Math.max(this.progressM, along);
      this.offCount = 0;
      this.started = true;
    } else {
      this.offCount += pr.offset > OFF_ROUTE_HARD_M ? 2 : 1;
    }
    return this.state(pr.point, pr.offset);
  }

  private state(snapped: LngLat, offsetM: number): GuidanceState {
    const remainingM = Math.max(0, this.totalM - this.progressM);
    let nextIndex = this.stepAt.findIndex((m, i) => m > this.progressM + 5 && this.announced[i].type !== 'depart');
    if (nextIndex === -1) nextIndex = this.announced.length - 1;
    const next = this.announced[nextIndex] ?? null;
    const distToNextM = next ? Math.max(0, this.stepAt[nextIndex] - this.progressM) : remainingM;
    const after = this.announced[nextIndex + 1];
    const then = after && this.stepAt[nextIndex + 1] - this.stepAt[nextIndex] < 120 && after.type !== 'arrive' ? after : null;
    return {
      snapped,
      offsetM,
      offRoute: this.offCount >= 2,
      progressM: this.progressM,
      remainingM,
      next,
      nextIndex,
      distToNextM,
      then,
      arrived: remainingM < ARRIVED_M,
    };
  }
}

/**
 * Decides what to say. Each turn gets an early heads-up and a "now" call,
 * timed by speed so they come early enough on faster roads.
 */
export class Announcer {
  private said = new Map<number, Set<'far' | 'prep' | 'now'>>();

  constructor(private readonly speak: (text: string) => void) {}

  reset() {
    this.said.clear();
  }

  handle(s: GuidanceState, speedMps: number) {
    const next = s.next;
    if (!next || s.offRoute) return;
    const key = s.nextIndex;
    const done = this.said.get(key) ?? new Set();
    this.said.set(key, done);
    const v = Math.max(8, speedMps || 0);
    const nowM = Math.max(40, v * 4);
    const prepM = Math.max(250, v * 15);
    const d = s.distToNextM;
    const text = next.instruction;
    const thenText = s.then ? `, then ${lowerFirst(s.then.instruction)}` : '';

    if (d <= nowM) {
      if (!done.has('now')) {
        done.add('now');
        done.add('prep');
        done.add('far');
        this.speak(text + thenText);
      }
      return;
    }
    const ahead = next.type === 'arrive' ? `The drive ends in ${spokenDistance(d)}` : `In ${spokenDistance(d)}, ${lowerFirst(text)}`;
    if (d <= prepM) {
      if (!done.has('prep')) {
        done.add('prep');
        done.add('far');
        this.speak(ahead);
      }
      return;
    }
    if (d <= 1600 && d > prepM + 400 && !done.has('far')) {
      done.add('far');
      this.speak(ahead);
    }
  }
}

function lowerFirst(t: string) {
  return t ? t[0].toLowerCase() + t.slice(1) : t;
}
