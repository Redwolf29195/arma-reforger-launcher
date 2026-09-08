const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Core Ed25519 verification is tested separately. This executes the real main
// cache orchestration with controlled fetch/verification results, no keys/files.
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const first = source.indexOf('async function loadUpdateEnvelope(');
const last = source.indexOf('async function verifyDownloadedUpdate(', first);
assert.ok(first >= 0 && last > first);

const descriptor = {
  version: '0.9.9', artifactName: 'Arma-Reforger-Launcher-0.9.9-x64-Setup.exe',
  sha512: 'first-hash', size: 123
};
function runtime({ fetch, verify }) {
  const requests = [];
  const verifications = [];
  const context = vm.createContext({
    updateEnvelopeCache: null,
    selectSignedInstallerUpdate: info => info,
    fetchUpdateArtifactEnvelope: async request => { requests.push(request); return fetch(request); },
    fs: { readFile: async () => 'mock public key' },
    PINNED_PUBLIC_KEY_PATH: 'mock-public-key.pem',
    verifyUpdateArtifactFile: async request => { verifications.push(request); return verify(request); },
    Promise, Error
  });
  vm.runInContext(source.slice(first, last), context, { filename: 'main-envelope-cache-integration.js' });
  return {
    context, requests, verifications,
    verify: (info = descriptor) => context.verifyAlgzUpdateArtifact(info, 'mock-installer.exe')
  };
}

test('an invalid fetched envelope does not poison a later retry with a healthy transport', async () => {
  let fetched = 0;
  const app = runtime({
    fetch: () => ++fetched === 1 ? 'invalid-envelope' : 'valid-envelope',
    verify: request => {
      if (request.envelope !== 'valid-envelope') throw new Error('update-artifact-signature');
      return { verified: true };
    }
  });
  await assert.rejects(app.verify(), /update-artifact-signature/);
  assert.equal(app.context.updateEnvelopeCache, null);
  assert.equal((await app.verify()).verified, true);
  assert.equal(app.requests.length, 2);
});

test('only a successful verification populates the cache and every file is still verified', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  const app = runtime({
    fetch: () => 'valid-envelope',
    verify: async () => { if (++attempts === 1) { entered(); await pending; } return { verified: true }; }
  });
  const verification = app.verify();
  await started;
  assert.equal(app.context.updateEnvelopeCache, null);
  release();
  await verification;
  await app.verify();
  assert.equal(app.requests.length, 1);
  assert.equal(app.verifications.length, 2);
});

test('same version and artifact name with changed hash or size never reuse the old envelope', async () => {
  const app = runtime({ fetch: () => 'envelope', verify: () => ({ verified: true }) });
  await app.verify();
  await app.verify({ ...descriptor, sha512: 'different-hash' });
  await app.verify({ ...descriptor, sha512: 'different-hash', size: 456 });
  assert.equal(app.requests.length, 3);
});

test('failure of an older pending verification cannot evict a different verified envelope', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise((_resolve, reject) => { release = reject; });
  let fetched = 0;
  const app = runtime({
    fetch: () => ++fetched === 1 ? 'older-envelope' : 'newer-envelope',
    verify: async request => {
      if (request.envelope === 'older-envelope') { entered(); await pending; }
      return { verified: true };
    }
  });
  const older = app.verify();
  await started;
  const newerDescriptor = { ...descriptor, version: '0.9.10', artifactName: 'Arma-Reforger-Launcher-0.9.10-x64-Setup.exe' };
  await app.verify(newerDescriptor);
  release(new Error('old signature rejected'));
  await assert.rejects(older, /old signature rejected/);
  await app.verify(newerDescriptor);
  assert.equal(app.requests.length, 2);
  assert.equal(app.context.updateEnvelopeCache.contents, 'newer-envelope');
});
