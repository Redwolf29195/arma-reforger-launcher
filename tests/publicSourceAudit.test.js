// SPDX-License-Identifier: GPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { auditFiles, collectCandidateFiles } = require('../scripts/audit-public-source');

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-source-audit-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}launcher-source-audit-`));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  }
  return root;
}

test('publication scan accepts a public verification envelope and harmless test marker strings', t => {
  const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const root = fixture(t, {
    'src/security/release-public-key.pem': ['-----BEGIN PUBLIC KEY-----', 'YWJjZA==', '-----END PUBLIC KEY-----', ''].join('\n'),
    'tests/marker.test.js': `const forbidden = Buffer.from('${marker}');`,
    'src/main/main.js': 'const home = process.env.USERPROFILE;'
  });
  const result = auditFiles(root, collectCandidateFiles(root).files);
  assert.equal(result.ok, true);
});

test('publication scan rejects credential values without including them in output', t => {
  const token = ['ghp', '_', 'a'.repeat(30)].join('');
  const root = fixture(t, { 'src/example.js': `const token = '${token}';` });
  const result = auditFiles(root, ['src/example.js']);
  assert.deepEqual(result.findings, [{ path: 'src/example.js', type: 'credential-shaped-token' }]);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('publication scan rejects private filenames and traversal before reading contents', t => {
  const root = fixture(t, {});
  const result = auditFiles(root, ['scripts/release-private.pem', '../outside.js', 'backups/data.zip']);
  assert.deepEqual(result.findings.map(entry => entry.type), ['private-or-generated-file', 'unsafe-relative-path', 'private-or-generated-file']);
});

test('publication scan rejects a private envelope stored under the public-key filename', t => {
  const privateHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const root = fixture(t, { 'src/security/release-public-key.pem': `${privateHeader}\nnot-a-real-key\n` });
  const result = auditFiles(root, ['src/security/release-public-key.pem']);
  assert.equal(result.findings[0].type, 'invalid-public-verification-key-envelope');
  assert.equal(JSON.stringify(result).includes(privateHeader), false);
});

test('exact publication manifests cannot include generated build outputs', t => {
  const root = fixture(t, { 'dist/app.js': 'generated', 'src/example.js': 'source' });
  assert.deepEqual(collectCandidateFiles(root), { files: ['src/example.js'], ignoredRoots: ['dist'] });
  assert.equal(auditFiles(root, ['dist/app.js']).findings[0].type, 'outside-public-allowlist');
});

test('publication scan identifies personal home paths while allowing portable environment lookups', t => {
  const root = fixture(t, {
    'scripts/local.js': `const directory = ${JSON.stringify(['C:', 'Users', 'ExampleOwner', 'project'].join('\\'))};`,
    'src/portable.js': 'const directory = process.env.LOCALAPPDATA;'
  });
  assert.deepEqual(auditFiles(root, ['scripts/local.js', 'src/portable.js']).findings,
    [{ path: 'scripts/local.js', type: 'personal-home-path' }]);
});

test('publication scan rejects unrecognized binary payloads inside source folders', t => {
  const root = fixture(t, { 'src/payload.bin': Buffer.from([0, 1, 2]) });
  assert.equal(auditFiles(root, ['src/payload.bin']).findings[0].type, 'unrecognized-binary-or-data-file');
});

test('publication scan distinguishes password locale keys from literal credential assignments', t => {
  const credential = ['synthetic', 'value'].join('-');
  const root = fixture(t, {
    'src/labels.js': "const labels = { 'servers.password': 'Password protected' };",
    'scripts/config.js': `const ${['pass', 'word'].join('')} = ${JSON.stringify(credential)};`
  });
  assert.deepEqual(auditFiles(root, ['src/labels.js', 'scripts/config.js']).findings,
    [{ path: 'scripts/config.js', type: 'credential-literal-assignment' }]);
});
