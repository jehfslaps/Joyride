// Route lab: builds fun routes against live Mapbox data, checks them, and draws
// each one on a map. Runs in GitHub Actions (see .github/workflows/routelab.yml).
//
//   EXPO_PUBLIC_MAPBOX_TOKEN=pk... npx tsx scripts/routelab.ts out/
import fs from 'node:fs';
import path from 'node:path';
import { cumulative, distance, project, thin, type LngLat } from '../src/lib/geo';
import { buildFunRoutes, routeThrough, setContinueStraight, type RoadRules, type RouteOption } from '../src/lib/funroutes';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const OUT = process.argv[2] ?? 'out';
fs.mkdirSync(OUT, { recursive: true });

const uptownWhittier: LngLat = [-118.0328, 33.9792];
const ANY = { noFreeways: false, noHighways: false };
const NONE = { noFreeways: true, noHighways: true };
const TRIPS: { name: string; to: LngLat; rules: RoadRules; cs: boolean }[] = [
  { name: 'costco-la-habra', to: [-117.948, 33.9335], rules: ANY, cs: false },
  { name: 'walnut', to: [-117.8653, 34.0203], rules: { noFreeways: true, noHighways: false }, cs: false },
  { name: 'downtown-fullerton', to: [-117.9243, 33.8704], rules: ANY, cs: false },
  { name: 'la-habra', to: [-117.9462, 33.9319], rules: ANY, cs: false },
];

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const lines: string[] = [];
const log = (s: string) => {
  console.log(s);
  lines.push(s);
};

// ---- checks ------------------------------------------------------------------

/** How the native app will see the route: thinned to 35 m, matched in pieces of 100 points. */
async function matched(coords: LngLat[]): Promise<LngLat[]> {
  const keep = thin(coords, 35).map((i) => coords[i]);
  const out: LngLat[] = [];
  for (let start = 0; start < keep.length - 1; start += 90) {
    const piece = keep.slice(start, Math.min(keep.length, start + 100));
    if (piece.length < 2) break;
    const params = new URLSearchParams({
      access_token: TOKEN,
      geometries: 'geojson',
      overview: 'full',
      radiuses: piece.map(() => '25').join(';'),
      waypoints: `0;${piece.length - 1}`,
    });
    const res = await fetch(`https://api.mapbox.com/matching/v5/mapbox/driving/${piece.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';')}?${params}`);
    const body: any = await res.json().catch(() => ({}));
    for (const m of body?.matchings ?? []) out.push(...(m.geometry?.coordinates ?? []));
  }
  return out;
}

function coverage(route: LngLat[], other: LngLat[], within = 30): number {
  if (other.length < 2) return 0;
  const cum = cumulative(route);
  const len = cum[cum.length - 1];
  let ok = 0;
  let n = 0;
  for (let m = 0; m <= len; m += 40) {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < m) i++;
    const p = route[i];
    n++;
    if ((project(p, other)?.offset ?? 1e9) <= within) ok++;
  }
  return n ? ok / n : 0;
}

