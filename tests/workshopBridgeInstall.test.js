const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  REQUIRED_BRIDGE_FILES,
  WORKSHOP_BRIDGE_DIRECTORY_NAME,
  installWorkshopBridge
} = require('../src/core/workshopBridge');

test('installs and refreshes the Workshop bridge inside the writable game profile', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-bridge-install-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, 'source');
  const profileDirectory = path.join(root, 'launcher-profile');

  for (const relativePath of REQUIRED_BRIDGE_FILES) {
    const filePath = path.join(sourceDirectory, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `fresh:${relativePath}`);
  }

  const first = await installWorkshopBridge({ sourceDirectory, profileDirectory });
  assert.equal(first.addonsDirectory, path.join(profileDirectory, 'profile', 'addons'));
  assert.equal(first.targetDirectory, path.join(first.addonsDirectory, WORKSHOP_BRIDGE_DIRECTORY_NAME));

  const scriptPath = path.join(first.targetDirectory, 'Scripts', 'Game', 'ALGZLauncherWorkshopBridge.c');
  await fs.writeFile(scriptPath, 'broken');
  const repaired = await installWorkshopBridge({ sourceDirectory, profileDirectory });
  assert.equal(await fs.readFile(path.join(repaired.targetDirectory, 'Scripts', 'Game', 'ALGZLauncherWorkshopBridge.c'), 'utf8'),
    `fresh:${path.join('Scripts', 'Game', 'ALGZLauncherWorkshopBridge.c')}`);
});

test('serializes concurrent bridge installations and keeps one complete final revision', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-bridge-stress-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sources = await Promise.all(Array.from({ length: 20 }, async (_, revision) => {
    const sourceDirectory = path.join(root, `source-${revision}`);
    for (const relativePath of REQUIRED_BRIDGE_FILES) {
      const filePath = path.join(sourceDirectory, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `revision:${revision}:${relativePath}`);
    }
    return sourceDirectory;
  }));
  const profileDirectory = path.join(root, 'profile');
  const results = await Promise.allSettled(sources.map((sourceDirectory) => installWorkshopBridge({ sourceDirectory, profileDirectory })));
  assert.equal(results.filter((result) => result.status === 'rejected').length, 0);
  const targetDirectory = results.at(-1).value.targetDirectory;
  for (const relativePath of REQUIRED_BRIDGE_FILES) {
    assert.equal(await fs.readFile(path.join(targetDirectory, relativePath), 'utf8'), `revision:19:${relativePath}`);
  }
});

test('preserves an installed bridge file if its replacement is denied', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-bridge-failure-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, 'source');
  const profileDirectory = path.join(root, 'profile');
  for (const relativePath of REQUIRED_BRIDGE_FILES) {
    const filePath = path.join(sourceDirectory, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `original:${relativePath}`);
  }
  const installed = await installWorkshopBridge({ sourceDirectory, profileDirectory });
  const oldProject = await fs.readFile(installed.projectPath, 'utf8');
  await fs.writeFile(path.join(sourceDirectory, 'addon.gproj'), 'new revision');
  const rename = fs.rename;
  context.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === installed.projectPath) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return rename(source, destination);
  });
  await assert.rejects(installWorkshopBridge({ sourceDirectory, profileDirectory }), { code: 'EACCES' });
  assert.equal(await fs.readFile(installed.projectPath, 'utf8'), oldProject);
  assert.equal((await fs.readdir(installed.targetDirectory)).some((name) => name.endsWith('.tmp')), false);
});
