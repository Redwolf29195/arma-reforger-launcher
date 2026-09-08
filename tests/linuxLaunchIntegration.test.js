// SPDX-License-Identifier: GPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSteamClientArguments, buildSteamLaunchUrl } = require('../src/core/launchBuilder');

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const launchSource = main.slice(main.indexOf('async function launchThroughSteam('), main.indexOf('function getWorkshopBridgeDirectory('));
function fixture(steamPath) {
  const calls = [];
  const context = vm.createContext({
    process: { platform: 'linux' }, path: path.posix, Date, Promise, setTimeout,
    findSteamExecutable: async () => steamPath,
    buildSteamClientArguments, buildSteamLaunchUrl,
    spawnDetached: async (command, args) => {
      assert.equal(command, steamPath, 'The Windows game must never be spawned directly on Linux');
      calls.push({ method: 'spawn', command, args });
    },
    shell: { openExternal: async (url) => calls.push({ method: 'protocol', url }) },
    isSteamRunning: async () => { throw Error('Linux must let Steam initialize its own Proton runtime'); },
    logger: { error: () => assert.fail('Unexpected direct-executable fallback') }
  });
  vm.runInContext(launchSource, context);
  return { context, calls };
}

test('Linux Workshop and server requests go through Steam and preserve path argument boundaries', async () => {
  const { context, calls } = fixture('/usr/bin/steam');
  const args = ['-profile', 'Z:\\home\\player\\My profile', '-algzJoinRequest', 'a'.repeat(32)];
  const result = await context.launchWithExactArguments('/games/Arma Reforger/ArmaReforgerSteam.exe', args, 'Workshop');
  assert.equal(result.method, 'steam-client');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-applaunch', '1874880', ...args]);
});

test('Linux can use the registered Steam protocol when the native command is unavailable', async () => {
  const { context, calls } = fixture('');
  const args = ['-profile', 'Z:\\home\\player\\My profile'];
  await context.launchWithExactArguments('/games/ArmaReforgerSteam.exe', args);
  assert.deepEqual(calls, [{ method: 'protocol', url: buildSteamLaunchUrl(args) }]);
});

test('cancelled Linux launch does not start Steam or the game', async () => {
  const { context, calls } = fixture('/usr/bin/steam');
  const result = await context.launchWithExactArguments('/games/ArmaReforgerSteam.exe', [], 'game', () => true);
  assert.equal(result.cancelled, true);
  assert.equal(calls.length, 0);
});
