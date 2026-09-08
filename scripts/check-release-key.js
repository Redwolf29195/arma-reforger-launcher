/*! Copyright (c) 2026 ALGZ / ExtaZzZ. SPDX-License-Identifier: GPL-3.0-only */
'use strict';

// Read-only migration check: never creates, copies, replaces or prints a key.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PINNED_FINGERPRINT = '4c055e343c60696125c51ecf59509a721f7a4d173a9c16db8ca4a564fac7f610';

function readKey(file) {
  const status = fs.lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink() || status.size > 16 * 1024) {
    throw new Error('Expected a regular PEM key file smaller than 16 KiB.');
  }
  return fs.readFileSync(file);
}

function fingerprint(key) {
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

function main() {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/check-release-key.js [private-key-path]');
  const publicKey = crypto.createPublicKey(readKey(path.join(__dirname, '..', 'src', 'security', 'release-public-key.pem')));
  if (fingerprint(publicKey) !== PINNED_FINGERPRINT) throw new Error('Project public key does not match the existing release pin.');
  const defaultRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'ALGZ', 'ReleaseKeys')
    : path.join(os.homedir(), '.algz', 'release-keys');
  const keyPath = path.resolve(process.argv[2] || process.env.ALGZ_RELEASE_PRIVATE_KEY_FILE
    || path.join(defaultRoot, 'algz-launcher-ed25519-private.pem'));
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Existing release key is missing: ${keyPath}. Transfer it separately from the old PC. DO NOT generate a replacement key.`);
  }
  const privateKey = crypto.createPrivateKey(readKey(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519'
    || fingerprint(crypto.createPublicKey(privateKey)) !== PINNED_FINGERPRINT) {
    throw new Error('This private key does not match the existing ALGZ releases. No files were changed.');
  }
  const challenge = crypto.randomBytes(32);
  if (!crypto.verify(null, challenge, publicKey, crypto.sign(null, challenge, privateKey))) {
    throw new Error('Release key sign/verify check failed.');
  }
  process.stdout.write(`PASS: existing ALGZ release key matches; signing verified.\nPublic fingerprint: ${PINNED_FINGERPRINT}\nNo files were changed.\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`FAIL: ${error.message}\n`);
  process.exitCode = 1;
}
