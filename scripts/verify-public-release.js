'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { version } = require('../package.json');

const repository = 'Redwolf29195/arma-reforger-launcher-updates';
const api = `https://api.github.com/repos/${repository}`;
const releaseRoot = path.resolve(__dirname, '..', 'dist-release', version);
const setup = `Arma-Reforger-Launcher-${version}-x64-Setup.exe`;
const expectedNames = [
  `Arma-Reforger-Launcher-${version}-x64-Portable.exe`,
  setup, `${setup}.algz.json`, `${setup}.blockmap`, 'latest.yml'
].sort();

class GitHubApiRateLimitError extends Error {
  constructor(url, response) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const resetAt = Number.isSafeInteger(reset) && reset > 0
      ? new Date(reset * 1000).toISOString()
      : null;
    super(`GitHub API rate limit confirmed${resetAt ? ` until ${resetAt}` : ''} (${url})`);
    this.name = 'GitHubApiRateLimitError';
    this.resetAt = resetAt;
  }
}

function isConfirmedApiRateLimit(response, body = '') {
  if (response.status !== 403 && response.status !== 429) return false;
  return response.headers.get('x-ratelimit-remaining') === '0'
    || /(?:API|secondary) rate limit/i.test(body);
}

async function request(url, options = {}) {
  const { timeoutMs = 60_000, ...fetchOptions } = options;
  const response = await fetch(url, {
    ...fetchOptions,
    signal: fetchOptions.signal || AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'ALGZ-release-verification', ...fetchOptions.headers }
  });
  if (!response.ok) {
    const body = await response.text();
    if (new URL(url).hostname === 'api.github.com' && isConfirmedApiRateLimit(response, body)) {
      throw new GitHubApiRateLimitError(url, response);
    }
    throw new Error(`Public release request failed: HTTP ${response.status} (${url})`);
  }
  return response;
}

async function hashFile(filePath) {
  const digest = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fsSync.createReadStream(filePath)) {
    size += chunk.length;
    digest.update(chunk);
  }
  return { size, sha256: digest.digest('hex') };
}

async function loadLocalFiles() {
  assert.deepEqual((await fs.readdir(releaseRoot)).sort(), expectedNames);
  const files = [];
  for (const name of expectedNames) {
    files.push({ name, ...await hashFile(path.join(releaseRoot, name)) });
  }
  return files;
}

function htmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/\b([\w:-]+)="([^"]*)"/g)) attributes[match[1]] = match[2];
  return attributes;
}

function parseReleaseHtml(html, tag) {
  const immutable = /<svg\b[^>]*class="[^"]*\bocticon-lock\b[^"]*"[^>]*>[\s\S]*?<\/svg>\s*<span>\s*Immutable\s*<span class="sr-only">\s*release\./.test(html);
  assert.equal(immutable, true, 'Public release page does not contain the structural Immutable marker');

  const expectedExpandedUrl = `https://github.com/${repository}/releases/expanded_assets/${tag}`;
  const expandedUrls = [...html.matchAll(/<include-fragment\b[^>]*>/g)]
    .map((match) => htmlAttributes(match[0]).src)
    .filter((src) => src && src.includes('/releases/expanded_assets/'));
  assert.deepEqual(expandedUrls, [expectedExpandedUrl], 'Release assets fragment does not target the expected tag');

  const published = html.match(/released this[\s\S]{0,700}<relative-time\b[^>]*datetime="([^"]+)"/);
  assert.ok(published, 'Release publication timestamp is missing');
  assert.ok(Number.isFinite(Date.parse(published[1])), 'Release publication timestamp is invalid');
  return { expandedUrl: expectedExpandedUrl, publishedAt: published[1] };
}

function parseExpandedAssetsHtml(html, tag) {
  const prefix = `/${repository}/releases/download/${tag}/`;
  const names = [];
  for (const match of html.matchAll(/<a\b[^>]*>/g)) {
    const href = htmlAttributes(match[0]).href;
    if (!href || !href.startsWith(prefix)) continue;
    const encodedName = href.slice(prefix.length);
    assert.ok(encodedName && !encodedName.includes('/'), 'Release asset link has an invalid filename');
    names.push(decodeURIComponent(encodedName));
  }
  assert.deepEqual(names.sort(), expectedNames, 'Public release does not contain exactly the five expected assets');

  const digests = new Map();
  for (const match of html.matchAll(/<clipboard-copy\b[^>]*>/g)) {
    const attributes = htmlAttributes(match[0]);
    const labelPrefix = 'Copy to clipboard digest for ';
    if (!attributes['aria-label']?.startsWith(labelPrefix)) continue;
    const name = attributes['aria-label'].slice(labelPrefix.length);
    if (!expectedNames.includes(name)) continue;
    assert.match(attributes.value || '', /^sha256:[0-9a-f]{64}$/);
    assert.equal(digests.has(name), false, `Duplicate digest for ${name}`);
    digests.set(name, attributes.value.slice('sha256:'.length));
  }
  assert.deepEqual([...digests.keys()].sort(), expectedNames, 'One or more public asset digests are missing');
  return digests;
}

