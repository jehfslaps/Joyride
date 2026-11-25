// Reads drive links made by the desktop Joyride Draw page (docs/draw/codec.js):
//   joyride://import?d=v1/<seconds>/<points>/<name>
// Same format as the page: points simplified to within a few meters, as
// latitude/longitude steps of 1e-5° in zigzag varints, base64url.

import type { LngLat } from './geo';

export interface LinkedDrive {
  name: string;
  durationS: number;
  coords: LngLat[];
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function fromB64(s: string): number[] | null {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return out;
}

function unpackPoints(s: string): LngLat[] | null {
  const bytes = fromB64(s);
  if (!bytes) return null;
  const vals: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    let z = 0;
    let mul = 1;
    let b: number;
    do {
      if (i >= bytes.length) return null;
      b = bytes[i++];
      z += (b & 127) * mul;
      mul *= 128;
    } while (b & 128);
    vals.push(z % 2 ? -(z + 1) / 2 : z / 2);
  }
  if (vals.length % 2) return null;
  const coords: LngLat[] = [];
  let lat = 0;
  let lng = 0;
  for (let k = 0; k < vals.length; k += 2) {
    lat += vals[k];
    lng += vals[k + 1];
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

export function decodeDriveLink(s: string | undefined | null): LinkedDrive | null {
  const m = /^v1\/(\d+)\/([A-Za-z0-9_-]+)\/?(.*)$/.exec(s ?? '');
  if (!m) return null;
  const coords = unpackPoints(m[2]);
  if (!coords || coords.length < 2) return null;
  if (coords.some(([lng, lat]) => Math.abs(lat) > 90 || Math.abs(lng) > 180)) return null;
  let name = '';
  try {
    name = decodeURIComponent(m[3] ?? '');
  } catch {
    name = '';
  }
  return { durationS: Number(m[1]), coords, name };
}
