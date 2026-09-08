const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { syncGameProfileSettings } = require('../src/core/gameProfileSettings');

test('rejects a launcher profile inside personal custom input settings before recursively copying source files', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'game-profile-overlap-test-'));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'personal');
  const relative = 'profile/.save/settings/ReforgerGameSettings.conf';
  await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
  const original = Buffer.from('personal controls and gameplay preferences');
  await fs.writeFile(path.join(source, relative), original);
  const profileDirectory = path.join(source, 'profile/.save/settings/customInputConfigs/Launcher');
  await assert.rejects(syncGameProfileSettings({ profileDirectory, sourceProfileDirectories: [source] }));
  assert.deepEqual(await fs.readFile(path.join(source, relative)), original);
  const copiedConfigs = (await fs.readdir(source, { recursive: true })).filter((name) => name.endsWith('.conf'));
  assert.equal(copiedConfigs.length, 1);
  await assert.rejects(fs.stat(profileDirectory), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(profileDirectory, relative)), { code: 'ENOENT' });
});

test('rejects a source profile nested inside the target before writing target preferences', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'game-profile-source-overlap-test-'));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const profileDirectory = path.join(temporary, 'launcher');
  const source = path.join(profileDirectory, 'profile/.save/settings/customInputConfigs/Personal');
  const relative = 'profile/.save/settings/ReforgerGameSettings.conf';
  await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
  const original = Buffer.from('personal controls remain in the source');
  await fs.writeFile(path.join(source, relative), original);
  await assert.rejects(syncGameProfileSettings({ profileDirectory, sourceProfileDirectories: [source] }));
  assert.deepEqual(await fs.readFile(path.join(source, relative)), original);
  await assert.rejects(fs.stat(path.join(profileDirectory, relative)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(profileDirectory, 'profile/ALGZLauncherGameSettingsSync.json')), { code: 'ENOENT' });
});

test('resolves existing junction ancestors before checking a not-yet-created target for source overlap', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'game-profile-junction-overlap-test-'));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'personal');
  const relative = 'profile/.save/settings/ReforgerGameSettings.conf';
  await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
  await fs.writeFile(path.join(source, relative), 'original preferences');
  const alias = path.join(temporary, 'alias');
  await fs.symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const profileDirectory = path.join(alias, 'profile/.save/settings/customInputConfigs/Launcher');
  await assert.rejects(syncGameProfileSettings({ profileDirectory, sourceProfileDirectories: [source] }));
  await assert.rejects(fs.stat(profileDirectory), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(source, relative), 'utf8'), 'original preferences');
});
