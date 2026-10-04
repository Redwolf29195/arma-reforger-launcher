// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const removalPlan = require('./no-updates-transform.json');

const UPDATER_FILES = [
  'src/main/updateCheckScheduler.js',
  'src/main/fastUpdater.js', 'src/main/updateTrust.js', 'src/main/updateArtifactFetch.js',
  'src/core/updateArtifactSignature.js', 'src/core/updateDeadlineStore.js',
  'src/core/updateDownload.js', 'src/core/updateError.js', 'src/core/updatePolicy.js',
  'src/core/updatePush.js', 'src/security/release-public-key.pem', 'src/security/app-update.yml'
];

// Apply audited, exact source changes while retaining all unrelated common code.
// Fail closed when updater code changes: a disabled updater must not slip into this build.
async function removeLauncherUpdates(appRoot) {
  for (const { file, changes } of removalPlan.transforms) {
    const target = path.join(appRoot, file);
    let source = (await fs.readFile(target, 'utf8')).replace(/\r\n/g, '\n');
    for (const { before, after } of changes) {
      if (!before || source.split(before).length !== 2) {
        throw new Error(`No-updates removal plan needs review: ${file}`);
      }
      source = source.replace(before, after);
    }
    await fs.writeFile(target, source);
  }
  for (const file of UPDATER_FILES) await fs.rm(path.join(appRoot, file), { force: true });
}

module.exports = { removeLauncherUpdates, UPDATER_FILES };
