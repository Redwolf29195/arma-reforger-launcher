// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { removeLauncherUpdates } = require('./no-updates-build');

const projectRoot = path.resolve(__dirname, '..');
// These tests exercise distribution metadata or the intentionally removed updater.
const excluded = /^(?:update.*|mandatoryUpdate.*|fastUpdater|buildIdentity|brandingCompatibility|openSourceBuild|noUpdatesBuild|publicSourceAudit|releaseArtifacts|verifyPublicRelease|runtimeHardening)\.test\.js$/;

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lar-no-updates-tests-'));
  try {
    await fs.cp(path.join(projectRoot, 'src'), path.join(temporaryRoot, 'src'), { recursive: true });
    await removeLauncherUpdates(temporaryRoot);
    await fs.cp(path.join(projectRoot, 'support'), path.join(temporaryRoot, 'support'), { recursive: true });
    const metadata = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    metadata.dependencies = {};
    await fs.writeFile(path.join(temporaryRoot, 'package.json'), JSON.stringify(metadata));
    await fs.mkdir(path.join(temporaryRoot, 'tests'));
    await fs.mkdir(path.join(temporaryRoot, 'scripts'));
    await fs.copyFile(path.join(projectRoot, 'scripts', 'linux-package-smoke.js'),
      path.join(temporaryRoot, 'scripts', 'linux-package-smoke.js'));
    const files = (await fs.readdir(path.join(projectRoot, 'tests')))
      .filter(file => file.endsWith('.test.js') && !excluded.test(file)).sort();
    for (const file of files) {
      await fs.copyFile(path.join(projectRoot, 'tests', file), path.join(temporaryRoot, 'tests', file));
    }
    process.stdout.write(`Testing ${files.length} common test files against source without launcher updates.\n`);
    const args = ['--test', '--test-skip-pattern', 'enables automatic updates by default',
      ...files.map(file => path.join('tests', file))];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: temporaryRoot, stdio: 'inherit', windowsHide: true
      });
      child.once('error', reject);
      child.once('exit', value => resolve(value ?? 1));
    });
    process.exitCode = code;
  } finally {
    const tempParent = path.resolve(os.tmpdir());
    if (path.dirname(temporaryRoot) !== tempParent
        || !path.basename(temporaryRoot).startsWith('lar-no-updates-tests-')) {
      throw new Error('Unsafe temporary test cleanup path.');
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
