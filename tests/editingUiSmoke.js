const { app, BrowserWindow } = require('electron');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installEditingShortcuts } = require('../src/main/editingShortcuts');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const profilePath = path.join(os.tmpdir(), `arma-launcher-editing-smoke-${process.pid}`);
fsSync.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', path.join(profilePath, 'session'));

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  installEditingShortcuts(window.webContents);
  await window.loadURL('data:text/html,<input id="search" autofocus>');
  await window.webContents.executeJavaScript('document.querySelector("#search").focus()');
  window.webContents.insertText('Arma');
  await wait(60);

  const before = await window.webContents.executeJavaScript('document.querySelector("#search").value');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
  await wait(60);
  const afterUndo = await window.webContents.executeJavaScript('document.querySelector("#search").value');

  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control', 'shift'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control', 'shift'] });
  await wait(60);
  const afterRedo = await window.webContents.executeJavaScript('document.querySelector("#search").value');

  const result = { before, afterUndo, afterRedo };
  if (before !== 'Arma' || afterUndo !== '' || afterRedo !== 'Arma') {
    throw new Error(`Editing shortcuts failed: ${JSON.stringify(result)}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.exit(1);
});
