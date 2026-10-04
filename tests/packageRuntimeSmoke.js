// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
process.on('uncaughtException', error => { process.stderr.write(`${error.stack || error}\n`); app.exit(1); });

// Run the shipped ASAR main/preload/renderer and real IPC/storage with stock
// Electron. Only the host identity, hidden window and temporary profile are
// supplied by this harness. It never starts the game or installs an update.
const [requestedAsar, mode, requestedOutput] = process.argv.slice(2);
assert(requestedAsar && requestedOutput, 'Provide app.asar, with-updates|no-updates and report directory');
const asar = path.resolve(requestedAsar);
assert.equal(path.basename(asar), 'app.asar');
const withUpdates = mode === 'with-updates';
const output = path.resolve(requestedOutput);
const metadata = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lar-package-runtime-'));
const fakeGame = path.join(profile, 'game', 'ArmaReforgerSteam.exe');
fs.mkdirSync(path.dirname(fakeGame), { recursive: true });
fs.writeFileSync(fakeGame, 'Isolated fixture; never executed');
const addons = path.join(profile, 'addons');
fs.mkdirSync(addons);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  gameExecutable: fakeGame, addonsDirectory: addons, downloadRoot: profile,
  profileDirectory: path.join(profile, 'reforger'), language: 'ru', autoUpdate: true
}));
app.setName(`lar-package-runtime-${process.pid}`);
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.getAppPath = () => asar;
app.getVersion = () => metadata.version;
Object.defineProperty(app, 'isPackaged', { get: () => true });
process.env.LOCALAPPDATA = path.join(profile, 'local-cache');
fs.mkdirSync(process.env.LOCALAPPDATA);
delete process.env.PORTABLE_EXECUTABLE_FILE;
delete process.env.PORTABLE_EXECUTABLE_DIR;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('browser-window-created', (_event, window) => {
  window.show = () => {};
  window.webContents.setBackgroundThrottling(false);
});
dialog.showErrorBox = (title, message) => process.stderr.write(`${title}: ${message}\n`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await wait(50);
  }
  throw new Error(`Timed out: ${description}`);
}
const watchdog = setTimeout(() => {
  process.stderr.write('Packaged runtime audit timed out\n');
  app.exit(1);
}, 60_000);
watchdog.unref();

require(path.join(asar, metadata.main));

app.whenReady().then(async () => {
  const report = { version: metadata.version, withUpdates,
    harness: 'shipped ASAR under stock Electron with an isolated profile', checks: [] };
  let window;
  await until(() => Boolean(window = BrowserWindow.getAllWindows()[0]), 'main window');
  await until(async () => {
    if (window.webContents.isLoading()) return false;
    return window.webContents.executeJavaScript(`Boolean(window.reforgerLauncher && $('#appVersion').textContent==='v${metadata.version}' && !state.busy)`);
  }, 'renderer bootstrap');
  const js = expression => window.webContents.executeJavaScript(expression);
  const check = (description, passed) => { assert(passed, description); report.checks.push(description); };
  const bootstrap = await js('api.bootstrap()');
  check('real bootstrap and packaged version', bootstrap.appVersion === metadata.version && bootstrap.packaged);
  check('profile, game fixture and addon scan are isolated',
    app.getPath('userData') === profile && bootstrap.settings.gameExecutable === fakeGame
    && bootstrap.settings.addonsDirectory === addons && bootstrap.installedMods.length === 0);
  check('all eight packaged pages open', await js(`(()=>{for(const view of Object.keys(viewMetadata)){setView(view);if(!$('#view-'+view).classList.contains('active'))return false;}return Object.keys(viewMetadata).length===8;})()`));

  const preset = await js(`api.savePreset({name:'Isolated package audit',mods:[{modId:'646B350F36C6D3E4',name:'Breachable Doors',version:'1.1.11'}]})`);
  assert(preset.id);
  const presets = await js('api.listPresets()');
  check('real preset save and list', presets.some(item => item.id === preset.id && item.mods.length === 1));
  const workspace = { activePresetId: preset.id, modIds: ['646B350F36C6D3E4'], pinnedIds: [] };
  await js(`api.saveWorkspace(${JSON.stringify(workspace)})`);
  check('real workspace persists the active preset', (await js('api.bootstrap()')).workspace.activePresetId === preset.id);
  await js(`api.saveSettings({language:'en'})`);
  check('real settings persist and reload', (await js('api.bootstrap()')).settings.language === 'en');

  const started = Date.now();
  const details = await js(`api.getModDetails('646B350F36C6D3E4',{refresh:true})`);
  check('real Workshop information reaches packaged IPC', details.modId === '646B350F36C6D3E4' && details.name && details.version);
  report.workshop = { name: details.name, version: details.version, elapsedMs: Date.now() - started };
  await js(`setView('mods');openModDetails('646B350F36C6D3E4')`);
  check('packaged card renders actual Workshop data', await js(`state.modDetails.data.name===${JSON.stringify(details.name)} && !$('#refreshModDetails').disabled`));
  await js('closeModDetails()');
  const repair = await js('api.repair()');
  check('repair is limited to temporary profile and empty addon fixture', repair.cacheCleared && repair.mods === 0 && repair.presets === 1);
  await js(`api.deletePreset(${JSON.stringify(preset.id)})`);
  check('real preset deletion', (await js('api.listPresets()')).length === 0);

  if (withUpdates) {
    check('installed distribution enables authenticated updater', bootstrap.updateMode === 'automatic');
    await until(async () => ['current', 'error', 'available', 'downloading', 'verifying', 'downloaded']
      .includes((await js('api.bootstrap()')).updateStatus.state), 'startup update check');
    const status = (await js('api.bootstrap()')).updateStatus;
    report.updateStatus = { state: status.state, revision: status.revision,
      feedVersion: status.info?.version || '', message: status.message || '' };
    check('startup update check reaches a terminal or download state', report.updateStatus.revision > 0);
  } else {
    check('no updater API, settings or notification survives packaging', await js(`!['checkForUpdates','downloadUpdate','installUpdate','onUpdateStatus'].some(key=>typeof api[key]==='function') && !Object.hasOwn(state.settings,'autoUpdate') && !$('#titlebarUpdate')`));
    check('no update status or mode in bootstrap', !Object.hasOwn(bootstrap, 'updateStatus') && !Object.hasOwn(bootstrap, 'updateMode'));
  }
  await js('setView("dashboard")');
  report.renderer = await js(`({version:$('#appVersion').textContent,view:state.currentView,busy:state.busy,profile:state.settings.profileDirectory})`);
  await fsp.mkdir(output, { recursive: true });
  await fsp.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  clearTimeout(watchdog);
  app.quit();
}).catch(error => { process.stderr.write(`${error.stack || error}\n`); app.exit(1); });
