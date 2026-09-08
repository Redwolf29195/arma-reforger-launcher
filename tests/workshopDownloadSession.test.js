const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createWorkshopDownloadController, readSession, SESSION_FILE, START_TIMEOUT_MS } = require('../src/core/workshopDownloadSession');
const { getQueuePaths, readWorkshopQueue, isWorkshopDownloadActive } = require('../src/core/workshopDownloadQueue');

const items = [
  { modId: 'AAAAAAAAAAAAAAAA', version: '1.2.3' },
  { modId: 'BBBBBBBBBBBBBBBB', version: '4.5.6' }
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(context) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-session-test-'));
  context.after(() => fs.rm(profile, { recursive: true, force: true }));
  const clock = { now: Date.now() };
  const game = { running: false };
  const launched = [];
  const create = () => createWorkshopDownloadController({ isGameRunning: async () => game.running, now: () => clock.now });
  const paths = getQueuePaths(profile);
  const writeStatus = async (line, timestamp = clock.now) => {
    await fs.writeFile(paths.statusPath, line);
    await fs.utimes(paths.statusPath, timestamp / 1000, timestamp / 1000);
  };
  const launch = async (_prepared, queue) => { launched.push(structuredClone(queue)); game.running = true; return { method: 'mock' }; };
  const start = async (controller, queue = items, options) => {
    const result = await controller.start(profile, async () => ({ items: queue }), launch, options);
    await writeStatus(`queued|0|${result.queuedCount}|0||0|queued`);
    return result;
  };
  return { profile, clock, game, launched, create, paths, writeStatus, launch, start };
}

test('game closing mid-download pauses a durable pinned queue and a recreated controller replays exact versions', async (context) => {
  const f = await fixture(context);
  const first = f.create();
  await f.start(first);
  await f.writeStatus('downloading|1|2|0|BBBBBBBBBBBBBBBB|37|second');
  f.game.running = false;
  const status = await first.status(f.profile);
  assert.equal(status.state, 'paused');
  assert.equal(status.reason, 'game-closed');
  assert.equal(status.resumeAvailable, true);
  assert.equal(status.total, 2);
  assert.deepEqual((await readSession(f.profile)).items, items);

  const recreated = f.create();
  assert.equal((await recreated.status(f.profile)).resumeAvailable, true);
  let preparedItems;
  const result = await recreated.start(f.profile, async (saved) => {
    preparedItems = structuredClone(saved);
    return { items: [{ modId: 'CCCCCCCCCCCCCCCC', version: '99' }] };
  }, f.launch, { resume: true });
  assert.equal(result.queuedCount, 2);
  assert.deepEqual(preparedItems, items);
  assert.deepEqual(f.launched.at(-1), items);
  assert.deepEqual(await readWorkshopQueue(f.profile), items);
});

test('a temporarily inaccessible primary retries instead of pausing an active 42 percent download', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  await f.start(controller);
  await f.writeStatus('downloading|1|2|0|BBBBBBBBBBBBBBBB|42|second');
  const primary = path.join(path.dirname(f.paths.queuePath), SESSION_FILE);
  const open = fs.open;
  for (const code of ['EBUSY', 'EACCES', 'EPERM', 'EAGAIN', 'EMFILE', 'ENFILE', 'EINTR', 'ETIMEDOUT', 'ESTALE']) {
    let failed = false;
    const temporaryFailure = context.mock.method(fs, 'open', async (...args) => {
      if (!failed && args[0] === primary) {
        failed = true;
        throw Object.assign(new Error('temporary primary read failure'), { code });
      }
      return open(...args);
    });
    await assert.rejects(controller.status(f.profile), { code });
    const current = await controller.status(f.profile);
    assert.equal(current.state, 'downloading');
    assert.equal(current.progress, 42);
    assert.equal(current.resumeAvailable, false);
    assert.deepEqual((await readSession(f.profile)).items, items);
    temporaryFailure.mock.restore();
  }
});

test('partial terminal bridge cleanup does not delete the durable session or its pinned replay', async (context) => {
  const f = await fixture(context);
  await f.start(f.create());
  await f.writeStatus('partial|1|2|1||0|one failed');
  await fs.rm(f.paths.queuePath);
  f.game.running = false;
  assert.equal((await fs.stat(path.join(path.dirname(f.paths.queuePath), SESSION_FILE))).isFile(), true);
  const controller = f.create();
  const status = await controller.status(f.profile);
  assert.equal(status.state, 'partial');
  assert.equal(status.resumeAvailable, true);
  await controller.start(f.profile, async (saved) => ({ items: saved }), f.launch, { resume: true });
  assert.deepEqual(await readWorkshopQueue(f.profile), items);
});

