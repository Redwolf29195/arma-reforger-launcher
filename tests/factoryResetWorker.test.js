const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  COMPLETE_FACTORY_RESET_SWITCH,
  RESET_TICKET_LIFETIME_MS,
  RESET_TICKET_SCHEMA,
  buildFactoryResetRelaunchArguments,
  completeFactoryReset,
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
  validateResetTarget
} = require('../src/core/factoryResetWorker');

const APP_NAME = 'Arma Reforger Launcher';

function createAppFixture(rootDirectory, overrides = {}) {
  const paths = {
    appData: overrides.appData || path.join(rootDirectory, 'app-data'),
    temp: overrides.temp || path.join(rootDirectory, 'temporary')
  };
  paths.userData = overrides.userData || path.join(paths.appData, overrides.appName || APP_NAME);
  const changedPaths = [];
  const electronApp = {
    getName: () => overrides.appName || APP_NAME,
    getPath(name) {
      if (!(name in paths)) throw new Error(`Unexpected path: ${name}`);
      return paths[name];
    },
    setPath(name, value) {
      paths[name] = value;
      changedPaths.push([name, value]);
    }
  };
  return { changedPaths, electronApp, paths };
}

test('removes only the exact launcher directory inside its protected appData parent', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-factory-reset-'));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, APP_NAME);
  await fs.mkdir(path.join(target, 'reforger', 'profile', 'addons', 'ALGZLauncherWorkshopBridge'), { recursive: true });
  await fs.mkdir(path.join(target, 'Cache'), { recursive: true });
  await fs.writeFile(path.join(target, 'settings.json'), '{}');
  await fs.writeFile(path.join(target, 'reforger', 'profile', 'ALGZLauncherWorkshopQueue.txt'), 'AAAAAAAAAAAAAAAA');
  await fs.writeFile(path.join(target, 'Cache', 'stale.bin'), 'stale');

  await removeLauncherData(target, {
    attempts: 2,
    expectedParentDirectory: parent,
    expectedBasename: APP_NAME
  });
  await assert.rejects(fs.access(target));
});

test('refuses broad or unscoped reset targets and decodes retained legacy arguments', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-reset-scope-'));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const documents = path.join(parent, 'Documents');
  await fs.mkdir(documents, { recursive: true });
  await fs.writeFile(path.join(documents, 'keep.txt'), 'keep');

  assert.throws(() => validateResetTarget(path.parse(process.cwd()).root), /Unsafe/);
  assert.throws(() => validateResetTarget(os.homedir()), /Unsafe/);
  await assert.rejects(removeLauncherData(documents), /scope is required/);
  await assert.rejects(removeLauncherData(documents, {
    expectedParentDirectory: parent,
    expectedBasename: APP_NAME
  }), /outside the protected application scope/);
  await assert.rejects(completeFactoryReset({
    active: true,
    parentProcessId: 9999,
    originalUserDataDirectory: documents
  }), /scope is required/);
  assert.equal(await fs.readFile(path.join(documents, 'keep.txt'), 'utf8'), 'keep');

  const encoded = Buffer.from(JSON.stringify(['.', '--safe']), 'utf8').toString('base64url');
  assert.deepEqual(decodeRelaunchArguments(encoded), ['.', '--safe']);
});

test('uses only a fixed-size nonce in the internal argument and blocks packaged path overrides', () => {
  const oldNonce = 'b'.repeat(64);
  const nonce = 'a'.repeat(64);
  const relaunchArguments = buildFactoryResetRelaunchArguments(
    ['.', '--safe', `${COMPLETE_FACTORY_RESET_SWITCH}${oldNonce}`],
    nonce
  );

  assert.deepEqual(relaunchArguments, ['.', '--safe', `${COMPLETE_FACTORY_RESET_SWITCH}${nonce}`]);
  assert.equal(parseCompleteFactoryResetArgument(relaunchArguments), nonce);
  assert.deepEqual(stripCompleteFactoryResetArguments(relaunchArguments), ['.', '--safe']);
  assert.equal(createCompleteFactoryResetArgument(nonce), `${COMPLETE_FACTORY_RESET_SWITCH}${nonce}`);
  assert.equal(parseCompleteFactoryResetArgument(['.', '--safe']), null);
  assert.throws(
    () => parseCompleteFactoryResetArgument([`${COMPLETE_FACTORY_RESET_SWITCH}42`]),
    /Invalid factory reset ticket/
  );
  assert.throws(
    () => parseCompleteFactoryResetArgument([
      `${COMPLETE_FACTORY_RESET_SWITCH}${nonce}`,
      `${COMPLETE_FACTORY_RESET_SWITCH}${oldNonce}`
    ]),
    /Invalid factory reset arguments/
  );
  assert.equal(hasUserDataDirectoryOverride(['--user-data-dir=C:\\Users\\User\\Documents']), true);
  assert.equal(hasForbiddenPackagedRuntimeSwitch(['--user-data-dir', 'C:\\Users\\User\\Documents']), true);
  assert.equal(hasForbiddenPackagedRuntimeSwitch(['--remote-debugging-port=9222']), true);
  assert.equal(hasForbiddenPackagedRuntimeSwitch(['--safe']), false);
});

