// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const profile = fsSync.mkdtempSync(path.join(os.tmpdir(), 'lar-layout-status-'));
const output = path.resolve(process.argv[2] || path.join(profile, 'screenshots'));
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  let settings = {
    language: 'ru', autoUpdate: false, autoAddDependencies: true, showModLogsFooter: true,
    gameExecutable: 'C:\\Steam\\ArmaReforgerSteam.exe', addonsDirectory: '',
    downloadRoot: '', profileDirectory: '', favoriteServers: [], favoriteMods: []
  };
  const preset = {
    id: '11111111-1111-4111-8111-111111111111', name: 'ALGZ',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    mods: [{ modId: '1337C0DE5DABBEEF', name: 'Example mod', version: '1.0.0', required: true }]
  };
  const server = {
    id: '39079454', name: 'ALGZ | Test server', address: 'server.example.test:2001',
    playerCount: 0, playerLimit: 128, status: 'online', lastUpdated: new Date().toISOString(),
    scenarioName: 'Everon', gameVersion: '1.8.0.10', totalModSize: 0
  };
  let failList = false;
  let failDetails = false;
  let exportedPreset = null;
  ipcMain.handle('launcher:bootstrap', () => ({
    appVersion: 'layout-test', packaged: false, platform: process.platform, settings,
    presets: [preset], installedMods: [],
    workspace: { activePresetId: preset.id, name: preset.name, mods: preset.mods, dirty: false },
    modLogCount: 0
  }));
  ipcMain.handle('settings:save', (_event, patch) => (settings = { ...settings, ...patch }));
  ipcMain.handle('workspace:save', (_event, value) => value);
  ipcMain.handle('mods:scan', () => []);
  ipcMain.handle('game:download-status', () => ({ state: 'idle', total: 0 }));
  ipcMain.handle('servers:list', () => {
    if (failList) throw new Error('Simulated network failure');
    return {
      items: [server, { ...server, id: '39079455', name: 'Training server', status: 'offline', playerCount: 12 },
        { ...server, id: '39079456', name: 'Old catalog record', lastUpdated: '2020-01-01T00:00:00Z' },
        { ...server, id: '39079457', name: 'No status record', status: '' }],
      page: 1, pageSize: 50, hasNext: false, providerUrl: 'https://reforgermods.com/servers'
    };
  });
  ipcMain.handle('servers:details', () => {
    if (failDetails) throw new Error('Simulated detail failure');
    return { server, mods: [] };
  });
  ipcMain.handle('presets:share-file', (_event, value) => {
    exportedPreset = value;
    return { filePath: path.join(profile, 'simulated-export.json') };
  });

  const window = new BrowserWindow({
    width: 1280, height: 800, show: false, frame: false,
    webPreferences: { preload: path.join(__dirname, '../src/main/preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false }
  });
  await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  for (let i = 0; i < 100; i += 1) {
    if (await window.webContents.executeJavaScript("document.querySelector('#appVersion').textContent === 'vlayout-test'")) break;
    await wait(25);
  }
  await window.webContents.executeJavaScript('document.fonts.ready');
  const layout = [];
  for (const language of ['ru', 'en']) {
    await window.webContents.executeJavaScript(`document.querySelector('[data-language="${language}"]').click()`);
    for (const [width, height] of [[1080, 720], [1280, 800], [1920, 1080], [2560, 1440]]) {
      window.setContentSize(width, height);
      await wait(80);
      for (const view of ['parameters', 'settings', 'presets']) {
        await window.webContents.executeJavaScript(`document.querySelector('.nav-item[data-view="${view}"]').click()`);
        await wait(180);
        const metrics = await window.webContents.executeJavaScript(`(() => {
          const view = document.querySelector('.view.active');
          const css = getComputedStyle(view);
          const width = view.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
          return {
            viewport: innerWidth, view: view.id, overflow: view.scrollWidth > view.clientWidth + 1,
            widths: [...view.querySelectorAll('.settings-section, .settings-actions')].map(node => node.getBoundingClientRect().width),
            expectedWidth: width,
            duplicateImport: !!document.querySelector('#headerActions [data-header-action="import"]'),
            duplicateExport: !!document.querySelector('#exportPreset'),
            imports: view.querySelectorAll('#importPreset').length,
            exports: view.querySelectorAll('#shareFilePreset').length,
            presetButtons: view.id === 'view-presets' ? (() => {
              const toolbar = view.querySelector('.preset-toolbar').getBoundingClientRect();
              const plus = view.querySelector('#newPreset').getBoundingClientRect();
              const importButton = view.querySelector('#importPreset').getBoundingClientRect();
              const exportButton = view.querySelector('#shareFilePreset').getBoundingClientRect();
              return {
                centerOffset: (plus.left + plus.right - toolbar.left - toolbar.right) / 2,
                rowOffset: importButton.top - exportButton.top,
                gap: exportButton.left - importButton.right,
                right: exportButton.right
              };
            })() : null,
            saveRight: view.querySelector('.settings-actions')?.getBoundingClientRect().right,
            cardRight: view.querySelector('.settings-section')?.getBoundingClientRect().right
          };
        })()`);
        assert.equal(metrics.viewport, width);
        assert.equal(metrics.overflow, false, JSON.stringify({ language, width, view, metrics }));
        for (const cardWidth of metrics.widths) assert.ok(Math.abs(cardWidth - metrics.expectedWidth) <= 1);
        if (view === 'presets') {
          assert.equal(metrics.duplicateImport, false);
          assert.equal(metrics.duplicateExport, false);
          assert.equal(metrics.imports, 1);
          assert.equal(metrics.exports, 1);
          assert.ok(Math.abs(metrics.presetButtons.centerOffset) <= 1, 'New preset button must be centered');
          assert.ok(Math.abs(metrics.presetButtons.rowOffset) <= 1, 'Import and export must stay on the same row');
          assert.equal(metrics.presetButtons.gap, 8);
          assert.ok(metrics.presetButtons.right <= width, 'Preset actions must fit inside the window');
        } else assert.equal(metrics.saveRight, metrics.cardRight);
        layout.push({ language, width, height, view, metrics });
        if (language === 'ru' && width === 1920) {
          window.webContents.invalidate();
          await wait(150);
          await fs.writeFile(path.join(output, view + '-1920.png'), (await window.capturePage()).toPNG());
        }
      }
    }
  }

  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#importPreset').click();
    if (!document.querySelector('#importDialog').open) throw new Error('Import did not open');
    document.querySelector('#closeImportDialog').click();
    document.querySelector('#shareFilePreset').click();
    await new Promise(resolve => setTimeout(resolve, 100));
  })()`);
  assert.equal(exportedPreset?.mods[0]?.modId, preset.mods[0].modId);

  const refresh = async () => {
    await window.webContents.executeJavaScript(`(async () => {
      state.currentView = 'servers';
      await loadServers({ refresh: true, silent: true, automatic: true });
      await loadServerDetails(state.selectedServerId, { refresh: true, silent: true });
    })()`);
  };
  const statuses = () => window.webContents.executeJavaScript(`({
    rows: [...document.querySelectorAll('.server-row .server-availability')].map(node => node.dataset.serverStatus),
    details: document.querySelector('#serverDetails .server-availability')?.dataset.serverStatus,
    labels: [...document.querySelectorAll('.server-row .server-availability')].map(node => node.textContent),
    title: document.querySelector('.server-row .server-availability')?.title
  })`);
  await window.webContents.executeJavaScript("document.querySelector('.nav-item[data-view=servers]').click()");
  await refresh();
  assert.deepEqual((await statuses()).rows, ['online', 'offline', 'unknown', 'unknown']);
  assert.equal((await statuses()).details, 'online');
  assert.match((await statuses()).title, /Catalog status/);
  await window.webContents.executeJavaScript("document.querySelector('[data-language=ru]').click()");
  assert.deepEqual((await statuses()).labels, ['Онлайн', 'Офлайн', 'Нет данных', 'Нет данных']);
  server.status = 'offline';
  await refresh();
  assert.equal((await statuses()).rows[0], 'offline');
  assert.equal((await statuses()).details, 'offline');
  server.status = 'online';
  server.lastUpdated = '2020-01-01T00:00:00Z';
  await refresh();
  assert.equal((await statuses()).rows[0], 'unknown');
  server.lastUpdated = new Date().toISOString();
  failList = true;
  await refresh();
  assert.ok((await statuses()).rows.every(status => status === 'unknown'));
  failList = false;
  failDetails = true;
  await refresh();
  assert.equal((await statuses()).rows[0], 'unknown');
  assert.equal((await statuses()).details, 'unknown');
  failDetails = false;
  await refresh();
  assert.equal((await statuses()).rows[0], 'online');
  await window.webContents.executeJavaScript(`(async () => {
    await toggleServerFavorite(state.selectedServerId);
    state.serverSort = 'favorites';
    await loadServers({ refresh: true });
  })()`);
  server.status = 'offline';
  await refresh();
  assert.deepEqual((await statuses()).rows, ['offline']);
  await refresh();
  assert.deepEqual((await statuses()).rows, ['offline']);
  server.status = 'online';
  await window.webContents.executeJavaScript("state.serverSort = 'players_desc'");
  await refresh();
  window.setContentSize(1920, 1080);
  await window.webContents.executeJavaScript("document.querySelectorAll('.toast').forEach(node => node.remove())");
  await wait(250);
  window.webContents.invalidate();
  await wait(150);
  await fs.writeFile(path.join(output, 'servers-1920.png'), (await window.capturePage()).toPNG());
  await fs.writeFile(path.join(output, 'checks.json'), JSON.stringify({ layout, serverStatuses: await statuses(), exportChecked: true }, null, 2));
  console.log('PASS: 24 layout checks; import/export actions; online/offline/stale/unknown/network failure/recovery/favorite status; EN/RU.');
  window.destroy();
  app.quit();
}).catch(error => { console.error(error.stack || error); app.exit(1); });
