// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const assert = require('node:assert/strict');

function releaseArtifactPrefix(version) {
  assert.match(version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.equal(version, version.trim());
  const [major, minor, patch] = version.split('.').map(Number);
  // Keep verification of immutable historical releases possible after the rename.
  const lar = major > 0 || minor > 3 || (minor === 3 && patch >= 48);
  return `${lar ? 'LAR-Launcher' : 'Arma-Reforger-Launcher'}-${version}`;
}

module.exports = { releaseArtifactPrefix };
