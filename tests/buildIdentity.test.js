const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BUILD_INFO_SCHEMA, BUILD_INFO_RELATIVE_PATH, readBuildIdentity } = require('../src/core/buildIdentity');

const VERSION = '0.3.43';

async function createBuildFixture(context, metadata) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-open-build-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'app.asar');
  const sourceFile = path.join(appPath, 'src', 'core', 'launcher.js');
  const bridgeFile = path.join(root, 'resources', 'launcher-addons', 'ALGZLauncherWorkshopBridge', 'Scripts', 'Game', 'Bridge.c');
  const metadataPath = path.join(appPath, 'src', BUILD_INFO_RELATIVE_PATH);
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.mkdir(path.dirname(bridgeFile), { recursive: true });
  await fs.writeFile(sourceFile, 'module.exports = "community";\n');
  await fs.writeFile(bridgeFile, '// Editable bridge\n');
  if (metadata !== undefined) {
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(metadataPath, typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  }
  return { appPath, sourceFile, bridgeFile, metadataPath };
}

function inspect(fixture, overrides = {}) {
  return readBuildIdentity({ appPath: fixture.appPath, version: VERSION, packaged: true, platform: 'linux', ...overrides });
}

function buildMetadata(overrides = {}) {
  return { schema: BUILD_INFO_SCHEMA, version: VERSION, releaseTier: 'community', ...overrides };
}

test('community packages run without build metadata, manifests or release keys', async (context) => {
  const fixture = await createBuildFixture(context);
  const identity = await inspect(fixture);
  assert.equal(identity.status, 'open-source');
  assert.equal(identity.releaseTier, 'community');
  assert.equal(identity.license, 'GPL-3.0-only');
  assert.equal(identity.authenticode, 'not-applicable');
  await assert.rejects(fs.access(path.join(fixture.appPath, 'src', 'security', 'release-public-key.pem')));
});

test('accepts unsigned informational community metadata', async (context) => {
  const fixture = await createBuildFixture(context, buildMetadata({ buildId: 'community-123', builtAt: '2026-09-08T10:00:00Z' }));
  const identity = await inspect(fixture);
  assert.equal(identity.status, 'open-source');
  assert.equal(identity.releaseTier, 'community');
  assert.equal(identity.buildId, 'community-123');
  assert.equal(identity.builtAt, '2026-09-08T10:00:00Z');
  assert.equal('internalSignature' in identity, false);
  assert.equal('sourceIntegrity' in identity, false);
});

test('modified installed JavaScript, added modules and edited bridge remain usable', async (context) => {
  const fixture = await createBuildFixture(context, buildMetadata({ releaseTier: 'public-unsigned' }));
  const before = await inspect(fixture);
  await fs.appendFile(fixture.sourceFile, 'module.exports = "my fork";\n');
  await fs.writeFile(path.join(path.dirname(fixture.sourceFile), 'communityFeature.js'), 'module.exports = true;\n');
  await fs.writeFile(fixture.bridgeFile, '// Community bridge customization\n');
  const after = await inspect(fixture);
  assert.deepEqual(after, before);
  assert.equal(after.status, 'open-source');
  assert.equal(after.releaseTier, 'public-unsigned');
});

test('author, origin and old signature fields cannot restrict a community build', async (context) => {
  const fixture = await createBuildFixture(context, buildMetadata({
    owner: 'Community maintainer', originId: 'my-fork', signature: 'not-a-signature', sourceSha256: 'edited'
  }));
  assert.equal((await inspect(fixture)).status, 'open-source');
});

test('missing, malformed, oversized or incompatible metadata falls back to community', async (context) => {
  for (const metadata of [
    '{', ' '.repeat(65537), [], null,
    buildMetadata({ schema: 2 }), buildMetadata({ version: '9.9.9' }),
    buildMetadata({ releaseTier: 'unknown' }), buildMetadata({ releaseTier: 'public' }),
    buildMetadata({ releaseTier: 'public-unsigned', windowsPublisher: 'CN=Unexpected' })
  ]) {
    const fixture = await createBuildFixture(context, metadata);
    const identity = await inspect(fixture);
    assert.equal(identity.status, 'open-source');
    assert.equal(identity.releaseTier, 'community');
  }
});

test('Windows signature failures do not prevent running or classify edited builds as tampered', async (context) => {
  const fixture = await createBuildFixture(context, buildMetadata({ releaseTier: 'public-unsigned' }));
  for (const status of ['notsigned', 'hashmismatch', 'unavailable']) {
    const identity = await inspect(fixture, { platform: 'win32', inspectSignature: async () => ({ status }) });
    assert.equal(identity.status, 'open-source');
    assert.equal(identity.releaseTier, 'public-unsigned');
  }
  const unavailable = await inspect(fixture, { platform: 'win32', inspectSignature: async () => { throw new Error('unavailable'); } });
  assert.equal(unavailable.status, 'open-source');
  assert.equal(unavailable.authenticode, 'unavailable');
});

test('signed distribution metadata configures updates without asserting source authenticity', async (context) => {
  const fixture = await createBuildFixture(context, buildMetadata({
    releaseTier: 'public', windowsPublisher: 'CN=ALGZ Publisher', windowsCertificateThumbprint: 'a'.repeat(40)
  }));
  const identity = await inspect(fixture, { platform: 'win32', inspectSignature: async () => ({ status: 'notsigned' }) });
  assert.equal(identity.status, 'open-source');
  assert.equal(identity.releaseTier, 'public');
  assert.equal(identity.windowsPublisher, 'CN=ALGZ Publisher');
  assert.equal(identity.windowsCertificateThumbprint, 'A'.repeat(40));
  assert.equal(identity.authenticode, 'unsigned');
});

test('reports an actual Windows signature separately from unsigned build metadata', async (context) => {
  const fixture = await createBuildFixture(context, buildMetadata());
  const identity = await inspect(fixture, { platform: 'win32', inspectSignature: async () => ({ status: 'Valid', subject: 'CN=Community Author' }) });
  assert.equal(identity.status, 'open-source');
  assert.equal(identity.authenticode, 'verified');
  assert.equal(identity.signer, 'CN=Community Author');
});

test('development mode needs neither packaged metadata nor executable signature inspection', async () => {
  const identity = await readBuildIdentity({
    appPath: '.', version: VERSION, packaged: false, platform: 'win32',
    inspectSignature: () => { throw new Error('Should not inspect development executable'); }
  });
  assert.equal(identity.status, 'development');
  assert.equal(identity.releaseTier, 'development');
  assert.equal(identity.license, 'GPL-3.0-only');
  assert.equal(identity.authenticode, 'development');
});
