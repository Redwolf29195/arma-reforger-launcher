const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { removeInstalledMod } = require('../src/core/modManager');

test('deletes only the selected direct child of the addons directory', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-delete-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const modId = '646B350F36C6D3E4';
  const modDirectory = path.join(root, `Example_${modId}`);
  const siblingDirectory = path.join(root, 'Keep_618C2492CC62D0D5');
  await fs.mkdir(modDirectory);
  await fs.mkdir(siblingDirectory);
  await fs.writeFile(path.join(modDirectory, 'data.pak'), 'mod');

  const result = await removeInstalledMod({
    addonsDirectory: root,
    installedMods: [{ modId, name: 'Example', directoryPath: modDirectory }],
    modId
  });

  assert.equal(result.modId, modId);
  await assert.rejects(fs.stat(modDirectory), { code: 'ENOENT' });
  assert.equal((await fs.stat(siblingDirectory)).isDirectory(), true);
});

test('refuses to delete a directory outside the configured addons root', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-delete-guard-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const addonsDirectory = path.join(root, 'addons');
  const outsideDirectory = path.join(root, 'outside');
  const modId = '646B350F36C6D3E4';
  await fs.mkdir(addonsDirectory);
  await fs.mkdir(outsideDirectory);

  await assert.rejects(removeInstalledMod({
    addonsDirectory,
    installedMods: [{ modId, name: 'Outside', directoryPath: outsideDirectory }],
    modId
  }), /вне настроенной папки addons/);
  assert.equal((await fs.stat(outsideDirectory)).isDirectory(), true);
});
