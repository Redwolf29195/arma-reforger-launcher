const test = require('node:test');
const assert = require('node:assert/strict');

const { isArmaReforgerRunning, windowsTaskListContains } = require('../src/core/gameProcess');

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

test('pgrep treats no matches as closed but retains actual process query failures', async () => {
  assert.equal(await isArmaReforgerRunning('linux', {
    execFileImpl(command, args, _options, callback) {
      assert.equal(command, 'pgrep');
      assert.equal(args[1], '(^|/)ArmaReforger(Steam)?(\\.exe)?([[:space:]]|$)');
      callback(Object.assign(new Error('no matches'), { code: 1 }), '');
    }
  }), false);
  await assert.rejects(isArmaReforgerRunning('linux', {
    execFileImpl(_command, _args, _options, callback) {
      callback(Object.assign(new Error('query error'), { code: 2 }), '');
    }
  }), { code: 'GAME_PROCESS_CHECK_FAILED' });
});
