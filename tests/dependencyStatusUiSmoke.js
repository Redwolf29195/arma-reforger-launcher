const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : String(process.argv[index + 1] || '');
}

const projectRoot = path.resolve(argumentValue('--project-root') || path.join(__dirname, '..'));
const resultPath = argumentValue('--result');
const liveRefresh = process.argv.includes('--live-refresh');
const profilePath = fsSync.mkdtempSync(path.join(os.tmpdir(), 'arma-launcher-dependency-ui-'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
app.setPath('userData', profilePath);
app.setPath('sessionData', path.join(profilePath, 'session'));

const ids = {
  main: 'A000000000000001', ready: 'B000000000000001', missing: 'B000000000000002',
  mismatch: 'B000000000000003', unknown: 'B000000000000004', corrupted: 'B000000000000005'
};
const dependencies = [
  { modId: ids.ready, name: 'Ready dependency', version: '2.0.0' },
  { modId: ids.missing, name: 'Missing dependency', version: '2.0.0' },
  { modId: ids.mismatch, name: 'Mismatch dependency', version: '2.0.0' },
  { modId: ids.unknown, name: 'Unknown dependency', version: '2.0.0' },
  { modId: ids.corrupted, name: 'Corrupted dependency', version: '1.0.0' }
];
const expectedStatuses = {
  ready: 'ready', missing: 'missing', mismatch: 'version-mismatch',
  unknown: 'version-unknown', corrupted: 'corrupted'
};
const preset = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Pinned server preset',
  createdAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:00:00.000Z',
  mods: [{ modId: ids.main, name: 'Main mod', version: '1.0.0', required: true }]
};
const workspace = { activePresetId: preset.id, name: preset.name, dirty: false, mods: preset.mods };
const localMod = (modId, name, version, extra = {}) => ({
  modId, name, version, directoryPath: path.join(profilePath, 'mock-addons', modId),
  dependencies: [], corrupted: false, ...extra
});
let installedMods = [
  localMod(ids.main, 'Main mod', '1.0.0', { dependencies }),
  localMod(ids.ready, dependencies[0].name, '2.0.0'),
  localMod(ids.mismatch, dependencies[2].name, '1.0.0'),
  localMod(ids.unknown, dependencies[3].name, ''),
  localMod(ids.corrupted, dependencies[4].name, '1.0.0', { corrupted: true })
];
const report = { tests: [], online: {}, offline: {}, rendererErrors: [] };
let window;
let finished = false;
const watchdog = setTimeout(() => finish(new Error('Dependency UI smoke exceeded 45 seconds')), 45_000);

async function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (error) report.error = error?.stack || String(error);
  if (window && !window.isDestroyed()) window.destroy();
  try {
    if (resultPath) {
      await fs.mkdir(path.dirname(path.resolve(resultPath)), { recursive: true });
      await fs.writeFile(resultPath, JSON.stringify(report, null, 2));
    }
  } catch (writeError) {
    report.error = `${report.error || ''}\nResult write failed: ${writeError.message}`.trim();
  } finally {
    (report.error ? process.stderr : process.stdout).write(`${JSON.stringify(report)}\n`);
    // Renderer syntax/bootstrap failures and timeouts must fail the release check.
    app.exit(report.error ? 1 : 0);
  }
}

async function waitFor(check, label, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`UI wait timed out: ${label}`);
}

