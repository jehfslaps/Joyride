// The pure rules behind "Are you still driving?" (see parked.ts).
import { distance, type LngLat } from './geo';

export const ASK_AFTER_MS = 10 * 60 * 1000;
export const AUTO_STOP_AFTER_MS = 15 * 60 * 1000;
export const ASK_AGAIN_AFTER_KEEP_MS = 15 * 60 * 1000;
/** Moving less than this from where you stopped still counts as parked. */
export const PARKED_RADIUS_M = 60;


export interface ParkedState {
  anchor: LngLat | null;
  /** When you arrived at the anchor (last real movement). */
  since: number;
  /** When you last chose Keep recording during this stop. */
  keptAt: number | null;
  /** When the question is currently scheduled for. */
  askAt: number | null;
}

export const fresh = (): ParkedState => ({ anchor: null, since: 0, keptAt: null, askAt: null });

export type ParkedDecision =
  | { kind: 'none' }
  | { kind: 'moved' }
  | { kind: 'auto-stop'; trimAfter: number };

/**
 * Pure step: given the state and a new fix, what happens. Updates `state`.
 * `gap` handling: if iOS sent nothing for a long time (phone asleep) and
 * you'd been parked past the limit, it still counts as a stop.
 */
export function step(state: ParkedState, at: LngLat, t: number): ParkedDecision {
  if (!state.anchor) {
    state.anchor = at;
    state.since = t;
    return { kind: 'moved' };
  }
  const parkedFor = t - state.since;
  if (distance(state.anchor, at) > PARKED_RADIUS_M) {
    // Moving again. If the stop before this was already past the limit (no
    // fixes came while parked), that stop ended the drive.
    if (!state.keptAt && parkedFor >= AUTO_STOP_AFTER_MS) return { kind: 'auto-stop', trimAfter: state.since };
    state.anchor = at;
    state.since = t;
    state.keptAt = null;
    return { kind: 'moved' };
  }
  if (!state.keptAt && parkedFor >= AUTO_STOP_AFTER_MS) return { kind: 'auto-stop', trimAfter: state.since };
  return { kind: 'none' };
}

