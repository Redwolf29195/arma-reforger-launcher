const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { assessPreset, getMissingPresetMods, resolvePresetDependencies } = require('../src/core/modScanner');
const { buildLaunchArguments, buildAddonDownloadArguments } = require('../src/core/launchBuilder');
const { createNativeServerLauncher } = require('../src/core/serverNativeLauncher');
const { createServerConnectionController } = require('../src/core/serverConnectionController');
const { WORKSHOP_BRIDGE_MOD_ID } = require('../src/core/workshopDownloadQueue');

// Execute the real main helper and all three launch routes. Every filesystem,
// settings sync, game, bridge exchange and Steam boundary is mocked; paths below
// are labels only and are never created or inspected.
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing main integration section: ${start}`);
  return source.slice(first, last);
}
const MOD = { modId: '1337C0DE5DABBEEF', version: '2.0.0', name: 'Test mod' };
const defaultSyncResult = () => ({ copied: 2, preserved: 1, conflicts: [], sourceDirectory: 'mock-source', skipped: false });

function runtime(options = {}) {
  const base = path.join(os.tmpdir(), 'algz-profile-integration-mocked');
  const settings = {
    gameExecutable: path.join(base, 'ArmaReforgerSteam.exe'),
    profileDirectory: path.join(base, 'launcher-profile'),
    downloadRoot: path.join(base, 'download-root'),
    addonsDirectory: path.join(base, 'alternate-mod-root', 'addons')
  };
  const userHome = path.join(base, 'user-home');
  const documents = path.join(base, 'redirected-documents');
  const events = [];
  const syncCalls = [];
  const logs = [];
  const handlers = new Map();
  const installedMods = [{ ...MOD, corrupted: false, dependencies: [] }];
  const context = vm.createContext({
    app: { getPath: key => ({ home: userHome, documents })[key] },
    process: { platform: options.platform || 'win32' },
    fs: { mkdir: async () => {} },
    path, Promise, Date, Error, Math,
    settingsStore: { get: () => settings, update: async patch => Object.assign(settings, patch) },
    findGameExecutable: async () => settings.gameExecutable,
    resolveGameExecutable: async () => ({ settings, gameExecutable: settings.gameExecutable }),
    isArmaReforgerRunning: async () => false,
    installedMods, scanMods: async () => installedMods,
    assessPreset, getMissingPresetMods, resolvePresetDependencies,
    syncGameProfileSettings: async request => {
      events.push('profile');
      syncCalls.push(request);
      return options.sync ? options.sync(request) : defaultSyncResult();
    },
    syncWorkshopSelection: async () => { events.push('selection'); return { enabled: 1, disabled: 0, updated: 1 }; },
    buildLaunchArguments, buildAddonDownloadArguments, WORKSHOP_BRIDGE_MOD_ID,
    prepareWorkshopBridge: async () => {
      events.push('bridge');
      return { addonsDirectory: path.join(base, 'bridge'), targetDirectory: path.join(base, 'bridge') };
    },
    resolveWorkshopQueue: async items => { events.push('metadata'); return { items, failedDetails: [] }; },
    workshopDownloads: {
      start: async (_profile, prepare, launch) => {
        const prepared = await prepare(null);
        return launch(prepared, prepared.items, () => false);
      },
      status: async () => ({ state: 'idle' })
    },
    launchThroughSteam: async () => { events.push('steam'); return { method: 'mock' }; },
    launchWithExactArguments: async () => { events.push('exact-launch'); return { method: 'mock' }; },
    createServerConnectionController,
    createNativeServerLauncher: dependencies => createNativeServerLauncher({
      ...dependencies,
      mkdir: async () => {},
      prepareRequest: async () => {
        events.push('request');
        return { token: 'a'.repeat(32), statusPath: path.join(base, 'mock-status'), startedAt: Date.now() };
      },
      cancelRequest: async () => { events.push('cleanup'); }
    }),
    fetchServerDetails: async () => { assert.fail('unexpected catalog request'); },
    serverModAssessment: mods => assessPreset({ mods }, installedMods),
    createServerJoinMonitor: () => { events.push('monitor'); return () => {}; },
    cancelServerJoinRequest: async () => { events.push('cleanup'); },
    stopServerLaunchMonitor: null,
    presetStore: { saveServerPreset: async () => { assert.fail('unexpected preset write'); } },
    mainWindow: null,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    mainT: (key, values) => values?.message ? `${key}: ${values.message}` : key,
    logger: { info: message => logs.push(message), error: message => logs.push(message) }
  });
  vm.runInContext([
    section('async function prepareGameProfile(', 'async function prepareWorkshopBridge('),
    section('async function queueWorkshopDownload(', 'function registerSystemHandlers('),
    section('function registerServerHandlers()', 'function registerSettingsHandlers()')
  ].join('\n'), context, { filename: 'main-game-profile-settings-integration.js' });
  context.registerGameHandlers();
  context.registerServerHandlers();
  return {
    context, settings, userHome, documents, events, syncCalls, logs,
    invoke: (name, ...args) => handlers.get(name)(null, ...args)
  };
}

test('main selects redirected Documents before legacy profile locations and keeps configured fallbacks', async () => {
  const app = runtime();
  await app.context.prepareGameProfile(app.settings);
  assert.equal(app.syncCalls[0].profileDirectory, app.settings.profileDirectory);
  assert.deepEqual(Array.from(app.syncCalls[0].sourceProfileDirectories), [
    path.join(app.documents, 'My Games', 'ArmaReforger'),
    path.join(app.userHome, 'Documents', 'My Games', 'ArmaReforger'),
    path.join(app.userHome, 'OneDrive', 'Documents', 'My Games', 'ArmaReforger'),
    app.settings.downloadRoot,
    path.dirname(app.settings.addonsDirectory)
  ]);
});

test('main includes the native Linux profile location when selecting settings sources', async () => {
  const app = runtime({ platform: 'linux' });
  await app.context.prepareGameProfile(app.settings);
  assert.equal(app.syncCalls[0].sourceProfileDirectories[3], path.join(app.userHome, '.local', 'share', 'ArmaReforger'));
});

const routes = [
  { name: 'normal game launch', start: app => app.invoke('game:launch', { mods: [MOD] }), expected: ['profile', 'selection', 'steam'] },
  {
    name: 'Workshop download',
    start: app => app.invoke('workshop:install', { ...MOD, version: '3.0.0' }),
    expected: ['profile', 'bridge', 'metadata', 'exact-launch']
  },
  { name: 'native server join', start: app => app.invoke('servers:connect', { address: '127.0.0.1:2001' }), expected: ['profile', 'bridge', 'request', 'steam', 'monitor'] }
];

for (const route of routes) {
  test(`${route.name} awaits profile preparation before selection, bridge or launch`, async () => {
    let entered;
    let release;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const app = runtime({ sync: async () => { entered(); await pending; return defaultSyncResult(); } });
    const launching = route.start(app);
    await started;
    assert.deepEqual(app.events, ['profile']);
    release();
    const result = await launching;
    assert.equal(result.launched, true);
    assert.equal(app.syncCalls.length, 1);
    assert.deepEqual(app.events, route.expected);
  });

  test(`${route.name} does not launch when settings preparation fails`, async () => {
    const app = runtime({ sync: async () => { throw new Error('EACCES sensitive-test-path'); } });
    await assert.rejects(route.start(app), error => error.message === 'gameSettingsImportFailed');
    assert.deepEqual(app.events, ['profile']);
    assert.ok(app.logs.some(message => message.includes('EACCES sensitive-test-path')));
  });
}

test('main cancellation during native profile preparation prevents bridge, request, Steam and monitor', async () => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const app = runtime({ sync: async () => { entered(); await pending; return defaultSyncResult(); } });
  const launching = app.invoke('servers:connect', { address: '127.0.0.1:2001' });
  await started;
  app.invoke('servers:cancel-connect');
  release();
  const result = await launching;
  assert.equal(result.launched, false);
  assert.equal(result.reason, 'cancelled');
  assert.deepEqual(app.events, ['profile']);
});
