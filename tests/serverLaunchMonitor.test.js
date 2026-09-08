const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_LOG_READ_BYTES,
  createServerLaunchMonitor,
  inspectServerLaunchLogs,
  parseServerLaunchFailure,
  readLogSample,
  resolveServerLogsDirectories
} = require('../src/core/serverLaunchMonitor');

const SERVER_ADDRESS = '45.143.199.198:2001';

function launchLog(lines, serverAddress = SERVER_ADDRESS) {
  return [
    'Log test-session/console.log started at 2026-09-04 20:33:21',
    `20:33:21.176 ENGINE       : CLI Params: -noSplash -client ${serverAddress} `,
    ...lines
  ].join('\n');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function temporaryLogs(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-server-monitor-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('parses the real server-launch failure signatures and prefers the specific reason', () => {
  const completeFailure = launchLog([
    '20:33:30.707 ENGINE       : Game successfully created.',
    '20:34:01.613 RPL       (E): ClientImpl event: handshake timeout (identity=0x00000000)',
    `20:34:01.613 NETWORK   (E): Unable to connect as client to '${SERVER_ADDRESS}'`,
    '20:34:01.829 ENGINE    (E): Unable to initialize the game'
  ]);
  assert.equal(parseServerLaunchFailure(completeFailure, SERVER_ADDRESS), 'handshake-timeout');

  const connectionFailure = launchLog([
    `20:34:01.613 NETWORK   (E): Unable to connect as client to '${SERVER_ADDRESS}'`
  ]);
  assert.equal(parseServerLaunchFailure(connectionFailure, SERVER_ADDRESS), 'connection-failed');

  const initializationFailure = launchLog([
    '20:33:30.707 ENGINE       : Game successfully created.',
    '20:34:01.829 ENGINE    (E): Unable to initialize the game'
  ]);
  assert.equal(parseServerLaunchFailure(initializationFailure, SERVER_ADDRESS), 'initialization-failed');
});

test('Linux default log discovery uses native Proton profile directories', async () => {
  const calls = [];
  const directories = await resolveServerLogsDirectories({
    platform: 'linux', gameExecutable: '/mnt/Steam/steamapps/common/Arma Reforger/ArmaReforgerSteam.exe',
    findProfileDirectories: async (...args) => {
      calls.push(args);
      return ['/mnt/Steam/steamapps/compatdata/1874880/pfx/drive_c/users/steamuser/Documents/My Games/ArmaReforger'];
    }
  });
  assert.deepEqual(directories, ['/mnt/Steam/steamapps/compatdata/1874880/pfx/drive_c/users/steamuser/Documents/My Games/ArmaReforger/logs']);
  assert.equal(calls[0][0], '/mnt/Steam/steamapps/common/Arma Reforger/ArmaReforgerSteam.exe');
  assert.equal(directories.some((directory) => directory.startsWith('Z:')), false);
});

test('an explicit native logs directory takes precedence over Proton discovery', async () => {
  assert.deepEqual(await resolveServerLogsDirectories({
    platform: 'linux', logsDirectory: '/home/user/Launcher Profile/logs/server-join',
    findProfileDirectories: () => { throw new Error('Do not scan unrelated default profiles'); }
  }), ['/home/user/Launcher Profile/logs/server-join']);
});

test('Linux discovery without an initialized Proton prefix does not scan a Windows fallback', async () => {
  assert.deepEqual(await resolveServerLogsDirectories({ platform: 'linux', findProfileDirectories: async () => [] }), []);
});

test('does not treat game creation as success or inspect a different client endpoint', () => {
  assert.equal(parseServerLaunchFailure(launchLog([
    '20:33:30.707 ENGINE       : Game successfully created.'
  ]), SERVER_ADDRESS), null);

  assert.equal(parseServerLaunchFailure(launchLog([
    '20:34:01.613 RPL       (E): ClientImpl event: handshake timeout (identity=0x00000000)',
    '20:34:01.829 ENGINE    (E): Unable to initialize the game'
  ], '45.143.199.198:2143'), SERVER_ADDRESS), null);
});

test('does not attribute a later connection failure for another endpoint to the launched server', () => {
  const otherAddress = '45.143.199.198:2143';
  const laterFailure = launchLog([
    '20:33:30.707 ENGINE       : Game successfully created.',
    '20:33:31.577 NETWORK      : Starting RPL client, number of addresses to try connecting to: 1',
    '20:35:41.613 RPL       (E): ClientImpl event: handshake timeout (identity=0x00000000)',
    `20:35:41.613 NETWORK   (E): Unable to connect as client to '${otherAddress}'`,
    '20:35:41.829 ENGINE    (E): Unable to initialize the game'
  ]);
  assert.equal(parseServerLaunchFailure(laterFailure, SERVER_ADDRESS), null);

  const incompleteMatchingFailure = launchLog([
    '20:34:01.613 RPL       (E): ClientImpl event: handshake timeout (identity=0x00000000)'
  ]);
  assert.equal(parseServerLaunchFailure(incompleteMatchingFailure, SERVER_ADDRESS), null);
  assert.equal(parseServerLaunchFailure(`${incompleteMatchingFailure}\n`
    + `20:34:01.613 NETWORK   (E): Unable to connect as client to '${SERVER_ADDRESS}'`, SERVER_ADDRESS),
  'handshake-timeout');
});

test('reads a bounded split sample with CLI parameters from the header and failure from the tail', async (t) => {
  const logsDirectory = await temporaryLogs(t);
  const logPath = path.join(logsDirectory, 'console.log');
  const header = launchLog(['20:33:30.707 ENGINE       : Game successfully created.']);
  const filler = 'x'.repeat(MAX_LOG_READ_BYTES + 128 * 1024);
  const failure = [
    '20:34:01.613 RPL       (E): ClientImpl event: handshake timeout (identity=0x00000000)',
    `20:34:01.613 NETWORK   (E): Unable to connect as client to '${SERVER_ADDRESS}'`
  ].join('\n');
  await fs.writeFile(logPath, `${header}\n${filler}\n${failure}`);

  const sample = await readLogSample(logPath);
  assert.ok(sample.size > MAX_LOG_READ_BYTES);
  assert.ok(sample.bytesRead <= MAX_LOG_READ_BYTES);
  assert.match(sample.text, /CLI Params: -noSplash -client 45\.143\.199\.198:2001/);
  assert.match(sample.text, /handshake timeout/);
  assert.equal(parseServerLaunchFailure(sample.text, SERVER_ADDRESS), 'handshake-timeout');
});

test('ignores old logs and a different endpoint, then reports a matching nested session once', async (t) => {
  const logsDirectory = await temporaryLogs(t);
  const oldDirectory = path.join(logsDirectory, 'logs_old');
  const wrongDirectory = path.join(logsDirectory, 'logs_wrong');
  const matchingDirectory = path.join(logsDirectory, 'recent', 'logs_matching');
  await Promise.all([
    fs.mkdir(oldDirectory, { recursive: true }),
    fs.mkdir(wrongDirectory, { recursive: true }),
    fs.mkdir(matchingDirectory, { recursive: true })
  ]);

  const oldLogPath = path.join(oldDirectory, 'console.log');
  await fs.writeFile(oldLogPath, launchLog([
    '20:34:01.613 RPL       (E): ClientImpl event: handshake timeout (identity=0x00000000)'
  ]));
  const oldDate = new Date(Date.now() - 60_000);
  await fs.utimes(oldLogPath, oldDate, oldDate);

  await fs.writeFile(path.join(wrongDirectory, 'console.log'), launchLog([
    '20:34:01.613 RPL       (E): ClientImpl event: handshake timeout (identity=0x00000000)'
  ], '45.143.199.198:2143'));

  const startedAt = Date.now();
  await delay(5);
  const matchingLogPath = path.join(matchingDirectory, 'console.log');
  await fs.writeFile(matchingLogPath, launchLog([
    '20:33:30.707 ENGINE       : Game successfully created.',
    '20:34:01.613 RPL       (E): ClientImpl event: handshake timeout (identity=0x00000000)',
    `20:34:01.613 NETWORK   (E): Unable to connect as client to '${SERVER_ADDRESS}'`,
    '20:34:01.829 ENGINE    (E): Unable to initialize the game'
  ]));

  const failures = [];
  const errors = [];
  const failure = new Promise((resolve, reject) => {
    // The production monitor intentionally unrefs its polling timer. A bounded
    // referenced test timer keeps this assertion alive without changing that.
    const timeout = setTimeout(() => reject(new Error('Expected matching launch failure was not reported')), 1500);
    t.after(() => clearTimeout(timeout));
    createServerLaunchMonitor({
      logsDirectory,
      serverAddress: SERVER_ADDRESS,
      startedAt,
      intervalMs: 10,
      timeoutMs: 1000,
      onFailure: (details) => {
        clearTimeout(timeout);
        failures.push(details);
        resolve(details);
      },
      onError: (error) => errors.push(error)
    });
  });

  const details = await failure;
  assert.deepEqual(details, {
    reason: 'handshake-timeout',
    logPath: matchingLogPath
  });
  await delay(60);
  assert.equal(failures.length, 1);
  assert.deepEqual(errors, []);
});

test('returns no failure for a pre-launch log even when it matches the endpoint', async (t) => {
  const logsDirectory = await temporaryLogs(t);
  const sessionDirectory = path.join(logsDirectory, 'logs_before_launch');
  await fs.mkdir(sessionDirectory);
  const logPath = path.join(sessionDirectory, 'console.log');
  await fs.writeFile(logPath, launchLog([
    `20:34:01.613 NETWORK   (E): Unable to connect as client to '${SERVER_ADDRESS}'`
  ]));
  const oldDate = new Date(Date.now() - 30_000);
  await fs.utimes(logPath, oldDate, oldDate);

  const result = await inspectServerLaunchLogs({
    logsDirectory,
    serverAddress: SERVER_ADDRESS,
    startedAt: Date.now()
  });
  assert.equal(result.failure, null);
  assert.deepEqual(result.errors, []);
});

test('ignores an old UTC log session even when a sync service refreshes its mtime', async (t) => {
  const logsDirectory = await temporaryLogs(t);
  const sessionDirectory = path.join(logsDirectory, 'logs_synced_later');
  await fs.mkdir(sessionDirectory);
  const logPath = path.join(sessionDirectory, 'console.log');
  const startedAt = Date.now();
  const oldUtcTimestamp = new Date(startedAt - 60_000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
  const contents = launchLog([
    '20:34:01.613 RPL       (E): ClientImpl event: handshake timeout (identity=0x00000000)',
    `20:34:01.613 NETWORK   (E): Unable to connect as client to '${SERVER_ADDRESS}'`
  ]).replace(
    /^Log[^\n]+/,
    `Log test-session/console.log started at 2026-09-04 20:33:21 (${oldUtcTimestamp} UTC)`
  );
  await fs.writeFile(logPath, contents);
  const refreshedMtime = new Date(startedAt + 5000);
  await fs.utimes(logPath, refreshedMtime, refreshedMtime);

  const result = await inspectServerLaunchLogs({
    logsDirectory,
    serverAddress: SERVER_ADDRESS,
    startedAt
  });
  assert.equal(result.failure, null);
  assert.deepEqual(result.errors, []);
});

test('missing logs, observation timeout and an immediate stop do not report a failure', async (t) => {
  const logsDirectory = await temporaryLogs(t);
  const missingDirectory = path.join(logsDirectory, 'not-created');
  let failures = 0;
  let errors = 0;
  createServerLaunchMonitor({
    logsDirectory: missingDirectory,
    serverAddress: SERVER_ADDRESS,
    intervalMs: 10,
    timeoutMs: 40,
    onFailure: () => { failures += 1; },
    onError: () => { errors += 1; }
  });

  const liveLogPath = path.join(logsDirectory, 'console.log');
  await fs.writeFile(liveLogPath, launchLog([
    '20:34:01.613 RPL       (E): ClientImpl event: handshake timeout (identity=0x00000000)'
  ]));
  const stop = createServerLaunchMonitor({
    logsDirectory,
    serverAddress: SERVER_ADDRESS,
    startedAt: Date.now() - 1000,
    intervalMs: 10,
    timeoutMs: 1000,
    onFailure: () => { failures += 1; },
    onError: () => { errors += 1; }
  });
  stop();

  await delay(100);
  assert.equal(failures, 0);
  assert.equal(errors, 0);
});
