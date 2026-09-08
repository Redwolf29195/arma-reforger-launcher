const { compareModVersions, parseModVersion } = require('./modVersion');
const { resolveWorkshopQueue } = require('./workshopDownloadQueue');

const MAX_UPDATE_MODS = 500;
const UPDATE_DEADLINE_MS = 90_000;
const ACTIVE_DOWNLOADS = new Set(['queued', 'waiting', 'preparing', 'downloading', 'failed']);

function failure(key) {
  const error = new Error(key);
  error.code = key;
  return error;
}

function requestedModIds(payload) {
  if (payload === undefined) return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('modUpdateInvalidSelection');
  if (payload.modIds === undefined) return null;
  if (!Array.isArray(payload.modIds) || !payload.modIds.length || payload.modIds.length > MAX_UPDATE_MODS) {
    throw failure('modUpdateInvalidSelection');
  }
  return [...new Set(payload.modIds.map(value => {
    if (typeof value !== 'string' || !/^[0-9A-F]{16}$/i.test(value.trim())) throw failure('modUpdateInvalidSelection');
    return value.trim().toUpperCase();
  }))];
}

function installedIndex(mods) {
  return new Map((Array.isArray(mods) ? mods : [])
    .filter(mod => /^[0-9A-F]{16}$/i.test(mod?.modId || '') && mod.directoryPath)
    .map(mod => [mod.modId.toUpperCase(), mod]));
}

function createFreshDetails(fetchDetails, options = {}) {
  const deadline = Date.now() + Math.max(1, Math.min(UPDATE_DEADLINE_MS, Number(options.deadlineMs) || UPDATE_DEADLINE_MS));
  const cache = new Map();
  function get(modId) {
    if (cache.has(modId)) return cache.get(modId);
    const promise = (async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw failure('modUpdateTimedOut');
      const timeoutMs = Math.min(15_000, remaining);
      const abort = new AbortController();
      let timer;
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(failure('modUpdateTimedOut'));
        }, timeoutMs);
      });
      try {
        const details = await Promise.race([
          Promise.resolve().then(() => fetchDetails(modId, { refresh: true, timeoutMs, signal: abort.signal })),
          expired
        ]);
        if (String(details?.modId || '').toUpperCase() !== modId) throw failure('modUpdateWrongMetadata');
        return details;
      } finally {
        clearTimeout(timer);
      }
    })();
    cache.set(modId, promise);
    return promise;
  }
  return get;
}