test('an intermediate failed item keeps polling and does not finish the remaining queue', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  await f.start(controller);
  await f.writeStatus('failed|0|2|1|AAAAAAAAAAAAAAAA|0|first failed');
  const status = await controller.status(f.profile);
  assert.equal(status.state, 'failed');
  assert.equal(isWorkshopDownloadActive(status), true);
  assert.equal(status.resumeAvailable, false);
  f.game.running = false;
  assert.equal((await controller.status(f.profile)).state, 'paused');
});

test('empty, missing and truncated bridge status stays waiting while the game runs', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  await f.start(controller);
  for (const value of ['', 'complete', 'complete|2|2', 'downloading|1|2']) {
    await f.writeStatus(value);
    const status = await controller.status(f.profile);
    assert.equal(status.state, 'waiting', value);
    assert.equal(status.total, 2);
    assert.equal(status.resumeAvailable, false);
  }
  await fs.rm(f.paths.statusPath);
  assert.equal((await controller.status(f.profile)).state, 'waiting');
});

test('completion requires valid consistent counters covering every saved queue item', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  await f.start(controller);
  for (const line of [
    'complete|1|2|0||100|too few',
    'complete|2|2|1||100|failure',
    'complete|1|1|0||100|different queue',
    'complete|2|2|oops||100|invalid failed counter',
    'complete|2|2|-1||100|negative failures',
    'complete|2|2|||100|missing failures'
  ]) {
    await f.writeStatus(line);
    assert.notEqual((await controller.status(f.profile)).state, 'complete', line);
  }
  await f.writeStatus('complete|2|2|0||100|done');
  const complete = await controller.status(f.profile);
  assert.equal(complete.state, 'complete');
  assert.equal(complete.resumeAvailable, false);
});

test('queued startup receives its bounded launch grace, then becomes resumable if the game never appears', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  await f.start(controller);
  f.game.running = false;
  f.clock.now += START_TIMEOUT_MS - 1;
  assert.equal((await controller.status(f.profile)).state, 'queued');
  f.clock.now += 2;
  const status = await controller.status(f.profile);
  assert.equal(status.state, 'paused');
  assert.equal(status.resumeAvailable, true);
  assert.equal(status.reason, 'game-closed');
});

test('a failed launch leaves the whole durable queue immediately resumable', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  await assert.rejects(controller.start(f.profile, async () => ({ items }), async () => { throw new Error('launch failed'); }), /launch failed/);
  const recreated = f.create();
  const status = await recreated.status(f.profile);
  assert.equal(status.state, 'paused');
  assert.equal(status.resumeAvailable, true);
  assert.deepEqual((await readSession(f.profile)).items, items);
  await recreated.start(f.profile, async (saved) => ({ items: saved }), f.launch, { resume: true });
  assert.deepEqual(f.launched[0], items);
});

test('100 concurrent start requests produce one launch and cannot overwrite the winning queue', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  const requests = Array.from({ length: 100 }, (_, index) => controller.start(f.profile,
    async () => ({ items: [{ modId: index.toString(16).toUpperCase().padStart(16, '0'), version: `1.0.${index}` }] }), f.launch));
  const results = await Promise.allSettled(requests);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && /Busy/.test(result.reason.message)).length, 99);
  assert.equal(f.launched.length, 1);
  assert.deepEqual(await readWorkshopQueue(f.profile), [{ modId: '0000000000000000', version: '1.0.0' }]);
});

test('new requests merge into a paused queue while keeping existing version pins and rejecting conflicts', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  await f.start(controller);
  await f.writeStatus('downloading|0|2|0|AAAAAAAAAAAAAAAA|10|first');
  f.game.running = false;
  const added = { modId: 'CCCCCCCCCCCCCCCC', version: '7.8.9' };
  await controller.start(f.profile, async () => ({ items: [{ modId: items[0].modId }, added] }), f.launch);
  assert.deepEqual(f.launched.at(-1), [...items, added]);
  f.game.running = false;
  const before = await readWorkshopQueue(f.profile);
  await assert.rejects(controller.start(f.profile, async () => ({ items: [{ modId: items[0].modId, version: '9.9.9' }] }), f.launch), /Conflicting/);
  assert.deepEqual(await readWorkshopQueue(f.profile), before);
});

