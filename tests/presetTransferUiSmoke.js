const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const profilePath = path.join(os.tmpdir(), `arma-launcher-transfer-ui-${process.pid}`);
const resultPath = process.argv.find((argument) => /preset-transfer-ui-result\.json$/i.test(argument));
fsSync.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', path.join(profilePath, 'session'));

const preset = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Server preset',
  updatedAt: new Date().toISOString(),
  mods: [{ modId: '646B350F36C6D3E4', name: 'Main mod', version: '1.0.0' }]
};

app.whenReady().then(async () => {
  let settings = {
    gameExecutable: 'C:\\ArmaReforgerSteam.exe',
    addonsDirectory: 'C:\\Arma\\addons',
    downloadRoot: '',
    profileDirectory: profilePath,
    noSplash: true,
    allowVersionMismatch: false,
    additionalArguments: '',
    defaultPresetId: preset.id,
    autoUpdate: false,
    showModLogsFooter: true,
    autoAddDependencies: true,
    confirmModDeletion: true,
    advancedMode: false,
    language: 'ru'
  };
  let transferPayload = null;

  ipcMain.handle('launcher:bootstrap', () => ({
    appVersion: '0.3.18',
    packaged: false,
    platform: process.platform,
    settings,
    presets: [preset],
    installedMods: [{
      modId: preset.mods[0].modId,
      name: preset.mods[0].name,
      version: preset.mods[0].version,
      directoryPath: 'C:\\Arma\\addons\\MainMod',
      dependencies: []
    }],
    workspace: { activePresetId: preset.id, name: preset.name, dirty: false, mods: preset.mods },
    modLogCount: 0
  }));
  ipcMain.handle('game:download-status', () => ({ state: 'idle', completed: 0, total: 0, failed: 0, progress: 0 }));
  ipcMain.handle('workspace:save', (_event, workspace) => workspace);
  ipcMain.handle('settings:save', (_event, patch) => {
    settings = { ...settings, ...patch };
    return settings;
  });
  ipcMain.handle('presets:choose-transfer-directory', () => 'D:\\ServerMods');
  ipcMain.handle('presets:transfer-mods', (_event, payload) => {
    transferPayload = payload;
    return {
      mode: payload.mode,
      destinationDirectory: payload.destinationDirectory,
      transferredCount: 1,
      removedCount: 1,
      failedRemovalCount: 0,
      dependencyCount: 0,
      installedMods: []
    };
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
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error('UI wait timed out');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    await waitFor(() => document.querySelector('#titlebarStatus')?.textContent.trim() !== 'Загрузка лаунчера');
    document.querySelector('[data-view="presets"]').click();
    const hiddenBefore = document.querySelector('#transferPresetMods').hidden;

    document.querySelector('[data-view="settings"]').click();
    const toggle = document.querySelector('#settingAdvancedMode');
    const uncheckedBefore = !toggle.checked;
    toggle.checked = true;
    document.querySelector('#saveSettings').click();
    await waitFor(() => [...document.querySelectorAll('#toastRegion .toast')]
      .some((toast) => toast.textContent.includes('Настройки сохранены')));

    document.querySelector('[data-view="presets"]').click();
    const transferButton = document.querySelector('#transferPresetMods');
    const buttonLabel = transferButton.textContent.trim();
    transferButton.click();
    const dialog = document.querySelector('#presetTransferDialog');
    await waitFor(() => dialog.open);
    const copyWarningHidden = document.querySelector('#presetTransferWarning').hidden;
    const move = document.querySelector('input[name="presetTransferMode"][value="move"]');
    move.click();
    const moveWarningVisible = !document.querySelector('#presetTransferWarning').hidden;
    document.querySelector('#presetTransferForm').requestSubmit();
    await waitFor(() => document.querySelector('#confirmationDialog')?.open);
    document.querySelector('#confirmationDialogConfirm').click();
    await waitFor(() => !dialog.open);
    await waitFor(() => [...document.querySelectorAll('#toastRegion .toast')]
      .some((toast) => toast.textContent.includes('Перемещено модов: 1')));
    return { hiddenBefore, uncheckedBefore, buttonLabel, copyWarningHidden, moveWarningVisible };
  })()`);

  assert.equal(result.hiddenBefore, true);
  assert.equal(result.uncheckedBefore, true);
  assert.equal(result.buttonLabel, 'Перенести моды');
  assert.equal(result.copyWarningHidden, true);
  assert.equal(result.moveWarningVisible, true);
  assert.deepEqual(transferPayload, {
    presetId: preset.id,
    destinationDirectory: 'D:\\ServerMods',
    mode: 'move'
  });

  const report = { result, transferPayload };
  if (resultPath) await fs.writeFile(resultPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  const failure = { error: error?.stack || String(error) };
  const finish = resultPath ? fs.writeFile(resultPath, JSON.stringify(failure, null, 2)).catch(() => {}) : Promise.resolve();
  finish.finally(() => app.exit(1));
});
