const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const CHUNK_SIZE = 1024 * 1024;
const MAX_INSTALLER_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_UPDATE_REDIRECTS = 5;
const TRUSTED_UPDATE_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);

function rangeError(message) {
  return Object.assign(new Error(message), { code: 'ERR_UPDATE_RANGE' });
}

function header(response, name) {
  const value = response.headers?.[name.toLowerCase()];
  return String(Array.isArray(value) ? value[0] : value || '');
}

function resolveTrustedUpdateRedirect(currentUrl, redirectUrl) {
  let nextUrl;
  try {
    nextUrl = new URL(String(redirectUrl || ''), currentUrl);
  } catch {
    throw rangeError('Invalid update redirect.');
  }
  if (nextUrl.protocol !== 'https:' || nextUrl.username || nextUrl.password ||
      !TRUSTED_UPDATE_HOSTS.has(currentUrl.hostname.toLowerCase()) ||
      !TRUSTED_UPDATE_HOSTS.has(nextUrl.hostname.toLowerCase())) {
    throw rangeError('Update redirect is not trusted.');
  }
  return nextUrl;
}

// Uses the updater's Electron transport, including its TLS and proxy handling.
// Only GitHub release redirects are followed; unsupported ranges return control
// to the standard electron-updater download path.
function fetchUpdateRange(executor, url, range, { headers = {}, signal, onBytes = () => {}, timeoutMs = 30_000 } = {}) {
  if (url.protocol !== 'https:' || url.username || url.password) {
    return Promise.reject(rangeError('Parallel updates require HTTPS without URL credentials.'));
  }
  if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      !Number.isSafeInteger(range.total) || range.start < 0 || range.end <= range.start ||
      range.end > range.total || range.total > MAX_INSTALLER_SIZE || range.end - range.start > CHUNK_SIZE) {
    return Promise.reject(rangeError('Invalid update range.'));
  }
  return new Promise((resolve, reject) => {
    let request;
    let timer;
    let finished = false;
    let redirectCount = 0;
    let currentUrl = url;
    let received = 0;
    const chunks = [];
    const expected = range.end - range.start;
    const finish = (error, data) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        try { request?.abort?.(); } catch {}
        reject(error);
      } else resolve(data);
    };
    const abort = () => finish(signal.reason || new Error('Update download cancelled.'));
    const resetTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(Object.assign(new Error('Update range timed out.'), { code: 'ETIMEDOUT' })), timeoutMs);
      timer.unref?.();
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const requestHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => (
        !['range', 'accept-encoding'].includes(key.toLowerCase())
      )));
      request = executor.createRequest({
        protocol: currentUrl.protocol,
        hostname: currentUrl.hostname,
        port: currentUrl.port || undefined,
        path: `${currentUrl.pathname}${currentUrl.search}`,
        method: 'GET',
        redirect: 'manual',
        headers: { ...requestHeaders, Range: `bytes=${range.start}-${range.end - 1}`, 'Accept-Encoding': 'identity' }
      }, (response) => {
        response.on('error', (error) => finish(error));
        if (finished) {
          response.destroy?.();
          return;
        }
        const interrupted = () => finish(Object.assign(new Error('Update range was interrupted.'), { code: 'ECONNRESET' }));
        response.on('aborted', interrupted);
        response.once('close', interrupted);
        const contentRange = header(response, 'content-range');
        const encoding = header(response, 'content-encoding');
        if (response.statusCode !== 206 || contentRange !== `bytes ${range.start}-${range.end - 1}/${range.total}` || (encoding && encoding !== 'identity')) {
          finish(rangeError(`Invalid update range response: HTTP ${response.statusCode}, ${contentRange}`));
          return;
        }
        response.on('data', (chunk) => {
          if (finished) return;
          try {
            const buffer = Buffer.from(chunk);
            received += buffer.length;
            if (received > expected) return finish(rangeError('Update range exceeds its expected size.'));
            chunks.push(buffer);
            onBytes(buffer.length);
            if (!finished) resetTimeout();
          } catch (error) {
            finish(error);
          }
        });
        response.once('end', () => {
          if (received !== expected) finish(new Error('Update range is incomplete.'));
          else finish(null, Buffer.concat(chunks, received));
        });
      });
      request.on('error', (error) => finish(error));
      request.on('redirect', (_statusCode, _method, redirectUrl) => {
        if (finished) return;
        try {
          if (++redirectCount > MAX_UPDATE_REDIRECTS) throw rangeError('Too many update redirects.');
          currentUrl = resolveTrustedUpdateRedirect(currentUrl, redirectUrl);
          request.followRedirect();
        } catch (error) {
          finish(error);
        }
      });
      if (finished) {
        request.abort?.();
        return;
      }
      resetTimeout();
      request.end();
    } catch (error) {
      finish(error);
    }
  });
}

