const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');
const { buildServerConnectArguments } = require('./launchBuilder');
const { normalizeServerAddress } = require('./serverBrowser');
const { prepareServerJoinRequest, cancelServerJoinRequest } = require('./serverJoinBridge');
const { WORKSHOP_BRIDGE_MOD_ID } = require('./workshopDownloadQueue');

async function resolveNativeServerAddress(value, options = {}) {
  const address = normalizeServerAddress(value);
  const separator = address.lastIndexOf(':');
  const host = address.slice(0, separator);
  const port = address.slice(separator + 1);
  if (net.isIP(host) === 4) return address;
  const lookup = options.lookup || dns.lookup;
  const timeoutMs = Math.max(10, Math.min(10_000, Number(options.timeoutMs) || 5_000));
  let timer;
  try {
    const result = await Promise.race([
      lookup(host, { family: 4 }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Не удалось вовремя определить IP сервера.')), timeoutMs);
      })
    ]);
    if (net.isIP(result?.address) !== 4) throw new Error('Для сервера не найден IPv4-адрес.');
    return `${result.address}:${port}`;
  } finally {
    clearTimeout(timer);
  }
}

// Dependency-injected so cancellation, Steam failures, and request cleanup can
// be tested without starting a game or changing a real player's profile.
function createNativeServerLauncher(dependencies) {
  const prepareRequest = dependencies.prepareRequest || prepareServerJoinRequest;
  const cancelRequest = dependencies.cancelRequest || cancelServerJoinRequest;
  const resolveAddress = dependencies.resolveAddress || resolveNativeServerAddress;
  const mkdir = dependencies.mkdir || ((directory) => fs.mkdir(directory, { recursive: true }));
  const cancelled = () => ({ cancelled: true });

  return async function launch(game, connection, isCancelled = () => false) {
    if (isCancelled()) return cancelled();
    const { settings, gameExecutable } = game;
    if (!settings.profileDirectory || !settings.downloadRoot) {
      throw new Error('A profile and Workshop download directory are required for native server joining.');
    }
    let request = null;
    const cleanup = async () => {
      if (!request) return;
      try { await cancelRequest(request); } catch (error) { dependencies.log?.(error.message); }
    };
    try {
      // Native IP Connect expects an IPv4 endpoint. Resolve hostnames once and
      // keep the catalog's displayed identity/address unchanged.
      const endpoint = await resolveAddress(connection.server.address);
      if (isCancelled()) return cancelled();
      await dependencies.prepareProfile?.(settings);
      if (isCancelled()) return cancelled();
      for (const directory of [
        settings.profileDirectory,
        settings.downloadRoot,
        path.join(settings.downloadRoot, 'temp'),
        path.join(settings.profileDirectory, 'logs', 'server-join')
      ]) {
        await mkdir(directory);
        if (isCancelled()) return cancelled();
      }
      const bridge = await dependencies.prepareBridge(settings.profileDirectory);
      if (isCancelled()) return cancelled();
      request = await prepareRequest(settings.profileDirectory, endpoint);
      if (isCancelled()) {
        await cleanup();
        return cancelled();
      }
      const args = buildServerConnectArguments({
        settings,
        serverAddress: connection.server.address,
        bridgeDirectory: bridge.addonsDirectory,
        bridgeModId: WORKSHOP_BRIDGE_MOD_ID,
        joinToken: request.token
      });
      const result = await dependencies.launchThroughSteam(gameExecutable, args, isCancelled);
      if (result.cancelled || isCancelled()) {
        await cleanup();
        return cancelled();
      }
      return {
        ...result,
        arguments: args,
        connectionMode: 'native-menu',
        connectionAttempted: false,
        joinRequest: request
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  };
}

module.exports = { createNativeServerLauncher, resolveNativeServerAddress };
