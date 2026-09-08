const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  buildTransferPlan,
  downloadWithPlan,
  fetchUpdateRange,
  resolveTrustedUpdateRedirect
} = require('../src/core/updateDownload');

function digest(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64');
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-fast-update-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('builds a complete bounded range plan and merges small gaps', () => {
  const plan = buildTransferPlan([
    { kind: 1, start: 0, end: 10 },
    { kind: 0, start: 10, end: 14 },
    { kind: 1, start: 14, end: 20 }
  ], 20, 20, 1024, 4);
  assert.deepEqual(plan.copies, [{ start: 10, end: 14, offset: 10 }]);
  assert.deepEqual(plan.ranges, [{ start: 0, end: 20, total: 20 }]);
  assert.throws(() => buildTransferPlan([{ kind: 1, start: 1, end: 3 }], 2), /offset/);
  assert.throws(() => buildTransferPlan([{ kind: 0, start: 5, end: 9 }], 4, 8), /cached installer/);
});

test('downloads a full update with bounded parallelism and verifies SHA-512', async (context) => {
  const root = await fixture(context);
  const expected = crypto.randomBytes(4 * 1024 * 1024 + 333);
  const output = path.join(root, 'installer.exe');
  let active = 0;
  let maximum = 0;
  const progress = [];
  const result = await downloadWithPlan({
    newFile: output,
    size: expected.length,
    sha512: digest(expected),
    chunkSize: 512 * 1024,
    fetchRange: async (range) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return expected.subarray(range.start, range.end);
    },
    onProgress: (value) => progress.push(value)
  });
  assert.equal(maximum, 4);
  assert.equal(result.fullBytes, expected.length);
  assert.equal(result.downloadBytes, expected.length);
  assert.deepEqual(await fs.readFile(output), expected);
  assert.equal(progress.at(-1).percent, 100);
});

test('reuses cached ranges and retries only a failed remote chunk', async (context) => {
  const root = await fixture(context);
  const old = Buffer.from('AAAAA-old-unused');
  const expected = Buffer.from('AAAAA-new-data');
  const oldFile = path.join(root, 'old.exe');
  const output = path.join(root, 'new.exe');
  await fs.writeFile(oldFile, old);
  let attempts = 0;
  const result = await downloadWithPlan({
    newFile: output,
    oldFile,
    size: expected.length,
    sha512: digest(expected),
    operations: [
      { kind: 0, start: 0, end: 5 },
      { kind: 1, start: 5, end: expected.length }
    ],
    retryDelay: 1,
    fetchRange: async (range) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary reset');
      return expected.subarray(range.start, range.end);
    }
  });
  assert.equal(attempts, 2);
  assert.equal(result.downloadBytes, expected.length - 5);
  assert.deepEqual(await fs.readFile(output), expected);
});

test('rejects a corrupt update even when every range was received', async (context) => {
  const root = await fixture(context);
  const expected = Buffer.from('trusted installer');
  await assert.rejects(downloadWithPlan({
    newFile: path.join(root, 'bad.exe'),
    size: expected.length,
    sha512: digest(expected),
    fetchRange: async () => Buffer.from('changed installer')
  }), /SHA-512 mismatch/);
  await assert.rejects(fs.stat(path.join(root, 'bad.exe')), { code: 'ENOENT' });
});

test('cancels all active ranges and removes a partial installer across repeated attempts', async (context) => {
  const root = await fixture(context);
  for (let iteration = 0; iteration < 25; iteration += 1) {
    const controller = new AbortController();
    const reason = new Error('cancelled by test');
    const output = path.join(root, `cancel-${iteration}.exe`);
    let active = 0;
    let started = 0;
    const progress = [];
    const download = downloadWithPlan({
      newFile: output,
      size: 128,
      chunkSize: 8,
      sha512: digest(Buffer.alloc(128)),
      signal: controller.signal,
      fetchRange: (_range, { signal }) => new Promise((_resolve, reject) => {
        active += 1;
        started += 1;
        signal.addEventListener('abort', () => { active -= 1; reject(signal.reason); }, { once: true });
        if (started === 4) controller.abort(reason);
      }),
      onProgress: (value) => progress.push(value)
    });
    await assert.rejects(download, (error) => error === reason);
    assert.equal(active, 0);
    assert.equal(started, 4);
    assert.equal(progress.some((value) => value.percent === 100), false);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  }
});

