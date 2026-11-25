// End-to-end check of the desktop Joyride Draw page (docs/draw) in a real
// browser with live Mapbox: draw with the mouse, click a stop, undo/redo, make
// the phone link, and read it back the way the phone app does.
//
//   EXPO_PUBLIC_MAPBOX_TOKEN=pk... npx tsx scripts/drawpage.e2e.ts out/
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { decodeDriveLink } from '../src/lib/drivelink';
import { cumulative, project, type LngLat } from '../src/lib/geo';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const OUT = process.argv[2] ?? 'out';
const BASE = 'http://localhost:8080/draw/';
fs.mkdirSync(OUT, { recursive: true });
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

function coverage(route: LngLat[], other: LngLat[], within = 30): number {
  const cum = cumulative(route);
  const len = cum[cum.length - 1];
  let ok = 0;
  let n = 0;
  for (let m = 0; m <= len; m += 30) {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < m) i++;
    n++;
    if ((project(route[i], other)?.offset ?? 1e9) <= within) ok++;
  }
  return n ? ok / n : 0;
}

async function main() {
  // A real street route through a Whittier neighborhood, to trace with the mouse.
  const a: LngLat = [-118.0357, 33.9601];
  const b: LngLat = [-118.0186, 33.9512];
  const q = new URLSearchParams({ geometries: 'geojson', overview: 'full', access_token: TOKEN });
  const real: LngLat[] = (await (await fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${a.join(',')};${b.join(',')}?${q}`)).json()).routes[0].geometry.coordinates;

  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript((t) => localStorage.setItem('joyride.draw.key', t), TOKEN);
  await page.goto(BASE);
  await page.waitForFunction(() => (window as any).__joyrideDraw?.map?.loaded(), null, { timeout: 60000 });

  // Frame the route, then trace it with the mouse, wobbling a few pixels like a hand.
  await page.evaluate((line) => {
    const { map } = (window as any).__joyrideDraw;
    const xs = line.map((c: number[]) => c[0]);
    const ys = line.map((c: number[]) => c[1]);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: { top: 120, bottom: 120, left: 460, right: 120 }, duration: 0 });
  }, real);
  await page.waitForTimeout(1500);
  const px: [number, number][] = await page.evaluate((line) => {
    const { map } = (window as any).__joyrideDraw;
    const r = map.getCanvas().getBoundingClientRect();
    return line.map((c: number[]) => {
      const p = map.project(c);
      return [r.left + p.x, r.top + p.y];
    });
  }, real);
  let seed = 3;
  const wobble = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 8;
  await page.mouse.move(px[0][0], px[0][1]);
  await page.mouse.down();
  for (let i = 1; i < px.length; i++) {
    const [x0, y0] = px[i - 1];
    const [x1, y1] = px[i];
    const steps = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 6));
    for (let k = 1; k <= steps; k++) await page.mouse.move(x0 + ((x1 - x0) * k) / steps + wobble(), y0 + ((y1 - y0) * k) / steps + wobble());
  }
  await page.mouse.up();
  await page.waitForFunction(() => {
    const i = (window as any).__joyrideDraw.info();
    return i.busy === 0 && i.steps >= 1;
  }, null, { timeout: 30000 });
  const drawn = await page.evaluate(() => (window as any).__joyrideDraw.info());
  const snapped: LngLat[] = drawn.pieces.flatMap((p: any) => p.coords);
  const cov = coverage(real, snapped, 30);
  console.log(`drawn stroke: ${drawn.pieces.length} piece(s), follows the real streets ${(cov * 100).toFixed(0)}%, adjusted ${drawn.pieces.some((p: any) => p.adjusted)}`);
  if (cov < 0.9) fail(`stroke snapped to only ${(cov * 100).toFixed(0)}% of the traced streets`);
  await page.screenshot({ path: path.join(OUT, 'draw-page-1-stroke.png') });

  // Click stops: one click a few blocks on.
  await page.click('#modeTap');
  const before = drawn.steps;
  const target = await page.evaluate(() => {
    const { map } = (window as any).__joyrideDraw;
    const r = map.getCanvas().getBoundingClientRect();
    const p = map.project([-118.0150, 33.9555]);
    return [r.left + p.x, r.top + p.y];
  });
  await page.mouse.click(target[0], target[1]);
  await page.waitForFunction((n) => {
    const i = (window as any).__joyrideDraw.info();
    return i.busy === 0 && i.steps === n + 1;
  }, before, { timeout: 30000 });
  console.log('click stop: added');

  // Undo twice, redo once (button and keyboard).
  await page.click('#undo');
  await page.keyboard.press('Control+z');
  let info = await page.evaluate(() => (window as any).__joyrideDraw.info());
  if (info.steps !== before - 1 || info.redo !== 2) fail(`undo: steps ${info.steps}, redo ${info.redo}`);
  await page.keyboard.press('Control+y');
  await page.click('#redo');
  info = await page.evaluate(() => (window as any).__joyrideDraw.info());
  if (info.steps !== before + 1 || info.redo !== 0) fail(`redo: steps ${info.steps}, redo ${info.redo}`);
  console.log(`undo/redo: ok (${info.steps} steps)`);

  // Send to phone: QR code, and the link the phone reads.
  await page.click('#send');
  await page.fill('#name', 'Whittier test drive');
  await page.waitForTimeout(300);
  const link: string = await page.evaluate(() => (window as any).__joyrideDraw.lastLink());
  const hasQr = await page.locator('#qr svg').count();
  await page.screenshot({ path: path.join(OUT, 'draw-page-2-send.png') });
  const data = link.split('#')[1];
  const drive = decodeDriveLink(data);
  if (!hasQr) fail('no QR code');
  if (!drive) fail('phone could not read the link');
  else {
    const all: LngLat[] = info.pieces.flatMap((p: any) => p.coords);
    const covLink = coverage(all, drive.coords, 10);
    console.log(`link: ${link.length} chars, QR ${hasQr ? 'shown' : 'missing'}, name "${drive.name}", ${drive.coords.length} points, ${Math.round(drive.durationS / 60)} min, matches the drawing ${(covLink * 100).toFixed(0)}%`);
    if (drive.name !== 'Whittier test drive') fail('name lost');
    if (covLink < 0.97) fail('link path drifts from the drawing');
  }

  // A reload keeps the drawing.
  await page.goto(BASE);
  await page.waitForFunction(() => (window as any).__joyrideDraw?.map?.loaded(), null, { timeout: 60000 });
  const kept = await page.evaluate(() => (window as any).__joyrideDraw.info().steps);
  console.log(`after reload: ${kept} steps kept`);
  if (kept !== info.steps) fail('drawing not kept after reload');

  const real404 = errors.filter((e) => !/Failed to load resource.*(events|telemetry)/i.test(e));
  if (real404.length) {
    console.log('page errors:\n  ' + real404.join('\n  '));
    fail('page logged errors');
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
