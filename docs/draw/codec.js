// Joyride drive links: a drawn drive packed small enough for a QR code.
//
//   https://jehfslaps.github.io/Joyride/open/#v1/<seconds>/<points>/<name>
//
// <points>: the path simplified to within a few meters, as latitude/longitude
// steps (1e-5 degrees, about a meter) written as zigzag varints, then
// base64url. The phone app reads the same format (src/lib/drivelink.ts).
(function (root) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;

  /** Meters from point p to segment a–b (flat-earth, fine at street scale). */
  function offset(p, a, b) {
    const k = Math.cos(rad(p[1])) * R;
    const ax = (a[0] - p[0]) * rad(1) * k, ay = (a[1] - p[1]) * rad(1) * R;
    const bx = (b[0] - p[0]) * rad(1) * k, by = (b[1] - p[1]) * rad(1) * R;
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  }

  /** Douglas–Peucker: drops points that are within `tol` meters of the line anyway. */
  function simplify(coords, tol) {
    if (coords.length < 3) return coords.slice();
    const keep = new Uint8Array(coords.length);
    keep[0] = keep[coords.length - 1] = 1;
    const stack = [[0, coords.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let best = -1, far = 0;
      for (let i = s + 1; i < e; i++) {
        const d = offset(coords[i], coords[s], coords[e]);
        if (d > far) { far = d; best = i; }
      }
      if (best >= 0 && far > tol) {
        keep[best] = 1;
        stack.push([s, best], [best, e]);
      }
    }
    return coords.filter((_, i) => keep[i]);
  }

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function toB64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
      if (i + 2 < bytes.length) out += B64[n & 63];
    }
    return out;
  }

  function fromB64(s) {
    const out = [];
    let bits = 0, acc = 0;
    for (const ch of s) {
      const v = B64.indexOf(ch);
      if (v < 0) return null;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((acc >> bits) & 255);
      }
    }
    return out;
  }

  function packPoints(coords) {
    const bytes = [];
    let plat = 0, plng = 0;
    const put = (v) => {
      let z = v < 0 ? -2 * v - 1 : 2 * v; // zigzag
      while (z >= 128) {
        bytes.push((z % 128) | 128);
        z = Math.floor(z / 128);
      }
      bytes.push(z);
    };
    for (const [lng, lat] of coords) {
      const a = Math.round(lat * 1e5), b = Math.round(lng * 1e5);
      put(a - plat);
      put(b - plng);
      plat = a;
      plng = b;
    }
    return toB64(bytes);
  }

  function unpackPoints(s) {
    const bytes = fromB64(s);
    if (!bytes) return null;
    const vals = [];
    let i = 0;
    while (i < bytes.length) {
      let z = 0, mul = 1, b;
      do {
        if (i >= bytes.length) return null;
        b = bytes[i++];
        z += (b & 127) * mul;
        mul *= 128;
      } while (b & 128);
      vals.push(z % 2 ? -(z + 1) / 2 : z / 2);
    }
    if (vals.length % 2) return null;
    const coords = [];
    let lat = 0, lng = 0;
    for (let k = 0; k < vals.length; k += 2) {
      lat += vals[k];
      lng += vals[k + 1];
      coords.push([lng / 1e5, lat / 1e5]);
    }
    return coords;
  }

  /** "v1/<seconds>/<points>/<name>", simplified to within `tol` meters. */
  function encode(drive, tol = 4) {
    const pts = packPoints(simplify(drive.coords, tol));
    return `v1/${Math.round(drive.durationS)}/${pts}/${encodeURIComponent(drive.name || '')}`;
  }

  function decode(s) {
    const m = /^v1\/(\d+)\/([A-Za-z0-9_-]+)\/?(.*)$/.exec(s || '');
    if (!m) return null;
    const coords = unpackPoints(m[2]);
    if (!coords || coords.length < 2) return null;
    let name = '';
    try { name = decodeURIComponent(m[3] || ''); } catch (e) { name = ''; }
    return { durationS: Number(m[1]), coords, name };
  }

  root.JoyrideCodec = { encode, decode, simplify, offset };
})(typeof window !== 'undefined' ? window : globalThis);
