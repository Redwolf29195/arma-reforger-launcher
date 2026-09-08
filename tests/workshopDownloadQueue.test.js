const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  parseWorkshopStatus,
  readWorkshopStatus,
  resolveWorkshopQueue,
  writeWorkshopQueue
} = require('../src/core/workshopDownloadQueue');

test('resolves Workshop dependencies recursively without duplicate GUIDs', async () => {
  const dependencies = new Map([
    ['AAAAAAAAAAAAAAAA', ['BBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCC']],
    ['BBBBBBBBBBBBBBBB', ['CCCCCCCCCCCCCCCC']],
    ['CCCCCCCCCCCCCCCC', []]
  ]);
  const result = await resolveWorkshopQueue(
    [{ modId: 'aaaaaaaaaaaaaaaa' }, { modId: 'AAAAAAAAAAAAAAAA' }],
    {
      concurrency: 2,
      fetchDetails: async (modId) => ({
        dependencies: dependencies.get(modId).map((dependencyId) => ({ modId: dependencyId }))
      })
    }
  );

  assert.deepEqual(result.modIds, ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCC']);
  assert.deepEqual(result.failedDetails, []);
});

test('keeps a requested mod when dependency metadata is unavailable', async () => {
  const result = await resolveWorkshopQueue([{ modId: 'AAAAAAAAAAAAAAAA' }], {
    fetchDetails: async () => { throw new Error('offline'); }
  });
  assert.deepEqual(result.modIds, ['AAAAAAAAAAAAAAAA']);
  assert.equal(result.failedDetails.length, 1);
});

test('preserves requested versions for server collection downloads', async () => {
  const result = await resolveWorkshopQueue([
    { modId: 'AAAAAAAAAAAAAAAA', version: '1.2.3' }
  ], {
    fetchDetails: async () => ({ dependencies: [] })
  });

  assert.deepEqual(result.items, [{ modId: 'AAAAAAAAAAAAAAAA', version: '1.2.3' }]);
});

test('writes and reads the bridge queue status', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-workshop-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const written = await writeWorkshopQueue(directory, ['aaaaaaaaaaaaaaaa', 'BBBBBBBBBBBBBBBB']);
  assert.equal(written.count, 2);
  assert.equal(await fs.readFile(written.queuePath, 'utf8'), 'AAAAAAAAAAAAAAAA\nBBBBBBBBBBBBBBBB\n');
  assert.deepEqual(await readWorkshopStatus(directory), {
    state: 'queued',
    completed: 0,
    total: 2,
    failed: 0,
    modId: '',
    progress: 0,
    message: 'Preparing Workshop queue'
  });
});

test('writes exact versions in the bridge queue without changing legacy lines', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-workshop-versioned-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const written = await writeWorkshopQueue(directory, [
    { modId: 'AAAAAAAAAAAAAAAA', version: '1.2.3' },
    { modId: 'BBBBBBBBBBBBBBBB', version: '' }
  ]);
  assert.equal(await fs.readFile(written.queuePath, 'utf8'), 'AAAAAAAAAAAAAAAA|1.2.3\nBBBBBBBBBBBBBBBB\n');
});

test('parses a Workshop bridge progress line', () => {
  assert.deepEqual(parseWorkshopStatus('downloading|4|10|1|AAAAAAAAAAAAAAAA|37|Example Mod'), {
    state: 'downloading',
    completed: 4,
    total: 10,
    failed: 1,
    modId: 'AAAAAAAAAAAAAAAA',
    progress: 37,
    message: 'Example Mod'
  });
});
