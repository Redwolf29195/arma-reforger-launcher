const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SettingsStore = require('../src/core/settingsStore');

test('uses English by default and persists a supported language', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new SettingsStore(directory);
  await store.load();
  assert.equal(store.get().language, 'en');

  await store.update({ language: 'ru' });
  const restored = new SettingsStore(directory);
  await restored.load();
  assert.equal(restored.get().language, 'ru');
});

test('falls back to English for an unsupported language', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new SettingsStore(directory);
  await store.load();
  await store.update({ language: 'de' });
  assert.equal(store.get().language, 'en');
});

test('enables automatic updates by default and persists an explicit opt-out', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new SettingsStore(directory);
  await store.load();
  assert.equal(store.get().autoUpdate, true);

  await store.update({ autoUpdate: false });
  const restored = new SettingsStore(directory);
  await restored.load();
  assert.equal(restored.get().autoUpdate, false);
});

test('allows a different installed mod version by default and persists an explicit opt-out', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new SettingsStore(directory);
  await store.load();
  assert.equal(store.get().allowVersionMismatch, true);

  await store.update({ allowVersionMismatch: false });
  const restored = new SettingsStore(directory);
  await restored.load();
  assert.equal(restored.get().allowVersionMismatch, false);
});

test('shows footer mod logs by default and persists an explicit opt-out', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new SettingsStore(directory);
  await store.load();
  assert.equal(store.get().showModLogsFooter, true);

  await store.update({ showModLogsFooter: false });
  const restored = new SettingsStore(directory);
  await restored.load();
  assert.equal(restored.get().showModLogsFooter, false);
});

test('adds dependencies automatically by default and persists an explicit opt-out', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new SettingsStore(directory);
  await store.load();
  assert.equal(store.get().autoAddDependencies, true);

  await store.update({ autoAddDependencies: false });
  const restored = new SettingsStore(directory);
  await restored.load();
  assert.equal(restored.get().autoAddDependencies, false);
});

test('shows irreversible mod deletion warnings by default and persists an opt-out', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory);
  await store.load();
  assert.equal(store.get().confirmModDeletion, true);

  await store.update({ confirmModDeletion: false });
  const restored = new SettingsStore(directory);
  await restored.load();
  assert.equal(restored.get().confirmModDeletion, false);
});

test('keeps advanced mode off by default and persists an explicit opt-in', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory);
  await store.load();
  assert.equal(store.get().advancedMode, false);

  await store.update({ advancedMode: true });
  const restored = new SettingsStore(directory);
  await restored.load();
  assert.equal(restored.get().advancedMode, true);
});

test('does not expose or persist a custom update channel', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new SettingsStore(directory);
  await store.load();
  await store.update({ updateBaseUrl: 'https://example.invalid/updates/' });

  assert.equal(Object.hasOwn(store.get(), 'updateBaseUrl'), false);
  const persisted = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
  assert.equal(Object.hasOwn(persisted, 'updateBaseUrl'), false);
});

test('persists a valid default preset identifier', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const presetId = '11111111-1111-4111-8111-111111111111';
  const store = new SettingsStore(directory);
  await store.load();
  await store.update({ defaultPresetId: presetId });

  const restored = new SettingsStore(directory);
  await restored.load();
  assert.equal(restored.get().defaultPresetId, presetId);
});

test('persists a bounded and sanitized favorite server list', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const serverId = '11e9dc0c-1304-4f20-8247-8fa9043f7a49';
  const numericServerId = '39079454';
  const store = new SettingsStore(directory);
  await store.load();
  await store.update({
    favoriteServers: [
      { id: serverId, name: 'Favorite server', address: 'play.example.test:2001', playerCount: 24 },
      { id: serverId, name: 'Duplicate' },
      { id: numericServerId, name: 'Catalog server', address: '198.51.100.5:2001', playerCount: 0 },
      { id: 'invalid', name: 'Invalid' }
    ]
  });

  const restored = new SettingsStore(directory);
  await restored.load();
  assert.deepEqual(restored.get().favoriteServers.map((server) => server.id), [serverId, numericServerId]);
  assert.equal(restored.get().favoriteServers[0].name, 'Favorite server');
  assert.equal(restored.get().favoriteServers[0].playerCount, 24);
});

test('persists unique and sanitized favorite mod GUIDs', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory);
  await store.load();
  await store.update({
    favoriteMods: [
      '5965550f24a0c152',
      { modId: '1337C0DE5DABBEEF' },
      '5965550F24A0C152',
      'invalid'
    ]
  });

  const restored = new SettingsStore(directory);
  await restored.load();
  assert.deepEqual(restored.get().favoriteMods, ['5965550F24A0C152', '1337C0DE5DABBEEF']);
});

test('keeps committed settings after a failed save and merges later concurrent patches', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-failure-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory);
  await store.load();
  const rename = fs.rename;
  const mocked = context.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === store.filePath) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return rename(source, destination);
  });
  await assert.rejects(store.update({ language: 'ru', noSplash: false }), { code: 'EACCES' });
  assert.equal(store.get().language, 'en');
  assert.equal(store.get().noSplash, true);
  mocked.mock.restore();
  await Promise.all([store.update({ language: 'ru' }), store.update({ noSplash: false })]);
  const restored = new SettingsStore(directory);
  await restored.load();
  assert.equal(restored.get().language, 'ru');
  assert.equal(restored.get().noSplash, false);
});

test('keeps a recovery copy of truncated settings before initializing defaults', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-recovery-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = '{"language":"ru","gameExecutable":"unfinished';
  await fs.writeFile(path.join(directory, 'settings.json'), original);
  const store = new SettingsStore(directory);
  await store.load();
  const recoveryFiles = (await fs.readdir(directory)).filter((name) => name.startsWith('settings.json.recovery.'));
  assert.equal(recoveryFiles.length, 1);
  assert.equal(await fs.readFile(path.join(directory, recoveryFiles[0]), 'utf8'), original);
  assert.equal(store.get().language, 'en');
});

test('does not overwrite damaged settings if their recovery copy cannot be created', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-settings-recovery-denied-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings.json');
  const original = '{"language":"ru"';
  await fs.writeFile(filePath, original);
  const copyFile = fs.copyFile;
  context.mock.method(fs, 'copyFile', async (source, ...args) => {
    if (source === filePath) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    return copyFile(source, ...args);
  });
  await assert.rejects(new SettingsStore(directory).load(), { code: 'ENOSPC' });
  assert.equal(await fs.readFile(filePath, 'utf8'), original);
});
