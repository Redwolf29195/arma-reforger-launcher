const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMPLETE_FACTORY_RESET_SWITCH = '--algz-complete-factory-reset=';
const RESET_TICKET_DIRECTORY_NAME = 'algz-launcher-factory-reset-tickets';
const RESET_TICKET_SCHEMA = 1;
const RESET_TICKET_LIFETIME_MS = 10 * 60 * 1000;
const RESET_TICKET_MAXIMUM_BYTES = 4096;
const RESET_NONCE_PATTERN = /^[0-9a-f]{64}$/;
const TEMPORARY_RESET_DIRECTORY_PREFIX = 'algz-launcher-factory-reset-';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizePathForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathsEqual(left, right) {
  return normalizePathForComparison(left) === normalizePathForComparison(right);
}

function isSameOrInside(parentPath, candidatePath) {
  const relative = path.relative(
    normalizePathForComparison(parentPath),
    normalizePathForComparison(candidatePath)
  );
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateResetBasename(value) {
  const source = String(value || '');
  if (
    !source
    || source !== source.trim()
    || source === '.'
    || source === '..'
    || source.length > 160
    || /[\0-\x1f<>:"/\\|?*]/.test(source)
    || path.basename(source) !== source
  ) {
    throw new Error('Unsafe launcher data directory name.');
  }
  return source;
}

function validateResetTarget(value, options = {}) {
  const source = String(value || '').trim();
  const target = path.resolve(source);
  const root = path.parse(target).root;
  const home = path.resolve(os.homedir());
  if (!source || target === root || pathsEqual(target, home) || pathsEqual(target, path.dirname(home))) {
    throw new Error('Unsafe launcher data reset target.');
  }

  const hasExpectedParent = options.expectedParentDirectory !== undefined;
  const hasExpectedBasename = options.expectedBasename !== undefined;
  if (hasExpectedParent !== hasExpectedBasename) {
    throw new Error('Launcher data reset scope is incomplete.');
  }
  if (hasExpectedParent) {
    const expectedParentSource = String(options.expectedParentDirectory || '').trim();
    const expectedParentDirectory = path.resolve(expectedParentSource);
    const expectedBasename = validateResetBasename(options.expectedBasename);
    const expectedTarget = path.resolve(expectedParentDirectory, expectedBasename);
    if (
      !expectedParentSource
      || pathsEqual(expectedParentDirectory, path.parse(expectedParentDirectory).root)
      || !pathsEqual(path.dirname(expectedTarget), expectedParentDirectory)
      || !pathsEqual(target, expectedTarget)
      || !pathsEqual(path.dirname(target), expectedParentDirectory)
      || (process.platform === 'win32'
        ? path.basename(target).toLowerCase() !== expectedBasename.toLowerCase()
        : path.basename(target) !== expectedBasename)
    ) {
      throw new Error('Launcher data reset target is outside the protected application scope.');
    }
  }
  return target;
}

function parseProcessId(value) {
  const source = String(value || '');
  if (!/^[1-9]\d*$/.test(source)) throw new Error('Invalid launcher process ID.');
  const processId = Number(source);
  if (!Number.isSafeInteger(processId)) throw new Error('Invalid launcher process ID.');
  return processId;
}

function validateResetNonce(value) {
  const nonce = String(value || '');
  if (!RESET_NONCE_PATTERN.test(nonce)) throw new Error('Invalid factory reset ticket.');
  return nonce;
}

function createCompleteFactoryResetArgument(nonce) {
  return `${COMPLETE_FACTORY_RESET_SWITCH}${validateResetNonce(nonce)}`;
}

function parseCompleteFactoryResetArgument(argumentsList = []) {
  const matches = argumentsList
    .map((argument) => String(argument))
    .filter((argument) => argument.startsWith(COMPLETE_FACTORY_RESET_SWITCH));
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('Invalid factory reset arguments.');
  return validateResetNonce(matches[0].slice(COMPLETE_FACTORY_RESET_SWITCH.length));
}

function stripCompleteFactoryResetArguments(argumentsList = []) {
  return argumentsList
    .map((argument) => String(argument))
    .filter((argument) => !argument.startsWith(COMPLETE_FACTORY_RESET_SWITCH));
}

function buildFactoryResetRelaunchArguments(argumentsList, nonce) {
  return [
    ...stripCompleteFactoryResetArguments(argumentsList),
    createCompleteFactoryResetArgument(nonce)
  ];
}

function hasUserDataDirectoryOverride(argumentsList = []) {
  return argumentsList.some((argument) => /^--user-data-dir(?:=|$)/i.test(String(argument)));
}

function hasForbiddenPackagedRuntimeSwitch(argumentsList = []) {
  return argumentsList.some((argument) => (
    /^(?:--inspect(?:-brk)?|--remote-debugging-(?:port|pipe)|--user-data-dir)(?:=|$)/i.test(String(argument))
  ));
}

function resolveStableLauncherDataDirectory(electronApp) {
  if (!electronApp || typeof electronApp.getPath !== 'function' || typeof electronApp.getName !== 'function') {
    throw new Error('Electron app identity is unavailable for factory reset.');
  }
  const appDataSource = String(electronApp.getPath('appData') || '').trim();
  const appDataDirectory = path.resolve(appDataSource);
  const appName = validateResetBasename(electronApp.getName());
  if (
    !appDataSource
    || pathsEqual(appDataDirectory, path.parse(appDataDirectory).root)
    || pathsEqual(appDataDirectory, os.homedir())
    || pathsEqual(appDataDirectory, path.dirname(os.homedir()))
  ) {
    throw new Error('Unsafe launcher application data parent.');
  }
  const targetDirectory = validateResetTarget(path.join(appDataDirectory, appName), {
    expectedParentDirectory: appDataDirectory,
    expectedBasename: appName
  });
  return { appDataDirectory, appName, targetDirectory };
}

function assertCurrentLauncherDataDirectory(electronApp, stableIdentity) {
  const currentUserDataDirectory = validateResetTarget(electronApp.getPath('userData'));
  if (!pathsEqual(currentUserDataDirectory, stableIdentity.targetDirectory)) {
    throw new Error('Launcher user data path was overridden; factory reset was blocked.');
  }
  return currentUserDataDirectory;
}

function resolveTemporaryParentDirectory(electronApp, options = {}) {
  const source = String(
    options.temporaryParentDirectory || electronApp.getPath('temp') || os.tmpdir()
  ).trim();
  return validateResetTarget(source);
}

function resolveFactoryResetTicketDirectory(electronApp, options = {}) {
  const temporaryParentDirectory = resolveTemporaryParentDirectory(electronApp, options);
  return validateResetTarget(path.join(temporaryParentDirectory, RESET_TICKET_DIRECTORY_NAME), {
    expectedParentDirectory: temporaryParentDirectory,
    expectedBasename: RESET_TICKET_DIRECTORY_NAME
  });
}

function factoryResetTicketPath(electronApp, nonce, options = {}) {
  const normalizedNonce = validateResetNonce(nonce);
  const ticketDirectory = resolveFactoryResetTicketDirectory(electronApp, options);
  const ticketPath = path.resolve(ticketDirectory, `${normalizedNonce}.json`);
  if (!pathsEqual(path.dirname(ticketPath), ticketDirectory)) {
    throw new Error('Unsafe factory reset ticket path.');
  }
  return ticketPath;
}

function optionNow(options = {}) {
  const value = typeof options.now === 'function'
    ? options.now()
    : options.now === undefined
      ? Date.now()
      : options.now;
  const now = Number(value);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid factory reset clock.');
  return now;
}

async function applyPrivatePermissions(filePath, mode) {
  if (process.platform === 'win32') return;
  await fs.chmod(filePath, mode).catch(() => {});
}

async function createFactoryResetTicket(electronApp, parentProcessId, options = {}) {
  const stableIdentity = resolveStableLauncherDataDirectory(electronApp);
  assertCurrentLauncherDataDirectory(electronApp, stableIdentity);
  const normalizedParentProcessId = parseProcessId(parentProcessId);
  const now = optionNow(options);
  const requestedLifetime = options.ticketLifetimeMs === undefined
    ? RESET_TICKET_LIFETIME_MS
    : Number(options.ticketLifetimeMs);
  if (!Number.isSafeInteger(requestedLifetime) || requestedLifetime < 1000 || requestedLifetime > RESET_TICKET_LIFETIME_MS) {
    throw new Error('Invalid factory reset ticket lifetime.');
  }

  const ticketDirectory = resolveFactoryResetTicketDirectory(electronApp, options);
  await fs.mkdir(ticketDirectory, { recursive: true, mode: 0o700 });
  await applyPrivatePermissions(ticketDirectory, 0o700);

  let lastCollision;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nonce = options.nonce === undefined
      ? crypto.randomBytes(32).toString('hex')
      : validateResetNonce(options.nonce);
    const ticketPath = factoryResetTicketPath(electronApp, nonce, options);
    const ticket = {
      schema: RESET_TICKET_SCHEMA,
      nonce,
      parentProcessId: normalizedParentProcessId,
      createdAt: now,
      expiresAt: now + requestedLifetime,
      appDataDirectory: stableIdentity.appDataDirectory,
      appName: stableIdentity.appName,
      targetDirectory: stableIdentity.targetDirectory
    };
    const contents = `${JSON.stringify(ticket)}\n`;
    try {
      await fs.writeFile(ticketPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await applyPrivatePermissions(ticketPath, 0o600);
      return {
        nonce,
        ticketPath,
        expiresAt: ticket.expiresAt,
        targetDirectory: stableIdentity.targetDirectory
      };
    } catch (error) {
      if (error?.code !== 'EEXIST' || options.nonce !== undefined) throw error;
      lastCollision = error;
    }
  }
  throw lastCollision || new Error('Could not create a unique factory reset ticket.');
}

async function discardFactoryResetTicket(electronApp, nonce, options = {}) {
  const ticketPath = factoryResetTicketPath(electronApp, nonce, options);
  await fs.rm(ticketPath, { force: true });
  return ticketPath;
}

function validateConsumedTicket(ticket, nonce, stableIdentity, now) {
  if (!ticket || Array.isArray(ticket) || typeof ticket !== 'object' || ticket.schema !== RESET_TICKET_SCHEMA) {
    throw new Error('Invalid factory reset ticket contents.');
  }
  if (ticket.nonce !== nonce) throw new Error('Factory reset ticket nonce does not match.');
  const parentProcessId = parseProcessId(ticket.parentProcessId);
  if (
    !pathsEqual(ticket.appDataDirectory, stableIdentity.appDataDirectory)
    || ticket.appName !== stableIdentity.appName
    || !pathsEqual(ticket.targetDirectory, stableIdentity.targetDirectory)
  ) {
    throw new Error('Factory reset ticket target is outside the protected application scope.');
  }
  const createdAt = Number(ticket.createdAt);
  const expiresAt = Number(ticket.expiresAt);
  if (
    !Number.isSafeInteger(createdAt)
    || !Number.isSafeInteger(expiresAt)
    || createdAt <= 0
    || expiresAt <= now
    || createdAt > now + 30_000
    || expiresAt <= createdAt
    || expiresAt - createdAt > RESET_TICKET_LIFETIME_MS
  ) {
    throw new Error('Factory reset ticket has expired or has an invalid lifetime.');
  }
  return { parentProcessId, createdAt, expiresAt };
}

function consumeFactoryResetTicket(electronApp, nonce, options = {}) {
  const normalizedNonce = validateResetNonce(nonce);
  const stableIdentity = resolveStableLauncherDataDirectory(electronApp);
  assertCurrentLauncherDataDirectory(electronApp, stableIdentity);
  const ticketPath = factoryResetTicketPath(electronApp, normalizedNonce, options);
  const ticketDirectory = path.dirname(ticketPath);
  const consumptionSuffix = crypto.randomBytes(12).toString('hex');
  const consumedTicketPath = path.resolve(
    ticketDirectory,
    `.${normalizedNonce}.${parseProcessId(process.pid)}.${consumptionSuffix}.consuming`
  );
  if (!pathsEqual(path.dirname(consumedTicketPath), ticketDirectory)) {
    throw new Error('Unsafe consumed factory reset ticket path.');
  }

  fsSync.renameSync(ticketPath, consumedTicketPath);
  try {
    const ticketStat = fsSync.lstatSync(consumedTicketPath);
    if (!ticketStat.isFile() || ticketStat.isSymbolicLink() || ticketStat.size > RESET_TICKET_MAXIMUM_BYTES) {
      throw new Error('Invalid factory reset ticket file.');
    }
    const ticket = JSON.parse(fsSync.readFileSync(consumedTicketPath, 'utf8'));
    const timing = validateConsumedTicket(ticket, normalizedNonce, stableIdentity, optionNow(options));
    return {
      nonce: normalizedNonce,
      parentProcessId: timing.parentProcessId,
      originalUserDataDirectory: stableIdentity.targetDirectory,
      expectedParentDirectory: stableIdentity.appDataDirectory,
      expectedBasename: stableIdentity.appName
    };
  } finally {
    fsSync.rmSync(consumedTicketPath, { force: true });
  }
}

function prepareFactoryResetStartup(electronApp, argumentsList = process.argv.slice(1), options = {}) {
  const nonce = parseCompleteFactoryResetArgument(argumentsList);
  if (nonce === null) return { active: false };
  if (hasUserDataDirectoryOverride(argumentsList)) {
    throw new Error('Launcher user data override is forbidden during factory reset.');
  }
  if (!electronApp || typeof electronApp.getPath !== 'function' || typeof electronApp.setPath !== 'function') {
    throw new Error('Electron app paths are unavailable for factory reset.');
  }

  const consumedTicket = consumeFactoryResetTicket(electronApp, nonce, options);
  const temporaryParentDirectory = resolveTemporaryParentDirectory(electronApp, options);
  fsSync.mkdirSync(temporaryParentDirectory, { recursive: true });
  const temporaryRootDirectory = fsSync.mkdtempSync(
    path.join(temporaryParentDirectory, TEMPORARY_RESET_DIRECTORY_PREFIX)
  );

  if (
    isSameOrInside(consumedTicket.originalUserDataDirectory, temporaryRootDirectory)
    || isSameOrInside(temporaryRootDirectory, consumedTicket.originalUserDataDirectory)
  ) {
    fsSync.rmSync(temporaryRootDirectory, { recursive: true, force: true });
    throw new Error('Temporary factory reset data cannot be stored inside launcher data.');
  }

  const temporaryUserDataDirectory = path.join(temporaryRootDirectory, 'user-data');
  const temporarySessionDataDirectory = path.join(temporaryRootDirectory, 'session-data');
  fsSync.mkdirSync(temporaryUserDataDirectory, { recursive: true });
  fsSync.mkdirSync(temporarySessionDataDirectory, { recursive: true });
  electronApp.setPath('userData', temporaryUserDataDirectory);
  electronApp.setPath('sessionData', temporarySessionDataDirectory);

  return {
    active: true,
    ...consumedTicket,
    temporaryRootDirectory,
    temporaryUserDataDirectory,
    temporarySessionDataDirectory,
    cleanRelaunchArguments: stripCompleteFactoryResetArguments(argumentsList)
  };
}

async function waitForProcessExit(processId, timeoutMs = 30_000) {
  const normalizedProcessId = parseProcessId(processId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(normalizedProcessId, 0);
      await wait(150);
    } catch {
      return;
    }
  }
  throw new Error('Launcher did not close before factory reset.');
}

async function removeLauncherData(directoryPath, options = {}) {
  if (options.expectedParentDirectory === undefined || options.expectedBasename === undefined) {
    throw new Error('Launcher data reset scope is required.');
  }
  const target = validateResetTarget(directoryPath, {
    expectedParentDirectory: options.expectedParentDirectory,
    expectedBasename: options.expectedBasename
  });
  const attempts = Math.max(1, Number(options.attempts) || 12);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return target;
    } catch (error) {
      if (attempt === attempts) throw error;
      await wait(250);
    }
  }
  return target;
}

