const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { normalizeServerAddress } = require('./serverBrowser');

const SERVER_JOIN_REQUEST_FILE = 'ALGZLauncherServerJoin.txt';
const SERVER_JOIN_STATUS_FILE = 'ALGZLauncherServerJoinStatus.txt';
const SERVER_JOIN_TOKEN_PATTERN = /^[0-9a-f]{32}$/i;
const SERVER_JOIN_STATES = new Set(['waiting', 'opening-browser', 'joining', 'error']);
const SERVER_JOIN_TERMINAL_STATES = new Set(['joining', 'error']);
const MAX_SERVER_JOIN_FILE_BYTES = 4 * 1024;
const SERVER_JOIN_STATUS_MTIME_TOLERANCE_MS = 2_000;
const DEFAULT_SERVER_JOIN_POLL_INTERVAL_MS = 500;
const DEFAULT_SERVER_JOIN_TIMEOUT_MS = 180_000;
const MAX_SERVER_JOIN_TIMEOUT_MS = 180_000;
const profileOperationQueues = new Map();

function normalizeServerJoinToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!SERVER_JOIN_TOKEN_PATTERN.test(token)) {
    throw new Error('Некорректный одноразовый идентификатор подключения к серверу.');
  }
  return token;
}

function getServerJoinPaths(profileDirectory) {
  const suppliedProfile = String(profileDirectory || '').trim();
  if (!suppliedProfile) throw new Error('Не указана папка профиля для подключения к серверу.');
  const profile = path.resolve(suppliedProfile);
  const scriptProfile = path.join(profile, 'profile');
  return {
    requestPath: path.join(scriptProfile, SERVER_JOIN_REQUEST_FILE),
    statusPath: path.join(scriptProfile, SERVER_JOIN_STATUS_FILE)
  };
}

function parseServerJoinRequest(value) {
  const line = String(value || '').replace(/^\uFEFF/, '').trim();
  if (!line || /[\r\n]/.test(line)) return null;
  const separator = line.indexOf('|');
  if (separator <= 0 || separator === line.length - 1 || line.indexOf('|', separator + 1) !== -1) return null;
  try {
    return {
      token: normalizeServerJoinToken(line.slice(0, separator)),
      address: normalizeServerAddress(line.slice(separator + 1))
    };
  } catch {
    return null;
  }
}

function parseServerJoinStatus(value) {
  const line = String(value || '').replace(/^\uFEFF/, '').trim();
  if (!line || /[\r\n]/.test(line)) return null;
  const [tokenValue = '', stateValue = '', ...messageParts] = line.split('|');
  let token;
  try {
    token = normalizeServerJoinToken(tokenValue);
  } catch {
    return null;
  }
  const state = stateValue.trim().toLowerCase();
  if (!SERVER_JOIN_STATES.has(state)) return null;
  return {
    token,
    state,
    message: messageParts.join('|').replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
  };
}

async function writeFileAtomic(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function profileOperationKey(requestPath) {
  return process.platform === 'win32' ? requestPath.toLowerCase() : requestPath;
}

function enqueueProfileOperation(requestPath, operation) {
  const key = profileOperationKey(requestPath);
  const previous = profileOperationQueues.get(key) || Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const tail = result.catch(() => {});
  profileOperationQueues.set(key, tail);
  void tail.then(() => {
    if (profileOperationQueues.get(key) === tail) profileOperationQueues.delete(key);
  });
  return result;
}

async function readBoundedText(filePath, maximumBytes = MAX_SERVER_JOIN_FILE_BYTES) {
  const limit = Math.max(1, Math.min(MAX_SERVER_JOIN_FILE_BYTES, Number(maximumBytes) || MAX_SERVER_JOIN_FILE_BYTES));
  const fileHandle = await fs.open(filePath, 'r');
  try {
    const stats = await fileHandle.stat();
    if (!stats.isFile() || stats.size > limit) {
      const error = new Error(`Файл обмена подключения к серверу превышает лимит ${limit} байт.`);
      error.code = 'SERVER_JOIN_FILE_TOO_LARGE';
      error.path = filePath;
      throw error;
    }
    // Always reserve the full bounded sample so growth after stat() cannot turn
    // a truncated valid-looking prefix into an accepted request or status.
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await fileHandle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > limit) {
      const error = new Error(`Файл обмена подключения к серверу превышает лимит ${limit} байт.`);
      error.code = 'SERVER_JOIN_FILE_TOO_LARGE';
      error.path = filePath;
      throw error;
    }
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      size: Number(stats.size) || 0,
      mtimeMs: Number(stats.mtimeMs) || 0
    };
  } finally {
    await fileHandle.close();
  }
}

