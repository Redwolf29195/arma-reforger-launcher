const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_SERVER_JOIN_FILE_BYTES,
  SERVER_JOIN_REQUEST_FILE,
  SERVER_JOIN_STATUS_FILE,
  cancelServerJoinRequest,
  createServerJoinMonitor,
  getServerJoinPaths,
  parseServerJoinRequest,
  parseServerJoinStatus,
  prepareServerJoinRequest,
  readBoundedText
} = require('../src/core/serverJoinBridge');

const TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER_TOKEN = 'fedcba9876543210fedcba9876543210';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withReferencedDeadline(operation, timeoutMs = 2000) {
  // Monitor polling intentionally uses unref'ed timers. A test awaiting only
  // a callback needs its own bounded handle to keep Node's event loop alive.
  let watchdog;
  try {
    return await Promise.race([
      operation,
      new Promise((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('Expected server-join callback was not received')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return predicate();
}

async function temporaryProfile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-server-join-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('prepares a one-shot request in the script profile with only nonce and normalized address', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const startedAt = Date.now() - 25;
  const result = await prepareServerJoinRequest(profileDirectory, '203.0.113.25:2002', {
    token: TOKEN.toUpperCase(),
    now: startedAt
  });

  assert.deepEqual(result, {
    token: TOKEN,
    address: '203.0.113.25:2002',
    profileDirectory: path.resolve(profileDirectory),
    requestPath: path.join(profileDirectory, 'profile', SERVER_JOIN_REQUEST_FILE),
    statusPath: path.join(profileDirectory, 'profile', SERVER_JOIN_STATUS_FILE),
    startedAt,
    arguments: ['-algzJoinRequest', TOKEN]
  });
  assert.equal(await fs.readFile(result.requestPath, 'utf8'), `${TOKEN}|203.0.113.25:2002\n`);
  assert.deepEqual(parseServerJoinRequest(await fs.readFile(result.requestPath, 'utf8')), {
    token: TOKEN,
    address: '203.0.113.25:2002'
  });
  assert.deepEqual(
    (await fs.readdir(path.dirname(result.requestPath))).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('generates a random 128-bit nonce and rejects injected addresses or invalid supplied nonces', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const first = await prepareServerJoinRequest(profileDirectory, '192.0.2.10:2001');
  const second = await prepareServerJoinRequest(profileDirectory, '192.0.2.10:2001');

  assert.match(first.token, /^[0-9a-f]{32}$/);
  assert.match(second.token, /^[0-9a-f]{32}$/);
  assert.notEqual(first.token, second.token);
  await assert.rejects(
    prepareServerJoinRequest(profileDirectory, '192.0.2.10:2001|password'),
    /(?:формате IP:порт|порт сервера)/
  );
  await assert.rejects(
    prepareServerJoinRequest(profileDirectory, '192.0.2.10:2001', { token: 'short' }),
    /одноразовый идентификатор/
  );
  await assert.rejects(
    prepareServerJoinRequest('', '192.0.2.10:2001', { token: TOKEN }),
    /папка профиля/
  );
});

test('cancellation removes only files that still belong to the matching nonce', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const paths = getServerJoinPaths(profileDirectory);
  await prepareServerJoinRequest(profileDirectory, '192.0.2.10:2001', { token: TOKEN });
  await fs.writeFile(paths.statusPath, `${TOKEN}|waiting|Ready\n`, 'utf8');

  const cancelled = await cancelServerJoinRequest({ profileDirectory, token: TOKEN });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.requestRemoved, true);
  assert.equal(cancelled.statusRemoved, true);
  await assert.rejects(fs.stat(paths.requestPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(paths.statusPath), { code: 'ENOENT' });

  await prepareServerJoinRequest(profileDirectory, '198.51.100.20:2002', { token: OTHER_TOKEN });
  await fs.writeFile(paths.statusPath, `${OTHER_TOKEN}|opening-browser|Opening\n`, 'utf8');
  const staleCancellation = await cancelServerJoinRequest(profileDirectory, TOKEN);
  assert.equal(staleCancellation.cancelled, false);
  assert.equal(staleCancellation.requestRemoved, false);
  assert.equal(staleCancellation.statusRemoved, false);
  assert.deepEqual(parseServerJoinRequest(await fs.readFile(paths.requestPath, 'utf8')), {
    token: OTHER_TOKEN,
    address: '198.51.100.20:2002'
  });
  assert.equal(parseServerJoinStatus(await fs.readFile(paths.statusPath, 'utf8')).token, OTHER_TOKEN);

  await fs.writeFile(paths.statusPath, `${TOKEN}|future-state|Cleanup still belongs to this nonce\n`, 'utf8');
  const partialCancellation = await cancelServerJoinRequest(profileDirectory, TOKEN);
  assert.equal(partialCancellation.requestRemoved, false);
  assert.equal(partialCancellation.statusRemoved, true);
  assert.equal((await fs.readFile(paths.requestPath, 'utf8')).startsWith(`${OTHER_TOKEN}|`), true);
});

test('bounded reads and cancellation never consume an oversized request file', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const { requestPath } = getServerJoinPaths(profileDirectory);
  await fs.mkdir(path.dirname(requestPath), { recursive: true });
  await fs.writeFile(requestPath, `${TOKEN}|192.0.2.10:2001|${'x'.repeat(MAX_SERVER_JOIN_FILE_BYTES)}\n`);

  await assert.rejects(
    readBoundedText(requestPath),
    (error) => error.code === 'SERVER_JOIN_FILE_TOO_LARGE'
  );
  const cancelled = await cancelServerJoinRequest(profileDirectory, TOKEN);
  assert.equal(cancelled.requestRemoved, false);
  assert.ok((await fs.stat(requestPath)).size > MAX_SERVER_JOIN_FILE_BYTES);
});

test('a concurrent cancellation can never remove the newer request in the same profile', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const { requestPath } = getServerJoinPaths(profileDirectory);

  for (let iteration = 0; iteration < 8; iteration += 1) {
    await prepareServerJoinRequest(profileDirectory, '192.0.2.10:2001', { token: TOKEN });
    const [cancelled, newest] = await Promise.all([
      cancelServerJoinRequest(profileDirectory, TOKEN),
      prepareServerJoinRequest(profileDirectory, '198.51.100.20:2002', { token: OTHER_TOKEN })
    ]);
    assert.equal(cancelled.requestRemoved, true);
    assert.equal(newest.token, OTHER_TOKEN);
    assert.deepEqual(parseServerJoinRequest(await fs.readFile(requestPath, 'utf8')), {
      token: OTHER_TOKEN,
      address: '198.51.100.20:2002'
    });

    const replacing = prepareServerJoinRequest(profileDirectory, '198.51.100.21:2003', { token: TOKEN });
    const staleCancellation = cancelServerJoinRequest(profileDirectory, OTHER_TOKEN);
    await Promise.all([replacing, staleCancellation]);
    assert.deepEqual(parseServerJoinRequest(await fs.readFile(requestPath, 'utf8')), {
      token: TOKEN,
      address: '198.51.100.21:2003'
    });
  }
});

test('timeout cleanup can preserve matching status diagnostics while removing the request', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const request = await prepareServerJoinRequest(profileDirectory, '192.0.2.10:2001', { token: TOKEN });
  await fs.writeFile(request.statusPath, `${TOKEN}|waiting|Native flow is still pending\n`, 'utf8');

  const result = await cancelServerJoinRequest({ ...request, preserveStatus: true });
  assert.equal(result.requestRemoved, true);
  assert.equal(result.statusRemoved, false);
  await assert.rejects(fs.stat(request.requestPath), { code: 'ENOENT' });
  assert.equal(
    await fs.readFile(request.statusPath, 'utf8'),
    `${TOKEN}|waiting|Native flow is still pending\n`
  );
});

test('status parser accepts only the bridge states and preserves safe pipe-separated messages', () => {
  assert.deepEqual(parseServerJoinStatus(`${TOKEN}|opening-browser|Opening|server browser\n`), {
    token: TOKEN,
    state: 'opening-browser',
    message: 'Opening|server browser'
  });
  assert.equal(parseServerJoinStatus(`${TOKEN}|connected|Unsupported state`), null);
  assert.equal(parseServerJoinStatus(`${TOKEN}|waiting|First\n${TOKEN}|joining|Second`), null);
  assert.equal(parseServerJoinStatus(`invalid|waiting|Message`), null);
});

test('monitor ignores stale and foreign statuses, reports changes, and stops on joining', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const { statusPath } = getServerJoinPaths(profileDirectory);
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  const startedAt = Date.now();
  await fs.writeFile(statusPath, `${TOKEN}|waiting|Stale\n`, 'utf8');
  const oldDate = new Date(startedAt - 30_000);
  await fs.utimes(statusPath, oldDate, oldDate);

  const statuses = [];
  const terminals = [];
  const errors = [];
  let timeouts = 0;
  const terminal = new Promise((resolve) => {
    createServerJoinMonitor({
      statusPath,
      token: TOKEN,
      startedAt,
      intervalMs: 10,
      timeoutMs: 1500,
      onStatus: (status) => statuses.push(status),
      onTerminal: (status) => {
        terminals.push(status);
        resolve(status);
      },
      onTimeout: () => { timeouts += 1; },
      onError: (error) => errors.push(error)
    });
  });

  await delay(40);
  assert.equal(statuses.length, 0);
  await fs.writeFile(statusPath, `${OTHER_TOKEN}|waiting|Foreign\n`, 'utf8');
  await delay(40);
  assert.equal(statuses.length, 0);

  await fs.writeFile(statusPath, `${TOKEN}|waiting|Bridge ready\n`, 'utf8');
  assert.equal(await waitFor(() => statuses.length === 1), true);
  await fs.writeFile(statusPath, `${TOKEN}|waiting|Bridge ready\n`, 'utf8');
  await delay(40);
  assert.equal(statuses.length, 1);

  await fs.writeFile(statusPath, `${TOKEN}|opening-browser|Opening server browser\n`, 'utf8');
  assert.equal(await waitFor(() => statuses.length === 2), true);
  await fs.writeFile(statusPath, `${TOKEN}|joining|Join request handed off\n`, 'utf8');
  const finalStatus = await withReferencedDeadline(terminal);
  assert.equal(finalStatus.state, 'joining');
  assert.deepEqual(statuses.map((status) => status.state), ['waiting', 'opening-browser', 'joining']);
  assert.equal(terminals.length, 1);

  await fs.writeFile(statusPath, `${TOKEN}|error|Late error\n`, 'utf8');
  await delay(50);
  assert.equal(statuses.length, 3);
  assert.equal(terminals.length, 1);
  assert.equal(timeouts, 0);
  assert.deepEqual(errors, []);
});

test('an explicit bridge error is terminal but does not become a fabricated game failure', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const { statusPath } = getServerJoinPaths(profileDirectory);
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  const startedAt = Date.now();
  const statuses = [];
  let timeoutCount = 0;

  const terminal = new Promise((resolve) => {
    createServerJoinMonitor({
      statusPath,
      token: TOKEN,
      startedAt,
      intervalMs: 10,
      timeoutMs: 1000,
      onStatus: (status) => statuses.push(status),
      onTerminal: resolve,
      onTimeout: () => { timeoutCount += 1; }
    });
  });
  await fs.writeFile(statusPath, `${TOKEN}|error|Native browser unavailable\n`, 'utf8');
  const result = await withReferencedDeadline(terminal);

  assert.equal(result.state, 'error');
  assert.equal(result.message, 'Native browser unavailable');
  assert.equal(statuses.length, 1);
  assert.equal(timeoutCount, 0);
});

