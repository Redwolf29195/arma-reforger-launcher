const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  UPDATE_PUSH_TOPIC,
  createUpdatePushSubscriber,
  parseUpdatePushLine
} = require('../src/core/updatePush');

test('accepts only launcher release push messages with a valid version', () => {
  const signal = parseUpdatePushLine(JSON.stringify({
    id: 'message-1',
    time: 1787659200,
    event: 'message',
    topic: UPDATE_PUSH_TOPIC,
    message: 'launcher-update:0.3.9'
  }));

  assert.deepEqual(signal, { id: 'message-1', time: 1787659200, version: '0.3.9' });
  assert.equal(parseUpdatePushLine('{"event":"keepalive"}'), null);
  assert.equal(parseUpdatePushLine('{"event":"message","message":"hello"}'), null);
  assert.equal(parseUpdatePushLine('{"event":"message","message":"launcher-update:latest"}'), null);
  assert.equal(parseUpdatePushLine('not json'), null);
});

test('receives an update once and closes the stream when stopped', async () => {
  const request = new EventEmitter();
  request.setTimeout = () => {};
  request.destroyedByStop = false;
  request.destroy = () => { request.destroyedByStop = true; };
  const response = new EventEmitter();
  response.statusCode = 200;
  response.setEncoding = () => {};
  response.destroyedByStop = false;
  response.destroy = () => { response.destroyedByStop = true; };

  let responseHandler;
  const signals = [];
  const subscriber = createUpdatePushSubscriber({
    request: (_url, _options, handler) => {
      responseHandler = handler;
      return request;
    },
    onUpdate: (signal) => signals.push(signal)
  });

  subscriber.start();
  responseHandler(response);
  const line = JSON.stringify({
    id: 'message-2',
    time: 1787659300,
    event: 'message',
    message: 'launcher-update:0.4.0'
  });
  response.emit('data', `${line}\n${line}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(signals.length, 1);
  assert.equal(signals[0].version, '0.4.0');
  subscriber.stop();
  assert.equal(response.destroyedByStop, true);
  assert.equal(request.destroyedByStop, true);
  assert.equal(subscriber.isRunning(), false);
});

function pushFixture(options = {}) {
  const requests = [];
  const timers = [];
  const signals = [];
  const subscriber = createUpdatePushSubscriber({
    request: (_url, _options, callback) => {
      const request = new EventEmitter();
      request.destroy = () => { request.destroyed = true; };
      request.setTimeout = (_timeout, handler) => { request.timeout = handler; };
      request.respond = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        response.destroy = () => { response.destroyed = true; };
        request.response = response;
        callback(response);
        return response;
      };
      requests.push(request);
      return request;
    },
    setTimer: (callback) => { const timer = { callback }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
    onUpdate: (signal) => signals.push(signal),
    ...options
  });
  return { subscriber, requests, timers, signals };
}

const releaseLine = (id) => `${JSON.stringify({ id, event: 'message', message: 'launcher-update:0.4.0' })}\n`;

test('ignores stopped and previous connection events across repeated restart cycles', async (context) => {
  const { subscriber, requests, timers, signals } = pushFixture();
  context.after(() => subscriber.stop());
  for (let iteration = 0; iteration < 50; iteration += 1) {
    subscriber.start();
    const first = requests.at(-1);
    const stale = first.respond();
    subscriber.stop();
    stale.emit('data', releaseLine(`stopped-${iteration}`));
    subscriber.start();
    const next = requests.at(-1);
    const active = next.respond();
    stale.emit('error', new Error('late old connection error'));
    first.timeout();
    stale.emit('data', releaseLine(`stale-${iteration}`));
    active.emit('data', releaseLine(`active-${iteration}`));
    assert.notEqual(next.destroyed, true);
    subscriber.stop();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.length, 50);
  assert.equal(signals.every((signal) => signal.id.startsWith('active-')), true);
  assert.equal(timers.length, 0);
});

test('rejects an oversized unterminated push line and reconnects once', (context) => {
  const { subscriber, requests, timers, signals } = pushFixture();
  context.after(() => subscriber.stop());
  subscriber.start();
  const response = requests[0].respond();
  for (let index = 0; index < 100; index += 1) response.emit('data', 'x'.repeat(4096));
  response.emit('data', releaseLine('after-overflow'));
  assert.equal(response.destroyed, true);
  assert.equal(requests[0].destroyed, true);
  assert.equal(timers.length, 1);
  assert.equal(signals.length, 0);
});

test('handles premature stream close and synchronous consumer failures', async (context) => {
  let calls = 0;
  const { subscriber, requests, timers } = pushFixture({ onUpdate() { calls += 1; throw new Error('consumer failure'); } });
  context.after(() => subscriber.stop());
  subscriber.start();
  const response = requests[0].respond();
  assert.doesNotThrow(() => response.emit('data', releaseLine('one')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  response.emit('close');
  assert.equal(timers.length, 1);
  response.emit('end');
  assert.equal(timers.length, 1);
});

test('accepts a large batch of small release messages without applying the line bound to the whole chunk', (context) => {
  const { subscriber, requests, timers, signals } = pushFixture();
  context.after(() => subscriber.stop());
  subscriber.start();
  const response = requests[0].respond();
  const batch = Array.from({ length: 2000 }, (_, index) => releaseLine(`batch-${index}`)).join('');
  assert.ok(Buffer.byteLength(batch) > 64 * 1024);
  response.emit('data', batch);
  assert.equal(signals.length, 2000);
  assert.equal(timers.length, 0);
  assert.notEqual(response.destroyed, true);
});
