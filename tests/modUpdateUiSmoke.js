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
const profilePath = fsSync.mkdtempSync(path.join(os.tmpdir(), 'arma-launcher-mod-update-ui-'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
app.setPath('userData', profilePath);
app.setPath('sessionData', path.join(profilePath, 'session'));

const ids = {
  main: 'A000000000000001', other: 'A000000000000002',
  ready: 'B000000000000001', missing: 'B000000000000002',
  mismatch: 'B000000000000003', unknown: 'B000000000000004',
  corrupted: 'B000000000000005'
};
const dependencies = [
  { modId: ids.ready, name: 'Ready dependency', version: '2.0.0' },
  { modId: ids.missing, name: 'Missing dependency', version: '2.0.0' },
  { modId: ids.mismatch, name: 'Mismatch dependency', version: '2.0.0' },
  { modId: ids.unknown, name: 'Unknown dependency', version: '2.0.0' },
  { modId: ids.corrupted, name: 'Corrupted dependency', version: '1.0.0' }
];
const preset = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Pinned server preset',
  createdAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:00:00.000Z',
  mods: [
    { modId: ids.main, name: 'Main mod', version: '1.0.0', required: true },
    { ...dependencies[1], required: true }
  ]
};
const initialWorkspace = {
  activePresetId: preset.id, name: preset.name, dirty: false, mods: preset.mods
};
const localMod = (modId, name, version, extra = {}) => ({
  modId, name, version, directoryPath: path.join(profilePath, 'mock-addons', modId),
  dependencies: [], corrupted: false, ...extra
});
let installedMods = [
  localMod(ids.main, 'Main mod', '1.0.0', { dependencies }),
  localMod(ids.other, 'Other installed mod', '1.0.0'),
  localMod(ids.ready, dependencies[0].name, '2.0.0'),
  localMod(ids.mismatch, dependencies[2].name, '1.0.0'),
  localMod(ids.unknown, dependencies[3].name, ''),
  localMod(ids.corrupted, dependencies[4].name, '1.0.0', { corrupted: true })
];

const report = { tests: [], requests: [], dependencyStates: {}, rendererErrors: [] };
let window;
let finished = false;
const watchdog = setTimeout(() => finish(new Error('Mod update UI smoke exceeded 60 seconds')), 60_000);

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
    // Explicit failure exit also covers renderer syntax/bootstrap errors.
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
  let lastWorkspace = structuredClone(initialWorkspace);
  const presetWrites = [];
  let pendingUpdate = null;
  let statusReads = 0;
  let scanCount = 0;
  let detailReads = 0;
  let downloadStatus = { state: 'idle', completed: 0, total: 0, failed: 0, progress: 0 };

  ipcMain.handle('launcher:bootstrap', () => ({
    appVersion: '0.3.39', packaged: false, platform: 'win32', settings,
    presets: [structuredClone(preset)], installedMods,
    workspace: structuredClone(initialWorkspace), modLogCount: 0
  }));
  ipcMain.handle('workspace:save', (_event, workspace) => {
    lastWorkspace = structuredClone(workspace);
    return workspace;
  });
  ipcMain.handle('settings:save', (_event, values) => Object.assign(settings, values));
  ipcMain.handle('presets:save', (_event, savedPreset) => {
    presetWrites.push(structuredClone(savedPreset));
    return savedPreset;
  });
  ipcMain.handle('mod-logs:add', () => ({ count: 0 }));
  ipcMain.handle('mod-logs:add-many', () => ({ count: 0 }));
  ipcMain.handle('mods:scan', () => { scanCount++; return installedMods; });
  ipcMain.handle('game:download-status', () => { statusReads++; return downloadStatus; });
  ipcMain.handle('mods:details', (_event, modId) => {
    detailReads++;
    return {
      modId, name: 'Main mod', author: 'Fixture author', version: '1.1.0',
      summary: 'Offline test fixture', description: 'Dependency states use local versions.',
      gameVersion: '1.8.0.13', sizeBytes: 1024, ratingPercent: 100, ratingCount: 1,
      downloads: 1, dependencies, previewUrls: [], versions: [], tags: [], scenarios: []
    };
  });
  ipcMain.handle('mods:update', (_event, payload) => {
    report.requests.push(structuredClone(payload));
    if (pendingUpdate) throw new Error('Duplicate request reached the mock backend');
    return new Promise((resolve, reject) => { pendingUpdate = { resolve, reject }; });
  });
  // These fail if a UI regression attempts a real launch path. All paths are mocks.
  for (const channel of ['game:launch', 'game:download-missing', 'game:resume-download']) {
    ipcMain.handle(channel, () => { throw new Error(`Unexpected game action: ${channel}`); });
  }

  window = new BrowserWindow({
    width: 1380, height: 850, show: false,
    webPreferences: {
      preload: path.join(projectRoot, 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false
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
  await waitFor(() => ui(`Boolean(document.querySelector('#updateMods') && !document.querySelector('#updateMods').disabled && document.querySelector('#modsTableBody'))`), 'bootstrap/update control');
  await ui(`document.querySelector('[data-view="mods"]').click()`);
  await waitFor(() => ui(`document.querySelectorAll('#modsTableBody .mod-row').length === 7`), 'installed and missing rows');

  assert.equal(await ui(`document.querySelectorAll('#modsTableBody .update-mod-button').length`), installedMods.length);
  assert.equal(await ui(`Boolean(document.querySelector('[data-mod-id="${ids.missing}"] .update-mod-button'))`), false);
  report.tests.push('update action exists only for installed rows');

  await ui(`document.querySelector('#modsTableBody [data-mod-id="${ids.main}"] .mod-main').click()`);
  await waitFor(() => ui(`document.querySelectorAll('#modDetailsBody .dependency-state').length === 5`), 'five dependency state badges');
  report.dependencyStates = await ui(`Object.fromEntries([...document.querySelectorAll('#modDetailsBody .mod-details-dependency:not(.mod-details-dependent)')].map((row) => {
    const badge = row.querySelector('.dependency-state');
    return [row.dataset.detailModId, { status: badge?.dataset.dependencyStatus || row.dataset.dependencyStatus, text: badge?.textContent.trim() }];
  }))`);
  for (const [key, expected] of Object.entries({ ready: 'ready', missing: 'missing', mismatch: 'version-mismatch', unknown: 'version-unknown', corrupted: 'corrupted' })) {
    assert.equal(report.dependencyStates[ids[key]]?.status, expected, `dependency ${key}`);
    assert.ok(report.dependencyStates[ids[key]].text, `visible dependency ${key} label`);
  }
  await ui(`document.querySelector('#closeModDetailsTop').click()`);
  report.tests.push('dependency badges distinguish ready, missing, mismatch, unknown and corrupted');

  const buttonState = () => ui(`({
    bulkDisabled: document.querySelector('#updateMods').disabled,
    rowDisabled: [...document.querySelectorAll('#modsTableBody .update-mod-button')].every(button => button.disabled),
    rowEnabled: [...document.querySelectorAll('#modsTableBody .update-mod-button')].every(button => !button.disabled),
    checking: document.querySelector('#updateMods').getAttribute('aria-busy') === 'true',
    detailsOpen: document.querySelector('#modDetailsDialog').open
  })`);
  async function beginRequest(selector, expectedIds) {
    const count = report.requests.length;
    await ui(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await waitFor(() => pendingUpdate !== null, 'update IPC pending');
    assert.equal(report.requests.length, count + 1);
    assert.deepEqual([...report.requests.at(-1).modIds].sort(), [...expectedIds].sort());
    const controls = await buttonState();
    assert.equal(controls.bulkDisabled, true, 'bulk disabled during request');
    assert.equal(controls.rowDisabled, true, 'row actions disabled during request');
    assert.equal(controls.detailsOpen, false, 'update must not open details');
    await ui(`document.querySelector('#updateMods').click(); document.querySelector('#modsTableBody .update-mod-button').click();`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(report.requests.length, count + 1, 'disabled repeated click must not send another IPC');
  }
  async function settleRequest(value, error) {
    const pending = pendingUpdate;
    pendingUpdate = null;
    if (error) pending.reject(new Error(error));
    else pending.resolve(value);
    if (!error && value?.queuedCount > 0) {
      await waitFor(async () => !(await buttonState()).checking, 'update request settled into download queue');
      const controls = await buttonState();
      assert.equal(controls.bulkDisabled, true, 'bulk remains disabled while downloading');
      assert.equal(controls.rowDisabled, true, 'row actions remain disabled while downloading');
      return;
    }
    await waitFor(async () => !(await buttonState()).bulkDisabled, 'update controls restored');
    assert.equal((await buttonState()).rowEnabled, true, 'all row actions restored');
  }
  const upToDate = (checkedCount) => ({
    checkedCount, updateCount: 0, queuedCount: 0, dependencyCount: 0,
    alreadyUpToDate: true, skippedCount: 0, updates: []
  });

  await beginRequest('#updateMods', [ids.main]);
  await settleRequest(upToDate(1));
  const currentToast = await ui(`({ text: document.querySelector('#toastRegion .toast:last-child')?.textContent, error: Boolean(document.querySelector('#toastRegion .toast:last-child.error')) })`);
  assert.ok(currentToast.text, 'already up-to-date gives feedback');
  assert.equal(currentToast.error, false, 'already up-to-date is not an error');
  report.tests.push('bulk updates selected installed IDs, prevents duplicate requests and reports no changes');

  const detailReadsBeforeUpdate = detailReads;
  const pollsBefore = statusReads;
  const scansBefore = scanCount;
  await beginRequest(`#modsTableBody [data-mod-id="${ids.other}"] .update-mod-button`, [ids.other]);
  downloadStatus = { state: 'downloading', completed: 0, total: 1, failed: 0, progress: 25 };
  await settleRequest({
    checkedCount: 1, updateCount: 1, queuedCount: 1, dependencyCount: 0,
    alreadyUpToDate: false, skippedCount: 0,
    updates: [{ modId: ids.other, name: 'Other installed mod', installedVersion: '1.0.0', version: '2.0.0' }]
  });
  assert.equal(detailReads, detailReadsBeforeUpdate, 'row update never requests a details dialog');
  await waitFor(() => statusReads > pollsBefore, 'queued update starts download polling');
  installedMods = installedMods.map((mod) => mod.modId === ids.other ? { ...mod, version: '2.0.0' } : mod);
  downloadStatus = { state: 'complete', completed: 1, total: 1, failed: 0, progress: 100 };
  await waitFor(() => scanCount > scansBefore, 'completed update rescans installed mods');
  await waitFor(() => ui(`document.querySelector('#modsTableBody [data-mod-id="${ids.other}"] .mod-version').textContent === '2.0.0'`), 'updated local version visible');
  await waitFor(async () => !(await buttonState()).bulkDisabled && (await buttonState()).rowEnabled, 'all update controls restored after download completion');
  assert.deepEqual(lastWorkspace, initialWorkspace, 'update must preserve the pinned workspace');
  assert.equal(presetWrites.length, 0, 'update must not rewrite pinned presets');
  report.tests.push('single-row update polls completion, refreshes local version and preserves preset pins');

  for (const error of ['NETWORK_OFFLINE', 'WORKSHOP_QUEUE_BUSY']) {
    await ui(`document.querySelector('#toastRegion').replaceChildren()`);
    await beginRequest('#updateMods', [ids.main]);
    await settleRequest(null, error);
    assert.equal(await ui(`Boolean(document.querySelector('#toastRegion .toast.error'))`), true, `${error} produces error feedback`);
    assert.deepEqual(lastWorkspace, initialWorkspace, `${error} preserves pinned workspace`);
  }
  report.tests.push('offline and busy-queue failures restore controls without changing the preset');

  const pollsBeforeFailure = statusReads;
  await beginRequest('#updateMods', [ids.main]);
  downloadStatus = { state: 'paused', resumeAvailable: true, completed: 0, total: 1, failed: 0, progress: 0 };
  await settleRequest(null, 'SIMULATED_GAME_LAUNCH_FAILURE');
  await waitFor(() => statusReads > pollsBeforeFailure, 'failed update launch polls durable queue');
  await waitFor(async () => (await buttonState()).bulkDisabled, 'saved queue prevents another update');
  assert.equal(await ui(`document.querySelector('#downloadMissingMods').disabled`), false);
  assert.match(await ui(`document.querySelector('#downloadMissingMods').textContent`), /RESUME DOWNLOAD/);
  const requestsBeforeResumeClick = report.requests.length;
  await ui(`document.querySelector('#updateMods').click()`);
  assert.equal(report.requests.length, requestsBeforeResumeClick);
  downloadStatus = { state: 'idle', resumeAvailable: false, completed: 0, total: 0, failed: 0, progress: 0 };
  await ui('pollModDownloadStatus()');
  report.tests.push('failed game launch reveals Resume Download and prevents overwriting its saved queue');

  await ui(`document.querySelector('#modsTableBody [data-mod-id="${ids.main}"] .mod-checkbox').click()`);
  assert.equal(await ui(`document.querySelector('#modsTableBody [data-mod-id="${ids.missing}"] .mod-checkbox').checked`), true);
  assert.equal((await buttonState()).bulkDisabled, true, 'missing-only selection must not update unrelated installed mods');
  const requestsBeforeMissing = report.requests.length;
  await ui(`document.querySelector('#updateMods').click()`);
  assert.equal(report.requests.length, requestsBeforeMissing);
  await ui(`document.querySelector('#clearSelection').click()`);
  await waitFor(() => ui(`document.querySelectorAll('#modsTableBody .mod-checkbox:checked').length === 0`), 'clear selected mods');
  report.tests.push('selecting only missing mods never falls back to updating all installed mods');
  await beginRequest('#updateMods', installedMods.map((mod) => mod.modId));
  await settleRequest(upToDate(installedMods.length));
  report.tests.push('bulk falls back to all installed IDs when none are selected');

  await ui('changeLanguage("ru")');
  await ui(`document.querySelector('#toastRegion').replaceChildren()`);
  assert.equal(await ui(`document.querySelector('#updateMods span').textContent`), 'Обновить все');
  report.layouts = [];
  for (const [width, height] of [[1040, 680], [1380, 850], [1920, 1080]]) {
    window.setContentSize(width, height);
    await waitFor(() => ui(`innerWidth === ${width} && innerHeight === ${height}`), 'mod list viewport');
    await ui(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await new Promise(resolve => setTimeout(resolve, 300));
    const layout = await ui(`(() => {
      const view = document.querySelector('#view-mods');
      const footer = document.querySelector('.launch-footer').getBoundingClientRect();
      const actions = document.querySelector('.launch-actions').getBoundingClientRect();
      const status = document.querySelector('.footer-status').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight,
        footerActionsFit: actions.left >= status.right - 1 && actions.right <= footer.right + 1,
        overflow: view.scrollWidth > view.clientWidth + 1,
        clipped: [...document.querySelectorAll('#modsTableBody .mod-actions')].some(actions => {
          const r = actions.getBoundingClientRect();
          return [...actions.children].some(button => {
            const b = button.getBoundingClientRect();
            return b.left < r.left - 1 || b.right > r.right + 1;
          });
        }) };
    })()`);
    assert.equal(layout.overflow, false, 'Russian mod list must fit the window');
    assert.equal(layout.clipped, false, 'update and delete controls must fit their column');
    assert.equal(layout.footerActionsFit, true, 'download/resume buttons must fit when mod logs are hidden');
    report.layouts.push(layout);
    if (resultPath) {
      const frame = await new Promise((resolve, reject) => {
        const painted = (_event, _dirty, image) => { clearTimeout(timeout); resolve(image); };
        const timeout = setTimeout(() => {
          window.webContents.removeListener('paint', painted);
          reject(new Error('Update controls screenshot timed out'));
        }, 5000);
        window.webContents.once('paint', painted);
        window.webContents.invalidate();
      });
      await fs.mkdir(path.dirname(path.resolve(resultPath)), { recursive: true });
      await fs.writeFile(path.join(path.dirname(path.resolve(resultPath)), `mod-updates-ru-${width}x${height}.png`), frame.toPNG());
    }
  }
  report.tests.push('Russian update controls fit compact, normal and fullscreen windows');

  assert.equal(report.rendererErrors.some((message) => /SyntaxError|ReferenceError|TypeError|No handler registered/.test(message)), false, report.rendererErrors.join('\n'));
  report.statusReads = statusReads;
  report.scanCount = scanCount;
  await finish();
}).catch(finish);
