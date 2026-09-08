const test = require('node:test');
const assert = require('node:assert/strict');

const { createServerConnectionController } = require('../src/core/serverConnectionController');

const SERVER_ID = '33669340';
const LIVE_ADDRESS = 'live.example.test:2002';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function knownPayload(overrides = {}) {
  return {
    serverId: SERVER_ID,
    name: 'Cached server',
    address: 'cached.example.test:2001',
    mods: [{ modId: '1337C0DE5DABBEEF', name: 'Cached mod', status: 'ready' }],
    ...overrides
  };
}

function liveDetails(overrides = {}) {
  const serverOverrides = overrides.server || {};
  return {
    server: {
      id: SERVER_ID,
      name: 'Live server',
      address: LIVE_ADDRESS,
      status: 'online',
      lastUpdated: new Date().toISOString(),
      playerCount: 42,
      playerLimit: 128,
      queueCount: 0,
      ...serverOverrides
    },
    mods: overrides.mods || [
      { modId: '595F2BF2F44836FB', name: 'Live mod', status: 'missing' }
    ]
  };
}

function createHarness(overrides = {}) {
  const calls = {
    cancelLaunch: [],
    assessMods: [],
    ensureGameClosed: 0,
    fetchDetails: [],
    launch: [],
    log: [],
    monitor: [],
    resolveGame: 0,
    savePreset: []
  };
  const implementations = {
    cancelLaunch: async () => {},
    assessMods: (mods) => mods,
    ensureGameClosed: async () => {},
    fetchDetails: async () => liveDetails(),
    launch: async () => ({
      cancelled: false,
      method: 'exact',
      arguments: ['-noSplash', '-client', LIVE_ADDRESS]
    }),
    monitor: () => {},
    resolveGame: async () => ({ executable: 'ArmaReforgerSteam.exe' }),
    savePreset: async () => ({ preset: null, presets: [], created: false }),
    ...overrides
  };

  const dependencies = {
    async cancelLaunch(launch) {
      calls.cancelLaunch.push(launch);
      return implementations.cancelLaunch(launch);
    },
    assessMods(mods) {
      calls.assessMods.push(mods);
      return implementations.assessMods(mods);
    },
    async ensureGameClosed() {
      calls.ensureGameClosed += 1;
      return implementations.ensureGameClosed();
    },
    async fetchDetails(...args) {
      calls.fetchDetails.push(args);
      return implementations.fetchDetails(...args);
    },
    async launch(...args) {
      calls.launch.push(args);
      return implementations.launch(...args);
    },
    log(message) {
      calls.log.push(message);
    },
    monitor(...args) {
      calls.monitor.push(args);
      return implementations.monitor(...args);
    },
    async resolveGame() {
      calls.resolveGame += 1;
      return implementations.resolveGame();
    },
    async savePreset(...args) {
      calls.savePreset.push(args);
      return implementations.savePreset(...args);
    }
  };

  return {
    calls,
    controller: createServerConnectionController(dependencies)
  };
}

test('passes the freshly verified endpoint and assessed mod pack to launch', async () => {
  const details = liveDetails({
    server: { address: '203.0.113.25:2007' },
    mods: [{ modId: '595F2BF2F44836FB', name: 'Fresh mod', status: 'missing' }]
  });
  const { calls, controller } = createHarness({
    fetchDetails: async () => details,
    assessMods: (mods) => mods.map((mod) => ({ ...mod, name: `${mod.name} assessed` }))
  });

  const result = await controller.connect(knownPayload());

  assert.equal(result.launched, true);
  assert.equal(result.catalogVerified, true);
  assert.equal(result.server.address, '203.0.113.25:2007');
  assert.deepEqual(result.mods.map((mod) => mod.name), ['Fresh mod assessed']);
  assert.equal(calls.fetchDetails.length, 1);
  assert.deepEqual(calls.fetchDetails[0], [SERVER_ID, { refresh: true, requireLive: true }]);
  assert.equal(calls.assessMods.length, 1);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0][1].server.address, '203.0.113.25:2007');
  assert.equal(calls.monitor.length, 1);
  assert.equal(calls.monitor[0][0].address, '203.0.113.25:2007');
  assert.equal(typeof calls.monitor[0][1], 'number');
});

test('requires an explicit retry before falling back after a catalog failure', async () => {
  const { calls, controller } = createHarness({
    fetchDetails: async () => {
      throw new Error('temporary HTTP 503');
    }
  });
  const payload = knownPayload();

  const warning = await controller.connect(payload);
  assert.equal(warning.launched, false);
  assert.equal(warning.reason, 'server-unavailable');
  assert.equal(warning.availability, 'catalog-unavailable');
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.resolveGame, 0);
  assert.equal(calls.monitor.length, 0);

  const result = await controller.connect({ ...payload, allowUnverified: true });
  assert.equal(result.launched, true);
  assert.equal(result.catalogVerified, false);
  assert.equal(calls.fetchDetails.length, 2);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0][1].server.address, payload.address);
  assert.equal(calls.monitor.length, 1);
  assert.match(calls.log[0], /temporary HTTP 503/);
});

