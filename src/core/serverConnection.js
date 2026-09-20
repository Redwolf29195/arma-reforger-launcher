const {
  normalizeServerAddress,
  normalizeServerId,
  normalizeServerMod
} = require('./serverBrowser');

const MAX_SERVER_MODS = 1000;
const { MAX_LIVE_SERVER_AGE_MS, assessServerAvailability } = require('../shared/serverAvailability');
const MISSING_STATUSES = new Set(['missing', 'corrupted']);
const MISMATCH_STATUSES = new Set(['version-mismatch', 'version-unknown']);

function serverCapacity(server = {}) {
  const playerCount = Math.max(0, Number(server.playerCount) || 0);
  const playerLimit = Math.max(0, Number(server.playerLimit) || 0);
  const queueCount = Math.max(0, Number(server.queueCount) || 0);
  return {
    playerCount,
    playerLimit,
    queueCount,
    full: playerLimit > 0 && playerCount >= playerLimit
  };
}

function prepareServerConnection(payload = {}) {
  const rawServerId = String(payload.serverId || '').trim();
  const knownServer = rawServerId.length > 0;
  const address = normalizeServerAddress(payload.address);
  const server = {
    id: knownServer ? normalizeServerId(rawServerId) : '',
    name: String(payload.name || address).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 180) || address,
    address
  };

  const seen = new Set();
  const mods = [];
  let missingCount = 0;
  let mismatchCount = 0;
  for (const rawMod of (Array.isArray(payload.mods) ? payload.mods : []).slice(0, MAX_SERVER_MODS)) {
    const mod = normalizeServerMod(rawMod);
    if (!mod || seen.has(mod.modId)) continue;
    seen.add(mod.modId);
    mods.push(mod);
    const status = String(rawMod.status || '').trim().toLowerCase();
    if (MISSING_STATUSES.has(status)) missingCount += 1;
    if (MISMATCH_STATUSES.has(status)) mismatchCount += 1;
  }

  return { knownServer, server, mods, missingCount, mismatchCount };
}

function prepareLiveServerConnection(connection, details = {}) {
  if (!connection?.knownServer) throw new Error('Для обновления требуется сервер из каталога.');
  const liveServer = details?.server;
  const liveId = normalizeServerId(liveServer?.id);
  if (liveId !== connection.server.id) throw new Error('Каталог серверов вернул другой сервер.');

  const prepared = prepareServerConnection({
    serverId: liveId,
    name: liveServer.name,
    address: liveServer.address,
    mods: Array.isArray(details.mods) ? details.mods : []
  });
  return {
    ...prepared,
    server: { ...liveServer, ...prepared.server }
  };
}

module.exports = {
  MAX_LIVE_SERVER_AGE_MS,
  assessServerAvailability,
  prepareLiveServerConnection,
  prepareServerConnection,
  serverCapacity
};
