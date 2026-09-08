const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_LOGS_DIRECTORY = path.join(
  os.homedir(),
  'Documents',
  'My Games',
  'ArmaReforger',
  'logs'
);
const MAX_SCAN_DEPTH = 2;
const MAX_SCAN_DIRECTORIES = 128;
const MAX_LOG_READ_BYTES = 1024 * 1024;
const LOG_HEADER_READ_BYTES = 16 * 1024;
const LOG_START_TOLERANCE_MS = 2000;

async function resolveServerLogsDirectories(options = {}) {
  if (options.logsDirectory) return [String(options.logsDirectory)];
  const platform = options.platform || process.platform;
  const nativePath = platform === 'win32' ? path.win32 : path.posix;
  const directories = [];
  if (options.profileDirectory) {
    directories.push(nativePath.join(options.profileDirectory, 'logs', 'server-join'));
    directories.push(nativePath.join(options.profileDirectory, 'logs'));
    return directories;
  }
  if (platform === 'linux') {
    const findProfiles = options.findProfileDirectories || require('./steamLinux').findLinuxGameProfileDirectories;
    const profiles = await findProfiles(options.gameExecutable || '', options.discoveryOptions || {});
    directories.push(...profiles.map((directory) => nativePath.join(directory, 'logs')));
  } else if (directories.length === 0) {
    directories.push(DEFAULT_LOGS_DIRECTORY);
  }
  return [...new Set(directories)];
}

function normalizedEndpoint(value) {
  return String(value || '').trim().toLocaleLowerCase('en');
}

