// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { processCommandFlags } = require('../scripts/linux-package-smoke');

test('Linux package smoke identifies renderers in ordinary proc argv', () => {
  assert.deepEqual(processCommandFlags('/opt/Arma Reforger Launcher/app\0--type=renderer\0--lang=en-US\0'), {
    type: 'renderer', noSandbox: false
  });
});

test('Linux package smoke identifies renderers in Chromium rewritten process titles', () => {
  assert.deepEqual(processCommandFlags('/opt/Arma Reforger Launcher/app --type=renderer --lang=en-US\0'), {
    type: 'renderer', noSandbox: false
  });
});

test('Linux package smoke rejects partial renderer and sandbox switch matches', () => {
  for (const command of ['app prefix--type=renderer', 'app --type=renderer-helper', 'app --type=renderer.invalid']) {
    assert.notEqual(processCommandFlags(command).type, 'renderer', command);
  }
  for (const command of ['app --no-sandboxed', 'app prefix--no-sandbox', 'app --disable-setuid-sandbox']) {
    assert.equal(processCommandFlags(command).noSandbox, false, command);
  }
});

test('Linux package smoke detects disabled sandbox in both proc formats', () => {
  for (const command of [
    'app\0--type=renderer\0--no-sandbox\0',
    'app --type=renderer --no-sandbox',
    'app --no-sandbox=false --type=renderer'
  ]) {
    assert.deepEqual(processCommandFlags(command), { type: 'renderer', noSandbox: true }, command);
  }
});
