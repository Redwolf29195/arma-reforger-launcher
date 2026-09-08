const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createWorkshopDownloadController, readSession, SESSION_FILE } = require('../src/core/workshopDownloadSession');
const { getQueuePaths } = require('../src/core/workshopDownloadQueue');

const items = [{ modId: 'AAAAAAAAAAAAAAAA', version: '1.2.3' }, { modId: 'BBBBBBBBBBBBBBBB', version: '4.5.6' }];

async function fixture(t) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-durability-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const paths = getQueuePaths(profile);
  const primary = path.join(path.dirname(paths.queuePath), SESSION_FILE);
  let launches = 0;
  const create = () => createWorkshopDownloadController({ isGameRunning: async () => false });
  const start = (controller = create(), queue = items) => controller.start(profile, async () => ({ items: queue }), async () => { launches++; return {}; });
  return { profile, paths, primary, backup: `${primary}.bak`, create, start, launches: () => launches };
}

test('flushes each durable session replacement before rename and keeps a complete redundant copy', async (t) => {
  const f = await fixture(t);
  const opened = new Map();
  const open = fs.open;
  const rename = fs.rename;
  let replacements = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes(SESSION_FILE) && String(args[0]).endsWith('.tmp')) {
      const state = { synced: false, closed: false };
      opened.set(args[0], state);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      handle.sync = async () => { await sync(); state.synced = true; };
      handle.close = async () => { await close(); state.closed = true; };
    }
    return handle;
  });
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === f.primary || to === f.backup) {
      replacements++;
      assert.deepEqual(opened.get(from), { synced: true, closed: true });
    }
    return rename(from, to);
  });
  await f.start();
  assert.ok(replacements >= 4);
  assert.equal(f.launches(), 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.primary, 'utf8')).items, items);
  assert.deepEqual(JSON.parse(await fs.readFile(f.backup, 'utf8')).items, items);
});

test('a truncated primary and deleted game text queue recover exact pins from backup and ignore terminal status', async (t) => {
  const f = await fixture(t);
  await f.start();
  await fs.writeFile(f.primary, '{"schema":');
  await fs.rm(f.paths.queuePath);
  await fs.writeFile(f.paths.statusPath, 'complete|2|2|0||100|old or torn completion');
  const recovered = await readSession(f.profile);
  assert.deepEqual(recovered.items, items);
  assert.equal(recovered.paused, true);
  const controller = f.create();
  const status = await controller.status(f.profile);
  assert.equal(status.state, 'paused');
  assert.equal(status.resumeAvailable, true);
  let replay;
  await controller.start(f.profile, async (saved) => { replay = saved; return {}; }, async () => ({}), { resume: true });
  assert.deepEqual(replay, items);
});

test('missing primary and queue recover from a flushed backup instead of appearing idle', async (t) => {
  const f = await fixture(t);
  await f.start();
  await fs.rm(f.primary);
  await fs.rm(f.paths.queuePath);
  assert.deepEqual((await readSession(f.profile)).items, items);
  assert.equal((await f.create().status(f.profile)).resumeAvailable, true);
});

test('a valid-looking corrupted primary cannot change a pinned version without detection', async (t) => {
  const f = await fixture(t);
  await f.start();
  const record = JSON.parse(await fs.readFile(f.primary, 'utf8'));
  record.items[0].version = '9.9.9';
  await fs.writeFile(f.primary, JSON.stringify(record));
  const recovered = await readSession(f.profile);
  assert.deepEqual(recovered.items, items);
  assert.equal(recovered.paused, true);
});

test('power interruption before primary replacement recovers a newer committed backup without dropping added items', async (t) => {
  const f = await fixture(t);
  await f.start();
  const oldPrimary = await fs.readFile(f.primary);
  const rename = fs.rename;
  const blocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === f.primary) throw Object.assign(new Error('power interrupted primary replacement'), { code: 'EIO' });
    return rename(from, to);
  });
  const added = { modId: 'CCCCCCCCCCCCCCCC', version: '7.8.9' };
  await assert.rejects(f.start(f.create(), [added]), { code: 'EIO' });
  blocked.mock.restore();
  assert.deepEqual(await fs.readFile(f.primary), oldPrimary);
  assert.equal(f.launches(), 1);
  const recovered = await readSession(f.profile);
  assert.deepEqual(recovered.items, [...items, added]);
  assert.equal(recovered.paused, true);
});

test('a failed backup flush cannot launch or overwrite the last good queue', async (t) => {
  const f = await fixture(t);
  await f.start();
  const original = await fs.readFile(f.primary);
  const open = fs.open;
  const failing = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).startsWith(`${f.backup}.`) && String(args[0]).endsWith('.tmp')) {
      handle.sync = async () => { throw Object.assign(new Error('disk flush failed'), { code: 'EIO' }); };
    }
    return handle;
  });
  await assert.rejects(f.start(f.create(), [{ modId: 'CCCCCCCCCCCCCCCC', version: '7.8.9' }]), { code: 'EIO' });
  failing.mock.restore();
  assert.deepEqual(await fs.readFile(f.primary), original);
  assert.deepEqual((await readSession(f.profile)).items, items);
  assert.equal(f.launches(), 1);
});

test('leftover complete temporary session can recover when both committed copies and text queue are missing', async (t) => {
  const f = await fixture(t);
  await f.start();
  const bytes = await fs.readFile(f.primary);
  const leftover = `${f.primary}.999.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp`;
  await fs.writeFile(leftover, bytes);
  await fs.rm(f.primary);
  await fs.rm(f.backup, { force: true });
  await fs.rm(f.paths.queuePath);
  const recovered = await readSession(f.profile);
  assert.deepEqual(recovered.items, items);
  assert.equal(recovered.paused, true);
});

