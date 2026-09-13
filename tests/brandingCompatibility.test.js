// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { releaseArtifactPrefix } = require('../scripts/release-artifact-name');
const { artifactNames } = require('../scripts/release-artifacts');
const { selectSignedInstallerUpdate } = require('../src/main/updateTrust');
const { createProtectedUpdateConfig } = require('../src/main/updateTrust');
const pkg = require('../package.json');

test('LAR filenames coexist with immutable pre-rename release names', () => {
  assert.equal(releaseArtifactPrefix('0.3.47'), 'Arma-Reforger-Launcher-0.3.47');
  for (const version of ['0.3.48', '0.3.49', '0.4.0', '1.0.0']) {
    assert.equal(releaseArtifactPrefix(version), `LAR-Launcher-${version}`);
    assert.equal(artifactNames(version, { withLinux: true }).length, 7);
  }
  for (const version of ['../0.3.48', '0.3.48/Setup.exe', '0.3.048', '0.3.48\n']) {
    assert.throws(() => releaseArtifactPrefix(version));
  }
});

test('existing updater accepts the renamed Setup with its version, digest and size', () => {
  const info = { version: '0.3.48', files: [{ url: 'LAR-Launcher-0.3.48-x64-Setup.exe', sha512: Buffer.alloc(64, 1).toString('base64'), size: 100_000 }] };
  assert.equal(selectSignedInstallerUpdate(info).artifactName, 'LAR-Launcher-0.3.48-x64-Setup.exe');
  assert.throws(() => selectSignedInstallerUpdate({ ...info, version: '0.3.49' }));
});

test('display rename preserves existing profile, installer and Linux upgrade identities', () => {
  assert.equal(pkg.build.productName, 'LAR Launcher');
  assert.equal(pkg.name, 'arma-reforger-launcher');
  assert.equal(pkg.productName, undefined, 'Runtime package name must retain the existing userData directory');
  assert.equal(pkg.build.appId, 'app.armareforger.launcher');
  assert.equal(pkg.build.linux.executableName, 'arma-reforger-launcher');
  assert.equal(createProtectedUpdateConfig('').updaterCacheDirName, 'arma-reforger-launcher-updater');
});
