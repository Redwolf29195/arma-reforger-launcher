const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { UPDATE_CHANNEL_URL } = require('../src/core/buildIdentity');
const {
  PROTECTED_UPDATE_CONFIG_RELATIVE_PATH,
  UPDATE_CACHE_DIRECTORY_NAME,
  createProtectedUpdateConfig,
  createUpdateTrustPolicy,
  resolveProtectedUpdateConfigPath,
  selectSignedInstallerUpdate,
  serializeProtectedUpdateConfig
} = require('../src/main/updateTrust');

const projectRoot = path.resolve(__dirname, '..');
const packagedAppPath = path.join('C:\\', 'Program Files', 'ALGZ', 'resources', 'app.asar');

test('explicit public distribution metadata enables signed NSIS updates', () => {
  const policy = createUpdateTrustPolicy({
    appPath: packagedAppPath,
    packaged: true,
    buildIdentity: { status: 'open-source', releaseTier: 'public', windowsPublisher: 'CN=ALGZ', windowsCertificateThumbprint: 'A'.repeat(40) },
    portableExecutableFile: ''
  });

  assert.equal(policy.enabled, true);
  assert.equal(policy.portable, false);
  assert.equal(policy.verificationMode, 'authenticode');
  assert.equal(
    policy.updateConfigPath,
    path.join(path.resolve(packagedAppPath), PROTECTED_UPDATE_CONFIG_RELATIVE_PATH)
  );
});

test('community, development and malformed distribution metadata do not opt into official updates', () => {
  const deniedIdentities = [
    null,
    { status: 'development', releaseTier: 'development' },
    { status: 'open-source', releaseTier: 'community' },
    { status: 'open-source', releaseTier: 'unknown' },
    { status: 'open-source', releaseTier: 'public' },
    { status: 'open-source', releaseTier: 'public', windowsPublisher: 'CN=ALGZ', windowsCertificateThumbprint: 'invalid' }
  ];

  for (const buildIdentity of deniedIdentities) {
    assert.equal(createUpdateTrustPolicy({
      appPath: packagedAppPath,
      packaged: true,
      buildIdentity,
      portableExecutableFile: ''
    }).enabled, false);
  }
  assert.equal(createUpdateTrustPolicy({
    appPath: packagedAppPath,
    packaged: false,
    buildIdentity: { status: 'open-source', releaseTier: 'public-unsigned' },
    portableExecutableFile: ''
  }).enabled, false);
  assert.equal(createUpdateTrustPolicy({
    appPath: path.join(projectRoot, 'src'),
    packaged: true,
    buildIdentity: { status: 'open-source', releaseTier: 'public-unsigned' },
    portableExecutableFile: ''
  }).enabled, false);
});

test('public-unsigned distribution requires Ed25519 verification of downloaded installers', () => {
  const policy = createUpdateTrustPolicy({
    appPath: packagedAppPath,
    packaged: true,
    buildIdentity: { status: 'open-source', releaseTier: 'public-unsigned' },
    portableExecutableFile: ''
  });

  assert.equal(policy.enabled, true);
  assert.equal(policy.portable, false);
  assert.equal(policy.verificationMode, 'algz-ed25519');
});

test('keeps Portable builds out of the NSIS updater flow', () => {
  const policy = createUpdateTrustPolicy({
    appPath: packagedAppPath,
    packaged: true,
    buildIdentity: { status: 'open-source', releaseTier: 'public-unsigned' },
    portableExecutableFile: 'C:\\Downloads\\Arma-Reforger-Launcher-0.3.27-x64-Portable.exe'
  });

  assert.equal(policy.enabled, false);
  assert.equal(policy.portable, true);
  assert.equal(policy.verificationMode, 'disabled');
});

test('builds a pinned JSON-as-YAML updater config with mandatory publisher metadata', () => {
  const publisher = 'CN=ALGZ, O=ALGZ';
  const config = createProtectedUpdateConfig(publisher);
  const serialized = serializeProtectedUpdateConfig(`  ${publisher}  `);

  assert.deepEqual(config, {
    provider: 'generic',
    url: UPDATE_CHANNEL_URL,
    updaterCacheDirName: UPDATE_CACHE_DIRECTORY_NAME,
    publisherName: [publisher]
  });
  assert.deepEqual(JSON.parse(serialized), config);
  assert.deepEqual(createProtectedUpdateConfig('').publisherName, []);
  assert.throws(() => resolveProtectedUpdateConfigPath(''), /Packaged application path is required/);
});

test('official update selection does not claim that metadata authenticates source files', () => {
  const policy = createUpdateTrustPolicy({
    appPath: packagedAppPath,
    packaged: true,
    buildIdentity: { releaseTier: 'public-unsigned' }
  });
  assert.equal(policy.enabled, true);
  assert.equal(policy.verificationMode, 'algz-ed25519');
});

test('selects exactly one bounded Setup artifact from updater metadata', () => {
  const sha512 = Buffer.alloc(64, 0x2a).toString('base64');
  assert.deepEqual(selectSignedInstallerUpdate({
    version: '0.3.27',
    files: [{
      url: 'Arma-Reforger-Launcher-0.3.27-x64-Setup.exe',
      sha512,
      size: 123456
    }]
  }), {
    artifactName: 'Arma-Reforger-Launcher-0.3.27-x64-Setup.exe',
    sha512,
    size: 123456,
    version: '0.3.27'
  });

  for (const updateInfo of [
    { version: '../0.3.27', files: [] },
    { version: '0.3.27', files: [{ url: '../evil-Setup.exe', sha512, size: 1 }] },
    { version: '0.3.27', files: [{ url: 'Arma-Reforger-Launcher-9.9.9-x64-Setup.exe', sha512, size: 1 }] },
    { version: '0.3.27', files: [{ url: 'Arma-Reforger-Launcher-0.3.27-x64-Setup.exe', sha512: 'bad', size: 1 }] },
    { version: '0.3.27', files: [
      { url: 'Arma-Reforger-Launcher-0.3.27-x64-Setup.exe', sha512, size: 1 },
      { url: 'Arma-Reforger-Launcher-0.3.27-arm64-Setup.exe', sha512, size: 1 }
    ] }
  ]) {
    assert.throws(() => selectSignedInstallerUpdate(updateInfo), /update-artifact-metadata/);
  }
});
