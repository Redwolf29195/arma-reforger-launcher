/*! Copyright (c) 2026 ALGZ / ExtaZzZ. SPDX-License-Identifier: GPL-3.0-only */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ARTIFACT_SIGNATURE_SCHEMA = 1;
const PRODUCT_ID = 'app.armareforger.launcher';
const ORIGIN_ID = 'ALGZ-ARL-e377d956209c489eb308586aa2eecfdd';
const PINNED_PUBLIC_KEY_FINGERPRINT = '4c055e343c60696125c51ecf59509a721f7a4d173a9c16db8ca4a564fac7f610';
const PINNED_PUBLIC_KEY_PATH = path.join(__dirname, '..', 'security', 'release-public-key.pem');
const SIGNATURE_FILE_SUFFIX = '.algz.json';
const MAX_SIGNATURE_ENVELOPE_BYTES = 16 * 1024;
const MAX_UPDATE_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const ENVELOPE_KEYS = Object.freeze([
  'artifactName',
  'originId',
  'productId',
  'schema',
  'sha512',
  'signature',
  'size',
  'version'
]);

function publicKeyFingerprint(publicKey) {
  const key = publicKey instanceof crypto.KeyObject && publicKey.type === 'public'
    ? publicKey
    : crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('update-artifact-key-type');
  return crypto.createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

function isSafeInstallerName(artifactName) {
  if (typeof artifactName !== 'string'
    || artifactName.length < 10
    || artifactName.length > 200
    || Buffer.byteLength(artifactName, 'utf8') !== artifactName.length
    || !/^[A-Za-z0-9][A-Za-z0-9._()+ -]*-Setup\.exe$/.test(artifactName)
    || artifactName.includes('..')
    || artifactName.endsWith(' ')
    || path.posix.basename(artifactName) !== artifactName
    || path.win32.basename(artifactName) !== artifactName) {
    return false;
  }

  const windowsStem = artifactName.slice(0, -4).split('.')[0].replace(/[ .]+$/g, '').toUpperCase();
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsStem);
}

function validateVersion(version) {
  return typeof version === 'string' && version.length <= 64 && VERSION_PATTERN.test(version);
}

function validateArtifactSignatureMetadata(metadata, options = {}) {
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') {
    throw new Error('update-artifact-envelope-invalid');
  }
  if (metadata.schema !== ARTIFACT_SIGNATURE_SCHEMA) throw new Error('update-artifact-schema');
  if (metadata.productId !== PRODUCT_ID || metadata.originId !== ORIGIN_ID) {
    throw new Error('update-artifact-origin');
  }
  if (!validateVersion(metadata.version)) throw new Error('update-artifact-version');
  if (typeof options.expectedVersion !== 'string' || metadata.version !== options.expectedVersion) {
    throw new Error('update-artifact-version-mismatch');
  }
  if (!isSafeInstallerName(metadata.artifactName)) throw new Error('update-artifact-name');
  if (!metadata.artifactName.includes(`-${metadata.version}-`)) {
    throw new Error('update-artifact-name-version');
  }
  if (options.expectedArtifactName !== undefined && metadata.artifactName !== options.expectedArtifactName) {
    throw new Error('update-artifact-name-mismatch');
  }
  if (!Number.isSafeInteger(metadata.size)
    || metadata.size < 1
    || metadata.size > MAX_UPDATE_ARTIFACT_BYTES) {
    throw new Error('update-artifact-size');
  }
  if (typeof metadata.sha512 !== 'string' || !/^[0-9a-f]{128}$/.test(metadata.sha512)) {
    throw new Error('update-artifact-digest');
  }

  return metadata;
}

function canonicalArtifactSignaturePayload(metadata) {
  return JSON.stringify({
    schema: Number(metadata.schema),
    productId: String(metadata.productId || ''),
    originId: String(metadata.originId || ''),
    version: String(metadata.version || ''),
    artifactName: String(metadata.artifactName || ''),
    size: Number(metadata.size),
    sha512: String(metadata.sha512 || '')
  });
}