test('strict range fetch accepts exact HTTPS 206 responses', async () => {
  let options;
  const executor = {
    createRequest(requestOptions, callback) {
      options = requestOptions;
      const request = new EventEmitter();
      request.abort = () => {};
      request.end = () => {
        const response = new PassThrough();
        response.statusCode = 206;
        response.headers = { 'content-range': 'bytes 2-4/6', 'content-encoding': 'identity' };
        callback(response);
        response.end(Buffer.from('cde'));
      };
      return request;
    }
  };
  const result = await fetchUpdateRange(executor, new URL('https://updates.example/test.exe'), { start: 2, end: 5, total: 6 });
  assert.equal(result.toString(), 'cde');
  assert.equal(options.headers.Range, 'bytes=2-4');
});

test('follows only trusted GitHub release redirects', async () => {
  const executor = {
    createRequest(_options, callback) {
      const request = new EventEmitter();
      request.abort = () => {};
      request.followRedirect = () => {
        const response = new PassThrough();
        response.statusCode = 206;
        response.headers = { 'content-range': 'bytes 0-2/3', 'content-encoding': 'identity' };
        callback(response);
        response.end(Buffer.from('abc'));
      };
      request.end = () => request.emit(
        'redirect',
        302,
        'GET',
        'https://release-assets.githubusercontent.com/github-production-release-asset/file?token=temporary'
      );
      return request;
    }
  };

  const result = await fetchUpdateRange(
    executor,
    new URL('https://github.com/owner/repo/releases/latest/download/file.exe'),
    { start: 0, end: 3, total: 3 }
  );
  assert.equal(result.toString(), 'abc');
  assert.throws(
    () => resolveTrustedUpdateRedirect(new URL('https://github.com/owner/repo/file'), 'https://example.com/file'),
    /not trusted/
  );
});

test('a failed progress consumer rejects the range without throwing from the network event', async () => {
  const controller = new AbortController();
  let response;
  const request = new EventEmitter();
  request.abort = () => {};
  request.end = () => {};
  const failure = new Error('progress consumer failed');
  const pending = fetchUpdateRange({
    createRequest(_options, callback) {
      response = new EventEmitter();
      response.statusCode = 206;
      response.headers = { 'content-range': 'bytes 0-2/3' };
      queueMicrotask(() => callback(response));
      return request;
    }
  }, new URL('https://github.com/test.exe'), { start: 0, end: 3, total: 3 }, {
    signal: controller.signal,
    onBytes() { throw failure; }
  });
  const rejected = assert.rejects(pending, (error) => error === failure);
  await Promise.resolve();
  let thrown;
  try { response.emit('data', Buffer.from('abc')); } catch (error) { thrown = error; }
  controller.abort(failure);
  await rejected;
  assert.equal(thrown, undefined);
});

