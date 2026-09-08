const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PresetStore = require('../src/core/presetStore');
const { parsePresetText } = require('../src/core/presetParser');

test('updates an existing preset without creating a new preset', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-preset-edit-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const original = await store.save({
    name: 'Original name',
    mods: [{ modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.10' }]
  });

  const updated = await store.save({
    ...original,
    name: 'Edited name',
    mods: [{ modId: '618C2492CC62D0D5', name: 'Gs BTR-90', version: '3.1.0' }]
  });
  const presets = await store.list();

  assert.equal(updated.id, original.id);
  assert.equal(updated.name, 'Edited name');
  assert.equal(updated.createdAt, original.createdAt);
  assert.deepEqual(updated.mods.map((mod) => mod.modId), ['618C2492CC62D0D5']);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, 'Edited name');
});

test('adds a Workshop mod to the selected preset without changing other presets', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-preset-add-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const target = await store.save({
    name: 'Target',
    mods: [{ modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.10' }]
  });
  const untouched = await store.save({
    name: 'Untouched',
    mods: [{ modId: '618C2492CC62D0D5', name: 'Gs BTR-90', version: '3.1.0' }]
  });

  const result = await store.addMod({
    presetId: target.id,
    mod: { modId: '595F2BF2F44836FB', name: 'RHS - Status Quo', version: '0.16.5150' }
  });

  assert.equal(result.created, false);
  assert.equal(result.preset.id, target.id);
  assert.deepEqual(result.preset.mods.map((mod) => mod.modId), ['646B350F36C6D3E4', '595F2BF2F44836FB']);
  assert.deepEqual(result.presets.find((preset) => preset.id === untouched.id).mods, untouched.mods);
});

test('creates the first preset when adding a Workshop mod to an empty store', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-preset-create-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);

  const result = await store.addMod({
    presetName: 'Workshop picks',
    mod: { modId: '595F2BF2F44836FB', name: 'RHS - Status Quo', version: '0.16.5150' }
  });

  assert.equal(result.created, true);
  assert.equal(result.preset.name, 'Workshop picks');
  assert.equal(result.preset.mods[0].version, '0.16.5150');
  assert.equal(result.presets.length, 1);
});

test('updates one preset for the same server and preserves exact mod versions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-server-preset-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const serverId = '11e9dc0c-1304-4f20-8247-8fa9043f7a49';

  const first = await store.saveServerPreset({
    serverId,
    serverName: 'Test server',
    mods: [{ modId: '1337C0DE5DABBEEF', name: 'RHS Pack', version: '0.16.5150' }]
  });
  const second = await store.saveServerPreset({
    serverId,
    serverName: 'Renamed server',
    mods: [{ modId: '1337C0DE5DABBEEF', name: 'RHS Pack', version: '0.16.5200' }]
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.preset.id, first.preset.id);
  assert.equal(second.preset.name, first.preset.name);
  assert.equal(second.preset.sourceName, `server:${serverId}`);
  assert.equal(second.preset.mods[0].version, '0.16.5200');
  assert.equal(second.presets.length, 1);
});

test('removes a logged mod from one preset without deleting it from other presets', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-presets-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const removedId = '646B350F36C6D3E4';
  const keptId = '618C2492CC62D0D5';
  const target = await store.save({ name: 'Target', mods: [
    { modId: removedId, name: 'Remove from target' },
    { modId: keptId, name: 'Keep in target' }
  ] });
  const other = await store.save({ name: 'Other', mods: [
    { modId: removedId, name: 'Keep in other preset' }
  ] });

  const result = await store.removeMod({ presetId: target.id, modId: removedId });

  assert.equal(result.presetRemoved, false);
  assert.equal(result.removedMod.modId, removedId);
  assert.deepEqual(result.preset.mods.map((mod) => mod.modId), [keptId]);
  assert.deepEqual(result.presets.find((preset) => preset.id === other.id).mods.map((mod) => mod.modId), [removedId]);
});

test('removes a preset when its last logged mod is removed', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-presets-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const target = await store.save({ name: 'Single mod', mods: [
    { modId: '646B350F36C6D3E4', name: 'Only mod' }
  ] });

  const result = await store.removeMod({ presetId: target.id, modId: '646B350F36C6D3E4' });

  assert.equal(result.preset, null);
  assert.equal(result.presetRemoved, true);
  assert.ok(!result.presets.some((preset) => preset.id === target.id));
});

test('removes a deleted mod from every preset and deletes presets left empty', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-presets-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const deletedId = '646B350F36C6D3E4';
  const keptId = '618C2492CC62D0D5';
  const unrelatedId = '59674C21AA886D57';

  const mixed = await store.save({ name: 'Mixed', mods: [
    { modId: deletedId, name: 'Delete' },
    { modId: keptId, name: 'Keep' }
  ] });
  const empty = await store.save({ name: 'Empty', mods: [
    { modId: deletedId, name: 'Delete' }
  ] });
  const unrelated = await store.save({ name: 'Unrelated', mods: [
    { modId: unrelatedId, name: 'Unrelated' }
  ] });

  const result = await store.removeModFromAll(deletedId);
  assert.equal(result.updatedPresets, 1);
  assert.deepEqual(result.removedPresetIds, [empty.id]);
  assert.deepEqual(result.presets.find((preset) => preset.id === mixed.id).mods.map((mod) => mod.modId), [keptId]);
  assert.ok(result.presets.some((preset) => preset.id === unrelated.id));
  assert.ok(!result.presets.some((preset) => preset.id === empty.id));
});