function buildTransferPlan(operations, size, oldSize = 0, chunkSize = CHUNK_SIZE, mergeGap = 32 * 1024) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_INSTALLER_SIZE) throw rangeError('Invalid update size.');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > CHUNK_SIZE) throw rangeError('Invalid update chunk size.');
  if (!Number.isSafeInteger(mergeGap) || mergeGap < 0 || mergeGap > CHUNK_SIZE) throw rangeError('Invalid update merge size.');
  const source = operations || [{ kind: 1, start: 0, end: size }];
  if (!Array.isArray(source) || source.length > 200_000) throw rangeError('Invalid update plan.');
  const copies = [];
  const remote = [];
  let offset = 0;
  for (const operation of source) {
    const { kind, start, end } = operation;
    if (![0, 1].includes(kind) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
      throw rangeError('Invalid update operation.');
    }
    const length = end - start;
    if (offset + length > size) throw rangeError('Update plan exceeds the installer size.');
    if (kind === 0) {
      if (end > oldSize) throw rangeError('Update copy exceeds the cached installer.');
      copies.push({ start, end, offset });
    } else {
      if (start !== offset) throw rangeError('Invalid update range offset.');
      const previous = remote.at(-1);
      if (previous && start - previous.end <= mergeGap && end - previous.start <= chunkSize) previous.end = end;
      else remote.push({ start, end });
    }
    offset += length;
  }
  if (offset !== size) throw rangeError('Update plan does not cover the complete installer.');
  const ranges = [];
  for (const range of remote) {
    for (let start = range.start; start < range.end; start += chunkSize) {
      ranges.push({ start, end: Math.min(start + chunkSize, range.end), total: size });
    }
  }
  return { copies, ranges, downloadBytes: ranges.reduce((sum, range) => sum + range.end - range.start, 0) };
}

async function writeAll(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesWritten) throw new Error('Could not write the update file.');
    offset += bytesWritten;
  }
}

async function verifyInstaller(filePath, sha512, signal) {
  const expected = Buffer.from(String(sha512 || ''), 'base64');
  if (expected.length !== 64) throw new Error('Missing or invalid update SHA-512.');
  const file = await fs.open(filePath, 'r');
  try {
    const hash = crypto.createHash('sha512');
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let position = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    signal?.throwIfAborted();
    if (!crypto.timingSafeEqual(hash.digest(), expected)) throw new Error('Update SHA-512 mismatch.');
  } finally {
    await file.close();
  }
}