async function prepareServerJoinRequest(profileDirectory, serverAddress, options = {}) {
  const address = normalizeServerAddress(serverAddress);
  const token = options.token === undefined
    ? crypto.randomBytes(16).toString('hex')
    : normalizeServerJoinToken(options.token);
  const { requestPath, statusPath } = getServerJoinPaths(profileDirectory);
  return enqueueProfileOperation(requestPath, async () => {
    const suppliedNow = Number(options.now);
    const startedAt = Number.isFinite(suppliedNow) ? suppliedNow : Date.now();
    await writeFileAtomic(requestPath, `${token}|${address}\n`);
    return {
      token,
      address,
      profileDirectory: path.dirname(path.dirname(requestPath)),
      requestPath,
      statusPath,
      startedAt,
      arguments: ['-algzJoinRequest', token]
    };
  });
}

function isMissingPathError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function tokenFromBridgeLine(value) {
  const line = String(value || '').replace(/^\uFEFF/, '').trim();
  if (!line || /[\r\n]/.test(line)) return '';
  const separator = line.indexOf('|');
  if (separator <= 0) return '';
  try {
    return normalizeServerJoinToken(line.slice(0, separator));
  } catch {
    return '';
  }
}

async function removeFileForMatchingToken(filePath, expectedToken) {
  let sample;
  try {
    sample = await readBoundedText(filePath);
  } catch (error) {
    if (isMissingPathError(error) || error?.code === 'SERVER_JOIN_FILE_TOO_LARGE') return false;
    throw error;
  }
  if (tokenFromBridgeLine(sample.text) !== expectedToken) return false;

  // Re-read immediately before deletion. The per-profile queue below makes this
  // conditional for launcher operations in this process; the game may still
  // consume the fixed handoff path concurrently, so cleanup remains best-effort.
  try {
    sample = await readBoundedText(filePath);
  } catch (error) {
    if (isMissingPathError(error) || error?.code === 'SERVER_JOIN_FILE_TOO_LARGE') return false;
    throw error;
  }
  if (tokenFromBridgeLine(sample.text) !== expectedToken) return false;
  await fs.rm(filePath, { force: true });
  return true;
}

async function cancelServerJoinRequest(profileDirectoryOrRequest, tokenValue) {
  const request = profileDirectoryOrRequest && typeof profileDirectoryOrRequest === 'object'
    ? profileDirectoryOrRequest
    : null;
  const profileDirectory = request?.profileDirectory || profileDirectoryOrRequest;
  const token = normalizeServerJoinToken(request?.token || tokenValue);
  const preserveStatus = request?.preserveStatus === true;
  const { requestPath, statusPath } = getServerJoinPaths(profileDirectory);
  return enqueueProfileOperation(requestPath, async () => {
    const requestRemoved = await removeFileForMatchingToken(requestPath, token);
    const statusRemoved = preserveStatus
      ? false
      : await removeFileForMatchingToken(statusPath, token);
    return {
      cancelled: requestRemoved || statusRemoved,
      requestRemoved,
      statusRemoved,
      requestPath,
      statusPath
    };
  });
}

