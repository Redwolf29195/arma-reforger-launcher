const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { transferPresetMods } = require('../src/core/presetTransfer');

const mainId = '646B350F36C6D3E4';
const dependencyId = '5994AD5A9F33BE57';

async function createFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-transfer-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const addonsDirectory = path.join(root, 'addons');
  const destinationDirectory = path.join(root, 'destination');
  const mainDirectory = path.join(addonsDirectory, `Main_${mainId}`);
  const dependencyDirectory = path.join(addonsDirectory, `Dependency_${dependencyId}`);
  await fs.mkdir(mainDirectory, { recursive: true });
  await fs.mkdir(dependencyDirectory, { recursive: true });
  await fs.writeFile(path.join(mainDirectory, 'main.pak'), 'main');
  await fs.writeFile(path.join(dependencyDirectory, 'dependency.pak'), 'dependency');
  const installedMods = [
    {
      modId: mainId,
      name: 'Main',
      directoryPath: mainDirectory,
      dependencies: [{ modId: dependencyId, name: 'Dependency', version: '1.0.0' }]
    },
    { modId: dependencyId, name: 'Dependency', directoryPath: dependencyDirectory, dependencies: [] }
  ];
  const preset = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Transfer test',
    mods: [{ modId: mainId, name: 'Main', version: '1.0.0' }]
  };
  return { addonsDirectory, destinationDirectory, mainDirectory, dependencyDirectory, installedMods, preset };
}

test('copies a preset and its dependencies while keeping addons intact', async (context) => {
  const fixture = await createFixture(context);
  const result = await transferPresetMods({ ...fixture, mode: 'copy', includeDependencies: true });

  assert.equal(result.transferredCount, 2);
  assert.equal(result.dependencyCount, 1);
  assert.equal(result.removedCount, 0);
  assert.equal(await fs.readFile(path.join(fixture.destinationDirectory, path.basename(fixture.mainDirectory), 'main.pak'), 'utf8'), 'main');
  assert.equal(await fs.readFile(path.join(fixture.mainDirectory, 'main.pak'), 'utf8'), 'main');
});

test('moves a preset only after copying it to the selected folder', async (context) => {
  const fixture = await createFixture(context);
  const result = await transferPresetMods({ ...fixture, mode: 'move', includeDependencies: false });

  assert.equal(result.transferredCount, 1);
  assert.equal(result.removedCount, 1);
  assert.equal(await fs.readFile(path.join(fixture.destinationDirectory, path.basename(fixture.mainDirectory), 'main.pak'), 'utf8'), 'main');
  await assert.rejects(fs.stat(fixture.mainDirectory), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(fixture.dependencyDirectory, 'dependency.pak'), 'utf8'), 'dependency');
});

test('refuses a destination inside addons and preserves the original mod', async (context) => {
  const fixture = await createFixture(context);
  await assert.rejects(transferPresetMods({
    ...fixture,
    destinationDirectory: path.join(fixture.addonsDirectory, 'export'),
    mode: 'move'
  }), /вне текущей папки addons/);
  assert.equal(await fs.readFile(path.join(fixture.mainDirectory, 'main.pak'), 'utf8'), 'main');
});

test('refuses to overwrite an existing destination mod', async (context) => {
  const fixture = await createFixture(context);
  const conflict = path.join(fixture.destinationDirectory, path.basename(fixture.mainDirectory));
  await fs.mkdir(conflict, { recursive: true });
  await fs.writeFile(path.join(conflict, 'keep.txt'), 'keep');

  await assert.rejects(transferPresetMods({ ...fixture, mode: 'move' }), /уже существует мод/);
  assert.equal(await fs.readFile(path.join(conflict, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(fixture.mainDirectory, 'main.pak'), 'utf8'), 'main');
});

test('refuses nested destinations whose directory name begins with two dots', async (context) => {
  const fixture = await createFixture(context);
  await assert.rejects(transferPresetMods({
    ...fixture,
    destinationDirectory: path.join(fixture.addonsDirectory, '..exports'),
    mode: 'move'
  }), /вне текущей папки addons/);
  assert.equal(await fs.readFile(path.join(fixture.mainDirectory, 'main.pak'), 'utf8'), 'main');
});