test('does not follow late redirects after cancellation', async () => {
  const controller = new AbortController();
  const request = new EventEmitter();
  let redirects = 0;
  request.abort = () => {};
  request.end = () => {};
  request.followRedirect = () => { redirects += 1; };
  const pending = fetchUpdateRange({ createRequest: () => request },
    new URL('https://github.com/test.exe'), { start: 0, end: 3, total: 3 }, { signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/file');
  assert.equal(redirects, 0);
});

test('honors cancellation from the final progress event and deletes the installer', async (context) => {
  const root = await fixture(context);
  const expected = Buffer.from('verified but cancelled');
  const output = path.join(root, 'cancel-final.exe');
  const controller = new AbortController();
  await assert.rejects(downloadWithPlan({
    newFile: output,
    size: expected.length,
    sha512: digest(expected),
    signal: controller.signal,
    fetchRange: async () => expected,
    onProgress(value) { if (value.percent === 100) controller.abort(new Error('late cancellation')); }
  }), /late cancellation/);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('disk write failure closes both handles, removes the partial update and preserves cache', async (context) => {
  const root = await fixture(context);
  const oldFile = path.join(root, 'old.exe');
  const output = path.join(root, 'no-space.exe');
  const expected = Buffer.from('trusted');
  await fs.writeFile(oldFile, expected);
  const originalOpen = fs.open;
  const opened = [];
  context.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    opened.push(handle);
    if (args[0] === output) handle.write = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    return handle;
  });
  await assert.rejects(downloadWithPlan({
    newFile: output,
    oldFile,
    size: expected.length,
    sha512: digest(expected),
    operations: [{ kind: 0, start: 0, end: expected.length }],
    fetchRange: async () => { throw new Error('unexpected network call'); }
  }), { code: 'ENOSPC' });
  assert.equal(opened.every((handle) => handle.fd === -1), true);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(oldFile), expected);
});

test('range transport rejects wrong, truncated, oversized, encoded and abruptly closed responses', async () => {
  const cases = [
    { status: 200 },
    { range: '' },
    { range: 'bytes 1-3/4' },
    { range: 'bytes 0-2/4' },
    { encoding: 'gzip' },
    { body: 'ab' },
    { body: 'abcd' },
    { closed: true }
  ];
  for (const scenario of cases) {
    let aborted = false;
    const executor = {
      createRequest(_options, callback) {
        const request = new EventEmitter();
        request.abort = () => { aborted = true; };
        request.end = () => queueMicrotask(() => {
          const response = new PassThrough();
          response.statusCode = scenario.status ?? 206;
          response.headers = { 'content-range': scenario.range ?? 'bytes 0-2/3', 'content-encoding': scenario.encoding ?? 'identity' };
          callback(response);
          if (scenario.closed) response.destroy();
          else response.end(Buffer.from(scenario.body ?? 'abc'));
        });
        return request;
      }
    };
    await assert.rejects(fetchUpdateRange(executor, new URL('https://github.com/file.exe'), { start: 0, end: 3, total: 3 }));
    assert.equal(aborted, true);
  }
});

test('stress reconstructs 100 fragmented delta plans with bounded retries and no hash mismatches', async (context) => {
  const root = await fixture(context);
  const old = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 251));
  const oldFile = path.join(root, 'old.exe');
  await fs.writeFile(oldFile, old);
  let retries = 0;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const expected = Buffer.alloc(8192);
    const operations = [];
    for (let offset = 0; offset < expected.length; offset += 128) {
      if (((offset / 128) + iteration) % 3 === 0) {
        const source = (offset * 7 + iteration * 131) % (old.length - 128);
        old.copy(expected, offset, source, source + 128);
        operations.push({ kind: 0, start: source, end: source + 128 });
      } else {
        expected.fill((offset + iteration) % 253, offset, offset + 128);
        operations.push({ kind: 1, start: offset, end: offset + 128 });
      }
    }
    const attempts = new Map();
    const output = path.join(root, 'next.exe');
    await downloadWithPlan({
      newFile: output,
      oldFile,
      size: expected.length,
      sha512: digest(expected),
      operations,
      chunkSize: 512,
      mergeGap: 128,
      concurrency: 8,
      retryDelay: 1,
      onRetry: () => { retries += 1; },
      fetchRange: async (range, { onBytes }) => {
        const attempt = (attempts.get(range.start) || 0) + 1;
        attempts.set(range.start, attempt);
        if ((range.start + iteration) % 17 === 0 && attempt === 1) throw new Error('simulated reset');
        const bytes = expected.subarray(range.start, range.end);
        onBytes(bytes.length);
        return bytes;
      }
    });
    assert.deepEqual(await fs.readFile(output), expected);
    assert.equal([...attempts.values()].every((count) => count <= 2), true);
  }
  assert.ok(retries > 50);
  assert.deepEqual(await fs.readFile(oldFile), old);
});
