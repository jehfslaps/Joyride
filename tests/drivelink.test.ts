import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { decodeDriveLink } from '../src/lib/drivelink';
import { distance, type LngLat } from '../src/lib/geo';

// Load the desktop page's codec, exactly as the browser would.
const ctx: any = { globalThis: {} as any };
vm.runInNewContext(fs.readFileSync('docs/draw/codec.js', 'utf8'), ctx);
const codec = ctx.globalThis.JoyrideCodec;

// A wiggly 6 km drive with dense points, straight runs and turns.
const coords: LngLat[] = [];
let [lng, lat] = [-118.0328, 33.9792];
for (let i = 0; i < 600; i++) {
  const leg = Math.floor(i / 60) % 4;
  lng += leg === 0 ? 0.0001 : leg === 2 ? -0.00005 : 0;
  lat += leg === 1 ? -0.0001 : leg === 3 ? -0.00004 : 0;
  coords.push([lng + Math.sin(i / 7) * 0.00001, lat]);
}

const link = codec.encode({ name: 'Hills & cul-de-sacs / test', durationS: 1234, coords });
const back = decodeDriveLink(link)!;
assert.ok(back, 'the phone reads what the page writes');
assert.equal(back.name, 'Hills & cul-de-sacs / test');
assert.equal(back.durationS, 1234);
assert.ok(back.coords.length < coords.length / 4, `simplified (${back.coords.length} of ${coords.length} points)`);
for (const c of coords) {
  let best = Infinity;
  for (let i = 1; i < back.coords.length; i++) best = Math.min(best, codec.offset(c, back.coords[i - 1], back.coords[i]));
  assert.ok(best < 5.5, `every original point within ~4 m of the link's path (got ${best.toFixed(1)} m)`);
}
assert.ok(distance(back.coords[0], coords[0]) < 2 && distance(back.coords.at(-1)!, coords.at(-1)!) < 2, 'same start and end');
assert.ok(link.length < 1200, `small enough for a QR code (${link.length} chars)`);

assert.equal(decodeDriveLink('nonsense'), null);
assert.equal(decodeDriveLink('v1/10/@@@/x'), null);
assert.equal(decodeDriveLink('v1/10/AA/x'), null);

console.log(`drivelink: all checks passed (${link.length}-char link, ${back.coords.length} points)`);
