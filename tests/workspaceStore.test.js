const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const WorkspaceStore = require('../src/core/workspaceStore');

test('restores the active preset and edited mod selection after restart', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-workspace-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const activePresetId = '11111111-1111-4111-8111-111111111111';
  const firstId = '646B350F36C6D3E4';
  const secondId = '618C2492CC62D0D5';

  const store = new WorkspaceStore(root);
  await store.load();
  await store.save({
    activePresetId,
    name: 'Operations',
    dirty: true,
    mods: [
      { modId: firstId, name: 'First', version: '1.0.0' },
      { modId: secondId, name: 'Second', version: '2.0.0' },
      { modId: firstId, name: 'Duplicate' }
    ]
  });

  const restartedStore = new WorkspaceStore(root);
  const restored = await restartedStore.load();
  assert.equal(restored.activePresetId, activePresetId);
  assert.equal(restored.name, 'Operations');
  assert.equal(restored.dirty, true);
  assert.deepEqual(restored.mods.map((mod) => mod.modId), [firstId, secondId]);

  const afterRemoval = await restartedStore.removeMod(firstId, [activePresetId]);
  assert.equal(afterRemoval.activePresetId, '');
  assert.equal(afterRemoval.dirty, true);
  assert.deepEqual(afterRemoval.mods.map((mod) => mod.modId), [secondId]);
});

test('keeps the committed workspace when a save fails', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-workspace-failure-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkspaceStore(root);
  await store.load();
  await store.save({ name: 'Keep', mods: [{ modId: '646B350F36C6D3E4', version: '1.2.3' }] });
  const original = store.get();
  const rename = fs.rename;
  context.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === store.filePath) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return rename(source, destination);
  });
  await assert.rejects(store.save({ name: 'Lost', mods: [] }), { code: 'EACCES' });
  assert.deepEqual(store.get(), original);
});

test('preserves truncated workspace bytes for manual recovery', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-workspace-recovery-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = '{"name":"Operations","mods":[{"modId":"646B350F36C6D3E4"';
  await fs.writeFile(path.join(root, 'workspace.json'), original);
  await new WorkspaceStore(root).load();
  const recoveryFiles = (await fs.readdir(root)).filter((name) => name.startsWith('workspace.json.recovery.'));
  assert.equal(recoveryFiles.length, 1);
  assert.equal(await fs.readFile(path.join(root, recoveryFiles[0]), 'utf8'), original);
});