function listTagArchivePaths(compressed) {
  const tar = zlib.gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 });
  const entries = [];
  let offset = 0;
  let reachedEnd = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      reachedEnd = true;
      break;
    }
    const readString = (start, length) => {
      const field = header.subarray(start, start + length);
      const zero = field.indexOf(0);
      return field.subarray(0, zero === -1 ? field.length : zero).toString('utf8');
    };
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const checksumField = readString(148, 8).trim();
    assert.match(checksumField, /^[0-7]+$/, `Invalid tar checksum for ${fullName}`);
    const expectedChecksum = Number.parseInt(checksumField, 8);
    let actualChecksum = 0;
    for (let i = 0; i < header.length; i++) actualChecksum += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(actualChecksum, expectedChecksum, `Tar checksum differs for ${fullName}`);
    const sizeField = readString(124, 12).trim();
    assert.match(sizeField, /^[0-7]+$/, `Invalid tar size for ${fullName}`);
    const size = Number.parseInt(sizeField, 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0, `Invalid tar entry size for ${fullName}`);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    offset += 512 + Math.ceil(size / 512) * 512;
    assert.ok(offset <= tar.length, `Truncated tar entry ${fullName}`);
    assert.notEqual(type, 'x', 'Per-file PAX metadata is not allowed in the public tag archive');
    if (type === 'g') {
      const pax = tar.subarray(dataStart, dataEnd).toString('utf8');
      const comment = pax.match(/^(\d+) comment=[0-9a-f]{40}\n$/);
      assert.ok(comment && Number(comment[1]) === Buffer.byteLength(pax), 'Unexpected global PAX metadata');
      continue;
    }
    entries.push({ name: fullName, type });
  }
  assert.equal(reachedEnd, true, 'Tag archive has no tar end marker');
  assert.ok(tar.length - offset >= 1024, 'Tag archive has fewer than two tar end blocks');
  assert.equal(tar.subarray(offset).every((value) => value === 0), true, 'Tag archive contains data after its end marker');

  const roots = entries.filter((entry) => entry.type === '5' && /^[^/]+\/$/.test(entry.name));
  assert.equal(roots.length, 1, 'Tag archive must contain one root directory');
  const root = roots[0].name;
  const tree = entries
    .filter((entry) => entry.name !== root)
    .map((entry) => {
      assert.ok(entry.name.startsWith(root), `Tag archive entry escapes its root: ${entry.name}`);
      const relative = entry.name.slice(root.length).replace(/\/$/, '');
      assert.ok(relative && !relative.split('/').includes('..'), `Invalid tag archive path: ${entry.name}`);
      return { path: relative, type: entry.type };
    });
  assert.deepEqual(tree, [{ path: 'README.md', type: '0' }], 'Public tag contains unexpected files');
  return tree.map((entry) => entry.path);
}

async function downloadAndHash(url) {
  const response = await request(url, { timeoutMs: 300_000 });
  const finalUrl = new URL(response.url);
  assert.equal(finalUrl.protocol, 'https:');
  assert.equal(finalUrl.hostname, 'release-assets.githubusercontent.com', 'Asset was not served by GitHub release storage');
  assert.ok(response.body, `Public asset response has no body (${url})`);
  const digest = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    digest.update(bytes);
  }
  return { size, sha256: digest.digest('hex') };
}

