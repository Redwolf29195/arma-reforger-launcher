const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { isArmaReforgerLinuxProcess, isArmaReforgerRunning, isSteamRunning, windowsTaskListContains } = require('../src/core/gameProcess');

test('matches exact Windows process names from tasklist CSV output', () => {
  const output = [
    '"steam.exe","1412","Console","1","123,456 K"',
    '"ArmaReforgerSteam.exe","9124","Console","1","1,234,567 K"'
  ].join('\r\n');

  assert.equal(windowsTaskListContains(output, 'steam.exe'), true);
  assert.equal(windowsTaskListContains(output, 'ArmaReforgerSteam.exe'), true);
  assert.equal(windowsTaskListContains(output, 'ArmaReforger.exe'), false);
  assert.equal(windowsTaskListContains('INFO: No tasks are running', 'steam.exe'), false);
});

test('detects both exact client image names and excludes dedicated servers and tools', async () => {
  for (const [image, running] of [
    ['ArmaReforgerSteam.exe', true], ['ArmaReforger.exe', true],
    ['ArmaReforgerServer.exe', false], ['ArmaReforgerWorkbench.exe', false]
  ]) {
    assert.equal(await isArmaReforgerRunning('win32', {
      execFileImpl(command, args, options, callback) {
        assert.equal(command, 'tasklist.exe');
        assert.equal(args[1], 'IMAGENAME eq ArmaReforger*');
        assert.equal(options.windowsHide, true);
        callback(null, `"${image}","1234","Console","1","1 K"`);
      }
    }), running, image);
  }
});

test('a failed process query is unknown state, never evidence that the game is closed', async () => {
  for (const failure of [
    Object.assign(new Error('timeout'), { killed: true, code: 1 }),
    Object.assign(new Error('tasklist missing'), { code: 'ENOENT' }),
    Object.assign(new Error('access denied'), { code: 1 })
  ]) {
    await assert.rejects(isArmaReforgerRunning('win32', {
      execFileImpl(_command, _args, _options, callback) { callback(failure, ''); }
    }), (error) => error.code === 'GAME_PROCESS_CHECK_FAILED' && error.cause === failure);
  }
});

test('macOS pgrep treats no matches as closed but retains actual process query failures', async () => {
  assert.equal(await isArmaReforgerRunning('darwin', {
    execFileImpl(command, args, _options, callback) {
      assert.equal(command, 'pgrep');
      assert.equal(args[1], '(^|/)ArmaReforger(Steam)?(\\.exe)?([[:space:]]|$)');
      callback(Object.assign(new Error('no matches'), { code: 1 }), '');
    }
  }), false);
  await assert.rejects(isArmaReforgerRunning('darwin', {
    execFileImpl(_command, _args, _options, callback) {
      callback(Object.assign(new Error('query error'), { code: 2 }), '');
    }
  }), { code: 'GAME_PROCESS_CHECK_FAILED' });
});

async function processFixture(context) {
  const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-linux-proc-'));
  context.after(() => fs.rm(procRoot, { recursive: true, force: true }));
  const write = async (pid, comm, argv, state = 'S') => {
    const directory = path.join(procRoot, String(pid));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'stat'), `${pid} (${comm}) ${state} 1 2 3\n`);
    await fs.writeFile(path.join(directory, 'cmdline'), `${argv.join('\0')}\0`);
  };
  return { procRoot, write };
}

test('recognizes Wine client argv and truncated Linux task names without matching Proton wrappers', () => {
  for (const [record, expected] of [
    [{ argv: ['/mnt/Steam Library/Arma Reforger/ArmaReforgerSteam.exe'] }, true],
    [{ argv: ['Z:\\mnt\\Steam Library\\Arma Reforger\\ArmaReforger.exe'] }, true],
    [{ argv: ['/proton/files/bin/wine64-preloader'], comm: 'ArmaReforgerSte' }, true],
    [{ argv: ['/usr/bin/steam', '-applaunch', '1874880', '/games/ArmaReforgerSteam.exe'], comm: 'steam' }, false],
    [{ argv: ['/usr/bin/python3', '/proton/proton', 'waitforexitandrun', '/games/ArmaReforgerSteam.exe'], comm: 'python3' }, false],
    [{ argv: ['/steam/pressure-vessel-wrap', '/games/ArmaReforgerSteam.exe'] }, false],
    [{ argv: ['/games/ArmaReforgerServer.exe'], comm: 'ArmaReforgerServ' }, false],
    [{ argv: ['/games/ArmaReforgerWorkbench.exe'], comm: 'ArmaReforgerWork' }, false],
    [{ argv: ['/games/ArmaReforgerSteam.exe.backup'] }, false],
    [{ argv: ['/games/ArmaReforgerSteam.exe'], comm: 'ArmaReforgerSte', state: 'Z' }, false]
  ]) assert.equal(isArmaReforgerLinuxProcess(record), expected, JSON.stringify(record));
});

test('Linux game exit is observed even while Steam and Proton wrappers continue running', async (context) => {
  const fixture = await processFixture(context);
  await fixture.write(101, 'steam', ['/usr/bin/steam', '-applaunch', '1874880']);
  await fixture.write(102, 'python3', ['/usr/bin/python3', '/proton/proton', 'waitforexitandrun', '/games/ArmaReforgerSteam.exe']);
  await fixture.write(103, 'ArmaReforgerSte', ['Z:\\games\\ArmaReforgerSteam.exe', '-profile', 'Z:\\home\\user\\Profile']);
  assert.equal(await isArmaReforgerRunning('linux', fixture), true);
  assert.equal(await isSteamRunning('linux', fixture), true);
  await fixture.write(103, 'ArmaReforgerSte', [], 'Z');
  assert.equal(await isArmaReforgerRunning('linux', fixture), false);
  assert.equal(await isSteamRunning('linux', fixture), true);
});

test('Linux /proc fixture excludes a dedicated server and ignores processes disappearing mid-scan', async (context) => {
  const fixture = await processFixture(context);
  await fixture.write(201, 'ArmaReforgerServ', ['/games/ArmaReforgerServer.exe']);
  await fs.mkdir(path.join(fixture.procRoot, '202'));
  assert.equal(await isArmaReforgerRunning('linux', fixture), false);
});

test('Linux process access and query failures cannot be treated as a closed game', async (context) => {
  const fixture = await processFixture(context);
  await fixture.write(301, 'ArmaReforgerSte', ['/games/ArmaReforgerSteam.exe']);
  const failure = Object.assign(new Error('access denied'), { code: 'EACCES' });
  await assert.rejects(isArmaReforgerRunning('linux', {
    ...fixture,
    fsImpl: { ...fs, readFile: async () => { throw failure; } }
  }), (error) => error.code === 'GAME_PROCESS_CHECK_FAILED' && error.cause === failure);
  await assert.rejects(isArmaReforgerRunning('linux', {
    fsImpl: { readdir: async () => { throw failure; } }
  }), { code: 'GAME_PROCESS_CHECK_FAILED' });
});

test('Linux process scanning does not inspect inaccessible processes belonging to another user', async (context) => {
  const fixture = await processFixture(context);
  await fixture.write(401, 'other-user', ['/usr/bin/other-user']);
  assert.equal(await isArmaReforgerRunning('linux', {
    ...fixture, userId: 1234,
    fsImpl: { ...fs, stat: async () => ({ uid: 5678 }), readFile: async () => { throw new Error('Must skip another user'); } }
  }), false);
});