async function completeFactoryReset(startup, options = {}) {
  if (!startup?.active) return false;
  if (startup.expectedParentDirectory === undefined || startup.expectedBasename === undefined) {
    throw new Error('Launcher data reset scope is required.');
  }
  const target = validateResetTarget(startup.originalUserDataDirectory, {
    expectedParentDirectory: startup.expectedParentDirectory,
    expectedBasename: startup.expectedBasename
  });
  const waitForExit = options.waitForProcessExit || waitForProcessExit;
  const removeData = options.removeLauncherData || removeLauncherData;
  await waitForExit(startup.parentProcessId, options.timeoutMs);
  await removeData(target, {
    ...options.removeOptions,
    expectedParentDirectory: startup.expectedParentDirectory,
    expectedBasename: startup.expectedBasename
  });
  return true;
}

function decodeRelaunchArguments(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

module.exports = {
  COMPLETE_FACTORY_RESET_SWITCH,
  RESET_TICKET_DIRECTORY_NAME,
  RESET_TICKET_LIFETIME_MS,
  RESET_TICKET_SCHEMA,
  buildFactoryResetRelaunchArguments,
  completeFactoryReset,
  consumeFactoryResetTicket,
  createCompleteFactoryResetArgument,
  createFactoryResetTicket,
  decodeRelaunchArguments,
  discardFactoryResetTicket,
  factoryResetTicketPath,
  hasForbiddenPackagedRuntimeSwitch,
  hasUserDataDirectoryOverride,
  parseCompleteFactoryResetArgument,
  prepareFactoryResetStartup,
  removeLauncherData,
  resolveFactoryResetTicketDirectory,
  resolveStableLauncherDataDirectory,
  stripCompleteFactoryResetArguments,
  validateResetTarget,
  waitForProcessExit
};
