const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyUpdateError } = require('../src/core/updateError');

test('classifies a missing update channel without exposing the raw response', () => {
  assert.equal(classifyUpdateError(new Error('Cannot find channel "preview.yml" update info: HttpError: 404')), 'channel');
});

test('classifies common update transport failures', () => {
  assert.equal(classifyUpdateError(new Error('net::ERR_CONNECTION_RESET')), 'network');
  assert.equal(classifyUpdateError(Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' })), 'network');
});

test('classifies verification and storage failures', () => {
  assert.equal(classifyUpdateError(new Error('sha512 checksum mismatch')), 'verification');
  assert.equal(classifyUpdateError(Object.assign(new Error('write failed'), { code: 'ENOSPC' })), 'storage');
});

test('uses an unknown category for an unrecognized updater error', () => {
  assert.equal(classifyUpdateError(new Error('unexpected updater failure')), 'unknown');
});

test('does not classify stack paths as update failures', () => {
  for (const directory of ['verification', 'signature', '404', 'corrupt']) {
    const error = Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' });
    error.stack = `Error: request failed\n    at fetch (C:\\${directory}\\launcher.js:404:1)`;
    assert.equal(classifyUpdateError(error), 'network');
    delete error.code;
    assert.equal(classifyUpdateError(error), 'unknown');
  }
  const storage = Object.assign(new Error("EACCES: open 'C:\\verification\\installer.exe'"), { code: 'EACCES' });
  assert.equal(classifyUpdateError(storage), 'storage');
});
