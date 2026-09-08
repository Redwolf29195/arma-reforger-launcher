const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const profilePath = path.join(os.tmpdir(), `arma-launcher-configurator-ui-${process.pid}`);
fsSync.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', path.join(profilePath, 'session'));

const outputPath = process.argv.find((argument) => /\.png$/i.test(argument))
  || path.join(app.getPath('temp'), 'arma-launcher-configurator-ui.png');

function item(modId, name, tag) {
  return {
    modId,
    name,
    author: 'Workshop author',
    summary: `${name} from the ${tag} category`,
    version: '1.0.0',
    sizeBytes: 1024 * 1024,
    ratingPercent: 95,
    subscriberCount: 1200,
    previewUrl: '',
    tags: [tag]
  };
}

app.whenReady().then(async () => {
  const requests = [];
  let copiedScenarioId = '';
  ipcMain.handle('launcher:bootstrap', () => ({
    appVersion: '0.3.2',
    packaged: false,
    platform: process.platform,
    settings: {
      gameExecutable: 'C:\\ArmaReforgerSteam.exe',
      addonsDirectory: '',
      downloadRoot: '',
      profileDirectory: profilePath,
      noSplash: true,
      allowVersionMismatch: false,
      additionalArguments: '',
      defaultPresetId: '',
      autoUpdate: false,
      showModLogsFooter: true,
      autoAddDependencies: true,
      language: 'en'
    },
    presets: [],
    installedMods: [],
    workspace: { activePresetId: '', name: '', dirty: false, mods: [] },
    modLogCount: 0
  }));
  ipcMain.handle('game:download-status', () => ({ state: 'idle', completed: 0, total: 0, failed: 0, progress: 0 }));
  ipcMain.handle('workspace:save', (_event, workspace) => workspace);
  ipcMain.handle('settings:save', (_event, patch) => ({
    autoUpdate: false,
    showModLogsFooter: true,
    autoAddDependencies: true,
    ...patch
  }));
  ipcMain.handle('workshop:search', (_event, payload = {}) => {
    requests.push({ ...payload });
    const selected = payload.category === 'VEHICLES'
      ? item('2222222222222222', 'Vehicle Pack', 'VEHICLES')
      : payload.category === 'SCENARIOS_MP'
        ? item('3333333333333333', 'Eastern Europe PvEvP', 'SCENARIOS_MP')
        : item('1111111111111111', 'Weapon Pack', 'WEAPONS');
    return {
      query: payload.query || '',
      category: payload.category || '',
      sort: payload.sort || 'subscribers',
      page: payload.page || 1,
      count: 1,
      pageSize: 16,
      items: [selected]
    };
  });
  ipcMain.handle('mods:details', (_event, modId) => ({
    modId,
    name: 'Eastern Europe PvEvP',
    scenarios: [{
      name: '=ATM= Eastern Europe PvEvP',
      scenarioId: '{EF980D7F911C6F1C}Missions/ATMEasternEuropePvEvP.conf',
      gameMode: '=ATM= PvEvP',
      author: 'Workshop author',
      playerCount: 128
    }]
  }));
  ipcMain.handle('clipboard:copy-scenario', (_event, scenarioId) => {
    copiedScenarioId = scenarioId;
    return true;
  });

  const window = new BrowserWindow({
    width: 1380,
    height: 850,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  const result = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate, timeout = 5000) => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error('UI wait timed out');
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    };
    await waitFor(() => document.querySelector('#titlebarStatus')?.textContent.trim() !== 'Loading launcher');
    const englishNav = document.querySelector('[data-view="workshop"] span').textContent.trim();
    document.querySelector('[data-view="workshop"]').click();
    await waitFor(() => document.querySelector('#workshopGrid .workshop-card-title strong'));
    const initial = {
      view: document.querySelector('.view.active')?.id || '',
      title: document.querySelector('#pageTitle').textContent.trim(),
      categories: document.querySelectorAll('.configurator-category').length,
      active: document.querySelector('.configurator-category.active strong').textContent.trim(),
      firstMod: document.querySelector('#workshopGrid .workshop-card-title strong').textContent.trim(),
      addButton: document.querySelector('#workshopGrid .workshop-add').textContent.trim()
    };
    document.querySelector('.configurator-category[data-category="WEAPONS"]').click();
    await waitFor(() => document.querySelector('#workshopSummary')?.textContent.includes('Weapons'));
    document.querySelector('.configurator-category[data-category="VEHICLES"]').click();
    await waitFor(() => document.querySelector('#workshopGrid .workshop-card-title strong')?.textContent.trim() === 'Vehicle Pack');
    const vehicle = {
      active: document.querySelector('.configurator-category.active strong').textContent.trim(),
      firstMod: document.querySelector('#workshopGrid .workshop-card-title strong').textContent.trim(),
      summary: document.querySelector('#workshopSummary').textContent.trim()
    };
    document.querySelector('.configurator-category[data-category="SCENARIOS_MP"]').click();
    await waitFor(() => document.querySelector('.workshop-copy-scenario'));
    const scenario = {
      name: document.querySelector('.workshop-scenario-identity strong').textContent.trim(),
      id: document.querySelector('.workshop-scenario-identity code').textContent.trim(),
      copy: document.querySelector('.workshop-copy-scenario').textContent.trim()
    };
    document.querySelector('.workshop-copy-scenario').click();
    await waitFor(() => [...document.querySelectorAll('#toastRegion .toast')]
      .some((toast) => toast.textContent.includes('Scenario ID copied')));
    document.querySelector('[data-language="ru"]').click();
    const russian = {
      nav: document.querySelector('[data-view="workshop"] span').textContent.trim(),
      title: document.querySelector('#pageTitle').textContent.trim(),
      active: document.querySelector('.configurator-category.active strong').textContent.trim(),
      addButton: document.querySelector('#workshopGrid .workshop-add').textContent.trim()
    };
    document.querySelector('.workshop-scenarios')?.scrollIntoView({ block: 'center' });
    return { englishNav, initial, vehicle, scenario, russian };
  })()`);

  window.show();
  window.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const screenshot = await window.capturePage();
  await fs.writeFile(outputPath, screenshot.toPNG());

  assert.equal(result.englishNav, 'Workshop');
  assert.equal(result.initial.view, 'view-workshop');
  assert.equal(result.initial.title, 'Workshop');
  assert.equal(result.initial.categories, 11);
  assert.equal(result.initial.active, 'All mods');
  assert.equal(result.initial.firstMod, 'Weapon Pack');
  assert.equal(result.initial.addButton, 'Add to preset');
  assert.equal(result.vehicle.active, 'Vehicles');
  assert.equal(result.vehicle.firstMod, 'Vehicle Pack');
  assert.match(result.vehicle.summary, /Vehicles/);
  assert.equal(result.russian.nav, 'Мастерская');
  assert.equal(result.russian.title, 'Мастерская');
  assert.equal(result.scenario.name, '=ATM= Eastern Europe PvEvP');
  assert.equal(result.scenario.id, '{EF980D7F911C6F1C}Missions/ATMEasternEuropePvEvP.conf');
  assert.equal(result.scenario.copy, 'Copy');
  assert.equal(copiedScenarioId, result.scenario.id);
  assert.equal(result.russian.active, 'Сетевые сценарии');
  assert.equal(result.russian.addButton, 'Добавить в пресет');
  assert.deepEqual(requests.map((request) => request.category), ['', 'WEAPONS', 'VEHICLES', 'SCENARIOS_MP']);

  process.stdout.write(`${JSON.stringify(result)}\n${outputPath}\n`);
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