test('creates, atomically consumes and cannot replay a private one-time reset ticket', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-reset-ticket-'));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const fixture = createAppFixture(parent);
  await fs.mkdir(fixture.paths.userData, { recursive: true });
  const nonce = 'c'.repeat(64);
  const now = 2_000_000;

  const ticket = await createFactoryResetTicket(fixture.electronApp, 9876, {
    nonce,
    now,
    temporaryParentDirectory: fixture.paths.temp
  });
  assert.equal(ticket.nonce, nonce);
  assert.equal(ticket.targetDirectory, path.resolve(fixture.paths.appData, APP_NAME));
  const storedTicket = JSON.parse(await fs.readFile(ticket.ticketPath, 'utf8'));
  assert.equal(storedTicket.schema, RESET_TICKET_SCHEMA);
  assert.equal(storedTicket.parentProcessId, 9876);
  assert.equal(storedTicket.targetDirectory, ticket.targetDirectory);

  const startup = prepareFactoryResetStartup(fixture.electronApp, [
    '.',
    '--safe',
    createCompleteFactoryResetArgument(nonce)
  ], {
    now: now + 500,
    temporaryParentDirectory: fixture.paths.temp
  });
  assert.equal(startup.active, true);
  assert.equal(startup.parentProcessId, 9876);
  assert.equal(startup.originalUserDataDirectory, path.resolve(fixture.paths.appData, APP_NAME));
  assert.equal(startup.expectedParentDirectory, path.resolve(fixture.paths.appData));
  assert.equal(startup.expectedBasename, APP_NAME);
  assert.deepEqual(startup.cleanRelaunchArguments, ['.', '--safe']);
  assert.deepEqual(fixture.changedPaths, [
    ['userData', startup.temporaryUserDataDirectory],
    ['sessionData', startup.temporarySessionDataDirectory]
  ]);
  await assert.rejects(fs.access(ticket.ticketPath));

  const replayFixture = createAppFixture(parent);
  assert.throws(() => prepareFactoryResetStartup(replayFixture.electronApp, [
    createCompleteFactoryResetArgument(nonce)
  ], {
    now: now + 600,
    temporaryParentDirectory: replayFixture.paths.temp
  }), /ENOENT/);
});

