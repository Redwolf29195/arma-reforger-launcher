const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createInstalledModUpdater, planInstalledModUpdates, requestedModIds } = require('../src/core/installedModUpdates');
const { createWorkshopDownloadController, readSession } = require('../src/core/workshopDownloadSession');
const { getQueuePaths } = require('../src/core/workshopDownloadQueue');
const { clearWorkshopDetailsCache, fetchWorkshopDetails } = require('../src/core/workshopDetails');

const A = '1111111111111111';
const B = '2222222222222222';
const C = '3333333333333333';
const local = (modId = A, version = '1', extra = {}) => ({ modId, version, name: modId, directoryPath: `/test/${modId}`, corrupted: false, ...extra });
const remote = (modId = A, version = '2', dependencies = []) => ({ modId, version, name: modId, dependencies });
const options = (records, extra = {}) => ({
  fetchDetails: async id => {
    if (records[id] instanceof Error) throw records[id];
    if (!records[id]) throw new Error('offline');
    return records[id];
  },
  ...extra
});

test('update selection validates GUIDs, count and shape before network work', () => {
  assert.equal(requestedModIds(undefined), null);
  assert.equal(requestedModIds({}), null);
  assert.deepEqual(requestedModIds({ modIds: [A, A] }), [A]);
  for (const value of [null, [], 'all', { modIds: [] }, { modIds: [123] }, { modIds: ['invalid'] }, { modIds: Array(501).fill(A) }]) {
    assert.throws(() => requestedModIds(value), /modUpdateInvalidSelection/);
  }
});

test('bulk updates only newer normalized versions and never downgrades a good copy', async () => {
  const plan = await planInstalledModUpdates([local(A, 'v1.0.0'), local(B, '3'), local(C, '1.9')], {}, options({
    [A]: remote(A, '1'), [B]: remote(B, '2'), [C]: remote(C, '1.10')
  }));
  assert.equal(plan.checkedCount, 3);
  assert.equal(plan.upToDateCount, 2);
  assert.equal(plan.updateCount, 1);
  assert.deepEqual(plan.items, [{ modId: C, version: '1.10' }]);
});

test('individual update never touches an unselected installed root or a missing supplied GUID', async () => {
  const calls = [];
  const plan = await planInstalledModUpdates([local(A), local(B)], { modIds: [A, C] }, {
    fetchDetails: async id => { calls.push(id); return remote(id); }
  });
  assert.deepEqual(calls, [A]);
  assert.deepEqual(plan.items, [{ modId: A, version: '2' }]);
  assert.equal(plan.skippedCount, 1);
  assert.equal(plan.failedDetails[0].modId, C);
});

test('corrupted and incomplete installed copies repair at a verified version without downgrade', async () => {
  const plan = await planInstalledModUpdates([
    local(A, '2', { corrupted: true }), local(B, '', { corrupted: true }), local(C, '3', { corrupted: true })
  ], {}, options({ [A]: remote(A), [B]: remote(B), [C]: remote(C) }));
  assert.deepEqual(plan.items, [{ modId: A, version: '2' }, { modId: B, version: '2' }]);
  assert.ok(plan.updates.every(item => item.reason === 'repair'));
  assert.equal(plan.failedDetails[0].message, 'modUpdateNewerCorrupted');
});

test('unknown versions, wrong metadata and offline checks never report up-to-date or enqueue blindly', async () => {
  const cases = [
    [local(A, ''), remote(A)], [local(), remote(A, 'unknown')],
    [local(), remote(B)], [local(), new Error('offline')]
  ];
  for (const [installed, details] of cases) {
    const plan = await planInstalledModUpdates([installed], {}, options({ [A]: details }));
    assert.equal(plan.alreadyUpToDate, false);
    assert.equal(plan.updateCount, 0);
    assert.equal(plan.skippedCount, 1);
    assert.deepEqual(plan.items, []);
  }
});