test('missing, malformed, foreign, and oversized status files only end in a neutral timeout', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const { statusPath } = getServerJoinPaths(profileDirectory);
  const statuses = [];
  const terminals = [];
  const errors = [];
  let timeouts = 0;
  createServerJoinMonitor({
    statusPath,
    token: TOKEN,
    startedAt: Date.now(),
    intervalMs: 10,
    timeoutMs: 140,
    onStatus: (status) => statuses.push(status),
    onTerminal: (status) => terminals.push(status),
    onTimeout: () => { timeouts += 1; },
    onError: (error) => errors.push(error)
  });

  await delay(25);
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, 'malformed\n', 'utf8');
  await delay(25);
  await fs.writeFile(statusPath, `${OTHER_TOKEN}|joining|Not this request\n`, 'utf8');
  await delay(25);
  await fs.writeFile(statusPath, 'x'.repeat(MAX_SERVER_JOIN_FILE_BYTES + 1), 'utf8');
  await delay(120);

  assert.deepEqual(statuses, []);
  assert.deepEqual(terminals, []);
  assert.equal(timeouts, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'SERVER_JOIN_FILE_TOO_LARGE');
});

test('stopping the monitor suppresses late status and timeout callbacks', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const { statusPath } = getServerJoinPaths(profileDirectory);
  let callbacks = 0;
  const stop = createServerJoinMonitor({
    statusPath,
    token: TOKEN,
    intervalMs: 10,
    timeoutMs: 60,
    onStatus: () => { callbacks += 1; },
    onTerminal: () => { callbacks += 1; },
    onTimeout: () => { callbacks += 1; },
    onError: () => { callbacks += 1; }
  });
  stop();
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, `${TOKEN}|joining|Late\n`, 'utf8');
  await delay(100);
  assert.equal(callbacks, 0);
});

test('stopping from onStatus suppresses onTerminal for the same observation', async (t) => {
  const profileDirectory = await temporaryProfile(t);
  const { statusPath } = getServerJoinPaths(profileDirectory);
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  let statusCount = 0;
  let terminalCount = 0;
  let stop;
  stop = createServerJoinMonitor({
    statusPath,
    token: TOKEN,
    startedAt: Date.now(),
    intervalMs: 10,
    timeoutMs: 500,
    onStatus: () => {
      statusCount += 1;
      stop();
    },
    onTerminal: () => { terminalCount += 1; }
  });
  await fs.writeFile(statusPath, `${TOKEN}|joining|Handoff\n`, 'utf8');
  assert.equal(await waitFor(() => statusCount === 1), true);
  await delay(40);
  assert.equal(terminalCount, 0);
});
