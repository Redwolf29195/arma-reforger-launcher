// SPDX-License-Identifier: GPL-3.0-only
const { build } = require('./package.json');

module.exports = {
  ...build,
  directories: { ...build.directories, output: 'dist-no-updates/${version}' },
  files: [...build.files, '!node_modules{,/**/*}'],
  publish: null,
  portable: { ...build.portable, artifactName: 'LAR-Launcher-No-Updates-${version}-${arch}-Portable.${ext}' },
  nsis: { ...build.nsis, artifactName: 'LAR-Launcher-No-Updates-${version}-${arch}-Setup.${ext}' }
};
