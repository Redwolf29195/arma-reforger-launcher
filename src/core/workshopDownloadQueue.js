const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { fetchWorkshopDetails } = require('./workshopDetails');

const WORKSHOP_BRIDGE_MOD_ID = 'A7909293ED71A512';
const WORKSHOP_QUEUE_FILE = 'ALGZLauncherWorkshopQueue.txt';
const WORKSHOP_STATUS_FILE = 'ALGZLauncherWorkshopStatus.txt';
// "failed" describes one item; the bridge continues the remaining queue.
const ACTIVE_STATES = new Set(['queued', 'waiting', 'preparing', 'downloading', 'failed']);
const MAX_QUEUE_ITEMS = 500;
const pendingQueueWrites = new Map();

function normalizeQueueItems(values, maximum = MAX_QUEUE_ITEMS) {
  if (!Array.isArray(values) || values.length > 10_000) throw new Error('Invalid Workshop queue.');
  const items = new Map();
  for (const value of values) {
    const item = normalizeQueueItem(value);
    if (!item) throw new Error('Invalid Workshop mod GUID.');
    const requestedVersion = String(typeof value === 'object' && value ? value.version || '' : '').trim();
    if (requestedVersion && requestedVersion !== item.version) throw new Error('Invalid Workshop mod version.');
    const previous = items.get(item.modId);
    if (previous?.version && item.version && previous.version !== item.version) {
      throw new Error(`Conflicting Workshop versions for ${item.modId}.`);
    }
    if (!previous || (!previous.version && item.version)) items.set(item.modId, item);
    if (items.size > maximum) throw new Error(`Workshop queue limit exceeded (${maximum}).`);
  }
  if (!items.size) throw new Error('Workshop queue is empty.');
  return [...items.values()];
}

async function readBoundedFile(filePath, maximum) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximum) throw new Error('Invalid or oversized Workshop file.');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error('Workshop file exceeds its size limit.');
    return { text: buffer.subarray(0, length).toString('utf8'), stats };
  } finally { await handle.close(); }
}

async function writeTextAtomic(filePath, text) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, filePath);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

function normalizeModId(value) {
  const modId = String(value || '').trim().toUpperCase();
  return /^[0-9A-F]{16}$/.test(modId) ? modId : '';
}

function normalizeVersion(value) {
  const version = String(value || '').trim();
  return version && version.length <= 64 && !/[|\r\n]/.test(version) ? version : '';
}

function normalizeQueueItem(value) {
  const supplied = typeof value === 'object' && value ? value : {};
  const modId = normalizeModId(supplied.modId || supplied.id || value);
  return modId ? { modId, version: normalizeVersion(supplied.version) } : null;
}

async function resolveWorkshopQueue(mods, options = {}) {
  const fetchDetails = options.fetchDetails || fetchWorkshopDetails;
  const maxMods = Math.max(1, Math.min(MAX_QUEUE_ITEMS, Math.floor(Number(options.maxMods) || MAX_QUEUE_ITEMS)));
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 8));
  const queue = [];
  const queued = new Map();
  const processed = new Set();
  const failedDetails = [];

  for (const mod of normalizeQueueItems(mods, maxMods)) {
    const item = normalizeQueueItem(mod);
    if (!item) continue;
    const existing = queued.get(item.modId);
    if (existing) {
      if (!existing.version && item.version) existing.version = item.version;
      continue;
    }
    queued.set(item.modId, item);
    queue.push(item);
  }
  if (queue.length === 0) throw new Error('Не указан ни один корректный GUID мода.');
  const pinnedRoots = new Set(queue.filter(item => item.version).map(item => item.modId));

  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const modId = queue[index]?.modId;
      if (!modId || processed.has(modId)) continue;
      processed.add(modId);

      try {
        const details = await fetchDetails(modId);
        for (const dependency of details.dependencies || []) {
          const item = normalizeQueueItem(dependency);
          if (!item) continue;
          if (String(dependency?.version || '').trim() && !item.version) {
            const error = new Error(`Invalid Workshop dependency version for ${item.modId}.`);
            error.code = 'WORKSHOP_QUEUE_VERSION';
            throw error;
          }
          const existing = queued.get(item.modId);
          if (existing) {
            if (existing.version && item.version && existing.version !== item.version && !pinnedRoots.has(item.modId)) {
              const error = new Error(`Conflicting Workshop dependency versions for ${item.modId}.`);
              error.code = 'WORKSHOP_QUEUE_VERSION';
              throw error;
            }
            if (!existing.version && item.version) existing.version = item.version;
            continue;
          }
          if (queue.length >= maxMods) {
            const error = new Error(`Workshop dependency limit exceeded (${maxMods}).`);
            error.code = 'WORKSHOP_QUEUE_LIMIT';
            throw error;
          }
          queued.set(item.modId, item);
          queue.push(item);
        }
      } catch (error) {
        if (error.code === 'WORKSHOP_QUEUE_LIMIT' || error.code === 'WORKSHOP_QUEUE_VERSION') throw error;
        failedDetails.push({ modId, message: String(error?.message || error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  return { items: queue, modIds: queue.map((item) => item.modId), failedDetails };
}

function getQueuePaths(profileDirectory) {
  if (!String(profileDirectory || '').trim()) throw new Error('Workshop profile directory is missing.');
  const profile = path.resolve(String(profileDirectory || ''));
  const scriptProfile = path.join(profile, 'profile');
  return {
    queuePath: path.join(scriptProfile, WORKSHOP_QUEUE_FILE),
    statusPath: path.join(scriptProfile, WORKSHOP_STATUS_FILE)
  };
}

async function writeWorkshopQueue(profileDirectory, modIds) {
  const normalized = normalizeQueueItems(modIds);
  const { queuePath, statusPath } = getQueuePaths(profileDirectory);
  const lines = normalized.map((item) => item.version ? `${item.modId}|${item.version}` : item.modId);
  const key = process.platform === 'win32' ? queuePath.toLowerCase() : queuePath;
  const previous = pendingQueueWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(queuePath), { recursive: true });
    await writeTextAtomic(queuePath, `${lines.join('\n')}\n`);
    await writeTextAtomic(statusPath, `queued|0|${normalized.length}|0||0|Preparing Workshop queue\n`);
    return { queuePath, statusPath, count: normalized.length };
  });
  pendingQueueWrites.set(key, pending);
  try { return await pending; }
  finally { if (pendingQueueWrites.get(key) === pending) pendingQueueWrites.delete(key); }
}

