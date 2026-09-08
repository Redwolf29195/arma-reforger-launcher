const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readJsonFile, writeJsonAtomic } = require('../src/core/jsonFiles');

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-json-stress-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, filePath: path.join(root, 'state.json') };
}

test('serializes 100 concurrent saves without collisions and persists the last request', async (context) => {
  const { root, filePath } = await fixture(context);
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, revision) =>
    writeJsonAtomic(filePath, { revision, payload: 'x'.repeat(revision * 113) })));
  assert.equal(results.filter((result) => result.status === 'rejected').length, 0);
  assert.deepEqual(await readJsonFile(filePath), { revision: 99, payload: 'x'.repeat(99 * 113) });
  assert.deepEqual(await fs.readdir(root), ['state.json']);
});

test('preserves the old document when replacement fails and allows a later save', async (context) => {
  const { root, filePath } = await fixture(context);
  await writeJsonAtomic(filePath, { revision: 'original' });
  const originalRename = fs.rename;
  const renameMock = context.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === filePath) throw Object.assign(new Error('Replacement denied'), { code: 'EACCES' });
    return originalRename(source, destination);
  });
  await assert.rejects(writeJsonAtomic(filePath, { revision: 'rejected' }), { code: 'EACCES' });
  assert.deepEqual(await readJsonFile(filePath), { revision: 'original' });
  assert.deepEqual(await fs.readdir(root), ['state.json']);
  renameMock.mock.restore();
  await writeJsonAtomic(filePath, { revision: 'recovered' });
  assert.deepEqual(await readJsonFile(filePath), { revision: 'recovered' });
});

test('takes a snapshot before awaiting filesystem work', async (context) => {
  const { filePath } = await fixture(context);
  const value = { mods: [{ modId: '646B350F36C6D3E4', version: '1.0.0' }] };
  const pending = writeJsonAtomic(filePath, value);
  value.mods[0].version = 'changed after save';
  await pending;
  assert.equal((await readJsonFile(filePath)).mods[0].version, '1.0.0');
});