test('rejects userData override and a forged ticket targeting Documents without deleting it', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-reset-exploit-'));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const fixture = createAppFixture(parent);
  const stableTarget = path.join(fixture.paths.appData, APP_NAME);
  const documents = path.join(parent, 'Documents');
  await fs.mkdir(stableTarget, { recursive: true });
  await fs.mkdir(documents, { recursive: true });
  await fs.writeFile(path.join(documents, 'irreplaceable.txt'), 'keep');
  const now = 3_000_000;

  const validNonce = 'd'.repeat(64);
  const validTicket = await createFactoryResetTicket(fixture.electronApp, 1111, {
    nonce: validNonce,
    now,
    temporaryParentDirectory: fixture.paths.temp
  });
  assert.throws(() => prepareFactoryResetStartup(fixture.electronApp, [
    `--user-data-dir=${documents}`,
    createCompleteFactoryResetArgument(validNonce)
  ], {
    now: now + 100,
    temporaryParentDirectory: fixture.paths.temp
  }), /override is forbidden/);
  await fs.access(validTicket.ticketPath);
  await discardFactoryResetTicket(fixture.electronApp, validNonce, {
    temporaryParentDirectory: fixture.paths.temp
  });

  const forgedNonce = 'e'.repeat(64);
  const ticketDirectory = resolveFactoryResetTicketDirectory(fixture.electronApp, {
    temporaryParentDirectory: fixture.paths.temp
  });
  await fs.mkdir(ticketDirectory, { recursive: true });
  const forgedTicketPath = factoryResetTicketPath(fixture.electronApp, forgedNonce, {
    temporaryParentDirectory: fixture.paths.temp
  });
  await fs.writeFile(forgedTicketPath, JSON.stringify({
    schema: RESET_TICKET_SCHEMA,
    nonce: forgedNonce,
    parentProcessId: 2222,
    createdAt: now,
    expiresAt: now + RESET_TICKET_LIFETIME_MS,
    appDataDirectory: parent,
    appName: 'Documents',
    targetDirectory: documents
  }));
  assert.throws(() => prepareFactoryResetStartup(fixture.electronApp, [
    createCompleteFactoryResetArgument(forgedNonce)
  ], {
    now: now + 200,
    temporaryParentDirectory: fixture.paths.temp
  }), /outside the protected application scope/);

  assert.equal(await fs.readFile(path.join(documents, 'irreplaceable.txt'), 'utf8'), 'keep');
  await fs.access(stableTarget);
  await assert.rejects(fs.access(forgedTicketPath));
});

test('refuses ticket creation whenever Electron userData differs from stable appData plus app name', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-reset-overridden-'));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const documents = path.join(parent, 'Documents');
  const fixture = createAppFixture(parent, { userData: documents });
  await fs.mkdir(documents, { recursive: true });

  const stable = resolveStableLauncherDataDirectory(fixture.electronApp);
  assert.equal(stable.targetDirectory, path.resolve(fixture.paths.appData, APP_NAME));
  await assert.rejects(createFactoryResetTicket(fixture.electronApp, 3333, {
    nonce: 'f'.repeat(64),
    now: 4_000_000,
    temporaryParentDirectory: fixture.paths.temp
  }), /path was overridden/);
  await fs.access(documents);
});

test('atomically consumes an expired ticket but never reaches launcher data deletion', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-reset-expired-'));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const fixture = createAppFixture(parent);
  await fs.mkdir(fixture.paths.userData, { recursive: true });
  await fs.writeFile(path.join(fixture.paths.userData, 'settings.json'), '{}');
  const nonce = '1'.repeat(64);
  const now = 5_000_000;
  const ticket = await createFactoryResetTicket(fixture.electronApp, 4444, {
    nonce,
    now,
    ticketLifetimeMs: 1000,
    temporaryParentDirectory: fixture.paths.temp
  });

  assert.throws(() => prepareFactoryResetStartup(fixture.electronApp, [
    createCompleteFactoryResetArgument(nonce)
  ], {
    now: now + 1000,
    temporaryParentDirectory: fixture.paths.temp
  }), /expired/);
  assert.equal(await fs.readFile(path.join(fixture.paths.userData, 'settings.json'), 'utf8'), '{}');
  await assert.rejects(fs.access(ticket.ticketPath));
});

test('waits for the original process and deletes only the stable scoped launcher data', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-reset-complete-'));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const fixture = createAppFixture(parent);
  await fs.mkdir(fixture.paths.userData, { recursive: true });
  await fs.writeFile(path.join(fixture.paths.userData, 'settings.json'), '{}');
  const nonce = '2'.repeat(64);
  const now = 6_000_000;
  await createFactoryResetTicket(fixture.electronApp, 4321, {
    nonce,
    now,
    temporaryParentDirectory: fixture.paths.temp
  });
  const startup = prepareFactoryResetStartup(fixture.electronApp, [
    createCompleteFactoryResetArgument(nonce)
  ], {
    now: now + 100,
    temporaryParentDirectory: fixture.paths.temp
  });
  const events = [];

  const completed = await completeFactoryReset(startup, {
    timeoutMs: 250,
    waitForProcessExit: async (processId, timeoutMs) => {
      events.push(['wait', processId, timeoutMs]);
    }
  });

  assert.equal(completed, true);
  assert.deepEqual(events, [['wait', 4321, 250]]);
  await assert.rejects(fs.access(path.join(fixture.paths.appData, APP_NAME)));
  assert.equal(await completeFactoryReset({ active: false }), false);
});
