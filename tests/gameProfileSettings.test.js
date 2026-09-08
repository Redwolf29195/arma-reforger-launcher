const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { syncGameProfileSettings } = require('../src/core/gameProfileSettings');

const ENGINE = 'profile/.save/app1874880_user123/settings/ReforgerEngineSettings.conf';
const GAME = 'profile/.save/app1874880_user123/settings/ReforgerGameSettings.conf';
const INPUT = 'profile/.save/app1874880_user123/settings/InputUserSettings.conf';
const CUSTOM = 'profile/.save/app1874880_user123/settings/customInputConfigs';
const MANIFEST = 'profile/ALGZLauncherGameSettingsSync.json';
const BACKUPS = 'profile/ALGZLauncherGameSettingsBackups';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const absolute = (root, relative) => path.join(root, ...relative.split('/'));

async function put(root, relative, bytes) {
  const filePath = absolute(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  return filePath;
}
async function read(root, relative) { return fs.readFile(absolute(root, relative), 'utf8'); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-game-preferences-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'standard');
  const target = path.join(root, 'isolated');
  await fs.mkdir(source);
  await fs.mkdir(target);
  return { root, source, target, sync: (sources = [source]) => syncGameProfileSettings({
    profileDirectory: target, sourceProfileDirectories: sources
  }) };
}

test('imports only personal preferences and custom input files while keeping account paths', async (t) => {
  const f = await fixture(t);
  const included = [ENGINE, GAME, INPUT, 'profile/.save/settings/ReforgerEngineSettings.conf',
    ENGINE.replace('user123', 'user456'), `${CUSTOM}/keyboard/personal.conf`];
  const excluded = ['profile/.save/app1874880_user123/game/save.conf',
    'profile/.save/app1874880_user123/workshop/I646B350F36C6D3E4.json',
    'profile/.save/app999_user123/settings/ReforgerEngineSettings.conf',
    'profile/.save/app1874880_user123/settings/unrelated.conf', `${CUSTOM}/notes.txt`, 'profile/private.json'];
  for (const relative of included) await put(f.source, relative, `source:${relative}`);
  for (const relative of excluded) await put(f.source, relative, 'must remain outside target');
  const result = await f.sync();
  assert.equal(result.copied, included.length);
  assert.deepEqual(result.conflicts, []);
  for (const relative of included) assert.equal(await read(f.target, relative), `source:${relative}`);
  for (const relative of excluded) await assert.rejects(read(f.target, relative), { code: 'ENOENT' });
});

test('first repair imports standard preferences even over newer defaults and backs up exact old bytes', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'personal-source');
  const targetPath = await put(f.target, ENGINE, 'isolated-defaults');
  await fs.utimes(targetPath, new Date('2030-01-01'), new Date('2030-01-01'));
  const result = await f.sync();
  assert.equal(result.copied, 1);
  assert.equal(await read(f.target, ENGINE), 'personal-source');
  assert.equal(await read(f.target, `${BACKUPS}/${digest('isolated-defaults')}.conf`), 'isolated-defaults');
  assert.equal(result.backupDirectory, absolute(f.target, BACKUPS));
  assert.equal(await read(f.source, ENGINE), 'personal-source');
});

test('an unchanged source preserves preferences edited in the isolated profile', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source-v1');
  await f.sync();
  await put(f.target, ENGINE, 'local-edit');
  const result = await f.sync();
  assert.equal(result.copied, 0);
  assert.equal(result.preserved, 1);
  assert.deepEqual(result.conflicts, []);
  assert.equal(await read(f.target, ENGINE), 'local-edit');
});

test('a changed source updates an untouched target and preserves its previous bytes', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source-v1');
  await f.sync();
  await put(f.source, ENGINE, 'source-v2');
  const result = await f.sync();
  assert.equal(result.copied, 1);
  assert.equal(await read(f.target, ENGINE), 'source-v2');
  assert.equal(await read(f.target, `${BACKUPS}/${digest('source-v1')}.conf`), 'source-v1');
});

test('divergent source and target edits stay intact and report a conflict on every unresolved retry', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source-v1');
  await f.sync();
  await put(f.source, ENGINE, 'source-v2');
  await put(f.target, ENGINE, 'local-edit');
  for (let index = 0; index < 2; index += 1) {
    const result = await f.sync();
    assert.deepEqual(result.conflicts, [ENGINE]);
    assert.equal(result.copied, 0);
    assert.equal(await read(f.target, ENGINE), 'local-edit');
  }
});

