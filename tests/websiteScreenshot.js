const { app, BrowserWindow, ipcMain } = require('electron');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const profilePath = path.join(os.tmpdir(), `arma-launcher-website-shot-${process.pid}`);
fsSync.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', path.join(profilePath, 'session'));

const outputPath = path.resolve(
  process.argv.find((argument) => /\.png$/i.test(argument))
    || path.join(__dirname, '..', 'website', 'public', 'assets', 'launcher-ui.png')
);
const screenshotLanguage = process.argv.includes('--ru') ? 'ru' : 'en';

const featuredMods = [
  ['69130B1F01615C59', '2-7 Ballistic Computer', '1.1.11', 4],
  ['6972C679D94CBBA6', '2-7 Guidance System', '1.1.12', 0],
  ['68A122193094C6FC', '2-7 Self-Propelled Howitzers', '1.1.10', 9],
  ['68B2B7B07E2BF026', '2-7 T-72B3 Upgrade', '1.0.9', 0],
  ['68C55B7A7DCB3BD4', '2-7_BMP-3M', '1.0.1', 0],
  ['66CA27F3F8C4C16A', '420s Tweaks', '0.0.26', 0],
  ['672B0395726428B6', '506IRRU - Enhanced Radio', '1.0.28', 0],
  ['6970E26BDF30FAA2', '506th IRRU Enhanced radio fix', '1.0.1', 0]
].map(([modId, name, version, dependencyCount]) => ({
  modId,
  name,
  version,
  corrupted: false,
  directoryPath: `B:\\ArmaReforger\\addons\\${name}_${modId}`,
  dependencies: Array.from({ length: dependencyCount }, (_value, index) => ({
    modId: `${index + 1}`.padStart(16, 'A'),
    name: `Dependency ${index + 1}`,
    version: ''
  }))
}));

const generatedMods = Array.from({ length: 269 }, (_value, index) => {
  const modId = (0x6000000000000000n + BigInt(index)).toString(16).toUpperCase();
  const name = `Workshop Content ${String(index + 1).padStart(3, '0')}`;
  return {
    modId,
    name,
    version: '1.0.0',
    corrupted: false,
    directoryPath: `B:\\ArmaReforger\\addons\\${name}_${modId}`,
    dependencies: []
  };
});

app.whenReady().then(async () => {
  let settings = {
    gameExecutable: 'B:\\SteamLibrary\\steamapps\\common\\Arma Reforger\\ArmaReforgerSteam.exe',
    addonsDirectory: 'B:\\ArmaReforger\\addons',
    downloadRoot: 'B:\\ArmaReforger',
    profileDirectory: 'B:\\ArmaLauncherProfile',
    noSplash: true,
    allowVersionMismatch: false,
    additionalArguments: '',
    autoUpdate: true,
    language: screenshotLanguage
  };
  ipcMain.handle('launcher:bootstrap', () => ({
    appVersion: '0.2.9',
    packaged: false,
    platform: 'win32',
    settings,
    presets: [],
    workspace: { activePresetId: '', name: '', dirty: false, mods: [] },
    installedMods: [...featuredMods, ...generatedMods]
  }));
  ipcMain.handle('workspace:save', (_event, workspace) => workspace);
  ipcMain.handle('settings:save', (_event, patch) => {
    settings = { ...settings, ...patch };
    return settings;
  });

  const window = new BrowserWindow({
    width: 1380,
    height: 850,
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  await window.loadURL(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href);
  await new Promise((resolve) => setTimeout(resolve, 450));
  const activeView = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    document.querySelector('[data-view="mods"]').click();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve(document.querySelector('.view.active')?.id || '');
    }));
  })`);
  window.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const image = await window.capturePage();
  await fs.writeFile(outputPath, image.toPNG());
  process.stdout.write(`${activeView}\n${outputPath}\n`);
  window.destroy();
  app.quit();
});