function parseArtifactSignatureEnvelope(contents, options = {}) {
  if (!Buffer.isBuffer(contents) && typeof contents !== 'string') {
    throw new Error('update-artifact-envelope-type');
  }
  const byteLength = Buffer.isBuffer(contents)
    ? contents.length
    : Buffer.byteLength(contents, 'utf8');
  if (byteLength < 2 || byteLength > MAX_SIGNATURE_ENVELOPE_BYTES) {
    throw new Error('update-artifact-envelope-size');
  }

  let envelope;
  try {
    envelope = JSON.parse(Buffer.isBuffer(contents) ? contents.toString('utf8') : contents);
  } catch {
    throw new Error('update-artifact-envelope-json');
  }
  if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object') {
    throw new Error('update-artifact-envelope-invalid');
  }
  const keys = Object.keys(envelope).sort();
  if (keys.length !== ENVELOPE_KEYS.length
    || keys.some((key, index) => key !== ENVELOPE_KEYS[index])) {
    throw new Error('update-artifact-envelope-fields');
  }

  validateArtifactSignatureMetadata(envelope, options);
  if (typeof envelope.signature !== 'string'
    || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) {
    throw new Error('update-artifact-signature-encoding');
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature) {
    throw new Error('update-artifact-signature-encoding');
  }
  return envelope;
}

function verifyArtifactEnvelopeSignature(envelope, publicKey, expectedFingerprint) {
  const key = publicKey instanceof crypto.KeyObject && publicKey.type === 'public'
    ? publicKey
    : crypto.createPublicKey(publicKey);
  const fingerprint = publicKeyFingerprint(key);
  if (typeof expectedFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(expectedFingerprint)
    || fingerprint !== expectedFingerprint) {
    throw new Error('update-artifact-key-mismatch');
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  const verified = crypto.verify(
    null,
    Buffer.from(canonicalArtifactSignaturePayload(envelope), 'utf8'),
    key,
    signature
  );
  if (!verified) throw new Error('update-artifact-signature-invalid');
  return true;
}

function safeAbsoluteLocalPath(filePath, errorCode) {
  if (typeof filePath !== 'string'
    || filePath.length < 1
    || filePath.length > 32_767
    || filePath.includes('\0')
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(filePath)
    || !path.isAbsolute(filePath)) {
    throw new Error(errorCode);
  }
  return path.resolve(filePath);
}

async function hashAndInspectArtifact(artifactPath) {
  const resolvedPath = safeAbsoluteLocalPath(artifactPath, 'update-artifact-path');
  const linkStatus = await fs.promises.lstat(resolvedPath);
  if (linkStatus.isSymbolicLink() || !linkStatus.isFile()) throw new Error('update-artifact-file-type');
  if (linkStatus.size < 1 || linkStatus.size > MAX_UPDATE_ARTIFACT_BYTES) {
    throw new Error('update-artifact-size');
  }

  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(resolvedPath, fs.constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== linkStatus.size) throw new Error('update-artifact-file-changed');
    const hash = crypto.createHash('sha512');
    let bytesRead = 0;
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) {
      bytesRead += chunk.length;
      if (bytesRead > MAX_UPDATE_ARTIFACT_BYTES) throw new Error('update-artifact-size');
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (bytesRead !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) {
      throw new Error('update-artifact-file-changed');
    }
    return {
      artifactName: path.basename(resolvedPath),
      path: resolvedPath,
      sha512: hash.digest('hex'),
      size: bytesRead
    };
  } finally {
    await handle.close();
  }
}