test('dependency expansion retains root latest pins and skips a newer healthy local dependency', async () => {
  const calls = [];
  const plan = await planInstalledModUpdates([local(A), local(B, '4')], { modIds: [A] }, {
    fetchDetails: async (id, request) => {
      calls.push([id, request.refresh]);
      return id === A ? remote(A, '2', [{ modId: B, version: '3' }, { modId: C }]) : remote(id, '3');
    }
  });
  assert.deepEqual(plan.items, [{ modId: A, version: '2' }, { modId: C, version: '3' }]);
  assert.equal(plan.dependencyCount, 1);
  assert.deepEqual(calls, [[A, true], [B, true], [C, true]], 'Root metadata must use its verified snapshot');
});

test('unknown dependency graph preserves installed mods without starting a partial unverified update', async () => {
  const plan = await planInstalledModUpdates([local()], {}, options({
    [A]: remote(A, '2', [{ modId: B, version: '1' }]), [B]: new Error('offline dependency')
  }));
  assert.equal(plan.updateCount, 0);
  assert.equal(plan.skippedCount, 1);
  assert.equal(plan.alreadyUpToDate, false);
  assert.deepEqual(plan.items, []);
  assert.equal(plan.failedDetails[0].modId, B);
});

test('metadata work uses at most six concurrent requests', async () => {
  const mods = Array.from({ length: 20 }, (_, index) => local(index.toString(16).padStart(16, '0')));
  let active = 0;
  let maximum = 0;
  const plan = await planInstalledModUpdates(mods, {}, {
    concurrency: 100,
    fetchDetails: async id => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return remote(id, '1');
    }
  });
  assert.ok(maximum <= 6 && maximum > 1);
  assert.equal(plan.upToDateCount, 20);
});

test('batch deadline bounds stalled metadata and returns safe partial information', async () => {
  let aborted = 0;
  const start = Date.now();
  const plan = await planInstalledModUpdates([local(A), local(B), local(C)], {}, {
    deadlineMs: 25,
    fetchDetails: async (id, request) => {
      if (id === A) return remote(id);
      request.signal.addEventListener('abort', () => { aborted++; });
      return new Promise(() => {});
    }
  });
  assert.ok(Date.now() - start < 1000);
  assert.equal(aborted, 2);
  assert.equal(plan.updateCount, 1);
  assert.equal(plan.skippedCount, 2);
  assert.deepEqual(plan.items, [{ modId: A, version: '2' }]);
});

function updaterHarness(overrides = {}) {
  const settings = { addonsDirectory: '/mods', profileDirectory: '/profile', downloadRoot: '/downloads', gameExecutable: '/game' };
  const calls = { queue: [], scans: 0, details: 0 };
  const deps = {
    getSettings: () => settings,
    scanInstalled: async () => { calls.scans++; return [local()]; },
    fetchDetails: async () => { calls.details++; return remote(); },
    isGameRunning: async () => false,
    getDownloadStatus: async () => ({ state: 'idle', resumeAvailable: false }),
    queueDownload: async (...args) => { calls.queue.push(args); return { launched: true, queuedCount: args[1].length }; },
    ...overrides
  };
  return { updater: createInstalledModUpdater(deps), settings, calls, deps };
}

test('update service passes exact checked pins through the queue without changing preset data', async () => {
  const { updater, calls } = updaterHarness();
  const result = await updater.update({ modIds: [A] });
  assert.equal(result.launched, true);
  assert.equal(result.queuedCount, 1);
  assert.equal(calls.scans, 2);
  assert.deepEqual(calls.queue[0][1], [{ modId: A, version: '2' }]);
  assert.equal(calls.details, 1);
  assert.equal('items' in result, false);
});

test('saved queue and game-running guards stop metadata work before preparation', async () => {
  for (const overrides of [
    { isGameRunning: async () => true },
    { getDownloadStatus: async () => ({ state: 'paused', resumeAvailable: true }) },
    { getDownloadStatus: async () => ({ state: 'queued', total: 0 }) }
  ]) {
    const { updater, calls } = updaterHarness(overrides);
    await assert.rejects(updater.update({}), /gameAlreadyRunning|workshopUpdateQueuePending/);
    assert.equal(calls.details, 0);
    assert.equal(calls.queue.length, 0);
  }
});