async function verifyWithApi(files) {
  const release = await (await request(`${api}/releases/latest`)).json();
  assert.equal(release.tag_name, `v${version}`, 'Latest release is not the newly built version');
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert.equal(release.immutable, true);
  assert.deepEqual(release.assets.map((asset) => asset.name).sort(), expectedNames);
  for (const file of files) {
    const asset = release.assets.find((item) => item.name === file.name);
    assert.equal(asset.state, 'uploaded', `${file.name} is not fully uploaded`);
    assert.equal(asset.size, file.size, `${file.name} size differs`);
    assert.equal(asset.digest, `sha256:${file.sha256}`, `${file.name} GitHub digest differs`);
    if (file.name.endsWith('.exe')) continue;
    const local = await fs.readFile(path.join(releaseRoot, file.name));
    for (const ref of [`download/v${version}`, 'latest/download']) {
      const response = await request(`https://github.com/${repository}/releases/${ref}/${encodeURIComponent(file.name)}`);
      const remote = Buffer.from(await response.arrayBuffer());
      assert.ok(remote.equals(local), `${ref}/${file.name} differs from audited local artifact`);
    }
  }
  const response = await request(`https://github.com/${repository}/releases/latest/download/${setup}`, {
    headers: { Range: 'bytes=0-1023' }
  });
  assert.equal(response.status, 206, 'Installer range request was not honored');
  assert.match(response.headers.get('content-range') || '', /^bytes 0-1023\/\d+$/);
  const remotePrefix = Buffer.from(await response.arrayBuffer());
  const handle = await fs.open(path.join(releaseRoot, setup), 'r');
  const localPrefix = Buffer.alloc(1024);
  try {
    await handle.read(localPrefix, 0, 1024, 0);
  } finally {
    await handle.close();
  }
  assert.ok(remotePrefix.equals(localPrefix), 'Public installer bytes differ');
  const tree = await (await request(`${api}/git/trees/v${version}?recursive=1`)).json();
  assert.equal(tree.truncated, false);
  assert.deepEqual(tree.tree.map((entry) => entry.path), ['README.md'], 'Public tag contains unexpected files');
  return {
    url: release.html_url,
    publishedAt: release.published_at,
    immutable: release.immutable,
    publicSourceFiles: tree.tree.map((entry) => entry.path),
    verificationMode: 'github-api'
  };
}

async function verifyWithoutApi(files, rateLimitError) {
  const tag = `v${version}`;
  const tagUrl = `https://github.com/${repository}/releases/tag/${tag}`;
  const latestResponse = await request(`https://github.com/${repository}/releases/latest`);
  assert.equal(latestResponse.url, tagUrl, 'Public Latest redirect does not resolve to the new tag');
  const { expandedUrl, publishedAt } = parseReleaseHtml(await latestResponse.text(), tag);
  const tagResponse = await request(tagUrl);
  assert.equal(tagResponse.url, tagUrl, 'Public tag URL redirected unexpectedly');
  parseReleaseHtml(await tagResponse.text(), tag);
  const digests = parseExpandedAssetsHtml(await (await request(expandedUrl)).text(), tag);
  for (const file of files) assert.equal(digests.get(file.name), file.sha256, `${file.name} HTML digest differs`);

  for (const ref of [`download/${tag}`, 'latest/download']) {
    for (const file of files) {
      const remote = await downloadAndHash(
        `https://github.com/${repository}/releases/${ref}/${encodeURIComponent(file.name)}`
      );
      assert.equal(remote.size, file.size, `${ref}/${file.name} size differs`);
      assert.equal(remote.sha256, file.sha256, `${ref}/${file.name} SHA-256 differs`);
    }
  }
  const archive = await request(`https://github.com/${repository}/archive/refs/tags/${tag}.tar.gz`);
  const archiveUrl = new URL(archive.url);
  assert.equal(archiveUrl.protocol, 'https:');
  assert.equal(archiveUrl.hostname, 'codeload.github.com', 'Tag archive was not served by GitHub codeload');
  const publicSourceFiles = listTagArchivePaths(Buffer.from(await archive.arrayBuffer()));
  return {
    url: tagUrl,
    publishedAt,
    immutable: true,
    publicSourceFiles,
    verificationMode: 'public-html-rate-limit-fallback',
    apiRateLimitResetAt: rateLimitError.resetAt
  };
}

async function main() {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const files = await loadLocalFiles();
  let release;
  try {
    release = await verifyWithApi(files);
  } catch (error) {
    if (!(error instanceof GitHubApiRateLimitError)) throw error;
    process.stderr.write(`${error.message}; using strict public HTML/download/archive fallback\n`);
    release = await verifyWithoutApi(files, error);
  }
  process.stdout.write(`${JSON.stringify({ version, verified: true, ...release, files }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  isConfirmedApiRateLimit,
  listTagArchivePaths,
  parseExpandedAssetsHtml,
  parseReleaseHtml
};
