const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeQueueItems, resolveWorkshopQueue, writeWorkshopQueue, readWorkshopQueue,
  parseWorkshopStatus, isWorkshopDownloadActive, readWorkshopStatus, getQueuePaths
} = require('../src/core/workshopDownloadQueue');

const guid = (index) => index.toString(16).toUpperCase().padStart(16, '0');
const mod = (index, version = '1.2.3') => ({ modId: guid(index), version });

async function fixture(context) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-queue-stress-'));
  context.after(() => fs.rm(profile, { recursive: true, force: true }));
  return profile;
}

test('queue accepts exactly 500 unique mods and rejects 501 roots without dropping entries', async () => {
  const queue = Array.from({ length: 500 }, (_, index) => mod(index));
  assert.equal(normalizeQueueItems([...queue, ...queue]).length, 500);
  assert.throws(() => normalizeQueueItems([...queue, mod(500)]), /limit/i);
  let calls = 0;
  await assert.rejects(resolveWorkshopQueue([...queue, mod(500)], {
    fetchDetails: async () => { calls += 1; return { dependencies: [] }; }
  }), /limit/i);
  assert.equal(calls, 0);
});

test('dependency expansion rejects a 501st mod instead of silently truncating the collection', async () => {
  await assert.rejects(resolveWorkshopQueue([mod(0)], {
    fetchDetails: async (id) => {
      const index = Number.parseInt(id, 16);
      return { dependencies: index < 500 ? [mod(index + 1)] : [] };
    }
  }), /limit/i);
});

test('invalid root versions cannot silently turn pinned requests into latest-version downloads', async () => {
  for (const version of ['1|2', '1\n2', '1\r2', 'v'.repeat(65)]) {
    let fetched = false;
    await assert.rejects(resolveWorkshopQueue([mod(0, version)], {
      fetchDetails: async () => { fetched = true; return { dependencies: [] }; }
    }), /version/i);
    assert.equal(fetched, false);
  }
});

test('invalid dependency versions cannot silently turn into unversioned downloads', async () => {
  for (const version of ['1|2', '1\n2', '1\r2', 'v'.repeat(65)]) {
    await assert.rejects(resolveWorkshopQueue([mod(0)], {
      fetchDetails: async (id) => ({ dependencies: id === guid(0) ? [mod(1, version)] : [] })
    }), /version/i);
  }
});

test('conflicting dependency pins fail deterministically instead of keeping the first arriving version', async () => {
  for (const reversed of [false, true]) {
    await assert.rejects(resolveWorkshopQueue([mod(0), mod(1)], {
      fetchDetails: async (id) => {
        if ((id === guid(0)) === reversed) await Promise.resolve();
        return { dependencies: id === guid(0) ? [mod(2, '2.0')] : id === guid(1) ? [mod(2, '3.0')] : [] };
      }
    }), /Conflicting.*version/i);
  }
});

test('an explicitly pinned root remains authoritative over a conflicting dependency recommendation', async () => {
  const result = await resolveWorkshopQueue([mod(0), mod(1, '4.0')], {
    fetchDetails: async (id) => ({ dependencies: id === guid(0) ? [mod(1, '5.0')] : [] })
  });
  assert.deepEqual(result.items, [mod(0), mod(1, '4.0')]);
});

test('100-node cyclic dependency graph processes each GUID exactly once with bounded parallelism', async () => {
  const visited = new Map();
  let active = 0;
  let peak = 0;
  const result = await resolveWorkshopQueue(Array.from({ length: 8 }, (_, index) => mod(index)), {
    concurrency: 8,
    fetchDetails: async (id) => {
      visited.set(id, (visited.get(id) || 0) + 1);
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      const index = Number.parseInt(id, 16);
      return { dependencies: [mod((index + 1) % 100), mod((index + 37) % 100), mod(index)] };
    }
  });
  assert.equal(result.items.length, 100);
  assert.equal(new Set(result.modIds).size, 100);
  assert.equal(visited.size, 100);
  assert.equal([...visited.values()].every((count) => count === 1), true);
  assert.ok(peak > 1 && peak <= 8);
  assert.equal(active, 0);
});

test('500 pinned queue entries survive disk roundtrip with every exact version', async (context) => {
  const profile = await fixture(context);
  const queue = Array.from({ length: 500 }, (_, index) => mod(index, `1.2.${index}`));
  await writeWorkshopQueue(profile, queue);
  assert.deepEqual(await readWorkshopQueue(profile), queue);
  assert.equal((await readWorkshopStatus(profile)).total, 500);
});

test('100 concurrent queue writes serialize queue/status pairs and preserve the final submitted collection', async (context) => {
  const profile = await fixture(context);
  const requests = Array.from({ length: 100 }, (_, index) => Array.from({ length: index % 10 + 1 }, (_, offset) => mod(offset, `0.${index}.${offset}`)));
  const results = await Promise.all(requests.map((queue) => writeWorkshopQueue(profile, queue)));
  assert.equal(results.length, 100);
  assert.deepEqual(await readWorkshopQueue(profile), requests.at(-1));
  assert.equal((await readWorkshopStatus(profile)).total, requests.at(-1).length);
  const names = await fs.readdir(path.dirname(getQueuePaths(profile).queuePath));
  assert.equal(names.some((name) => name.endsWith('.tmp')), false);
});

test('invalid new queue input preserves the previous text queue and status on disk', async (context) => {
  const profile = await fixture(context);
  const queue = [mod(0), mod(1)];
  await writeWorkshopQueue(profile, queue);
  const paths = getQueuePaths(profile);
  const previousStatus = await fs.readFile(paths.statusPath, 'utf8');
  for (const invalid of [[mod(2, 'invalid|version')], Array.from({ length: 501 }, (_, index) => mod(index))]) {
    await assert.rejects(writeWorkshopQueue(profile, invalid));
    assert.deepEqual(await readWorkshopQueue(profile), queue);
    assert.equal(await fs.readFile(paths.statusPath, 'utf8'), previousStatus);
  }
});

test('failed means an active item failure and impossible completion counters never parse as complete', () => {
  assert.equal(isWorkshopDownloadActive(parseWorkshopStatus('failed|0|2|1||0|next item follows')), true);
  for (const status of [
    'complete|999|999|0||100|out of range',
    'complete|2|2|bad||100|invalid failures',
    'complete|2|2|-1||100|negative failures',
    'complete|2|2|||100|missing failures'
  ]) assert.notEqual(parseWorkshopStatus(status).state, 'complete', status);
});