function createServerJoinMonitor(options = {}) {
  const statusPath = path.resolve(String(options.statusPath || '').trim());
  if (!String(options.statusPath || '').trim()) throw new Error('Не указан файл состояния подключения к серверу.');
  const token = normalizeServerJoinToken(options.token);
  const suppliedStartedAt = Number(options.startedAt);
  const startedAt = Number.isFinite(suppliedStartedAt) ? suppliedStartedAt : Date.now();
  const suppliedInterval = Number(options.intervalMs);
  const intervalMs = Number.isFinite(suppliedInterval)
    ? Math.max(10, Math.min(5_000, suppliedInterval))
    : DEFAULT_SERVER_JOIN_POLL_INTERVAL_MS;
  const suppliedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(suppliedTimeout)
    ? Math.max(0, Math.min(MAX_SERVER_JOIN_TIMEOUT_MS, suppliedTimeout))
    : DEFAULT_SERVER_JOIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  const onTerminal = typeof options.onTerminal === 'function' ? options.onTerminal : () => {};
  const onTimeout = typeof options.onTimeout === 'function' ? options.onTimeout : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const reportedErrors = new Set();
  let active = timeoutMs > 0;
  let timer = null;
  let generation = 0;
  let lastStatusKey = '';

  const invoke = (callback, value) => {
    try {
      Promise.resolve(callback(value)).catch(() => {});
    } catch {
      // Observer callbacks must never affect the launcher or the monitor.
    }
  };

  const stop = () => {
    if (!active && !timer) return;
    active = false;
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const reportError = (error) => {
    if (!active) return;
    const key = `${error?.code || ''}:${error?.path || ''}:${error?.message || error}`;
    if (reportedErrors.has(key)) return;
    reportedErrors.add(key);
    invoke(onError, error);
  };

  const reportTimeout = () => {
    if (!active) return;
    stop();
    invoke(onTimeout, { token, statusPath });
  };

  const schedule = (delay) => {
    if (!active) return;
    timer = setTimeout(() => {
      timer = null;
      if (Date.now() >= deadline) {
        reportTimeout();
        return;
      }
      const scanGeneration = generation;
      void readBoundedText(statusPath)
        .then((sample) => {
          if (!active || scanGeneration !== generation) return;
          if (Date.now() >= deadline) {
            reportTimeout();
            return;
          }
          const fresh = sample.mtimeMs >= startedAt - SERVER_JOIN_STATUS_MTIME_TOLERANCE_MS;
          const status = fresh ? parseServerJoinStatus(sample.text) : null;
          if (status?.token === token) {
            const details = {
              ...status,
              statusPath,
              updatedAt: new Date(sample.mtimeMs).toISOString()
            };
            const statusKey = `${status.state}|${status.message}`;
            if (statusKey !== lastStatusKey) {
              lastStatusKey = statusKey;
              invoke(onStatus, details);
            }
            if (!active || scanGeneration !== generation) return;
            if (SERVER_JOIN_TERMINAL_STATES.has(status.state)) {
              stop();
              invoke(onTerminal, details);
              return;
            }
          }
          schedule(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
        })
        .catch((error) => {
          if (!active || scanGeneration !== generation) return;
          if (!isMissingPathError(error)) reportError(error);
          if (Date.now() >= deadline) reportTimeout();
          else schedule(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
        });
    }, Math.max(0, delay));
    timer.unref?.();
  };

  if (active) schedule(0);
  return stop;
}

module.exports = {
  DEFAULT_SERVER_JOIN_POLL_INTERVAL_MS,
  DEFAULT_SERVER_JOIN_TIMEOUT_MS,
  MAX_SERVER_JOIN_FILE_BYTES,
  MAX_SERVER_JOIN_TIMEOUT_MS,
  SERVER_JOIN_REQUEST_FILE,
  SERVER_JOIN_STATUS_FILE,
  SERVER_JOIN_STATUS_MTIME_TOLERANCE_MS,
  SERVER_JOIN_STATES,
  SERVER_JOIN_TERMINAL_STATES,
  cancelServerJoinRequest,
  createServerJoinMonitor,
  getServerJoinPaths,
  normalizeServerJoinToken,
  parseServerJoinRequest,
  parseServerJoinStatus,
  prepareServerJoinRequest,
  readBoundedText
};