app.whenReady().then(async () => {
  const settings = {
    gameExecutable: path.join(profilePath, 'mock-game', 'ArmaReforgerSteam.exe'),
    addonsDirectory: path.join(profilePath, 'mock-addons'), downloadRoot: '',
    profileDirectory: profilePath, noSplash: true, allowVersionMismatch: false,
    additionalArguments: '', defaultPresetId: preset.id, autoUpdate: false,
    showModLogsFooter: false, autoAddDependencies: false, confirmModDeletion: true,
    advancedMode: false, favoriteMods: [], favoriteServers: [], language: 'en'
  };
  let lastWorkspace = structuredClone(workspace);
  let presetWrites = 0;
  let detailReads = 0;
  let scanCount = 0;
  let offline = false;
  ipcMain.handle('launcher:bootstrap', () => ({
    appVersion: '0.3.39', packaged: false, platform: 'win32', settings,
    presets: [structuredClone(preset)], installedMods, workspace: structuredClone(workspace), modLogCount: 0
  }));
  ipcMain.handle('workspace:save', (_event, value) => { lastWorkspace = structuredClone(value); return value; });
  ipcMain.handle('presets:save', (_event, value) => { presetWrites++; return value; });
  ipcMain.handle('mods:scan', () => { scanCount++; return installedMods; });
  ipcMain.handle('game:download-status', () => ({ state: 'idle', completed: 0, total: 0, failed: 0, progress: 0 }));
  ipcMain.handle('mods:details', (_event, modId) => {
    detailReads++;
    if (offline) throw new Error('Offline fixture: Workshop is unavailable');
    return {
      modId, name: 'Main mod', author: 'Fixture author', version: '1.1.0',
      summary: 'Offline test fixture', description: 'Dependency states use local versions.',
      gameVersion: '1.8.0.13', sizeBytes: 1024, ratingPercent: 100, ratingCount: 1,
      downloads: 1, dependencies, previewUrls: [], versions: [], tags: [], scenarios: []
    };
  });

  window = new BrowserWindow({
    width: 1380, height: 850, show: false,
    webPreferences: {
      preload: path.join(projectRoot, 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true
    }
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) report.rendererErrors.push(message);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!finished) finish(new Error(`Renderer exited: ${details.reason}`));
  });
  await window.loadFile(path.join(projectRoot, 'src', 'renderer', 'index.html'));
  const ui = (source) => window.webContents.executeJavaScript(source);
  await waitFor(() => ui(`document.querySelector('#titlebarStatus')?.textContent.trim() !== 'Loading launcher' && document.querySelector('#rescanMods')?.disabled === false`), 'bootstrap');
  await ui(`document.querySelector('[data-view="mods"]').click()`);
  await waitFor(() => ui(`Boolean(document.querySelector('#modsTableBody [data-mod-id="${ids.main}"] .mod-main'))`), 'main installed mod row');

  const readStates = () => ui(`Object.fromEntries([...document.querySelectorAll('#modDetailsBody .mod-details-dependency:not(.mod-details-dependent)')].map((row) => {
    const badge = row.querySelector('.dependency-state');
    return [row.dataset.detailModId, {
      status: badge?.dataset.dependencyStatus || row.dataset.dependencyStatus,
      text: badge?.textContent.trim(), title: badge?.title, className: badge?.className
    }];
  }))`);
  function assertStates(states, expected = expectedStatuses) {
    assert.equal(Object.keys(states).length, 5, 'all dependency cards must be present');
    for (const [key, status] of Object.entries(expected)) {
      assert.equal(states[ids[key]]?.status, status, `dependency ${key}`);
      assert.ok(states[ids[key]].text && !states[ids[key]].text.startsWith('mods.'), `translated ${key} status`);
    }
  }
  async function openMainDetails() {
    await ui(`document.querySelector('#modsTableBody [data-mod-id="${ids.main}"] .mod-main').click()`);
    await waitFor(() => ui(`document.querySelector('#modDetailsDialog').open && document.querySelectorAll('#modDetailsBody .dependency-state').length === 5`), 'five dependency badges');
  }

  await openMainDetails();
  report.online = await readStates();
  assertStates(report.online);
  assert.match(report.online[ids.mismatch].title, /1\.0\.0/);
  assert.match(report.online[ids.mismatch].title, /2\.0\.0/);
  report.tests.push('online details compare required versions with installed versions for all five states');

  await ui(`document.querySelector('#closeModDetailsTop').click()`);
  offline = true;
  const readsBeforeOffline = detailReads;
  await openMainDetails();
  assert.equal(detailReads, readsBeforeOffline + 1, 'offline fixture must be requested');
  assert.equal(await ui(`Boolean(document.querySelector('#modDetailsBody .mod-details-message'))`), true, 'offline details show fallback message');
  report.offline = await readStates();
  assertStates(report.offline);
  assert.deepEqual(report.offline, report.online, 'local dependency fallback retains all status information');
  report.tests.push('failed Workshop request preserves dependency cards using local metadata');

  if (liveRefresh) {
    installedMods = installedMods.filter((mod) => mod.modId !== ids.ready).map((mod) => {
      if (mod.modId === ids.mismatch || mod.modId === ids.unknown) return { ...mod, version: '2.0.0' };
      if (mod.modId === ids.corrupted) return { ...mod, corrupted: false };
      return mod;
    });
    installedMods.push(localMod(ids.missing, dependencies[1].name, '2.0.0'));
    const scansBefore = scanCount;
    const readsBeforeRefresh = detailReads;
    // Invoke the real rescan handler while the details dialog remains open,
    // exercising the same render path used by a background inventory refresh.
    await ui(`document.querySelector('#rescanMods').click()`);
    await waitFor(() => scanCount > scansBefore, 'inventory rescan');
    await waitFor(async () => (await readStates())[ids.ready]?.status === 'missing', 'open details refresh after inventory changes');
    report.refreshed = await readStates();
    assertStates(report.refreshed, { ready: 'missing', missing: 'ready', mismatch: 'ready', unknown: 'ready', corrupted: 'ready' });
    assert.equal(await ui(`document.querySelector('#modDetailsDialog').open`), true);
    assert.equal(detailReads, readsBeforeRefresh, 'inventory-only refresh does not retry Workshop');
    report.tests.push('open offline details refresh after installed dependencies change');
  }

  assert.deepEqual(lastWorkspace, workspace, 'viewing and refreshing details preserves the pinned workspace');
  assert.equal(presetWrites, 0, 'details never rewrite the active preset');
  assert.equal(report.rendererErrors.some((message) => /SyntaxError|ReferenceError|TypeError|No handler registered/.test(message)), false, report.rendererErrors.join('\n'));
  report.tests.push('details preserve preset pins and introduce no renderer runtime errors');
  report.detailReads = detailReads;
  report.scanCount = scanCount;
  await finish();
}).catch(finish);
