'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const {
  isConfirmedApiRateLimit,
  listTagArchivePaths,
  parseExpandedAssetsHtml,
  parseReleaseHtml
} = require('../scripts/verify-public-release');

const version = require('../package.json').version;
const tag = `v${version}`;
const repository = 'Redwolf29195/arma-reforger-launcher-updates';
const setup = `Arma-Reforger-Launcher-${version}-x64-Setup.exe`;
const names = [
  `Arma-Reforger-Launcher-${version}-x64-Portable.exe`,
  setup,
  `${setup}.algz.json`,
  `${setup}.blockmap`,
  'latest.yml'
];

test('accepts only an explicit GitHub API rate-limit response', () => {
  const response = (status, remaining) => ({ status, headers: new Headers({ 'x-ratelimit-remaining': remaining }) });
  assert.equal(isConfirmedApiRateLimit(response(403, '0')), true);
  assert.equal(isConfirmedApiRateLimit(response(429, '12'), 'secondary rate limit exceeded'), true);
  assert.equal(isConfirmedApiRateLimit(response(403, '12'), 'Forbidden'), false);
  assert.equal(isConfirmedApiRateLimit(response(500, '0'), 'API rate limit exceeded'), false);
});

test('requires the structural immutable marker and exact assets fragment', () => {
  const expanded = `https://github.com/${repository}/releases/expanded_assets/${tag}`;
  const html = `<svg class="octicon octicon-lock"></svg><span> Immutable <span class="sr-only">release. Locked</span></span>
    released this <relative-time datetime="2026-09-04T20:00:00Z"></relative-time>
    <include-fragment src="${expanded}"></include-fragment>`;
  assert.deepEqual(parseReleaseHtml(html, tag), {
    expandedUrl: expanded,
    publishedAt: '2026-09-04T20:00:00Z'
  });
  assert.throws(() => parseReleaseHtml(html.replace('octicon-lock', 'octicon-tag'), tag), /Immutable/);
});

test('requires exactly five tag-scoped assets and one digest per asset', () => {
  const digest = 'a'.repeat(64);
  const html = names.map((name) => `<a href="/${repository}/releases/download/${tag}/${encodeURIComponent(name)}"></a>
    <clipboard-copy aria-label="Copy to clipboard digest for ${name}" value="sha256:${digest}"></clipboard-copy>`).join('\n');
  const parsed = parseExpandedAssetsHtml(html, tag);
  assert.deepEqual([...parsed.keys()].sort(), [...names].sort());
  assert.throws(() => parseExpandedAssetsHtml(html.replace(/<a\b[^>]*><\/a>/, ''), tag), /exactly the five/);
});

function tarHeader(name, size, type) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header[156] = type.charCodeAt(0);
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function tagArchive(extraPath) {
  const root = `arma-reforger-launcher-updates-${version}/`;
  const chunks = [tarHeader(root, 0, '5'), tarHeader(`${root}README.md`, 2, '0'), Buffer.from('ok'), Buffer.alloc(510)];
  if (extraPath) chunks.push(tarHeader(`${root}${extraPath}`, 0, '0'));
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

test('accepts only a README-only public tag archive', () => {
  assert.deepEqual(listTagArchivePaths(tagArchive()), ['README.md']);
  assert.throws(() => listTagArchivePaths(tagArchive('src-main.js')), /unexpected files/);
});

test('rejects PAX path overrides and content hidden after the tar end marker', () => {
  const root = `arma-reforger-launcher-updates-${version}/`;
  const pax = Buffer.from('23 path=src/main.js\n');
  const paxArchive = zlib.gzipSync(Buffer.concat([
    tarHeader('pax-entry', pax.length, 'x'), pax, Buffer.alloc(512 - pax.length),
    tarHeader(root, 0, '5'), tarHeader(`${root}README.md`, 0, '0'), Buffer.alloc(1024)
  ]));
  assert.throws(() => listTagArchivePaths(paxArchive), /PAX metadata/);

  const validTar = zlib.gunzipSync(tagArchive());
  const hiddenEntry = tarHeader(`${root}hidden.js`, 0, '0');
  const trailingArchive = zlib.gzipSync(Buffer.concat([validTar, hiddenEntry, Buffer.alloc(1024)]));
  assert.throws(() => listTagArchivePaths(trailingArchive), /after its end marker/);
});
