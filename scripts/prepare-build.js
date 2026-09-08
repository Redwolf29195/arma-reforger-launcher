// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { serializeProtectedUpdateConfig } = require('../src/main/updateTrust');

async function prepareBuild(projectRoot, argumentsList = [], environment = process.env) {
  projectRoot = path.resolve(projectRoot);
  const publicBuild = argumentsList.includes('--public');
  const publicUnsignedBuild = argumentsList.includes('--public-unsigned');
  if (argumentsList.some((item) => !['--public', '--public-unsigned'].includes(item))) {
    throw new Error('Usage: node scripts/prepare-build.js [--public | --public-unsigned]');
  }
  if (publicBuild && publicUnsignedBuild) throw new Error('Choose either --public or --public-unsigned, not both.');
  const metadata = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(metadata.version)) {
    throw new Error('A valid release version is required.');
  }
  const windowsPublisher = publicBuild ? String(environment.ALGZ_WINDOWS_PUBLISHER || '').trim() : '';
  const windowsCertificateThumbprint = publicBuild
    ? String(environment.ALGZ_WINDOWS_CERTIFICATE_THUMBPRINT || '').replace(/\s/g, '').toUpperCase() : '';
  if (publicBuild && (!windowsPublisher || !/^[0-9A-F]{40,128}$/.test(windowsCertificateThumbprint))) {
    throw new Error('Public Windows builds require ALGZ_WINDOWS_PUBLISHER and ALGZ_WINDOWS_CERTIFICATE_THUMBPRINT.');
  }
  const stagingRoot = path.resolve(projectRoot, '.build');
  if (stagingRoot !== path.join(projectRoot, '.build') || !stagingRoot.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error('Unsafe build staging path.');
  }
  // Do not follow a replaced staging directory or delete through a dependency junction.
  try {
    if ((await fs.lstat(stagingRoot)).isSymbolicLink()) throw new Error('Build staging must not be a link.');
    const appRoot = path.join(stagingRoot, 'app');
    try {
      if ((await fs.lstat(appRoot)).isSymbolicLink()) throw new Error('Staged app must not be a link.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      const modules = path.join(appRoot, 'node_modules');
      if ((await fs.lstat(modules)).isSymbolicLink()) await fs.unlink(modules);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.access(path.join(projectRoot, 'node_modules'));
  await fs.rm(stagingRoot, { recursive: true, force: true });
  const stagedAppRoot = path.join(stagingRoot, 'app');
  await fs.mkdir(stagedAppRoot, { recursive: true });
  await fs.cp(path.join(projectRoot, 'src'), path.join(stagedAppRoot, 'src'), { recursive: true, errorOnExist: true, force: false });
  await fs.cp(path.join(projectRoot, 'support', 'ALGZLauncherWorkshopBridge'),
    path.join(stagedAppRoot, 'launcher-addons', 'ALGZLauncherWorkshopBridge'), { recursive: true, errorOnExist: true, force: false });
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.copyFile(path.join(projectRoot, name), path.join(stagedAppRoot, name));
  const stagedPackage = Object.fromEntries(['name', 'version', 'description', 'main', 'private', 'author', 'license', 'homepage', 'repository', 'dependencies']
    .filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]));
  await fs.writeFile(path.join(stagedAppRoot, 'package.json'), `${JSON.stringify(stagedPackage, null, 2)}\n`);
  await fs.symlink(path.join(projectRoot, 'node_modules'), path.join(stagedAppRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const securityRoot = path.join(stagedAppRoot, 'src', 'security');
  await fs.mkdir(securityRoot, { recursive: true });
  await fs.rm(path.join(securityRoot, 'release-manifest.json'), { force: true });
  const buildInfo = {
    schema: 1,
    version: metadata.version,
    releaseTier: publicBuild ? 'public' : publicUnsignedBuild ? 'public-unsigned' : 'community',
    windowsPublisher,
    windowsCertificateThumbprint
  };
  await fs.writeFile(path.join(securityRoot, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
  await fs.writeFile(path.join(securityRoot, 'app-update.yml'), serializeProtectedUpdateConfig(windowsPublisher));
  return { ...buildInfo, stagedAppRoot };
}

module.exports = { prepareBuild };
if (require.main === module) {
  prepareBuild(path.resolve(__dirname, '..'), process.argv.slice(2))
    .then((result) => process.stdout.write(`Prepared readable ${result.releaseTier} build ${result.version}: ${result.stagedAppRoot}\n`))
    .catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}