function equalHex(left, right) {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeExpectedSha512(expectedSha512) {
  if (typeof expectedSha512 !== 'string') throw new Error('update-artifact-metadata-digest');
  if (/^[0-9a-f]{128}$/.test(expectedSha512)) return expectedSha512;
  if (!/^[A-Za-z0-9+/]{86}==$/.test(expectedSha512)) {
    throw new Error('update-artifact-metadata-digest');
  }
  const decoded = Buffer.from(expectedSha512, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== expectedSha512) {
    throw new Error('update-artifact-metadata-digest');
  }
  return decoded.toString('hex');
}

function normalizeEnvelopeForVerification(envelope, options) {
  if (Buffer.isBuffer(envelope) || typeof envelope === 'string') {
    return parseArtifactSignatureEnvelope(envelope, options);
  }
  let serialized;
  try {
    serialized = JSON.stringify(envelope);
  } catch {
    throw new Error('update-artifact-envelope-invalid');
  }
  return parseArtifactSignatureEnvelope(serialized, options);
}

async function verifyUpdateArtifactFileAgainstFingerprint({
  envelope,
  publicKeyPem,
  filePath,
  expectedVersion,
  expectedArtifactName,
  expectedSha512,
  expectedSize
}, expectedPublicKeyFingerprint) {
  if (!isSafeInstallerName(expectedArtifactName)) throw new Error('update-artifact-expected-name');
  if (!Number.isSafeInteger(expectedSize)
    || expectedSize < 1
    || expectedSize > MAX_UPDATE_ARTIFACT_BYTES) {
    throw new Error('update-artifact-metadata-size');
  }
  const metadataSha512 = normalizeExpectedSha512(expectedSha512);
  const parsedEnvelope = normalizeEnvelopeForVerification(envelope, {
    expectedVersion,
    expectedArtifactName
  });
  verifyArtifactEnvelopeSignature(parsedEnvelope, publicKeyPem, expectedPublicKeyFingerprint);
  if (parsedEnvelope.size !== expectedSize || !equalHex(parsedEnvelope.sha512, metadataSha512)) {
    throw new Error('update-artifact-metadata-mismatch');
  }

  const actual = await hashAndInspectArtifact(filePath);
  if (actual.size !== parsedEnvelope.size || !equalHex(actual.sha512, parsedEnvelope.sha512)) {
    throw new Error('update-artifact-content-mismatch');
  }
  return Object.freeze({
    artifactName: parsedEnvelope.artifactName,
    sha512: parsedEnvelope.sha512,
    size: parsedEnvelope.size,
    version: parsedEnvelope.version
  });
}

async function verifyUpdateArtifactFile(options) {
  return verifyUpdateArtifactFileAgainstFingerprint(options, PINNED_PUBLIC_KEY_FINGERPRINT);
}

async function verifySignedUpdateArtifact({ artifactPath, envelopeBytes, expectedVersion }) {
  const resolvedArtifactPath = safeAbsoluteLocalPath(artifactPath, 'update-artifact-path');
  const artifactName = path.basename(resolvedArtifactPath);
  const envelope = parseArtifactSignatureEnvelope(envelopeBytes, {
    expectedVersion,
    expectedArtifactName: artifactName
  });
  const publicKey = await fs.promises.readFile(PINNED_PUBLIC_KEY_PATH);
  return verifyUpdateArtifactFile({
    envelope,
    publicKeyPem: publicKey,
    filePath: resolvedArtifactPath,
    expectedVersion,
    expectedArtifactName: artifactName,
    expectedSha512: envelope.sha512,
    expectedSize: envelope.size
  });
}

async function verifySignedUpdateArtifactFiles({ artifactPath, signaturePath, expectedVersion }) {
  const resolvedArtifactPath = safeAbsoluteLocalPath(artifactPath, 'update-artifact-path');
  const resolvedSignaturePath = safeAbsoluteLocalPath(signaturePath, 'update-artifact-signature-path');
  if (resolvedSignaturePath !== `${resolvedArtifactPath}${SIGNATURE_FILE_SUFFIX}`) {
    throw new Error('update-artifact-signature-path-mismatch');
  }
  const linkStatus = await fs.promises.lstat(resolvedSignaturePath);
  if (linkStatus.isSymbolicLink() || !linkStatus.isFile()) throw new Error('update-artifact-signature-file');
  if (linkStatus.size < 2 || linkStatus.size > MAX_SIGNATURE_ENVELOPE_BYTES) {
    throw new Error('update-artifact-signature-file');
  }
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(resolvedSignaturePath, fs.constants.O_RDONLY | noFollow);
  let envelopeBytes;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== linkStatus.size) {
      throw new Error('update-artifact-signature-file-changed');
    }
    envelopeBytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < envelopeBytes.length) {
      const result = await handle.read(envelopeBytes, offset, envelopeBytes.length - offset, offset);
      if (result.bytesRead < 1) throw new Error('update-artifact-signature-file-changed');
      offset += result.bytesRead;
    }
    const overflow = Buffer.alloc(1);
    const extra = await handle.read(overflow, 0, 1, offset);
    const after = await handle.stat();
    if (extra.bytesRead !== 0 || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('update-artifact-signature-file-changed');
    }
  } finally {
    await handle.close();
  }
  return verifySignedUpdateArtifact({ artifactPath: resolvedArtifactPath, envelopeBytes, expectedVersion });
}

module.exports = {
  ARTIFACT_SIGNATURE_SCHEMA,
  MAX_SIGNATURE_ENVELOPE_BYTES,
  MAX_UPDATE_ARTIFACT_BYTES,
  ORIGIN_ID,
  PINNED_PUBLIC_KEY_FINGERPRINT,
  PINNED_PUBLIC_KEY_PATH,
  PRODUCT_ID,
  SIGNATURE_FILE_SUFFIX,
  canonicalArtifactSignaturePayload,
  hashAndInspectArtifact,
  isSafeInstallerName,
  normalizeExpectedSha512,
  parseArtifactSignatureEnvelope,
  publicKeyFingerprint,
  validateArtifactSignatureMetadata,
  verifyArtifactEnvelopeSignature,
  verifySignedUpdateArtifact,
  verifySignedUpdateArtifactFiles,
  verifyUpdateArtifactFile,
  verifyUpdateArtifactFileAgainstFingerprint
};