function clientEndpointFromParams(parameters) {
  const match = String(parameters || '').match(
    /(?:^|\s)-client(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i
  );
  return normalizedEndpoint(match?.[1] || match?.[2] || match?.[3]);
}

function hasMatchingClientParams(logText, serverAddress) {
  const expected = normalizedEndpoint(serverAddress);
  if (!expected) return false;

  const pattern = /\bCLI Params:\s*([^\r\n]*)/gi;
  for (const match of String(logText || '').matchAll(pattern)) {
    if (clientEndpointFromParams(match[1]) === expected) return true;
  }
  return false;
}

function connectionFailureEndpoints(logText) {
  const endpoints = [];
  const pattern = /Unable to connect as client to\s+['"]?([^'"\s\r\n]+)['"]?/gi;
  for (const match of String(logText || '').matchAll(pattern)) {
    const endpoint = normalizedEndpoint(match[1]);
    if (endpoint) endpoints.push(endpoint);
  }
  return endpoints;
}

function parseLogStartedAtUtc(logText) {
  const match = String(logText || '').match(
    /^Log\s+[^\r\n]*\bstarted at\b[^\r\n]*\((\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s+UTC\)/im
  );
  if (!match) return null;
  const timestamp = Date.parse(`${match[1].replace(' ', 'T')}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseServerLaunchFailure(logText, serverAddress) {
  const text = String(logText || '');
  if (!hasMatchingClientParams(text, serverAddress)) return null;
  const expected = normalizedEndpoint(serverAddress);
  const failedEndpoints = connectionFailureEndpoints(text);
  const matchingConnectionFailure = failedEndpoints.includes(expected);
  if (/\bhandshake timeout\b/i.test(text)) {
    return matchingConnectionFailure ? 'handshake-timeout' : null;
  }
  if (matchingConnectionFailure) return 'connection-failed';
  if (failedEndpoints.length > 0) return null;
  if (/\bUnable to initialize the game\b/i.test(text)) return 'initialization-failed';
  return null;
}

async function readAtMost(fileHandle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readLogSample(logPath, options = {}) {
  const maximumBytes = Math.max(
    1,
    Math.min(MAX_LOG_READ_BYTES, Number(options.maximumBytes) || MAX_LOG_READ_BYTES)
  );
  const requestedHeaderBytes = Math.max(
    1,
    Math.min(maximumBytes, Number(options.headerBytes) || LOG_HEADER_READ_BYTES)
  );
  const fileHandle = await fs.open(logPath, 'r');
  try {
    const stats = await fileHandle.stat();
    const size = Math.max(0, Number(stats.size) || 0);
    if (size <= maximumBytes) {
      const contents = await readAtMost(fileHandle, size, 0);
      return {
        text: contents.toString('utf8'),
        bytesRead: contents.length,
        size
      };
    }

    const headerLength = Math.min(requestedHeaderBytes, size);
    const tailLength = Math.min(maximumBytes - headerLength, size - headerLength);
    const [header, tail] = await Promise.all([
      readAtMost(fileHandle, headerLength, 0),
      readAtMost(fileHandle, tailLength, size - tailLength)
    ]);
    return {
      text: `${header.toString('utf8')}\n${tail.toString('utf8')}`,
      bytesRead: header.length + tail.length,
      size
    };
  } finally {
    await fileHandle.close();
  }
}

function isMissingPathError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

async function collectConsoleLogs(logsDirectory) {
  const queue = [{ directory: path.resolve(logsDirectory), depth: 0 }];
  const logPaths = [];
  const errors = [];
  let scannedDirectories = 0;

  while (queue.length > 0 && scannedDirectories < MAX_SCAN_DIRECTORIES) {
    const current = queue.shift();
    scannedDirectories += 1;
    let entries;
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      if (!isMissingPathError(error)) errors.push(error);
      continue;
    }

    entries.sort((left, right) => right.name.localeCompare(left.name, 'en'));
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLocaleLowerCase('en') === 'console.log') {
        logPaths.push(path.join(current.directory, entry.name));
      }
    }

    if (current.depth >= MAX_SCAN_DEPTH) continue;
    const remainingCapacity = MAX_SCAN_DIRECTORIES - scannedDirectories - queue.length;
    if (remainingCapacity <= 0) continue;
    const childDirectories = entries
      .filter((entry) => entry.isDirectory())
      .slice(0, remainingCapacity)
      .map((entry) => ({
        directory: path.join(current.directory, entry.name),
        depth: current.depth + 1
      }));
    queue.push(...childDirectories);
  }

  return { logPaths, errors };
}

async function inspectServerLaunchLogs(options = {}) {
  const serverAddress = String(options.serverAddress || '').trim();
  const startedAt = Number(options.startedAt);
  const minimumMtime = Number.isFinite(startedAt) ? startedAt : Date.now();
  const logsDirectories = await resolveServerLogsDirectories(options);
  const scans = await Promise.all(logsDirectories.map(collectConsoleLogs));
  const collected = {
    logPaths: [...new Set(scans.flatMap((scan) => scan.logPaths))],
    errors: scans.flatMap((scan) => scan.errors)
  };
  const errors = [...collected.errors];
  const candidates = [];

  for (const logPath of collected.logPaths) {
    try {
      const stats = await fs.stat(logPath);
      if (stats.isFile() && stats.mtimeMs >= minimumMtime) {
        candidates.push({ logPath, mtimeMs: stats.mtimeMs });
      }
    } catch (error) {
      if (!isMissingPathError(error)) errors.push(error);
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates) {
    try {
      const sample = await readLogSample(candidate.logPath);
      const logStartedAt = parseLogStartedAtUtc(sample.text);
      if (logStartedAt !== null && logStartedAt < minimumMtime - LOG_START_TOLERANCE_MS) continue;
      const reason = parseServerLaunchFailure(sample.text, serverAddress);
      if (reason) {
        return {
          failure: { reason, logPath: candidate.logPath },
          errors
        };
      }
    } catch (error) {
      if (!isMissingPathError(error)) errors.push(error);
    }
  }

  return { failure: null, errors };
}

function createServerLaunchMonitor(options = {}) {
  const serverAddress = String(options.serverAddress || '').trim();
  const suppliedStartedAt = Number(options.startedAt);
  const startedAt = Number.isFinite(suppliedStartedAt) ? suppliedStartedAt : Date.now();
  const onFailure = typeof options.onFailure === 'function' ? options.onFailure : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const suppliedInterval = Number(options.intervalMs);
  const suppliedTimeout = Number(options.timeoutMs);
  const intervalMs = Number.isFinite(suppliedInterval) ? Math.max(10, suppliedInterval) : 1000;
  const timeoutMs = Number.isFinite(suppliedTimeout) ? Math.max(0, suppliedTimeout) : 180000;
  const deadline = Date.now() + timeoutMs;
  const reportedErrors = new Set();
  let active = timeoutMs > 0 && Boolean(serverAddress);
  let timer = null;
  let generation = 0;

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
    try {
      onError(error);
    } catch {
      // An observer callback must never affect the launcher or the monitor.
    }
  };

  const schedule = (delay) => {
    if (!active) return;
    timer = setTimeout(() => {
      timer = null;
      const scanGeneration = generation;
      void inspectServerLaunchLogs({ ...options, serverAddress, startedAt })
        .then((result) => {
          if (!active || scanGeneration !== generation || Date.now() >= deadline) {
            stop();
            return;
          }
          for (const error of result.errors) reportError(error);
          if (!active || scanGeneration !== generation) return;
          if (!result.failure) {
            schedule(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
            return;
          }

          active = false;
          generation += 1;
          try {
            const callbackResult = onFailure(result.failure);
            Promise.resolve(callbackResult).catch(() => {});
          } catch {
            // Failure reporting is best-effort and must not affect the launcher.
          }
        })
        .catch((error) => {
          if (!active || scanGeneration !== generation) return;
          reportError(error);
          if (Date.now() >= deadline) stop();
          else schedule(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
        });
    }, Math.max(0, delay));
    timer.unref?.();
  };

  if (active) schedule(0);
  return stop;
}

module.exports = {
  DEFAULT_LOGS_DIRECTORY,
  LOG_HEADER_READ_BYTES,
  LOG_START_TOLERANCE_MS,
  MAX_LOG_READ_BYTES,
  MAX_SCAN_DEPTH,
  MAX_SCAN_DIRECTORIES,
  createServerLaunchMonitor,
  inspectServerLaunchLogs,
  parseLogStartedAtUtc,
  parseServerLaunchFailure,
  readLogSample,
  resolveServerLogsDirectories
};
