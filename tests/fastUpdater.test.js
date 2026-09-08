const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const zlib = require('node:zlib');

const { applyStableUpdateChannel, FastNsisUpdater, readBlockMap } = require('../src/main/fastUpdater');

test('forces local preview builds to use the stable update channel without downgrading', () => {
  const updater = {
    allowPrerelease: true,
    allowDowngrade: false,
    set channel(value) {
      this.selectedChannel = value;
      this.allowDowngrade = true;
    }
  };

  applyStableUpdateChannel(updater);

  assert.equal(updater.selectedChannel, 'latest');
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
});

test('accepts a bounded electron-builder blockmap', () => {
  const blockmap = { version: '2', files: [{ name: 'file', offset: 0, sizes: [4, 2], checksums: ['a', 'b'] }] };
  assert.deepEqual(readBlockMap(zlib.gzipSync(JSON.stringify(blockmap))), blockmap);
});

test('rejects malformed or oversized blockmaps', () => {
  assert.throws(() => readBlockMap(Buffer.from('not gzip')));
  assert.throws(() => readBlockMap(zlib.gzipSync(JSON.stringify({ version: '2', files: [] }))), /Invalid update blockmap/);
});

test('keeps electron-updater verification flow, reconstructs a delta and honors cancellation during blockmap storage', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-nsis-updater-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'cache');
  const pending = path.join(root, 'pending');
  await fs.mkdir(cacheDir);
  await fs.mkdir(pending);
  const old = Buffer.from('AAAABBBB');
  const next = Buffer.from('AAAACCCC');
  await fs.writeFile(path.join(cacheDir, 'installer.exe'), old);
  const oldMap = { version: '2', files: [{ name: 'file', offset: 0, sizes: [4, 4], checksums: ['same', 'old'] }] };
  const newMap = { version: '2', files: [{ name: 'file', offset: 0, sizes: [4, 4], checksums: ['same', 'new'] }] };
  await fs.writeFile(path.join(cacheDir, 'current.blockmap'), zlib.gzipSync(JSON.stringify(oldMap)));

  const updater = Object.create(FastNsisUpdater.prototype);
  updater.app = { version: '1.0.0' };
  updater._logger = { info() {}, warn() {}, error() {} };
  updater.downloadedUpdateHelper = { cacheDir, cacheDirForPendingUpdate: pending };
  const progress = [];
  updater.emit = (name, value) => { if (name === 'download-progress') progress.push(value); };
  updater.httpExecutor = {
    downloadToBuffer: async (url) => zlib.gzipSync(JSON.stringify(String(url).includes('new') ? newMap : oldMap)),
    createRequest(options, callback) {
      const request = new EventEmitter();
      request.abort = () => {};
      request.end = () => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
        const start = Number(match[1]);
        const end = Number(match[2]);
        const response = new PassThrough();
        response.statusCode = 206;
        response.headers = { 'content-range': `bytes ${start}-${end}/${next.length}` };
        callback(response);
        response.end(next.subarray(start, end + 1));
      };
      return request;
    }
  };
  const token = new EventEmitter();
  token.cancelled = false;
  const output = path.join(root, 'new.exe');
  const download = () => updater.differentialDownloadInstaller({
    url: new URL('https://updates.example/new.exe'),
    info: { size: next.length, sha512: crypto.createHash('sha512').update(next).digest('base64') }
  }, {
    cancellationToken: token,
    requestHeaders: {},
    updateInfoAndProvider: { info: { version: '1.0.1' } }
  }, output, {
    getBlockMapFiles: async () => [new URL('https://updates.example/old.blockmap'), new URL('https://updates.example/new.blockmap')]
  }, 'installer.exe');

  const usedStandardDownload = await download();
  assert.equal(usedStandardDownload, false);
  assert.deepEqual(await fs.readFile(output), next);
  assert.equal(progress.at(-1).percent, 100);
  assert.ok((await fs.stat(path.join(pending, 'current.blockmap'))).size > 0);

  const writeFile = fs.writeFile;
  context.mock.method(fs, 'writeFile', async (...args) => {
    await writeFile(...args);
    if (args[0] === path.join(pending, 'current.blockmap')) {
      token.cancelled = true;
      token.emit('cancel');
    }
  });
  await assert.rejects(download(), /cancel/i);
  assert.equal(token.listenerCount('cancel'), 0);
});