async function planInstalledModUpdates(installedMods, payload, options = {}) {
  const selection = requestedModIds(payload);
  const installed = installedIndex(installedMods);
  const ids = selection || [...installed.keys()];
  if (ids.length > MAX_UPDATE_MODS) throw failure('modUpdateInvalidSelection');
  const details = createFreshDetails(options.fetchDetails, options);
  const results = new Array(ids.length);
  const concurrency = Math.max(1, Math.min(6, Number(options.concurrency) || 6));
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const index = cursor++;
      const modId = ids[index];
      const local = installed.get(modId);
      if (!local) {
        results[index] = { error: { modId, message: 'modUpdateNotInstalled' } };
        continue;
      }
      try {
        const remote = await details(modId);
        const latest = String(remote.version || '').trim();
        if (latest.length > 64 || !parseModVersion(latest)) throw failure('modUpdateUnknownVersion');
        const order = compareModVersions(local.version, latest);
        if (order > 0 && local.corrupted) throw failure('modUpdateNewerCorrupted');
        if (!local.corrupted && order !== null && order >= 0) {
          results[index] = { current: true };
        } else if (order === null && !local.corrupted) {
          throw failure('modUpdateUnknownInstalledVersion');
        } else {
          results[index] = { update: {
            modId, name: String(remote.name || local.name || modId).slice(0, 180),
            installedVersion: String(local.version || ''), version: latest,
            reason: local.corrupted ? 'repair' : 'newer-version'
          } };
        }
      } catch (error) {
        results[index] = { error: { modId, message: String(error.code || error.message || error).slice(0, 500) } };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  const updates = results.flatMap(result => result.update ? [result.update] : []);
  const failedDetails = results.flatMap(result => result.error ? [result.error] : []);
  const plan = {
    checkedCount: ids.length,
    upToDateCount: results.filter(result => result.current).length,
    updateCount: updates.length,
    queuedCount: 0,
    dependencyCount: 0,
    skippedCount: failedDetails.length,
    alreadyUpToDate: !updates.length && !failedDetails.length,
    updates, failedDetails, items: [], observedModIds: []
  };
  if (!updates.length) return plan;

  // Resolve the same dependency graph as Workshop install, using the exact
  // metadata snapshots already checked for roots. No roots use old preset pins.
  const queue = await resolveWorkshopQueue(updates, { fetchDetails: details, concurrency, maxMods: MAX_UPDATE_MODS });
  // Retain dependencies omitted from downloads too: a healthy copy may be
  // deleted or replaced while the remaining metadata is being checked.
  plan.observedModIds = queue.items.map(item => item.modId);
  if (queue.failedDetails.length) {
    // An incomplete dependency graph is not a verified update plan. Leave all
    // installed files intact; users can retry without an uncertain download.
    plan.failedDetails.push(...queue.failedDetails);
    plan.skippedCount += updates.length;
    plan.updateCount = 0;
    plan.updates = [];
    return plan;
  }
  const rootIds = new Set(updates.map(mod => mod.modId));
  try {
    for (const item of queue.items) {
      if (rootIds.has(item.modId)) {
        plan.items.push(item);
        continue;
      }
      const local = installed.get(item.modId);
      const remote = await details(item.modId);
      const version = item.version || String(remote.version || '').trim();
      if (version.length > 64 || !parseModVersion(version)) throw failure('modUpdateUnknownVersion');
      const order = compareModVersions(local?.version, version);
      if (local && !local.corrupted && order !== null && order >= 0) continue;
      if (local && order === null && !local.corrupted) throw failure('modUpdateUnknownInstalledVersion');
      if (local?.corrupted && order > 0) throw failure('modUpdateNewerCorrupted');
      plan.items.push({ modId: item.modId, version });
    }
  } catch (error) {
    plan.failedDetails.push({ modId: '', message: String(error.code || error.message || error).slice(0, 500) });
    plan.skippedCount += updates.length;
    plan.updateCount = 0;
    plan.updates = [];
    plan.items = [];
    return plan;
  }
  plan.dependencyCount = plan.items.length - updates.length;
  return plan;
}

function settingsIdentity(settings) {
  return JSON.stringify(['addonsDirectory', 'downloadRoot', 'profileDirectory', 'gameExecutable'].map(key => settings?.[key] || ''));
}

function localIdentity(mod) {
  return JSON.stringify(mod ? [mod.directoryPath, mod.version || '', Boolean(mod.corrupted)] : null);
}

function createInstalledModUpdater(dependencies) {
  let checking = false;
  const errorMessage = dependencies.errorMessage || (key => key);
  const reject = key => { throw new Error(errorMessage(key)); };
  async function ensureAvailable(settings) {
    if (await dependencies.isGameRunning()) reject('gameAlreadyRunning');
    const status = await dependencies.getDownloadStatus(settings);
    if (status?.resumeAvailable || ACTIVE_DOWNLOADS.has(status?.state)) reject('workshopUpdateQueuePending');
  }
  async function update(payload) {
    requestedModIds(payload);
    if (checking) reject('modUpdateBusy');
    checking = true;
    try {
      const settings = { ...dependencies.getSettings() };
      await ensureAvailable(settings);
      const installed = await dependencies.scanInstalled(settings);
      const plan = await planInstalledModUpdates(installed, payload, dependencies);
      const { items, observedModIds, ...result } = plan;
      result.failedDetails = result.failedDetails.map(item => ({ ...item, message: errorMessage(item.message) }));
      if (!items.length) return result;
      if (settingsIdentity(settings) !== settingsIdentity(dependencies.getSettings())) reject('modUpdateSettingsChanged');
      await ensureAvailable(settings);
      const current = installedIndex(await dependencies.scanInstalled(settings));
      if (settingsIdentity(settings) !== settingsIdentity(dependencies.getSettings())) reject('modUpdateSettingsChanged');
      const before = installedIndex(installed);
      for (const modId of observedModIds) {
        if (localIdentity(before.get(modId)) !== localIdentity(current.get(modId))) reject('modUpdateFilesChanged');
      }
      const queued = await dependencies.queueDownload(settings, items, result);
      return { ...queued, ...result, queuedCount: queued.queuedCount || 0, dependencyCount: plan.dependencyCount };
    } catch (error) {
      if (error.code?.startsWith('modUpdate')) reject(error.code);
      throw error;
    } finally {
      checking = false;
    }
  }
  return { update };
}

module.exports = { MAX_UPDATE_MODS, UPDATE_DEADLINE_MS, createInstalledModUpdater, planInstalledModUpdates, requestedModIds };
