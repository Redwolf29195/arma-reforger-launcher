/*! Copyright (c) 2026 ALGZ / ExtaZzZ. SPDX-License-Identifier: GPL-3.0-only */
'use strict';

const {
  MAX_SIGNATURE_ENVELOPE_BYTES,
  SIGNATURE_FILE_SUFFIX,
  isSafeInstallerName
} = require('../core/updateArtifactSignature');

const UPDATE_ENVELOPE_BASE_URL = 'https://github.com/Redwolf29195/arma-reforger-launcher-updates/releases/latest/download/';
const DEFAULT_ENVELOPE_FETCH_TIMEOUT_MS = 15_000;
const MAXIMUM_ENVELOPE_FETCH_TIMEOUT_MS = 60_000;
const TRUSTED_GITHUB_RELEASE_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);
const GITHUB_RELEASE_CDN_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);

function artifactFetchError(code) {
  return Object.assign(new Error(code), { code });
}

function buildUpdateArtifactEnvelopeUrl(artifactName) {
  if (!isSafeInstallerName(artifactName)) throw artifactFetchError('update-artifact-fetch-name');
  const url = new URL(`${encodeURIComponent(artifactName)}${SIGNATURE_FILE_SUFFIX}`, UPDATE_ENVELOPE_BASE_URL);
  const pinnedBase = new URL(UPDATE_ENVELOPE_BASE_URL);
  if (
    url.protocol !== 'https:'
    || url.hostname !== pinnedBase.hostname
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.startsWith(pinnedBase.pathname)
  ) {
    throw artifactFetchError('update-artifact-fetch-url');
  }
  return url;
}

function validateFinalResponseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw artifactFetchError('update-artifact-fetch-final-url');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || url.hash
    || !TRUSTED_GITHUB_RELEASE_HOSTS.has(hostname)
    || (url.search && !GITHUB_RELEASE_CDN_HOSTS.has(hostname))
  ) {
    throw artifactFetchError('update-artifact-fetch-final-url');
  }
  return url;
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === 'function') {
    const value = response.headers.get(name);
    return value === null ? '' : String(value);
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(response?.headers || {})) {
    if (key.toLowerCase() === wanted) return String(Array.isArray(value) ? value[0] : value ?? '');
  }
  return '';
}

function declaredEnvelopeLength(response) {
  const value = responseHeader(response, 'content-length').trim();
  if (!value) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw artifactFetchError('update-artifact-fetch-content-length');
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > MAX_SIGNATURE_ENVELOPE_BYTES) {
    throw artifactFetchError('update-artifact-fetch-size');
  }
  return length;
}

function waitForAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || artifactFetchError('update-artifact-fetch-aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || artifactFetchError('update-artifact-fetch-aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function appendEnvelopeChunk(chunks, state, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.received += buffer.length;
  if (state.received > MAX_SIGNATURE_ENVELOPE_BYTES) {
    throw artifactFetchError('update-artifact-fetch-size');
  }
  chunks.push(buffer);
}

function releaseBody(operation) {
  // A pending next()/read() can prevent return()/cancel() from settling. Cleanup
  // must never extend the fetch deadline or hide the original body error.
  try {
    Promise.resolve(operation()).catch(() => {});
  } catch {}
}

async function readBoundedEnvelopeBody(response, signal) {
  const declaredLength = declaredEnvelopeLength(response);
  const chunks = [];
  const state = { received: 0 };
  const body = response.body;

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const iterator = body[Symbol.asyncIterator]();
    try {
      while (true) {
        const item = await waitForAbort(iterator.next(), signal);
        if (item.done) break;
        appendEnvelopeChunk(chunks, state, item.value);
      }
    } finally {
      releaseBody(() => iterator.return?.());
    }
  } else if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const item = await waitForAbort(reader.read(), signal);
        if (item.done) break;
        appendEnvelopeChunk(chunks, state, item.value);
      }
    } catch (error) {
      releaseBody(() => reader.cancel?.(error));
      throw error;
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
  } else if (typeof response.arrayBuffer === 'function') {
    appendEnvelopeChunk(chunks, state, await waitForAbort(response.arrayBuffer(), signal));
  } else {
    throw artifactFetchError('update-artifact-fetch-body');
  }

  if (declaredLength !== null && state.received !== declaredLength) {
    throw artifactFetchError('update-artifact-fetch-content-length');
  }
  return Buffer.concat(chunks, state.received);
}

function normalizeFetchOptions(input, overrides) {
  if (typeof input === 'string') return { ...overrides, artifactName: input };
  if (!input || Array.isArray(input) || typeof input !== 'object') return {};
  return input;
}

async function fetchUpdateArtifactEnvelope(input = {}, overrides = {}) {
  const options = normalizeFetchOptions(input, overrides);
  const requestUrl = buildUpdateArtifactEnvelopeUrl(options.artifactName);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw artifactFetchError('update-artifact-fetch-unavailable');
  const timeoutMs = options.timeoutMs === undefined
    ? DEFAULT_ENVELOPE_FETCH_TIMEOUT_MS
    : Number(options.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_ENVELOPE_FETCH_TIMEOUT_MS) {
    throw artifactFetchError('update-artifact-fetch-timeout-value');
  }

  const controller = new AbortController();
  const timeoutError = artifactFetchError('update-artifact-fetch-timeout');
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer.unref?.();
  try {
    const response = await waitForAbort(fetchImpl(requestUrl.href, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    }), controller.signal);
    validateFinalResponseUrl(response?.url);
    if (response?.ok !== true) throw artifactFetchError('update-artifact-fetch-http');
    return await readBoundedEnvelopeBody(response, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    if (controller.signal.reason === timeoutError) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_ENVELOPE_FETCH_TIMEOUT_MS,
  GITHUB_RELEASE_CDN_HOSTS,
  TRUSTED_GITHUB_RELEASE_HOSTS,
  UPDATE_ENVELOPE_BASE_URL,
  buildUpdateArtifactEnvelopeUrl,
  fetchDetachedUpdateEnvelope: fetchUpdateArtifactEnvelope,
  fetchUpdateArtifactEnvelope,
  readBoundedEnvelopeBody,
  validateFinalResponseUrl
};