test('unrecoverable truncated records never silently become idle or complete', async (t) => {
  const f = await fixture(t);
  await f.start();
  await fs.writeFile(f.primary, '{');
  await fs.writeFile(f.backup, '{');
  await fs.rm(f.paths.queuePath);
  await fs.writeFile(f.paths.statusPath, 'complete|2|2|0||100|done');
  await assert.rejects(f.create().status(f.profile));
});

test('interruption immediately after primary rename leaves a resumable exact queue and does not launch', async (t) => {
  const f = await fixture(t);
  const rename = fs.rename;
  const interrupted = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (to === f.primary) throw Object.assign(new Error('cut after rename'), { code: 'EIO' });
  });
  await assert.rejects(f.start(), { code: 'EIO' });
  interrupted.mock.restore();
  assert.equal(f.launches(), 0);
  const record = await readSession(f.profile);
  assert.deepEqual(record.items, items);
  assert.equal(record.paused, true);
  assert.equal((await f.create().status(f.profile)).resumeAvailable, true);
});

test('failure to flush the bridge text queue keeps the JSON replay durable and blocks launch', async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  const blocked = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.paths.queuePath && args[1] === 'r+') {
      handle.sync = async () => { throw Object.assign(new Error('queue flush interrupted'), { code: 'EIO' }); };
    }
    return handle;
  });
  await assert.rejects(f.start(), { code: 'EIO' });
  blocked.mock.restore();
  assert.equal(f.launches(), 0);
  assert.deepEqual((await readSession(f.profile)).items, items);
  assert.equal((await readSession(f.profile)).paused, true);
});

test('a partial leftover temporary is ignored when a committed queue survives', async (t) => {
  const f = await fixture(t);
  await f.start();
  await fs.writeFile(`${f.primary}.999.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp`, '{"schema":2,"items":');
  const record = await readSession(f.profile);
  assert.deepEqual(record.items, items);
  assert.equal(record.paused, false);
});

test('legacy valid text queue remains a conservative recovery source when both JSON copies are corrupt', async (t) => {
  const f = await fixture(t);
  await f.start();
  await fs.writeFile(f.primary, '{');
  await fs.writeFile(f.backup, '{');
  const record = await readSession(f.profile);
  assert.deepEqual(record.items, items);
  assert.equal(record.paused, true);
  assert.equal((await f.create().status(f.profile)).resumeAvailable, true);
});

async function crashWhileSaving(profile, queue, phase) {
  const script = `
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const { createWorkshopDownloadController, SESSION_FILE } = require(process.argv[1]);
    const [profile, queueJson, phase] = process.argv.slice(2);
    const primary = path.join(profile, 'profile', SESSION_FILE);
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (phase === 'before-backup-rename' && to === primary + '.bak') process.kill(process.pid, 'SIGKILL');
      await rename(from, to);
      if ((phase === 'after-backup-rename' && to === primary + '.bak')
          || (phase === 'after-primary-rename' && to === primary)) process.kill(process.pid, 'SIGKILL');
    };
    createWorkshopDownloadController({ isGameRunning: async () => false }).start(
      profile, async () => ({ items: JSON.parse(queueJson) }),
      async () => { await fs.writeFile(path.join(profile, 'unexpected-launch'), 'launched'); }
    ).then(() => process.exit(0), error => { console.error(error); process.exit(94); });
  `;
  await assert.rejects(promisify(execFile)(process.execPath, [
    '-e', script, require.resolve('../src/core/workshopDownloadSession'), profile, JSON.stringify(queue), phase
  ], { timeout: 15_000, windowsHide: true }), error => {
    assert.notEqual(error.code, 94, error.stderr);
    assert.notEqual(error.killed, true, 'Child must reach the simulated crash before its timeout.');
    return true;
  });
  await assert.rejects(fs.stat(path.join(profile, 'unexpected-launch')), { code: 'ENOENT' });
}

test('an abruptly terminated first save recovers the complete temporary without catch/finally cleanup', async (t) => {
  const f = await fixture(t);
  await crashWhileSaving(f.profile, items, 'before-backup-rename');
  await assert.rejects(fs.stat(f.primary), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.backup), { code: 'ENOENT' });
  assert.deepEqual((await readSession(f.profile)).items, items);
  assert.equal((await f.create().status(f.profile)).resumeAvailable, true);
});

test('an abruptly terminated replacement recovers newly added pins from its committed backup', async (t) => {
  const f = await fixture(t);
  await f.start();
  const previous = await fs.readFile(f.primary);
  const added = { modId: 'CCCCCCCCCCCCCCCC', version: '7.8.9' };
  await crashWhileSaving(f.profile, [added], 'after-backup-rename');
  assert.deepEqual(await fs.readFile(f.primary), previous);
  const recovered = await readSession(f.profile);
  assert.deepEqual(recovered.items, [...items, added]);
  assert.equal(recovered.paused, true);
});

test('an abrupt termination after primary rename retains a paused queue across controller recreation', async (t) => {
  const f = await fixture(t);
  await crashWhileSaving(f.profile, items, 'after-primary-rename');
  const recovered = await readSession(f.profile);
  assert.deepEqual(recovered.items, items);
  assert.equal(recovered.paused, true);
  let replay;
  await f.create().start(f.profile, async saved => { replay = saved; return {}; }, async () => ({}), { resume: true });
  assert.deepEqual(replay, items);
});
