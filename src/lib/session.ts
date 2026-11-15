// One "relive this drive" session: gets you to the route, guides you along it,
// and steers you back if you wander off.

import { distance, type LngLat } from './geo';
import { Announcer, Guidance, type GuidanceState } from './guidance';
import { getDirections } from './mapbox';
import type { NavRoute } from './route';

export type Phase = 'approach' | 'main' | 'rejoin' | 'done';
export type JoinMode = 'nearest' | 'start';

export interface SessionView {
  phase: Phase;
  /** What to show in the banner right now (main route, or the detour to it). */
  guide: GuidanceState | null;
  /** Detour line (to the route, or back to it). */
  detour: LngLat[] | null;
  /** Straight-line target when there are no directions available. */
  beeline: LngLat | null;
  mainProgressM: number;
  mainTotalM: number;
  mainRemainingM: number;
}

const ON_ROUTE_M = 25;
const REROUTE_COOLDOWN_MS = 12000;

export class NavSession {
  readonly main: Guidance;
  private detour: Guidance | null = null;
  private detourAnnouncer: Announcer;
  private mainAnnouncer: Announcer;
  private phase: Phase = 'approach';
  private joinAtM = 0;
  private beeline: LngLat | null = null;
  private lastReroute = 0;
  private rerouting = false;
  private lastMain: GuidanceState | null = null;
  private lastDetour: GuidanceState | null = null;

  /** Swappable clock (handy for testing). */
  now: () => number = () => Date.now();

  constructor(route: NavRoute, private readonly speak: (t: string) => void) {
    this.main = new Guidance(route);
    this.mainAnnouncer = new Announcer(speak);
    this.detourAnnouncer = new Announcer(speak);
  }

  /** Where you'd join the route from `pos`, and how far into the drive that is. */
  joinPoint(pos: LngLat, mode: JoinMode): { point: LngLat; atM: number; awayM: number } {
    if (mode === 'start') {
      const p = this.main.route.coords[0];
      return { point: p, atM: 0, awayM: distance(pos, p) };
    }
    const n = this.main.nearest(pos)!;
    return { point: n.point, atM: n.atM, awayM: n.offsetM };
  }

  async begin(pos: LngLat, mode: JoinMode): Promise<void> {
    const j = this.joinPoint(pos, mode);
    this.joinAtM = j.atM;
    this.main.setProgress(j.atM);
    if (j.awayM < 60) {
      this.enterMain(true);
      return;
    }
    this.phase = 'approach';
    this.lastReroute = this.now();
    const ok = await this.routeTo(pos, j.atM);
    this.speak(
      ok
        ? `Let's get you to the route. ${this.detour?.announced[0]?.instruction ?? ''}`
        : 'Head toward the route shown on the map.',
    );
  }

  /** Directions from `pos` to the route at `atM`, arriving pointed the right way. */
  private async routeTo(pos: LngLat, atM: number): Promise<boolean> {
    const target = this.main.pointAt(atM);
    const onward = this.main.pointAt(atM + 150);
    const pts: LngLat[] = distance(target, onward) > 20 ? [pos, target, onward] : [pos, target];
    try {
      const r = await getDirections(pts, pts.length === 3 ? [1] : []);
      if (r) {
        this.detour = new Guidance(r);
        this.lastDetour = null;
        this.detourAnnouncer.reset();
        this.beeline = null;
        return true;
      }
    } catch {
      // fall through to the straight-line fallback
    }
    this.detour = null;
    this.beeline = target;
    return false;
  }

  private enterMain(first: boolean) {
    const from = this.phase;
    this.phase = 'main';
    this.detour = null;
    this.beeline = null;
    this.mainAnnouncer.reset();
    const depart = this.main.announced[0];
    const departText = depart?.type === 'depart' ? ` ${depart.instruction}.` : '';
    if (first) {
      this.speak(this.joinAtM < 50 ? `Starting your drive.${departText}` : "You're on the route. Enjoy the drive.");
    } else if (from === 'rejoin') {
      this.speak("You're back on the route.");
    } else {
      this.speak(this.joinAtM < 50 ? `You're at the start. Let's relive this drive.${departText}` : "You're on the route. Enjoy the drive.");
    }
  }

  /** Feed every GPS update in here. */
  async onPosition(pos: LngLat, speedMps: number): Promise<SessionView> {
    if (this.phase === 'done') return this.view();

    const onDetourNow = this.phase === 'approach' || this.phase === 'rejoin';
    const m = this.main.update(pos, !onDetourNow);
    this.lastMain = m;

    if (onDetourNow) {
      const backOnMain = m.offsetM < ON_ROUTE_M && m.progressM >= this.joinAtM - 250;
      if (backOnMain) {
        this.enterMain(false);
      } else if (this.detour) {
        const d = this.detour.update(pos);
        this.lastDetour = d;
        if (d.arrived) this.enterMain(false);
        else if (d.offRoute) await this.fetchDetour(pos);
        else this.detourAnnouncer.handle(d, speedMps);
      } else if (this.now() - this.lastReroute > 30000) {
        // No directions yet (offline?) — keep trying now and then.
        await this.fetchDetour(pos);
      }
      return this.view();
    }

    // phase === 'main'
    if (m.arrived) {
      this.phase = 'done';
      this.speak("That's the end of the drive. Hope it was as good as the first time.");
      return this.view();
    }
    if (m.offRoute) {
      await this.reroute(pos);
      return this.view();
    }
    this.mainAnnouncer.handle(m, speedMps);
    return this.view();
  }

  /** You've left the route: switch to "back to the route" guidance. */
  private async reroute(pos: LngLat) {
    this.phase = 'rejoin';
    this.speak('Getting you back on the route.');
    // Rejoin a little ahead of where you left, so you're not sent back to redo it.
    this.joinAtM = Math.min(this.main.totalM, (this.lastMain?.progressM ?? this.joinAtM) + 200);
    this.lastReroute = 0;
    await this.fetchDetour(pos);
  }

  /** Get (fresh) directions to the join point, at most every few seconds. */
  private async fetchDetour(pos: LngLat) {
    if (this.rerouting || this.now() - this.lastReroute < REROUTE_COOLDOWN_MS) return;
    this.rerouting = true;
    this.lastReroute = this.now();
    try {
      await this.routeTo(pos, this.joinAtM);
    } finally {
      this.rerouting = false;
    }
  }

  view(): SessionView {
    const onDetour = this.phase === 'approach' || this.phase === 'rejoin';
    const main = this.lastMain;
    return {
      phase: this.phase,
      guide: onDetour ? (this.detour ? this.lastDetour : null) : main,
      detour: onDetour && this.detour ? this.detour.route.coords : null,
      beeline: onDetour ? this.beeline : null,
      mainProgressM: main?.progressM ?? this.joinAtM,
      mainTotalM: this.main.totalM,
      mainRemainingM: Math.max(0, this.main.totalM - (main?.progressM ?? this.joinAtM)),
    };
  }
}