/** Street spots where the route turns around instead of driving through. */
function uTurnsAtStreets(r: RouteOption): number {
  let n = 0;
  for (const v of r.via) {
    if (v.kind !== 'street') continue;
    let best = 0;
    let bd = Infinity;
    r.coords.forEach((c, i) => {
      const d = distance(c, v.coord);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    const back = r.coords[Math.max(0, best - 6)];
    const fwd = r.coords[Math.min(r.coords.length - 1, best + 6)];
    if (distance(back, fwd) < 25 && distance(back, r.coords[best]) > 40) n++;
  }
  return n;
}

// ---- drawing -----------------------------------------------------------------

function encode(coords: LngLat[]): string {
  let out = '';
  let pl = 0;
  let pg = 0;
  const enc = (v: number) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (x >= 0x20) {
      s += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
      x >>= 5;
    }
    return s + String.fromCharCode(x + 63);
  };
  for (const [lng, lat] of coords) {
    const a = Math.round(lat * 1e5);
    const b = Math.round(lng * 1e5);
    out += enc(a - pl) + enc(b - pg);
    pl = a;
    pg = b;
  }
  return out;
}

function simplified(coords: LngLat[], budget: number): string {
  for (const spacing of [15, 25, 40, 60, 90, 140, 200]) {
    const s = encode(thin(coords, spacing).map((i) => coords[i]));
    if (s.length <= budget) return s;
  }
  return encode(thin(coords, 300).map((i) => coords[i]));
}

async function draw(file: string, r: RouteOption, base: LngLat[] | null) {
  const overlays: string[] = [];
  if (base) overlays.push(`path-4+7a7f8a-0.6(${encodeURIComponent(simplified(base, 600))})`);
  overlays.push(`path-5+ff7a00-0.95(${encodeURIComponent(simplified(r.coords, 3000))})`);
  for (const v of r.via.filter((x) => x.kind !== 'street').slice(0, 12)) {
    overlays.push(`pin-s-${v.kind === 'culdesac' ? 'c' : 'star'}+${v.kind === 'culdesac' ? 'd6336c' : '2f9e44'}(${v.coord[0].toFixed(5)},${v.coord[1].toFixed(5)})`);
  }
  for (const v of r.via.filter((x) => x.kind === 'street').slice(0, 10)) {
    overlays.push(`pin-s+1c7ed6(${v.coord[0].toFixed(5)},${v.coord[1].toFixed(5)})`);
  }
  const url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlays.join(',')}/auto/700x700@2x?padding=40&access_token=${TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    log(`    (map image failed: ${res.status} ${(await res.text()).slice(0, 120)})`);
    return;
  }
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// ---- run ---------------------------------------------------------------------

const min = (s: number) => `${Math.round(s / 60)} min`;
const mi = (m: number) => `${(m / 1609.344).toFixed(1)} mi`;

async function main() {
  if (!TOKEN) throw new Error('No Mapbox token');
  for (const trip of TRIPS) {
    {
      const rules = trip.rules;
      setContinueStraight(trip.cs);
      const tag = `${trip.name}${rules.noFreeways ? '-nofwy' : ''}${rules.noHighways ? '-nohwy' : ''}${trip.cs ? '-cs' : ''}`;
      const t0 = Date.now();
      const routes = await buildFunRoutes(uptownWhittier, trip.to, { rules, rand });
      log(`\n=== ${tag}: ${routes.length} routes in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      const base = routes.find((r) => r.style === 'fastest')?.coords ?? null;
      let k = 0;
      for (const r of routes) {
        k++;
        // Street-by-street routes are their own exact path; only the older kind needs re-routing to inspect.
        const check = r.streets ? null : await routeThrough([uptownWhittier, ...r.via.map((v) => v.coord), trip.to], rules);
        const steps = (check as any)?.steps ?? [];
        const longest = Math.max(0, ...steps.map((st: any) => st.distance));
        const longOnes = steps.filter((st: any) => st.distance > 805).length;
        const mains = new Set(r.via.filter((v) => v.kind === 'main').map((v) => v.name).filter(Boolean));
        const turns = steps.length;
        const fwy = steps.filter((s: any) => (s.intersections ?? []).some((x: any) => x.classes?.includes('motorway'))).reduce((a: number, s: any) => a + s.distance, 0);
        const hwy = r.highwayM;
        const m = await matched(r.coords);
        const cov = coverage(r.coords, m);
        const culsKept = r.via.filter((v) => v.kind === 'culdesac' && (project(v.coord, m)?.offset ?? 1e9) < 40).length;
        const culsDriven = r.via.filter((v) => v.kind === 'culdesac' && (project(v.coord, r.coords)?.offset ?? 1e9) < 40).length;
        log(
          `${String(k).padStart(2)}. ${min(r.durationS).padStart(7)} ${mi(r.distanceM).padStart(8)}  L${r.level} ${r.title} — ${r.blurb}` +
            `\n      spots ${r.via.length} (cul-de-sacs driven ${culsDriven}/${r.culDeSacs}, kept by matching ${culsKept})` +
            ` · freeway ${mi(fwy)} · highway ${mi(hwy)}${r.usesHighway ? ' (flagged)' : ''}` +
            ` · street U-turns ${uTurnsAtStreets(r)} · nav match ${(cov * 100).toFixed(0)}%` +
            `\n      turns ${turns} · longest straight ${mi(longest)} · stretches over ½ mi: ${longOnes} · other main streets ${mains.size} (${[...mains].slice(0, 4).join(', ')})`,
        );
        if (r.streets?.length) log(`      streets: ${r.streets.join(' → ')}`);
        await draw(path.join(OUT, `${tag}-${String(k).padStart(2, '0')}-L${r.level}.png`), r, r.style === 'fastest' ? null : base);
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'summary.txt'), lines.join('\n') + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