async function readWorkshopQueue(profileDirectory) {
  try {
    const { text } = await readBoundedFile(getQueuePaths(profileDirectory).queuePath, 64 * 1024);
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return normalizeQueueItems(lines.map(line => {
      const parts = line.split('|');
      if (parts.length > 2) throw new Error('Invalid saved Workshop queue line.');
      return { modId: parts[0], version: parts[1] || '' };
    }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function parseWorkshopStatus(value) {
  const [state = '', completed = '0', total = '0', failed = '0', modId = '', progress = '0', ...message] = String(value || '').trim().split('|');
  const validState = ACTIVE_STATES.has(state.toLowerCase()) || ['complete', 'partial', 'error', 'idle'].includes(state.toLowerCase());
  const number = text => /^\d{1,9}$/.test(text) && Number(text) <= MAX_QUEUE_ITEMS ? Number(text) : -1;
  const countsValid = [completed, total, failed].every(value => number(value) >= 0)
    && number(completed) + number(failed) <= number(total);
  return {
    state: validState && countsValid && String(value || '').trim().split('|').length >= 7 ? state.toLowerCase() : 'unknown',
    completed: Math.max(0, number(completed)),
    total: Math.max(0, number(total)),
    failed: Math.max(0, number(failed)),
    modId: normalizeModId(modId),
    progress: Math.max(0, Math.min(100, Number.parseInt(progress, 10) || 0)),
    message: message.join('|').trim()
  };
}

async function readWorkshopStatus(profileDirectory, options = {}) {
  const { statusPath } = getQueuePaths(profileDirectory);
  try {
    const { text, stats } = await readBoundedFile(statusPath, 16 * 1024);
    const status = parseWorkshopStatus(text);
    if (options.includeFileMetadata === true) {
      const now = Number.isFinite(options.now) ? options.now : Date.now();
      status.updatedAt = stats.mtime.toISOString();
      status.ageMs = Math.max(0, now - stats.mtimeMs);
    }
    return status;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const idle = { state: 'idle', completed: 0, total: 0, failed: 0, modId: '', progress: 0, message: '' };
      if (options.includeFileMetadata === true) Object.assign(idle, { updatedAt: '', ageMs: 0 });
      return idle;
    }
    throw error;
  }
}

function isWorkshopDownloadActive(status) {
  return ACTIVE_STATES.has(String(status?.state || '').toLowerCase());
}

module.exports = {
  WORKSHOP_BRIDGE_MOD_ID,
  WORKSHOP_QUEUE_FILE,
  WORKSHOP_STATUS_FILE,
  getQueuePaths,
  isWorkshopDownloadActive,
  normalizeQueueItems,
  normalizeVersion,
  parseWorkshopStatus,
  readWorkshopStatus,
  readWorkshopQueue,
  resolveWorkshopQueue,
  writeWorkshopQueue
};
