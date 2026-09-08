const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createWorkshopDownloadController } = require('../src/core/workshopDownloadSession');
const { getQueuePaths, readWorkshopQueue, WORKSHOP_BRIDGE_MOD_ID } = require('../src/core/workshopDownloadQueue');
const { assessPreset, resolvePresetDependencies, getMissingPresetMods } = require('../src/core/modScanner');
const { buildAddonDownloadArguments } = require('../src/core/launchBuilder');
const { createServerConnectionController } = require('../src/core/serverConnectionController');

// Run the actual IPC handlers and queue preparation, with temporary profiles
// and fake executable/Steam boundaries. No Electron, game or network is used.
const source = fsSync.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing main integration section: ${start}`);
  return source.slice(first, last);
}

const ROOT = '1337C0DE5DABBEEF';
const DEPENDENCY = '595F2BF2F44836FB';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-workshop-main-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    profileDirectory: path.join(directory, 'profile-root'),
    downloadRoot: path.join(directory, 'downloads'),
    addonsDirectory: path.join(directory, 'downloads', 'addons'),
    gameExecutable: path.join(directory, 'mock-game.exe')
  };
}

function runtime(settings, options = {}) {
  const handlers = new Map();
  const calls = { launches: [], metadata: [], cleanup: [], monitors: [] };
  const isGameRunning = async () => options.running === true;
  const downloads = createWorkshopDownloadController({ isGameRunning });
  const context = vm.createContext({
    fs, path, Date, Promise, Error, Math,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    settingsStore: { get: () => settings, update: async patch => Object.assign(settings, patch) },
    findGameExecutable: async () => settings.gameExecutable,
    installedMods: options.installedMods || [],
    scanMods: async () => options.installedMods || [],
    assessPreset, resolvePresetDependencies, getMissingPresetMods,
    isArmaReforgerRunning: isGameRunning,
    workshopDownloads: downloads,
    prepareGameProfile: async () => {},
    prepareWorkshopBridge: async () => ({
      addonsDirectory: path.join(settings.profileDirectory, 'mock-bridge'),
      targetDirectory: path.join(settings.profileDirectory, 'mock-bridge')
    }),
    resolveWorkshopQueue: async items => {
      calls.metadata.push(items);
      return { items: options.resolveItems ? options.resolveItems(items) : items, failedDetails: [] };
    },
    buildAddonDownloadArguments,
    WORKSHOP_BRIDGE_MOD_ID,
    launchWithExactArguments: async (...args) => {
      calls.launches.push(args);
      return { method: 'mock', cancelled: false };
    },
    logger: { info() {}, error() {} },
    mainT: key => key,
    createServerConnectionController,
    createNativeServerLauncher: () => options.nativeLaunch,
    launchThroughSteam: async () => { assert.fail('real Steam boundary reached'); },
    fetchServerDetails: async () => { assert.fail('unexpected catalog fetch'); },
    resolveGameExecutable: async () => ({ settings, gameExecutable: settings.gameExecutable }),
    serverModAssessment: mods => assessPreset({ mods }, options.installedMods || []),
    cancelServerJoinRequest: async request => { calls.cleanup.push(request); },
    createServerJoinMonitor: details => { calls.monitors.push(details); return () => {}; },
    stopServerLaunchMonitor: null,
    presetStore: { saveServerPreset: async () => { assert.fail('unexpected preset write'); } },
    mainWindow: null
  });
  vm.runInContext([
    section('async function queueWorkshopDownload(', 'function registerSystemHandlers('),
    section('function registerServerHandlers()', 'function registerSettingsHandlers()')
  ].join('\n'), context, { filename: 'main-workshop-download-integration.js' });
  context.registerGameHandlers();
  if (options.nativeLaunch) context.registerServerHandlers();
  return { calls, downloads, invoke: (name, ...args) => handlers.get(name)(null, ...args) };
}

test('resume IPC restores the saved exact queue after restart with an empty current selection', async t => {
  const settings = await fixture(t);
  const first = runtime(settings, {
    resolveItems: items => [...items, { modId: DEPENDENCY, version: '3.2.1' }]
  });
  await first.invoke('workshop:install', { modId: ROOT, name: 'Root', version: '2.0.4' });
  const paths = getQueuePaths(settings.profileDirectory);
  await fs.writeFile(paths.statusPath, `downloading|0|2|0|${ROOT}|37|in progress\n`);
  await fs.rm(paths.queuePath); // The game can consume/remove the exchange file.
  const interrupted = await first.invoke('game:download-status');
  assert.equal(interrupted.state, 'paused');
  assert.equal(interrupted.resumeAvailable, true);

  const reopened = runtime(settings);
  const resumed = await reopened.invoke('game:resume-download');
  assert.equal(resumed.launched, true);
  assert.equal(resumed.queuedCount, 2);
  assert.equal(reopened.calls.metadata.length, 0, 'resume must preserve stored versions without re-expanding metadata');
  assert.equal(reopened.calls.launches.length, 1);
  assert.deepEqual(await readWorkshopQueue(settings.profileDirectory), [
    { modId: ROOT, version: '2.0.4' }, { modId: DEPENDENCY, version: '3.2.1' }
  ]);
});

test('Workshop install queues corrupt and mismatched copies instead of declaring them already installed', async t => {
  for (const installed of [
    { modId: ROOT, version: '2.0.0', corrupted: true },
    { modId: ROOT, version: '1.0.0', corrupted: false },
    { modId: ROOT, version: '', corrupted: false }
  ]) {
    const settings = await fixture(t);
    const app = runtime(settings, { installedMods: [installed] });
    const result = await app.invoke('workshop:install', { modId: ROOT, version: '2.0.0' });
    assert.equal(result.alreadyInstalled, undefined);
    assert.equal(result.launched, true);
    assert.equal(app.calls.launches.length, 1);
    assert.deepEqual(await readWorkshopQueue(settings.profileDirectory), [{ modId: ROOT, version: '2.0.0' }]);
  }
});

test('Workshop install still skips a verified matching installed version', async t => {
  const settings = await fixture(t);
  const app = runtime(settings, { installedMods: [{ modId: ROOT, version: '2.0.0', corrupted: false }] });
  const result = await app.invoke('workshop:install', { modId: ROOT, version: '2.0.0' });
  assert.equal(result.alreadyInstalled, true);
  assert.equal(app.calls.launches.length, 0);
  assert.equal(app.calls.metadata.length, 0);
});

test('main server cancellation hook removes the late handoff without starting a stale monitor', async t => {
  const settings = await fixture(t);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const request = { token: 'a'.repeat(32), profileDirectory: settings.profileDirectory };
  const app = runtime(settings, { nativeLaunch: async () => { entered(); return pending; } });
  const result = app.invoke('servers:connect', { address: '127.0.0.1:2001' });
  await started;
  app.invoke('servers:cancel-connect');
  release({ method: 'mock', joinRequest: request });
  assert.equal((await result).reason, 'cancelled');
  assert.deepEqual(app.calls.cleanup, [request]);
  assert.equal(app.calls.monitors.length, 0);
});

function rendererRuntime(api, initialDownloadState = 'downloading') {
  const rendererSource = fsSync.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const extract = (start, end) => {
    const offset = rendererSource.indexOf(start);
    const finish = rendererSource.indexOf(end, offset + start.length);
    assert.ok(offset >= 0 && finish > offset);
    return rendererSource.slice(offset, finish);
  };
  const toasts = [];
  const state = { busy: false, settings: {gameExecutable:'mock.exe'}, installedMods: [], modDownloadStatus: { state: initialDownloadState } };
  const context = vm.createContext({
    state, api,
    modDownloadTimer: 0, modDownloadPollGeneration: 0, modDownloadPollFailures: 0,
    activeModDownloadStates: new Set(['queued', 'waiting', 'preparing', 'downloading', 'failed', 'unknown']),
    setTimeout: () => 1, clearTimeout() {},
    setBusy: busy => { state.busy = busy; },
    waitForPendingSaves: async () => {}, saveSettings: async () => {},
    renderLaunchState() {}, renderAll() {}, renderWorkshop() {}, recordModActions() {},
    installedById: () => new Map(state.installedMods.map(mod => [mod.modId, mod])),
    $: () => ({open:false}),
    t: key => key, showToast: message => toasts.push(message), errorMessage: error => error.message,
    Date, Math, Promise
  });
  vm.runInContext([
    extract('function modAcquisitionState(', 'function renderModAcquisitionControls()'),
    extract('async function installWorkshopMod(mod)', 'function detailFact('),
    extract('function scheduleModDownloadPoll(', 'function renderUpdateStatus()')
  ].join('\n'), context, { filename: 'renderer-workshop-race-integration.js' });
  return { context, state, toasts };
}

test('an old renderer terminal poll cannot overwrite a newly queued Workshop install', async () => {
  let releaseStatus;
  const pendingStatus = new Promise(resolve => { releaseStatus = resolve; });
  const app = rendererRuntime({
    getModDownloadStatus: () => pendingStatus,
    installWorkshopMod: async () => ({ queuedCount: 2 }),
    scanMods: async () => []
  }, 'idle');
  const oldPoll = app.context.pollModDownloadStatus();
  await app.context.installWorkshopMod({ modId: ROOT, version: '2.0.0' });
  releaseStatus({ state: 'complete', completed: 1, total: 1 });
  await oldPoll;
  assert.equal(app.state.modDownloadStatus.state, 'queued');
  assert.equal(app.state.modDownloadStatus.total, 2);
  assert.equal(app.toasts.includes('toast.missingDownloadComplete'), false);
});

test('an older completion rescan cannot replace the mod list after a new download started', async () => {
  let releaseScan;
  let enteredScan;
  const scanning = new Promise(resolve => { enteredScan = resolve; });
  const pendingScan = new Promise(resolve => { releaseScan = resolve; });
  const app = rendererRuntime({
    getModDownloadStatus: async () => ({ state: 'complete', completed: 1, total: 1 }),
    installWorkshopMod: async () => ({ queuedCount: 2 }),
    scanMods: () => { enteredScan(); return pendingScan; }
  });
  const oldPoll = app.context.pollModDownloadStatus();
  await scanning;
  await app.context.installWorkshopMod({ modId: ROOT, version: '2.0.0' });
  const currentMods = [{ modId: DEPENDENCY, version: '3.2.1' }];
  app.state.installedMods = currentMods;
  releaseScan([{ modId: ROOT, version: 'old' }]);
  await oldPoll;
  assert.equal(app.state.installedMods, currentMods);
  assert.equal(app.state.modDownloadStatus.state, 'queued');
});
