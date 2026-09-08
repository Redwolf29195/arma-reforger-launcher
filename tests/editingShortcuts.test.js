const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { installEditingShortcuts } = require('../src/main/editingShortcuts');

function createWebContents() {
  const webContents = new EventEmitter();
  webContents.undoCount = 0;
  webContents.redoCount = 0;
  webContents.undo = () => { webContents.undoCount += 1; };
  webContents.redo = () => { webContents.redoCount += 1; };
  return webContents;
}

function sendInput(webContents, input) {
  let prevented = false;
  webContents.emit('before-input-event', {
    preventDefault() { prevented = true; }
  }, input);
  return prevented;
}

test('maps Ctrl+Z and Command+Z to the native undo command', () => {
  const webContents = createWebContents();
  installEditingShortcuts(webContents);

  assert.equal(sendInput(webContents, { type: 'keyDown', control: true, key: 'z' }), true);
  assert.equal(sendInput(webContents, { type: 'keyDown', meta: true, key: 'Z' }), true);
  assert.equal(webContents.undoCount, 2);
  assert.equal(webContents.redoCount, 0);
});

test('maps Ctrl+Shift+Z and Ctrl+Y to the native redo command', () => {
  const webContents = createWebContents();
  installEditingShortcuts(webContents);

  assert.equal(sendInput(webContents, { type: 'keyDown', control: true, shift: true, key: 'z' }), true);
  assert.equal(sendInput(webContents, { type: 'keyDown', control: true, key: 'y' }), true);
  assert.equal(webContents.undoCount, 0);
  assert.equal(webContents.redoCount, 2);
});

test('leaves unrelated shortcuts and key-up events untouched', () => {
  const webContents = createWebContents();
  const uninstall = installEditingShortcuts(webContents);

  assert.equal(sendInput(webContents, { type: 'keyDown', control: true, key: 'f' }), false);
  assert.equal(sendInput(webContents, { type: 'keyUp', control: true, key: 'z' }), false);
  assert.equal(sendInput(webContents, { type: 'keyDown', control: true, alt: true, key: 'z' }), false);
  assert.equal(webContents.undoCount, 0);
  uninstall();
  assert.equal(sendInput(webContents, { type: 'keyDown', control: true, key: 'z' }), false);
});
