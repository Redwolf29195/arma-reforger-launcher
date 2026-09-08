const assert = require('node:assert/strict');
const test = require('node:test');

const { createTrustedIpcRegistrar, isTrustedIpcEvent } = require('../src/main/ipcTrust');

function fixture() {
  const mainFrame = { url: 'file:///C:/launcher/src/renderer/index.html' };
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };
  const options = {
    getMainWindow: () => window,
    trustedRendererUrl: mainFrame.url
  };
  return { mainFrame, webContents, window, options };
}

test('trusts only the exact main frame of the launcher window', () => {
  const { mainFrame, webContents, options } = fixture();
  assert.equal(isTrustedIpcEvent({ sender: webContents, senderFrame: mainFrame }, options), true);
  assert.equal(isTrustedIpcEvent({ sender: {}, senderFrame: mainFrame }, options), false);
  assert.equal(isTrustedIpcEvent({ sender: webContents, senderFrame: { url: mainFrame.url } }, options), false);
  assert.equal(isTrustedIpcEvent({ sender: webContents, senderFrame: { url: 'https://example.com' } }, options), false);
});

test('registrar blocks untrusted invoke and ignores untrusted events', async () => {
  const handlers = new Map();
  const listeners = new Map();
  const rejected = [];
  const ipcMain = {
    handle: (channel, listener) => handlers.set(channel, listener),
    on: (channel, listener) => listeners.set(channel, listener)
  };
  const { mainFrame, webContents, options } = fixture();
  const registrar = createTrustedIpcRegistrar({
    ipcMain,
    ...options,
    onRejected: (channel) => rejected.push(channel)
  });
  let eventCalls = 0;
  registrar.handle('trusted:invoke', (_event, value) => value + 1);
  registrar.on('trusted:event', () => { eventCalls += 1; });

  const trustedEvent = { sender: webContents, senderFrame: mainFrame };
  const remoteEvent = { sender: {}, senderFrame: { url: 'https://example.com' } };
  assert.equal(await handlers.get('trusted:invoke')(trustedEvent, 3), 4);
  assert.throws(() => handlers.get('trusted:invoke')(remoteEvent, 3), /Unauthorized launcher request/);
  listeners.get('trusted:event')(remoteEvent);
  listeners.get('trusted:event')(trustedEvent);
  assert.equal(eventCalls, 1);
  assert.deepEqual(rejected, ['trusted:invoke', 'trusted:event']);
});