test('a game or saved queue appearing while checking blocks a late launch', async () => {
  for (const lateState of ['game', 'queue']) {
    let checked = false;
    const { updater, calls } = updaterHarness({
      fetchDetails: async () => { checked = true; return remote(); },
      isGameRunning: async () => lateState === 'game' && checked,
      getDownloadStatus: async () => ({ state: lateState === 'queue' && checked ? 'paused' : 'idle', resumeAvailable: lateState === 'queue' && checked })
    });
    await assert.rejects(updater.update({}), /gameAlreadyRunning|workshopUpdateQueuePending/);
    assert.equal(calls.queue.length, 0);
  }
});

test('paths or installed versions changing during checking require a fresh scan', async () => {
  const first = updaterHarness();
  first.deps.fetchDetails = async () => { first.settings.downloadRoot = '/other'; return remote(); };
  await assert.rejects(first.updater.update({}), /modUpdateSettingsChanged/);
  let scans = 0;
  const second = updaterHarness({ scanInstalled: async () => [local(A, ++scans === 1 ? '1' : '3')] });
  await assert.rejects(second.updater.update({}), /modUpdateFilesChanged/);
  assert.equal(first.calls.queue.length + second.calls.queue.length, 0);
});

test('a healthy dependency removed during checking blocks the root update', async () => {
  let scans = 0;
  const { updater, calls } = updaterHarness({
    scanInstalled: async () => ++scans === 1 ? [local(A), local(B, '3')] : [local(A)],
    fetchDetails: async id => id === A ? remote(A, '2', [{ modId: B, version: '2' }]) : remote(B, '3')
  });
  await assert.rejects(updater.update({ modIds: [A] }), /modUpdateFilesChanged/);
  assert.equal(calls.queue.length, 0);
});

test('a settings edit during the final disk scan cannot enqueue into old paths', async () => {
  const harness = updaterHarness();
  harness.deps.scanInstalled = async () => {
    if (++harness.calls.scans === 2) harness.settings.profileDirectory = '/different-profile';
    return [local()];
  };
  await assert.rejects(harness.updater.update({}), /modUpdateSettingsChanged/);
  assert.equal(harness.calls.queue.length, 0);
});

test('500 updates retain exact versions with bounded metadata traffic', async () => {
  const mods = Array.from({ length: 500 }, (_, index) => local((index + 1).toString(16).padStart(16, '0').toUpperCase()));
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const plan = await planInstalledModUpdates(mods, {}, {
    fetchDetails: async id => {
      calls++;
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return remote(id, '2.0.1');
    }
  });
  assert.equal(calls, 500);
  assert.ok(maximum <= 6);
  assert.equal(plan.updateCount, 500);
  assert.equal(plan.skippedCount, 0);
  assert.deepEqual(plan.items, mods.map(mod => ({ modId: mod.modId, version: '2.0.1' })));
});

test('an update whose dependencies exceed the queue limit does not enqueue', async () => {
  const dependencies = Array.from({ length: 500 }, (_, index) => ({
    modId: (index + 1).toString(16).padStart(16, '0').toUpperCase(), version: '1'
  }));
  const { updater, calls } = updaterHarness({
    fetchDetails: async id => id === A ? remote(A, '2', dependencies) : remote(id, '1')
  });
  await assert.rejects(updater.update({}), /dependency limit exceeded/);
  assert.equal(calls.queue.length, 0);
});

