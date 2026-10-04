// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const builderRequire = createRequire(require.resolve('electron-builder'));
const asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar');
const { UPDATER_FILES } = require('../scripts/no-updates-build');
const plan = require('../scripts/no-updates-transform.json');

const [normalPath, noUpdatesPath, reportPath] = process.argv.slice(2).map(value => path.resolve(value));
assert(normalPath && noUpdatesPath && reportPath, 'Provide two app.asar paths and the report path');
function files(archive) {
  return asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''))
    .filter(file => !asar.statFile(archive, path.normalize(file)).files);
}
const normalFiles = files(normalPath);
const noFiles = files(noUpdatesPath);
const read = (archive, file) => asar.extractFile(archive, path.normalize(file));
const normalPackage = JSON.parse(read(normalPath, 'package.json'));
const noPackage = JSON.parse(read(noUpdatesPath, 'package.json'));
assert.equal(normalPackage.version, noPackage.version);
assert.equal(normalPackage.version, require('../package.json').version);
assert.equal(normalPackage.name, noPackage.name);
assert.deepEqual(noPackage.dependencies, {});
assert.equal(normalPackage.dependencies['electron-updater'], '6.8.9');
assert(!noFiles.some(file => file.startsWith('node_modules/')), 'No dependency modules may remain in No-Updates');
for (const file of UPDATER_FILES) {
  assert(normalFiles.includes(file), `Normal updater file is missing: ${file}`);
  assert(!noFiles.includes(file), `No-Updates contains updater file: ${file}`);
}
assert(!fs.existsSync(path.join(path.dirname(noUpdatesPath), 'app-update.yml')), 'No-Updates contains an external update feed');
const buildInfo = archive => JSON.parse(read(archive, 'src/security/build-info.json'));
assert.equal(buildInfo(normalPath).launcherUpdates, true);
assert.equal(buildInfo(noUpdatesPath).launcherUpdates, false);
const transformed = new Set(plan.transforms.map(item => item.file));
for (const { file, changes } of plan.transforms) {
  let source = read(normalPath, file).toString().replace(/\r\n/g, '\n');
  for (const { before, after } of changes) {
    assert.equal(source.split(before).length, 2, `Ambiguous packaged removal patch: ${file}`);
    source = source.replace(before, after);
  }
  assert.equal(read(noUpdatesPath, file).toString(), source, `Unreviewed variant difference: ${file}`);
}
const commonFiles = normalFiles.filter(file => (file.startsWith('src/') || ['LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(file))
  && !transformed.has(file) && !UPDATER_FILES.includes(file) && file !== 'src/security/build-info.json');
for (const file of commonFiles) {
  assert(noFiles.includes(file), `Common packaged file is missing: ${file}`);
  assert.deepEqual(read(normalPath, file), read(noUpdatesPath, file), `Common fix/assets differ: ${file}`);
}
for (const file of noFiles.filter(file => file.startsWith('src/'))) {
  assert(normalFiles.includes(file), `Unexpected No-Updates source file: ${file}`);
}
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { version: normalPackage.version, commonFilesIdentical: commonFiles.length,
  reviewedVariantFiles: transformed.size, removedUpdaterFiles: UPDATER_FILES.length,
  noUpdatesDependencyFiles: 0, noUpdatesExternalFeed: false,
  normalAsarSha256: digest(normalPath), noUpdatesAsarSha256: digest(noUpdatesPath),
  passed: true };
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
