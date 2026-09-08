/*! Copyright (c) 2026 ALGZ / ExtaZzZ. SPDX-License-Identifier: GPL-3.0-only */

function isTrustedIpcEvent(event, { getMainWindow, trustedRendererUrl }) {
  const window = getMainWindow();
  const webContents = window && !window.isDestroyed() ? window.webContents : null;
  const frame = event?.senderFrame;
  return Boolean(
    webContents
    && event?.sender === webContents
    && frame
    && frame === webContents.mainFrame
    && frame.url === trustedRendererUrl
  );
}

function createTrustedIpcRegistrar({ ipcMain, getMainWindow, trustedRendererUrl, onRejected = () => {} }) {
  const trusted = (event) => isTrustedIpcEvent(event, { getMainWindow, trustedRendererUrl });
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!trusted(event)) {
          onRejected(channel, event);
          throw new Error('Unauthorized launcher request.');
        }
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (!trusted(event)) {
          onRejected(channel, event);
          return;
        }
        listener(event, ...args);
      });
    },
    isTrusted: trusted
  };
}

module.exports = { createTrustedIpcRegistrar, isTrustedIpcEvent };
