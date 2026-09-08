const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { acquireLauncherInstance } = require('../src/main/singleInstance');

function mockApp(primary) {
  const app = new EventEmitter();
  app.lockCalls = 0;
  app.quitCalls = 0;
  app.requestSingleInstanceLock = () => { app.lockCalls += 1; return primary; };
  app.quit = () => { app.quitCalls += 1; };
  return app;
}

function mockWindow({ minimized = false, visible = true, destroyed = false } = {}) {
  return {
    actions: [],
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore() { this.actions.push('restore'); },
    show() { this.actions.push('show'); },
    focus() { this.actions.push('focus'); }
  };
}

test('secondary launcher quits and returns false before installing window listeners', () => {
  const app = mockApp(false);
  const allowed = acquireLauncherInstance({ app, getMainWindow: () => { throw new Error('Must not access window'); } });
  assert.equal(allowed, false);
  assert.equal(app.lockCalls, 1);
  assert.equal(app.quitCalls, 1);
  assert.equal(app.listenerCount('second-instance'), 0);
});

test('primary launcher restores, shows and focuses its current window on another launch', () => {
  const app = mockApp(true);
  let window = mockWindow({ minimized: true, visible: false });
  assert.equal(acquireLauncherInstance({ app, getMainWindow: () => window }), true);
  assert.equal(app.lockCalls, 1);
  assert.equal(app.quitCalls, 0);
  assert.equal(app.listenerCount('second-instance'), 1);
  app.emit('second-instance', {}, ['untrusted-argument'], 'untrusted-directory', { command: 'untrusted' });
  assert.deepEqual(window.actions, ['restore', 'show', 'focus']);

  window = mockWindow();
  app.emit('second-instance');
  assert.deepEqual(window.actions, ['focus']);
});

test('missing or already destroyed primary windows are safely ignored', () => {
  const app = mockApp(true);
  let window = null;
  acquireLauncherInstance({ app, getMainWindow: () => window });
  assert.doesNotThrow(() => app.emit('second-instance'));
  window = mockWindow({ destroyed: true });
  app.emit('second-instance');
  assert.deepEqual(window.actions, []);
});

test('a window destroyed while restoring is not shown or focused', () => {
  const app = mockApp(true);
  const window = mockWindow({ minimized: true, visible: false });
  window.restore = () => { window.actions.push('restore'); window.isDestroyed = () => true; };
  acquireLauncherInstance({ app, getMainWindow: () => window });
  app.emit('second-instance');
  assert.deepEqual(window.actions, ['restore']);
});

test('a validated factory reset worker bypasses the ordinary launcher lock', () => {
  const app = mockApp(false);
  assert.equal(acquireLauncherInstance({ app, factoryResetStartup: { active: true } }), true);
  assert.equal(app.lockCalls, 0);
  assert.equal(app.quitCalls, 0);
  assert.equal(app.listenerCount('second-instance'), 0);
});

test('inactive or truthy non-boolean reset flags do not bypass the launcher lock', () => {
  for (const active of [undefined, false, 'true', 1]) {
    const app = mockApp(false);
    assert.equal(acquireLauncherInstance({ app, factoryResetStartup: { active } }), false);
    assert.equal(app.lockCalls, 1);
    assert.equal(app.quitCalls, 1);
  }
});