test('a missing target is restored even if the source hash did not change', async (t) => {
  const f = await fixture(t);
  await put(f.source, INPUT, 'personal-input');
  await f.sync();
  await fs.unlink(absolute(f.target, INPUT));
  assert.equal((await f.sync()).copied, 1);
  assert.equal(await read(f.target, INPUT), 'personal-input');
});

test('uses one first eligible source without mixing other roots', async (t) => {
  const f = await fixture(t);
  const second = path.join(f.root, 'second-source');
  await put(f.source, ENGINE, 'first-root');
  await put(second, ENGINE, 'second-root');
  await put(second, GAME, 'second-only');
  const result = await f.sync([path.join(f.root, 'missing'), f.source, second]);
  assert.equal(result.sourceDirectory, await fs.realpath(f.source));
  assert.equal(await read(f.target, ENGINE), 'first-root');
  await assert.rejects(read(f.target, GAME), { code: 'ENOENT' });
});

test('skips roots without recognized nonempty preference files', async (t) => {
  const f = await fixture(t);
  await put(f.source, 'profile/private.json', 'ignored');
  await put(f.source, ENGINE, '');
  assert.equal((await f.sync()).skipped, true);
  await assert.rejects(read(f.target, MANIFEST), { code: 'ENOENT' });
});

test('skips a source that is the same physical profile through a directory junction', async (t) => {
  const f = await fixture(t);
  await put(f.target, ENGINE, 'shared-settings');
  const alias = path.join(f.root, 'target-alias');
  await fs.symlink(f.target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.sync([alias]);
  assert.equal(result.skipped, true);
  assert.equal(await read(f.target, ENGINE), 'shared-settings');
  await assert.rejects(read(f.target, MANIFEST), { code: 'ENOENT' });
});

test('serializes twenty imports to the same destination without redundant copies', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source');
  await put(f.target, ENGINE, 'old-target');
  const results = await Promise.all(Array.from({ length: 20 }, () => f.sync()));
  assert.equal(results.reduce((sum, result) => sum + result.copied, 0), 1);
  assert.equal(await read(f.target, ENGINE), 'source');
  assert.equal((await fs.readdir(absolute(f.target, BACKUPS))).length, 1);
});

test('rejects excess file counts before changing any target', async (t) => {
  const f = await fixture(t);
  await put(f.target, ENGINE, 'keep');
  await Promise.all(Array.from({ length: 257 }, (_, index) => put(f.source, `${CUSTOM}/${index}.conf`, 'control')));
  await assert.rejects(f.sync(), /Too many game settings files/);
  assert.equal(await read(f.target, ENGINE), 'keep');
  await assert.rejects(read(f.target, MANIFEST), { code: 'ENOENT' });
});

test('rejects an oversized source file before changing target bytes', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, Buffer.alloc(2 * 1024 * 1024 + 1));
  await put(f.target, ENGINE, 'keep');
  await assert.rejects(f.sync(), /size limit/);
  assert.equal(await read(f.target, ENGINE), 'keep');
});

test('rejects total settings exceeding sixteen MiB', async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 9 }, (_, index) => put(f.source, `${CUSTOM}/${index}.conf`, Buffer.alloc(2 * 1024 * 1024, index))));
  await assert.rejects(f.sync(), /size limit/);
  await assert.rejects(read(f.target, MANIFEST), { code: 'ENOENT' });
});

test('bounds custom input directory depth', async (t) => {
  const f = await fixture(t);
  await put(f.source, `${CUSTOM}/${Array(9).fill('deep').join('/')}/input.conf`, 'input');
  await assert.rejects(f.sync(), /too deep/);
});

test('rejects a source settings junction escaping the selected profile', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'ReforgerEngineSettings.conf'), 'outside-data');
  await fs.mkdir(path.join(f.source, 'profile', '.save'), { recursive: true });
  await fs.symlink(outside, path.join(f.source, 'profile', '.save', 'settings'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.sync(), /Unsafe game settings directory/);
  assert.equal(await fs.readFile(path.join(outside, 'ReforgerEngineSettings.conf'), 'utf8'), 'outside-data');
});

test('rejects a destination settings junction and preserves its external file', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source');
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'ReforgerEngineSettings.conf'), 'keep-outside');
  await fs.mkdir(path.join(f.target, 'profile', '.save', 'app1874880_user123'), { recursive: true });
  await fs.symlink(outside, path.dirname(absolute(f.target, ENGINE)), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.sync(), /Unsafe game settings directory/);
  assert.equal(await fs.readFile(path.join(outside, 'ReforgerEngineSettings.conf'), 'utf8'), 'keep-outside');
});