test('reports a recent offline server and launches only after the user override', async () => {
  const offline = liveDetails({
    server: {
      address: '198.51.100.20:2001',
      status: 'offline',
      lastUpdated: new Date().toISOString(),
      playerCount: 0
    }
  });
  const { calls, controller } = createHarness({ fetchDetails: async () => offline });
  const payload = knownPayload();

  const warning = await controller.connect(payload);
  assert.equal(warning.launched, false);
  assert.equal(warning.reason, 'server-unavailable');
  assert.equal(warning.availability, 'offline');
  assert.equal(warning.server.address, '198.51.100.20:2001');
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.monitor.length, 0);

  const result = await controller.connect({ ...payload, allowUnverified: true });
  assert.equal(result.launched, true);
  assert.equal(result.catalogVerified, true);
  assert.equal(result.server.address, '198.51.100.20:2001');
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.monitor.length, 1);
});

test('cancelling while the catalog refresh is pending prevents every launch step', async () => {
  const refreshStarted = deferred();
  const refresh = deferred();
  const { calls, controller } = createHarness({
    fetchDetails: async () => {
      refreshStarted.resolve();
      return refresh.promise;
    }
  });

  const connection = controller.connect(knownPayload());
  await refreshStarted.promise;
  assert.deepEqual(controller.cancel(), { cancelled: true });
  refresh.resolve(liveDetails());

  assert.deepEqual(await connection, { launched: false, reason: 'cancelled' });
  assert.equal(calls.resolveGame, 0);
  assert.equal(calls.ensureGameClosed, 0);
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.monitor.length, 0);
});

test('coalesces synchronous connection requests into one check and one launch', async () => {
  const { calls, controller } = createHarness();

  const first = controller.connect(knownPayload({ name: 'First request' }));
  const second = controller.connect(knownPayload({ name: 'Latest request' }));
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, { launched: false, reason: 'cancelled' });
  assert.equal(secondResult.launched, true);
  assert.equal(calls.fetchDetails.length, 1);
  assert.equal(calls.resolveGame, 1);
  assert.equal(calls.ensureGameClosed, 1);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.monitor.length, 1);
});

test('exposes the cancellation guard to an in-progress launch and does not monitor it', async () => {
  const launchStarted = deferred();
  const releaseLaunch = deferred();
  let cancellationGuard;
  const { calls, controller } = createHarness({
    launch: async (_game, _connection, isCancelled) => {
      cancellationGuard = isCancelled;
      launchStarted.resolve();
      await releaseLaunch.promise;
      return {
        cancelled: isCancelled(),
        method: 'exact',
        arguments: ['-noSplash', '-client', '127.0.0.1:2001']
      };
    }
  });

  const connection = controller.connect({ address: '127.0.0.1:2001' });
  await launchStarted.promise;
  assert.equal(cancellationGuard(), false);
  controller.cancel();
  assert.equal(cancellationGuard(), true);
  releaseLaunch.resolve();

  assert.deepEqual(await connection, { launched: false, reason: 'cancelled' });
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.monitor.length, 0);
});

test('never lets allowUnverified override a changed catalog identity', async () => {
  const wrongServer = liveDetails({ server: { id: '33669341' } });
  const { calls, controller } = createHarness({ fetchDetails: async () => wrongServer });

  await assert.rejects(
    controller.connect(knownPayload({ allowUnverified: true })),
    /Каталог серверов вернул другой сервер/
  );
  assert.equal(calls.resolveGame, 0);
  assert.equal(calls.ensureGameClosed, 0);
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.monitor.length, 0);

  const mismatch = new Error('Catalog returned a different server');
  mismatch.code = 'SERVER_CATALOG_ID_MISMATCH';
  const rejectedHarness = createHarness({
    fetchDetails: async () => {
      throw mismatch;
    }
  });
  await assert.rejects(
    rejectedHarness.controller.connect(knownPayload({ allowUnverified: true })),
    (error) => error === mismatch
  );
  assert.equal(rejectedHarness.calls.resolveGame, 0);
  assert.equal(rejectedHarness.calls.launch.length, 0);
  assert.equal(rejectedHarness.calls.monitor.length, 0);
});

