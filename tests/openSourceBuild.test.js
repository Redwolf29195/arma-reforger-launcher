// SPDX-License-Identifier: GPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareBuild } = require('../scripts/prepare-build');
const packageMetadata = require('../package.json');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-open-build-'));
  t.after(async () => {
    const modules = path.join(root, '.build', 'app', 'node_modules');
    try { if ((await fs.lstat(modules)).isSymbolicLink()) await fs.unlink(modules); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}algz-open-build-`));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const dir of ['src/security', 'support/ALGZLauncherWorkshopBridge/Scripts/Game', 'node_modules']) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(packageMetadata));
  await fs.writeFile(path.join(root, 'src', 'sample.js'), '// Custom editable source\r\nconst customName = "community";\r\n');
  await fs.writeFile(path.join(root, 'support/ALGZLauncherWorkshopBridge/Scripts/Game/bridge.c'), '// Keep comments\r\nclass ALGZ_Example {};\r\n');
  await fs.writeFile(path.join(root, 'LICENSE'), 'Fixture license');
  await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'Fixture notices');
  await fs.writeFile(path.join(root, 'node_modules', 'sentinel.txt'), 'Keep dependencies');
  return root;
}

test('community builds need no private key and preserve modified source and bridge bytes', async (t) => {
  const root = await fixture(t);
  const result = await prepareBuild(root, [], { ALGZ_RELEASE_PRIVATE_KEY_FILE: path.join(root, 'does-not-exist.pem') });
  assert.equal(result.releaseTier, 'community');
  for (const [source, output] of [
    ['src/sample.js', 'src/sample.js'],
    ['support/ALGZLauncherWorkshopBridge/Scripts/Game/bridge.c', 'launcher-addons/ALGZLauncherWorkshopBridge/Scripts/Game/bridge.c']
  ]) assert.deepEqual(await fs.readFile(path.join(root, source)), await fs.readFile(path.join(result.stagedAppRoot, output)));
  const metadata = JSON.parse(await fs.readFile(path.join(result.stagedAppRoot, 'src/security/build-info.json')));
  assert.equal(metadata.schema, 1);
  assert.equal(metadata.version, packageMetadata.version);
  assert.equal(metadata.signature, undefined);
  await fs.writeFile(path.join(root, 'src/sample.js'), '// A second user modification\n');
  await prepareBuild(root);
  assert.equal(await fs.readFile(path.join(root, 'node_modules/sentinel.txt'), 'utf8'), 'Keep dependencies');
  assert.equal(await fs.readFile(path.join(result.stagedAppRoot, 'src/sample.js'), 'utf8'), '// A second user modification\n');
});

test('public-unsigned preparation remains keyless; signing is a separate release step', async (t) => {
  const root = await fixture(t);
  const result = await prepareBuild(root, ['--public-unsigned'], {});
  assert.equal(result.releaseTier, 'public-unsigned');
  await assert.rejects(prepareBuild(root, ['--public', '--public-unsigned']), /either/);
  await assert.rejects(prepareBuild(root, ['--public'], {}), /ALGZ_WINDOWS_PUBLISHER/);
});

test('publishes GPL source, packages its notices, and removes obfuscation dependencies', async () => {
  assert.equal(packageMetadata.license, 'GPL-3.0-only');
  assert.equal(packageMetadata.devDependencies['javascript-obfuscator'], undefined);
  assert.equal(packageMetadata.build.directories.app, '.build/app');
  assert.ok(packageMetadata.build.files.includes('LICENSE'));
  assert.ok(packageMetadata.build.files.includes('THIRD_PARTY_NOTICES.md'));
  assert.deepEqual(packageMetadata.algzUpdatePolicy, { mode: 'optional', gracePeriodSeconds: 0 });
  const license = await fs.readFile(path.join(__dirname, '..', 'LICENSE'), 'utf8');
  assert.match(license, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 29 June 2007/);
});