test('rejects journal path traversal without touching existing settings', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source');
  await put(f.target, ENGINE, 'keep');
  await put(f.target, MANIFEST, JSON.stringify({ formatVersion: 1, sourceDirectory: f.source, files: {
    'profile/.save/settings/../../outside.conf': { sourceHash: digest('source'), appliedHash: digest('source') }
  } }));
  await assert.rejects(f.sync(), /Invalid game settings sync manifest/);
  assert.equal(await read(f.target, ENGINE), 'keep');
});

test('fails closed on a corrupt manifest instead of repeating first-time overwrite', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source');
  await put(f.target, ENGINE, 'local-edit');
  await put(f.target, MANIFEST, '{"truncated":');
  await assert.rejects(f.sync());
  assert.equal(await read(f.target, ENGINE), 'local-edit');
});

test('backup write failure preserves the previous settings file', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source');
  await put(f.target, ENGINE, 'keep');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to.includes('ALGZLauncherGameSettingsBackups')) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  await assert.rejects(f.sync(), { code: 'ENOSPC' });
  assert.equal(await read(f.target, ENGINE), 'keep');
});

test('write-ahead manifest failure cannot modify the target file', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source');
  await put(f.target, ENGINE, 'keep');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === absolute(f.target, MANIFEST)) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return rename(from, to);
  });
  await assert.rejects(f.sync(), { code: 'EACCES' });
  assert.equal(await read(f.target, ENGINE), 'keep');
});

test('a failed final journal write followed by a user edit never resets that edit on retry', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source');
  await put(f.target, ENGINE, 'old-defaults');
  const rename = fs.rename;
  let journalWrites = 0;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === absolute(f.target, MANIFEST) && ++journalWrites === 2) {
      throw Object.assign(new Error('Commit failed'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  });
  await assert.rejects(f.sync(), { code: 'ENOSPC' });
  assert.equal(await read(f.target, ENGINE), 'source');
  await put(f.target, ENGINE, 'user-edit-after-failure');
  mocked.mock.restore();
  assert.equal((await f.sync()).copied, 0);
  assert.equal(await read(f.target, ENGINE), 'user-edit-after-failure');
  await put(f.source, ENGINE, 'new-source');
  assert.deepEqual((await f.sync()).conflicts, [ENGINE]);
  assert.equal(await read(f.target, ENGINE), 'user-edit-after-failure');
});

test('a denied target replacement leaves its original bytes and can safely retry', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source');
  await put(f.target, ENGINE, 'keep');
  const rename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === absolute(f.target, ENGINE)) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return rename(from, to);
  });
  await assert.rejects(f.sync(), { code: 'EACCES' });
  assert.equal(await read(f.target, ENGINE), 'keep');
  mocked.mock.restore();
  assert.equal((await f.sync()).copied, 1);
  assert.equal(await read(f.target, ENGINE), 'source');
});

test('rejects settings changed during a bounded read before copying any bytes', async (t) => {
  const f = await fixture(t);
  const sourcePath = await put(f.source, ENGINE, 'source');
  await put(f.target, ENGINE, 'keep');
  const open = fs.open;
  let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === sourcePath) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        if (!changed) { changed = true; await fs.appendFile(sourcePath, 'grew'); }
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(f.sync(), /changed while being read/);
  assert.equal(await read(f.target, ENGINE), 'keep');
});

test('rejects a zero-byte preference in an otherwise selected source root', async (t) => {
  const f = await fixture(t);
  await put(f.source, ENGINE, 'source');
  await put(f.source, INPUT, '');
  await put(f.target, ENGINE, 'keep');
  await assert.rejects(f.sync(), /file is empty/);
  assert.equal(await read(f.target, ENGINE), 'keep');
});

test('rejects a source truncated between enumeration and opening the file', async (t) => {
  const f = await fixture(t);
  const sourcePath = await put(f.source, ENGINE, 'source');
  await put(f.target, ENGINE, 'keep');
  const open = fs.open;
  let truncated = false;
  t.mock.method(fs, 'open', async (...args) => {
    if (args[0] === sourcePath && !truncated) {
      truncated = true;
      await fs.truncate(sourcePath, 0);
    }
    return open(...args);
  });
  await assert.rejects(f.sync(), /file is empty/);
  assert.equal(await read(f.target, ENGINE), 'keep');
});
