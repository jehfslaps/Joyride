// Creates (setup) and removes (cleanup) a short-lived App Store signing
// certificate and provisioning profile through the App Store Connect API, so
// the build can be signed without a Mac, a registered iPhone, or an Admin key.
//
//   node asc-signing.mjs setup <bundleId> <csr.pem> <outDir>
//   node asc-signing.mjs cleanup <outDir>
//
// Needs ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH in the environment.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.appstoreconnect.apple.com/v1';
const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH } = process.env;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' }));
  const key = fs.readFileSync(ASC_KEY_PATH, 'utf8');
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(sig)}`;
}

async function call(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`::error::App Store Connect ${method} ${url} failed (${res.status}): ${text}`);
    throw new Error(`HTTP ${res.status}`);
  }
  return text ? JSON.parse(text) : {};
}

async function setup(bundleId, csrPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const ids = await call('GET', `/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=200`);
  const bundle = ids.data.find((b) => b.attributes.identifier === bundleId);
  if (!bundle) throw new Error(`Bundle ID ${bundleId} isn't registered`);
  console.log(`Bundle ID ${bundleId} found`);

  const csr = fs.readFileSync(csrPath, 'utf8');
  const cert = await call('POST', '/certificates', {
    data: { type: 'certificates', attributes: { certificateType: 'DISTRIBUTION', csrContent: csr } },
  });
  const certId = cert.data.id;
  fs.writeFileSync(path.join(outDir, 'cert-id'), certId);
  fs.writeFileSync(path.join(outDir, 'dist.cer'), Buffer.from(cert.data.attributes.certificateContent, 'base64'));
  console.log(`Created distribution certificate ${certId}`);

  const name = `Joyride CI ${process.env.GITHUB_RUN_ID ?? Date.now()}`;
  const prof = await call('POST', '/profiles', {
    data: {
      type: 'profiles',
      attributes: { name, profileType: 'IOS_APP_STORE' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundle.id } },
        certificates: { data: [{ type: 'certificates', id: certId }] },
      },
    },
  });
  fs.writeFileSync(path.join(outDir, 'profile-id'), prof.data.id);
  fs.writeFileSync(path.join(outDir, 'profile-name'), name);
  fs.writeFileSync(path.join(outDir, 'profile-uuid'), prof.data.attributes.uuid);
  fs.writeFileSync(path.join(outDir, 'app.mobileprovision'), Buffer.from(prof.data.attributes.profileContent, 'base64'));
  console.log(`Created App Store profile "${name}"`);
}

async function cleanup(outDir) {
  const read = (f) => { try { return fs.readFileSync(path.join(outDir, f), 'utf8').trim(); } catch { return ''; } };
  const profileId = read('profile-id');
  const certId = read('cert-id');
  if (profileId) await call('DELETE', `/profiles/${profileId}`).then(() => console.log('Removed profile')).catch(() => {});
  if (certId) await call('DELETE', `/certificates/${certId}`).then(() => console.log('Revoked certificate')).catch(() => {});
}

const [cmd, ...args] = process.argv.slice(2);
(cmd === 'setup' ? setup(...args) : cleanup(...args)).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