test('accepts an online catalog snapshot that is two hours old', async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const details = liveDetails({ server: { lastUpdated: twoHoursAgo } });
  const { calls, controller } = createHarness({ fetchDetails: async () => details });

  const result = await controller.connect(knownPayload());

  assert.equal(result.launched, true);
  assert.equal(result.catalogVerified, true);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.monitor.length, 1);
});

test('starts monitoring only after launch reports an actual process start', async () => {
  let attempt = 0;
  const { calls, controller } = createHarness({
    launch: async () => {
      attempt += 1;
      if (attempt === 1) return { cancelled: true };
      return {
        cancelled: false,
        method: 'exact',
        arguments: ['-noSplash', '-client', '127.0.0.2:2001']
      };
    }
  });

  const cancelled = await controller.connect({ address: '127.0.0.1:2001' });
  assert.deepEqual(cancelled, { launched: false, reason: 'cancelled' });
  assert.equal(calls.monitor.length, 0);

  const launched = await controller.connect({ address: '127.0.0.2:2001' });
  assert.equal(launched.launched, true);
  assert.equal(calls.monitor.length, 1);
  assert.equal(calls.monitor[0][0].address, '127.0.0.2:2001');
});

test('native menu handoff carries private monitoring context without claiming connection success', async () => {
  const joinRequest = { token: 'a'.repeat(32), statusPath: 'status' };
  const { controller, calls } = createHarness({
    launch: async () => ({
      method: 'steam-client', connectionMode: 'native-menu', connectionAttempted: false,
      arguments: ['-world', 'worlds/MainMenuWorld/MainMenuWorld.ent'], joinRequest
    })
  });
  const result = await controller.connect(knownPayload());
  assert.equal(result.launched, true);
  assert.equal(result.connectionMode, 'native-menu');
  assert.equal(result.connectionAttempted, false);
  assert.equal(result.joinRequest, undefined);
  assert.equal(calls.monitor[0][2].joinRequest, joinRequest);
});

test('cancellation at launch promise completion cleans the handoff and skips stale monitoring and preset saving', async () => {
  const started = deferred();
  const finished = deferred();
  const launch = { method: 'steam-client', joinRequest: { token: 'c'.repeat(32) } };
  const { controller, calls } = createHarness({
    launch: async () => { started.resolve(); return finished.promise; }
  });
  const connection = controller.connect(knownPayload({ savePreset: true }));
  await started.promise;
  controller.cancel();
  finished.resolve(launch);
  assert.deepEqual(await connection, { launched: false, reason: 'cancelled' });
  assert.deepEqual(calls.cancelLaunch, [launch]);
  assert.deepEqual(calls.monitor, []);
  assert.deepEqual(calls.savePreset, []);
});

test('a burst of 250 connections starts only the most recent request', async () => {
  const { controller, calls } = createHarness();
  const results = await Promise.all(Array.from({ length: 250 }, (_unused, index) =>
    controller.connect({ address: `127.0.0.1:${2000 + index}` })));
  assert.equal(results.filter((result) => result.launched).length, 1);
  assert.equal(results.at(-1).server.address, '127.0.0.1:2249');
  assert.equal(calls.resolveGame, 1);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.monitor.length, 1);
});

test('preset save failure after launch returns a warning without reporting a failed launch or fake preset', async () => {
  const { controller, calls } = createHarness({
    savePreset: async () => { throw new Error('EACCES test preset file'); }
  });
  const result = await controller.connect(knownPayload({ savePreset: true }));
  assert.equal(result.launched, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.presetSaveFailed, true);
  assert.equal(result.preset, null);
  assert.equal(result.presets, null);
  assert.equal(result.presetCreated, false);
  assert.equal(JSON.stringify(result).includes('EACCES'), false);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.monitor.length, 1);
  assert.match(calls.log.at(-1), /preset could not be saved.*EACCES/);
});

test('cancellation while saving a preset never turns an accepted launch into a retry result', async () => {
  for (const failSave of [false, true]) {
    const started = deferred();
    const finished = deferred();
    const preset = { id: 'saved-preset', name: 'Server preset' };
    const { controller, calls } = createHarness({
      savePreset: async () => { started.resolve(); return finished.promise; }
    });
    const connection = controller.connect(knownPayload({ savePreset: true }));
    await started.promise;
    controller.cancel();
    if (failSave) finished.reject(new Error('disk full'));
    else finished.resolve({ preset, presets: [preset], created: true });
    const result = await connection;
    assert.equal(result.launched, true);
    assert.equal(result.reason, undefined);
    assert.equal(result.presetSaveFailed, failSave);
    assert.equal(result.preset, failSave ? null : preset);
    assert.equal(result.presetCreated, !failSave);
    assert.equal(calls.launch.length, 1);
    assert.equal(calls.monitor.length, 1);
    assert.equal(calls.cancelLaunch.length, 0);
  }
});