test('exports a friend-ready JSON that can be imported without conversion', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-share-file-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const preset = await store.save({ name: 'Squad night', mods: [
    { modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.10' },
    { modId: '618C2492CC62D0D5', name: 'Gs BTR-90', version: '3.1.0' }
  ] });
  const filePath = path.join(root, 'Squad night.json');

  await store.exportShareFile(preset, filePath);
  const text = await fs.readFile(filePath, 'utf8');
  const document = JSON.parse(text);
  const imported = parsePresetText(text, { sourceName: path.basename(filePath) });

  assert.equal(document.format, 'arma-reforger-launcher-preset');
  assert.equal(document.name, 'Squad night');
  assert.equal(imported.name, 'Squad night');
  assert.deepEqual(imported.mods, preset.mods);
});

test('rejects preset identifiers that escape the presets directory', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-preset-boundary-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const outsidePath = path.join(root, 'settings.json');
  await fs.writeFile(outsidePath, '{"keep":true}');
  await assert.rejects(store.save({ id: '../settings', name: 'Invalid', mods: [
    { modId: '646B350F36C6D3E4', version: '1.0.0' }
  ] }), /идентификатор пресета/);
  assert.equal(await fs.readFile(outsidePath, 'utf8'), '{"keep":true}');
});

test('keeps all mods from concurrent additions to one preset', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-preset-stress-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const original = await store.save({ name: 'Stress', mods: [{ modId: '646B350F36C6D3E4' }] });
  const additions = Array.from({ length: 40 }, (_, index) => ({
    modId: (index + 1).toString(16).padStart(16, '0').toUpperCase(), version: `1.${index}.0`
  }));
  const results = await Promise.allSettled(additions.map((mod) => store.addMod({ presetId: original.id, mod })));
  assert.equal(results.filter((result) => result.status === 'rejected').length, 0);
  const [stored] = await store.list();
  assert.equal(stored.mods.length, 41);
  for (const mod of additions) assert.equal(stored.mods.find((entry) => entry.modId === mod.modId)?.version, mod.version);
});

test('concurrent server preset saves create one preset and keep the last exact revision', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-server-preset-stress-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => store.saveServerPreset({
    serverId: '11e9dc0c-1304-4f20-8247-8fa9043f7a49', serverName: 'Concurrent server',
    mods: [{ modId: '646B350F36C6D3E4', version: `1.${index}.0` }]
  })));
  const presets = await store.list();
  assert.equal(presets.length, 1);
  assert.equal(new Set(results.map((result) => result.preset.id)).size, 1);
  assert.equal(presets[0].mods[0].version, '1.19.0');
});

test('saves and updates presets for numeric IDs from the server catalog', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-server-numeric-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const first = await store.saveServerPreset({ serverId: '39079454', serverName: 'Catalog server',
    mods: [{ modId: '646B350F36C6D3E4', version: '1.0.0' }] });
  const second = await store.saveServerPreset({ serverId: '39079454', serverName: 'Catalog server',
    mods: [{ modId: '646B350F36C6D3E4', version: '2.0.0' }] });
  assert.equal(first.preset.id, second.preset.id);
  assert.equal(second.preset.sourceName, 'server:39079454');
  assert.equal(second.preset.mods[0].version, '2.0.0');
  for (const serverId of ['../settings', '1234567890123', '1e3']) {
    await assert.rejects(store.saveServerPreset({ serverId, mods: first.preset.mods }), /идентификатор сервера/);
  }
});

test('orders concurrent removal and addition without resurrecting removed mods', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-preset-mixed-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  const original = await store.save({ name: 'Mixed', mods: [
    { modId: '646B350F36C6D3E4' }, { modId: '618C2492CC62D0D5' }
  ] });
  await Promise.all([
    store.removeMod({ presetId: original.id, modId: '646B350F36C6D3E4' }),
    store.addMod({ presetId: original.id, mod: { modId: '595F2BF2F44836FB', version: '3.2.1' } })
  ]);
  assert.deepEqual((await store.list())[0].mods.map((mod) => mod.modId), ['618C2492CC62D0D5', '595F2BF2F44836FB']);
});

test('ignores mismatched on-disk preset IDs and recovers after a rejected mutation', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-preset-invalid-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PresetStore(root);
  await store.initialize();
  const invalidPath = path.join(store.directory, '11111111-1111-4111-8111-111111111111.json');
  const original = JSON.stringify({ id: '../settings', mods: [{ modId: '646B350F36C6D3E4' }] });
  await fs.writeFile(invalidPath, original);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.addMod({ mod: { modId: 'invalid' } }), /GUID/);
  await store.save({ name: 'Recovered', mods: [{ modId: '646B350F36C6D3E4', version: '2.0.0' }] });
  assert.equal((await store.list()).length, 1);
  assert.equal(await fs.readFile(invalidPath, 'utf8'), original);
});