test('failed launch and a later game crash preserve exact update pins across controller recreation', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-update-crash-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  let running = false;
  const createController = () => createWorkshopDownloadController({ isGameRunning: async () => running });
  const controller = createController();
  const expectedItems = [{ modId: A, version: '2' }, { modId: B, version: '3' }];
  const { updater } = updaterHarness({
    fetchDetails: async id => id === A ? remote(A, '2', [{ modId: B, version: '3' }]) : remote(B, '3'),
    getDownloadStatus: () => controller.status(folder),
    queueDownload: (_settings, items) => controller.start(folder, async () => ({ items }), async () => {
      throw new Error('Simulated game launch failure');
    }, { requireEmptyQueue: true })
  });
  await assert.rejects(updater.update({ modIds: [A] }), /Simulated game launch failure/);
  assert.deepEqual((await readSession(folder)).items, expectedItems);
  assert.equal((await controller.status(folder)).resumeAvailable, true);
  const resumed = createController();
  await resumed.start(folder, async items => ({ items }), async (_prepared, items) => {
    assert.deepEqual(items, expectedItems);
    running = true;
    return { launched: true };
  }, { resume: true });
  await fs.writeFile(getQueuePaths(folder).statusPath, `downloading|0|2|0|${A}|35|Updating\n`);
  assert.equal((await resumed.status(folder)).state, 'downloading');
  running = false;
  const afterCrash = await createController().status(folder);
  assert.equal(afterCrash.state, 'paused');
  assert.equal(afterCrash.resumeAvailable, true);
  assert.equal(afterCrash.total, 2);
  assert.deepEqual((await readSession(folder)).items, expectedItems);
});

test('a stale terminal status with no recoverable items does not permanently block a new update', async () => {
  const { updater, calls } = updaterHarness({ getDownloadStatus: async () => ({ state: 'error', total: 1, resumeAvailable: false }) });
  assert.equal((await updater.update({})).queuedCount, 1);
  assert.equal(calls.queue.length, 1);
});

test('a concurrent click is rejected and the service becomes available after completion', async () => {
  let release;
  const { updater } = updaterHarness({ fetchDetails: () => new Promise(resolve => { release = resolve; }) });
  const pending = updater.update({});
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(updater.update({}), /modUpdateBusy/);
  release(remote(A, '1'));
  assert.equal((await pending).alreadyUpToDate, true);
});

test('queue start checks requireEmptyQueue under its lock and leaves saved pins unchanged', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-mod-updates-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const controller = createWorkshopDownloadController({ isGameRunning: async () => false });
  await controller.start(folder, async () => ({ items: [{ modId: A, version: '1' }] }), async () => ({ cancelled: true }));
  const before = await readSession(folder);
  await assert.rejects(controller.start(folder, async () => {
    assert.fail('New queue preparation must not run with saved pending items');
  }, async () => assert.fail('Launch must not run'), { requireEmptyQueue: true }), /workshopUpdateQueuePending/);
  assert.deepEqual(await readSession(folder), before);
});

test('fresh details bypass an existing cache and propagate caller cancellation through body reads', async () => {
  clearWorkshopDetailsCache();
  let version = '1';
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const text = `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { asset: { id: A, currentVersionNumber: version } } } })}</script>`;
    return { ok: true, url: `https://reforger.armaplatform.com/workshop/${A}`, text: async () => text };
  };
  assert.equal((await fetchWorkshopDetails(A, { fetchImpl })).version, '1');
  version = '2';
  assert.equal((await fetchWorkshopDetails(A, { fetchImpl })).version, '1');
  assert.equal((await fetchWorkshopDetails(A, { fetchImpl, refresh: true })).version, '2');
  assert.equal(calls, 2);
  const abort = new AbortController();
  const pending = fetchWorkshopDetails(A, {
    refresh: true, signal: abort.signal,
    fetchImpl: async () => ({ ok: true, text: () => new Promise(() => {}) })
  });
  setImmediate(() => abort.abort());
  await assert.rejects(pending, /не ответил вовремя/);
});

test('trusted main handler and preload expose installed update service using the exact payload', async () => {
  const main = fsSync.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const line = main.split(/\r?\n/).find(value => value.includes("ipcMain.handle('mods:update'"));
  assert.ok(line);
  const handlers = new Map();
  const payload = { modIds: [A] };
  vm.runInNewContext(line, {
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    installedModUpdater: { update: value => { assert.equal(value, payload); return 'updated'; } }
  });
  assert.equal(handlers.get('mods:update')(null, payload), 'updated');
  const preload = fsSync.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  let bridge;
  vm.runInNewContext(preload, { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
    ipcRenderer: { invoke: (channel, value) => ({ channel, value }) }
  }) });
  assert.deepEqual(bridge.updateInstalledMods(payload), { channel: 'mods:update', value: payload });
  assert.match(main, /exactCollection: true, requireEmptyQueue: true/);
});
