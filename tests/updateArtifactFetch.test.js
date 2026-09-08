'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_SIGNATURE_ENVELOPE_BYTES } = require('../src/core/updateArtifactSignature');
const {
  UPDATE_ENVELOPE_BASE_URL,
  buildUpdateArtifactEnvelopeUrl,
  fetchUpdateArtifactEnvelope
} = require('../src/main/updateArtifactFetch');

const ARTIFACT_NAME = 'Arma-Reforger-Launcher-0.3.27-x64-Setup.exe';

async function withReferencedDeadline(operation) {
  // Mock fetches create no sockets. Keep the test alive for AbortSignal's
  // unref'ed timeout, and fail deterministically if the operation never ends.
  let watchdog;
  try {
    return await Promise.race([
      operation,
      new Promise((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('Mock fetch test did not settle before its deadline')), 1000);
      })
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

function headers(values = {}) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => normalized.get(String(name).toLowerCase()) ?? null };
}

function streamedResponse(chunks, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    url: options.url === undefined
      ? 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture?sp=r&sig=signed'
      : options.url,
    headers: headers(options.headers),
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      }
    }
  };
}

test('downloads a bounded detached envelope from the pinned release URL and trusted GitHub CDN', async () => {
  const expected = Buffer.from('{"schema":1}\n', 'utf8');
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return streamedResponse([expected.subarray(0, 5), expected.subarray(5)], {
      headers: { 'content-length': expected.length }
    });
  };

  const result = await fetchUpdateArtifactEnvelope({ artifactName: ARTIFACT_NAME, fetchImpl });
  assert.equal(Buffer.isBuffer(result), true);
  assert.deepEqual(result, expected);
  assert.equal(
    request.url,
    `${UPDATE_ENVELOPE_BASE_URL}${encodeURIComponent(ARTIFACT_NAME)}.algz.json`
  );
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'follow');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.equal(request.options.signal instanceof AbortSignal, true);
  assert.equal(buildUpdateArtifactEnvelopeUrl(ARTIFACT_NAME).search, '');
  assert.equal(buildUpdateArtifactEnvelopeUrl(ARTIFACT_NAME).hash, '');
});

test('rejects an oversized Content-Length before consuming response bytes', async () => {
  let bodyRead = false;
  const fetchImpl = async () => ({
    ok: true,
    url: 'https://objects.githubusercontent.com/github-production-release-asset/fixture?sig=signed',
    headers: headers({ 'content-length': MAX_SIGNATURE_ENVELOPE_BYTES + 1 }),
    body: {
      async *[Symbol.asyncIterator]() {
        bodyRead = true;
        yield Buffer.from('{}');
      }
    }
  });

  await assert.rejects(
    fetchUpdateArtifactEnvelope({ artifactName: ARTIFACT_NAME, fetchImpl }),
    /update-artifact-fetch-size/
  );
  assert.equal(bodyRead, false);
});

test('enforces the byte limit while streaming when Content-Length is absent', async () => {
  const first = Buffer.alloc(MAX_SIGNATURE_ENVELOPE_BYTES, 0x61);
  const fetchImpl = async () => streamedResponse([first, Buffer.from('x')], { headers: {} });
  await assert.rejects(
    fetchUpdateArtifactEnvelope({ artifactName: ARTIFACT_NAME, fetchImpl }),
    /update-artifact-fetch-size/
  );
});

test('rejects a successful response whose final redirect host is not a GitHub release host', async () => {
  const fetchImpl = async () => streamedResponse([Buffer.from('{}')], {
    url: 'https://downloads.evil.example/forged.algz.json'
  });
  await assert.rejects(
    fetchUpdateArtifactEnvelope({ artifactName: ARTIFACT_NAME, fetchImpl }),
    /update-artifact-fetch-final-url/
  );
});

test('rejects a fetch implementation that does not expose the final redirect URL', async () => {
  const fetchImpl = async () => streamedResponse([Buffer.from('{}')], { url: '' });
  await assert.rejects(
    fetchUpdateArtifactEnvelope({ artifactName: ARTIFACT_NAME, fetchImpl }),
    /update-artifact-fetch-final-url/
  );
});

test('uses the standard fetch implementation so the final GitHub CDN URL remains observable', async () => {
  const expected = Buffer.from('{"schema":1}\n', 'utf8');
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return streamedResponse([expected], {
      headers: { 'content-length': expected.length },
      url: 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture?sig=signed'
    });
  };
  try {
    assert.deepEqual(await fetchUpdateArtifactEnvelope({ artifactName: ARTIFACT_NAME }), expected);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(request.url, `${UPDATE_ENVELOPE_BASE_URL}${encodeURIComponent(ARTIFACT_NAME)}.algz.json`);
  assert.equal(request.options.redirect, 'follow');
});

test('rejects invalid installer names before calling fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return streamedResponse([Buffer.from('{}')]);
  };
  for (const artifactName of [
    '../Arma-Reforger-Launcher-0.3.27-x64-Setup.exe',
    'https://evil.example/Arma-Reforger-Launcher-0.3.27-x64-Setup.exe',
    'Arma-Reforger-Launcher-0.3.27-x64-Setup.exe?redirect=evil',
    'Arma-Reforger-Launcher-0.3.27-x64.exe'
  ]) {
    await assert.rejects(
      fetchUpdateArtifactEnvelope({ artifactName, fetchImpl }),
      /update-artifact-fetch-name/
    );
  }
  assert.equal(calls, 0);
});

test('aborts a fetch implementation that never resolves', async () => {
  const fetchImpl = () => new Promise(() => {});
  await assert.rejects(
    withReferencedDeadline(fetchUpdateArtifactEnvelope({ artifactName: ARTIFACT_NAME, fetchImpl, timeoutMs: 10 })),
    /update-artifact-fetch-timeout/
  );
});

test('a stalled body cannot hold the fetch timeout hostage through iterator cleanup', async () => {
  let cleanupCalled = false;
  const response = streamedResponse([]);
  response.body = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
        return() { cleanupCalled = true; return new Promise(() => {}); }
      };
    }
  };
  await assert.rejects(
    withReferencedDeadline(fetchUpdateArtifactEnvelope({ artifactName: ARTIFACT_NAME, fetchImpl: async () => response, timeoutMs: 10 })),
    /update-artifact-fetch-timeout/
  );
  assert.equal(cleanupCalled, true);
});

test('cancels a stalled reader without waiting for its cancel operation or masking timeout with releaseLock', async () => {
  let cancelled = false;
  let released = false;
  const response = streamedResponse([]);
  response.body = {
    getReader() {
      return {
        read: () => new Promise(() => {}),
        cancel() { cancelled = true; return new Promise(() => {}); },
        releaseLock() { released = true; throw new Error('pending read'); }
      };
    }
  };
  await assert.rejects(
    withReferencedDeadline(fetchUpdateArtifactEnvelope({ artifactName: ARTIFACT_NAME, fetchImpl: async () => response, timeoutMs: 10 })),
    /update-artifact-fetch-timeout/
  );
  assert.equal(cancelled, true);
  assert.equal(released, true);
});
