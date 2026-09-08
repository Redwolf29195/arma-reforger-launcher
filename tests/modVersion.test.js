const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareModVersions,
  modVersionsEqual,
  parseModVersion,
  selectCurrentModVersion
} = require('../src/core/modVersion');

test('treats harmless Workshop version formatting differences as equal', () => {
  assert.equal(modVersionsEqual('v1.2.0', '1.2'), true);
  assert.equal(modVersionsEqual(' 1.2.3+workshop.9 ', '1.2.3+workshop.10'), true);
  assert.equal(modVersionsEqual('1.2.3-rc.1', '1.2.3'), false);
});

test('orders numeric mod revisions without relying on string sorting', () => {
  assert.equal(compareModVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareModVersions('2.0', '2.0.0'), 0);
  assert.equal(compareModVersions('2.0-beta.2', '2.0-beta.10'), -1);
  assert.equal(compareModVersions('custom', '2.0'), null);
});

test('parses large numeric revision components safely', () => {
  const parsed = parseModVersion('v1.999999999999999999999.0');
  assert.deepEqual(parsed.parts, [1n, 999999999999999999999n]);
});

test('uses a newer installed version but keeps a newer required version', () => {
  assert.equal(selectCurrentModVersion('1.9.0', '2.0.0'), '2.0.0');
  assert.equal(selectCurrentModVersion('2.0.0', '1.9.0'), '2.0.0');
  assert.equal(selectCurrentModVersion('v2.0', '2.0.0'), '2.0.0');
});