test('cancelling asynchronous preparation prevents a late launch and allows the next start', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  const entered = deferred();
  const preparation = deferred();
  const pending = controller.start(f.profile, async () => { entered.resolve(); return preparation.promise; }, f.launch);
  await entered.promise;
  controller.cancelPendingStart();
  preparation.resolve({ items });
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(f.launched.length, 0);
  assert.equal(await readSession(f.profile), null);
  await f.start(controller);
  assert.equal(f.launched.length, 1);
});

test('cancel during asynchronous launch cannot publish successful completion afterward', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  const entered = deferred();
  const result = deferred();
  const pending = controller.start(f.profile, async () => ({ items }), async () => { entered.resolve(); return result.promise; });
  await entered.promise;
  controller.cancelPendingStart();
  result.resolve({ method: 'mock' });
  assert.equal((await pending).cancelled, true);
  assert.equal((await readSession(f.profile)).paused, true);
});

test('stale terminal status from an earlier attempt cannot discard or block a saved resumable queue', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  await f.start(controller);
  f.clock.now += START_TIMEOUT_MS + 1000;
  await f.writeStatus('complete|2|2|0||100|old attempt', f.clock.now - START_TIMEOUT_MS - 2000);
  f.game.running = false;
  assert.equal((await controller.status(f.profile)).resumeAvailable, true);
  await controller.start(f.profile, async (saved) => ({ items: saved }), f.launch, { resume: true });
  assert.deepEqual(f.launched.at(-1), items);
});

test('30 pause/resume cycles preserve the full original pinned queue across controller recreation', async (context) => {
  const f = await fixture(context);
  let controller = f.create();
  await f.start(controller);
  for (let cycle = 0; cycle < 30; cycle += 1) {
    await f.writeStatus(`downloading|1|2|0|BBBBBBBBBBBBBBBB|${cycle}|second`);
    f.game.running = false;
    assert.equal((await controller.status(f.profile)).state, 'paused');
    controller = f.create();
    await controller.start(f.profile, async (saved) => ({ items: saved }), f.launch, { resume: true });
    assert.deepEqual(await readWorkshopQueue(f.profile), items);
    assert.deepEqual((await readSession(f.profile)).items, items);
  }
  assert.equal(f.launched.length, 31);
});

test('a poll already reading old completed state cannot finish a new start during preparation', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  await f.start(controller);
  await f.writeStatus('complete|2|2|0||100|previous queue done');
  f.game.running = false;
  const readEntered = deferred();
  const releaseRead = deferred();
  const prepareEntered = deferred();
  const releasePrepare = deferred();
  const originalOpen = fs.open;
  let stalled = false;
  context.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (!stalled && String(args[0]).endsWith(SESSION_FILE)) {
      stalled = true;
      readEntered.resolve();
      await releaseRead.promise;
    }
    return handle;
  });
  const polling = controller.status(f.profile);
  await readEntered.promise;
  const starting = controller.start(f.profile, async () => {
    prepareEntered.resolve();
    await releasePrepare.promise;
    return { items: [{ modId: 'CCCCCCCCCCCCCCCC', version: '3.0' }] };
  }, f.launch);
  await prepareEntered.promise;
  releaseRead.resolve();
  const status = await polling;
  releasePrepare.resolve();
  await starting;
  assert.equal(status.state, 'queued');
  assert.equal(status.resumeAvailable, false);
});

test('merging beyond 500 mods cannot overwrite a paused session or launch a truncated queue', async (context) => {
  const f = await fixture(context);
  const controller = f.create();
  const full = Array.from({ length: 500 }, (_, index) => ({
    modId: index.toString(16).toUpperCase().padStart(16, '0'), version: `1.0.${index}`
  }));
  await f.start(controller, full);
  await f.writeStatus('downloading|0|500|0|0000000000000000|15|first');
  f.game.running = false;
  await assert.rejects(controller.start(f.profile, async () => ({ items }), f.launch), /limit/i);
  assert.equal(f.launched.length, 1);
  assert.deepEqual(await readWorkshopQueue(f.profile), full);
  assert.deepEqual((await readSession(f.profile)).items, full);
  const status = await controller.status(f.profile);
  assert.equal(status.state, 'paused');
  assert.equal(status.resumeAvailable, true);
  assert.equal(status.total, 500);
});
