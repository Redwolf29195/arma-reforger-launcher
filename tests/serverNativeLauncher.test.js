const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeServerLauncher, resolveNativeServerAddress } = require('../src/core/serverNativeLauncher');

function harness(overrides = {}) {
  const calls = { mkdir: [], prepare: [], cancel: [], steam: [] };
  const request = { token: 'a'.repeat(32), requestPath: 'request', statusPath: 'status', startedAt: Date.now() };
  const dependencies = {
    mkdir: async (directory) => calls.mkdir.push(directory),
    prepareBridge: async () => ({ addonsDirectory: 'B:\\Profile\\profile\\addons' }),
    prepareRequest: async (...args) => { calls.prepare.push(args); return request; },
    cancelRequest: async (value) => calls.cancel.push(value),
    launchThroughSteam: async (...args) => { calls.steam.push(args); return { method: 'steam-client' }; },
    ...overrides
  };
  return { calls, request, launch: createNativeServerLauncher(dependencies) };
}

const game = {
  gameExecutable: 'B:\\Game\\ArmaReforgerSteam.exe',
  settings: { profileDirectory: 'B:\\Profile', downloadRoot: 'B:\\Mods', additionalArguments: '-client evil' }
};
const connection = { server: { address: '151.80.33.213:2002' } };

test('native server launch prepares the exact endpoint and starts Steam without early RPL', async () => {
  const { launch, calls, request } = harness();
  const result = await launch(game, connection);
  assert.deepEqual(calls.prepare, [[game.settings.profileDirectory, connection.server.address]]);
  assert.equal(calls.steam.length, 1);
  assert.equal(calls.steam[0][0], game.gameExecutable);
  assert.equal(calls.steam[0][1].includes('-client'), false);
  assert.equal(calls.steam[0][1].includes('evil'), false);
  assert.equal(calls.steam[0][1].at(-1), request.token);
  assert.equal(result.connectionMode, 'native-menu');
  assert.equal(result.connectionAttempted, false);
  assert.equal(result.joinRequest, request);
  assert.equal(calls.cancel.length, 0);
});

test('already cancelled native launch does not prepare a profile or start Steam', async () => {
  const { launch, calls } = harness();
  assert.deepEqual(await launch(game, connection, () => true), { cancelled: true });
  assert.deepEqual(calls, { mkdir: [], prepare: [], cancel: [], steam: [] });
});

test('cancellation after preparing the request removes only that request and never starts Steam', async () => {
  let isCancelled = false;
  const request = { token: 'b'.repeat(32) };
  const { launch, calls } = harness({
    prepareRequest: async () => { isCancelled = true; return request; }
  });
  assert.deepEqual(await launch(game, connection, () => isCancelled), { cancelled: true });
  assert.deepEqual(calls.cancel, [request]);
  assert.equal(calls.steam.length, 0);
});

test('Steam launch failure cleans the one-shot request and preserves the original error', async () => {
  const error = new Error('Steam did not start');
  const { launch, calls, request } = harness({ launchThroughSteam: async () => { throw error; } });
  await assert.rejects(launch(game, connection), (failure) => failure === error);
  assert.deepEqual(calls.cancel, [request]);
});

test('Steam cancellation cleans the request, but never claims a connection was attempted', async () => {
  const { launch, calls, request } = harness({ launchThroughSteam: async () => ({ cancelled: true }) });
  assert.deepEqual(await launch(game, connection), { cancelled: true });
  assert.deepEqual(calls.cancel, [request]);
});

test('late cancellation after Steam accepted launch removes the pending join request', async () => {
  let isCancelled = false;
  const { launch, calls, request } = harness({
    launchThroughSteam: async () => { isCancelled = true; return { method: 'steam-client' }; }
  });
  assert.deepEqual(await launch(game, connection, () => isCancelled), { cancelled: true });
  assert.deepEqual(calls.cancel, [request]);
});

test('missing profile settings fail before installing a bridge or writing a request', async () => {
  const { launch, calls } = harness();
  await assert.rejects(launch({ ...game, settings: {} }, connection), /profile/);
  assert.equal(calls.mkdir.length, 0);
  assert.equal(calls.prepare.length, 0);
});

test('native join awaits profile settings preparation before bridge installation, request and Steam', async () => {
  const events = [];
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { launch } = harness({
    prepareProfile: async settings => {
      assert.equal(settings, game.settings);
      events.push('profile-start');
      entered();
      await pending;
      events.push('profile-ready');
    },
    prepareBridge: async () => { events.push('bridge'); return { addonsDirectory: 'B:\\Profile\\bridge' }; },
    prepareRequest: async () => { events.push('request'); return { token: 'a'.repeat(32) }; },
    launchThroughSteam: async () => { events.push('steam'); return { method: 'mock' }; }
  });
  const result = launch(game, connection);
  await started;
  assert.deepEqual(events, ['profile-start']);
  release();
  await result;
  assert.deepEqual(events, ['profile-start', 'profile-ready', 'bridge', 'request', 'steam']);
});

test('profile settings preparation failure prevents native bridge setup and game launch', async () => {
  const failure = new Error('profile settings could not be prepared');
  let bridgeCalls = 0;
  const { launch, calls } = harness({
    prepareProfile: async () => { throw failure; },
    prepareBridge: async () => { bridgeCalls++; return { addonsDirectory: 'unused' }; }
  });
  await assert.rejects(launch(game, connection), error => error === failure);
  assert.deepEqual(calls.mkdir, []);
  assert.equal(bridgeCalls, 0);
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.steam.length, 0);
  assert.equal(calls.cancel.length, 0);
});

test('cancelling during profile preparation prevents bridge, request and Steam after preparation completes', async () => {
  let cancelled = false;
  let entered;
  let release;
  let bridgeCalls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { launch, calls } = harness({
    prepareProfile: async () => { entered(); await pending; },
    prepareBridge: async () => { bridgeCalls++; return { addonsDirectory: 'unused' }; }
  });
  const launching = launch(game, connection, () => cancelled);
  await started;
  cancelled = true;
  release();
  assert.deepEqual(await launching, { cancelled: true });
  assert.equal(bridgeCalls, 0);
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.steam.length, 0);
  assert.equal(calls.cancel.length, 0);
});

test('hostnames resolve to one IPv4 address without changing the port', async () => {
  const calls = [];
  assert.equal(await resolveNativeServerAddress('PLAY.Example.Test:02002', {
    lookup: async (...args) => { calls.push(args); return { address: '203.0.113.6' }; }
  }), '203.0.113.6:2002');
  assert.deepEqual(calls, [['play.example.test', { family: 4 }]]);
  assert.equal(await resolveNativeServerAddress('151.80.33.213:2002', {
    lookup: () => { throw new Error('numeric address must not use DNS'); }
  }), '151.80.33.213:2002');
});

test('failed, non-IPv4, or unresponsive DNS cannot leave a pending join request', async () => {
  await assert.rejects(resolveNativeServerAddress('example.test:2001', {
    lookup: async () => ({ address: '::1' })
  }), /IPv4/);
  await assert.rejects(resolveNativeServerAddress('example.test:2001', {
    lookup: () => new Promise(() => {}), timeoutMs: 10
  }), /вовремя/);
  const { launch, calls } = harness({ resolveAddress: async () => { throw new Error('DNS failure'); } });
  await assert.rejects(launch(game, connection), /DNS failure/);
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.steam.length, 0);
});
