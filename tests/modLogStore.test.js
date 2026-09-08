const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ModLogStore = require('../src/core/modLogStore');

test('persists newest mod actions with a trusted timestamp', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-mod-logs-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ModLogStore(directory);
  await store.load();

  const first = await store.append({
    action: 'preset-add',
    source: 'workshop',
    modId: '646B350F36C6D3E4',
    name: 'Breachable\nDoors',
    version: '1.1.10',
    presetName: 'Field Ops'
  });
  const second = await store.append({
    action: 'auto-disable',
    source: 'dependency',
    modId: '618C2492CC62D0D5',
    name: 'Gs BTR-90'
  });
  const third = await store.append({
    action: 'preset-remove',
    source: 'user',
    modId: '646B350F36C6D3E4',
    name: 'Breachable Doors',
    presetName: 'Field Ops'
  });

  assert.equal(first.name, 'Breachable Doors');
  assert.equal(Number.isNaN(new Date(first.timestamp).getTime()), false);
  assert.deepEqual((await store.list()).map((entry) => entry.id), [third.id, second.id, first.id]);

  const restored = new ModLogStore(directory);
  await restored.load();
  assert.deepEqual((await restored.list()).map((entry) => entry.action), ['preset-remove', 'auto-disable', 'preset-add']);
});

test('rejects invalid log actions and GUIDs', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-mod-logs-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ModLogStore(directory);
  await store.load();

  await assert.rejects(() => store.append({ action: 'unknown', modId: '646B350F36C6D3E4' }));
  await assert.rejects(() => store.append({ action: 'enable', modId: '../bad' }));
  assert.equal(store.count(), 0);
});

test('clears the persisted mod log', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-mod-logs-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ModLogStore(directory);
  await store.load();
  await store.append({ action: 'delete', modId: '646B350F36C6D3E4', name: 'Breachable Doors' });
  await store.clear();

  const restored = new ModLogStore(directory);
  await restored.load();
  assert.deepEqual(await restored.list(), []);
});

test('rejects overlong GUIDs instead of logging a different truncated ID', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-mod-logs-guid-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ModLogStore(directory);
  await store.load();
  await assert.rejects(store.append({ action: 'delete', modId: '646B350F36C6D3E4extra' }), /Invalid mod GUID/);
  assert.equal(store.count(), 0);
});

test('preserves existing log entries after failed append and clear', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-mod-logs-failure-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ModLogStore(directory);
  await store.load();
  await store.append({ action: 'enable', modId: '646B350F36C6D3E4' });
  const original = await store.list();
  const rename = fs.rename;
  context.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === store.filePath) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return rename(source, destination);
  });
  await assert.rejects(store.append({ action: 'delete', modId: '618C2492CC62D0D5' }), { code: 'EACCES' });
  assert.deepEqual(await store.list(), original);
  await assert.rejects(store.clear(), { code: 'EACCES' });
  assert.deepEqual(await store.list(), original);
});

test('preserves a truncated log file before resetting the active log', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-mod-logs-recovery-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = '{"entries":[{"action":"install","modId":"646B350F36C6D3E4"';
  await fs.writeFile(path.join(directory, 'mod-logs.json'), original);
  const store = new ModLogStore(directory);
  await store.load();
  const recoveryFiles = (await fs.readdir(directory)).filter((name) => name.startsWith('mod-logs.json.recovery.'));
  assert.equal(recoveryFiles.length, 1);
  assert.equal(await fs.readFile(path.join(directory, recoveryFiles[0]), 'utf8'), original);
  assert.equal(store.count(), 0);
});