async function downloadWithPlan({
  newFile, oldFile, size, sha512, operations, fetchRange, signal,
  onProgress = () => {}, onRetry = () => {}, concurrency = 4, chunkSize = CHUNK_SIZE,
  mergeGap = 32 * 1024, retryDelay = 250
}) {
  if (oldFile && path.resolve(oldFile).toLowerCase() === path.resolve(newFile).toLowerCase()) throw rangeError('Cannot overwrite the cached installer.');
  if (Buffer.from(String(sha512 || ''), 'base64').length !== 64) throw new Error('Missing or invalid update SHA-512.');
  const oldSize = oldFile ? (await fs.stat(oldFile)).size : 0;
  const plan = buildTransferPlan(operations, size, oldSize, chunkSize, mergeGap);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  const activeSignal = controller.signal;
  let output;
  let cached;
  let outputCreated = false;
  let verified = false;
  let completeBytes = 0;
  let wireBytes = 0;
  let lastWireBytes = 0;
  let lastProgressAt = 0;
  const started = Date.now();
  const partial = new Map();
  const progress = (verified = false) => {
    const now = Date.now();
    if (!verified && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    const transferred = completeBytes + [...partial.values()].reduce((sum, bytes) => sum + bytes, 0);
    onProgress({
      total: plan.downloadBytes,
      transferred,
      delta: wireBytes - lastWireBytes,
      bytesPerSecond: Math.round(wireBytes / Math.max(0.001, (now - started) / 1000)),
      percent: verified ? 100 : Math.min(99.9, plan.downloadBytes ? transferred * 100 / plan.downloadBytes : 0)
    });
    lastWireBytes = wireBytes;
  };
  try {
    activeSignal.throwIfAborted();
    if (plan.copies.length) cached = await fs.open(oldFile, 'r');
    activeSignal.throwIfAborted();
    output = await fs.open(newFile, 'w');
    outputCreated = true;
    activeSignal.throwIfAborted();
    await output.truncate(size);
    const buffer = Buffer.allocUnsafe(chunkSize);
    for (const copy of plan.copies) {
      let copied = 0;
      while (copied < copy.end - copy.start) {
        activeSignal.throwIfAborted();
        const length = Math.min(buffer.length, copy.end - copy.start - copied);
        const { bytesRead } = await cached.read(buffer, 0, length, copy.start + copied);
        if (bytesRead !== length) throw new Error('Cached installer is incomplete.');
        await writeAll(output, buffer.subarray(0, bytesRead), copy.offset + copied);
        copied += bytesRead;
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < plan.ranges.length) {
        activeSignal.throwIfAborted();
        const index = next++;
        const range = plan.ranges[index];
        let bytes;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          activeSignal.throwIfAborted();
          partial.set(index, 0);
          try {
            bytes = await fetchRange(range, { signal: activeSignal, onBytes: (count) => {
              wireBytes += count;
              partial.set(index, (partial.get(index) || 0) + count);
              progress();
            } });
            if (!Buffer.isBuffer(bytes) || bytes.length !== range.end - range.start) throw rangeError('Incorrect downloaded chunk size.');
            break;
          } catch (error) {
            partial.delete(index);
            if (activeSignal.aborted || error.code === 'ERR_UPDATE_RANGE' || attempt === 2) throw error;
            onRetry({ range, attempt: attempt + 1, error });
            await delay(retryDelay * (attempt + 1), undefined, { signal: activeSignal });
          }
        }
        activeSignal.throwIfAborted();
        await writeAll(output, bytes, range.start);
        partial.delete(index);
        completeBytes += bytes.length;
        progress();
      }
    };
    const workers = Array.from({ length: Math.min(4, Math.max(1, Math.floor(concurrency) || 1), plan.ranges.length) }, () => (
      worker().catch((error) => { controller.abort(error); throw error; })
    ));
    const results = await Promise.allSettled(workers);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw controller.signal.reason || failed.reason;
    activeSignal.throwIfAborted();
    await output.sync();
    await output.close();
    output = null;
    await verifyInstaller(newFile, sha512, activeSignal);
    activeSignal.throwIfAborted();
    progress(true);
    activeSignal.throwIfAborted();
    verified = true;
    return { downloadBytes: plan.downloadBytes, wireBytes, fullBytes: size, rangeCount: plan.ranges.length };
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', abort);
    // Settle both handles before deleting the incomplete temporary installer on
    // Windows. A failing close must not prevent the other handle being released.
    const closed = await Promise.allSettled([output?.close(), cached?.close()]);
    if (outputCreated && !verified) await fs.rm(newFile, { force: true });
    const closeFailure = closed.find((result) => result.status === 'rejected');
    if (verified && closeFailure) throw closeFailure.reason;
  }
}

module.exports = {
  buildTransferPlan,
  downloadWithPlan,
  fetchUpdateRange,
  resolveTrustedUpdateRedirect,
  verifyInstaller
};
