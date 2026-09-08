/*! Copyright (c) 2026 ALGZ / ExtaZzZ. SPDX-License-Identifier: GPL-3.0-only */
'use strict';

const crypto = require('node:crypto');
const {
  ORIGIN_ID,
  PINNED_PUBLIC_KEY_FINGERPRINT,
  PRODUCT_ID,
  isSafeInstallerName,
  normalizeExpectedSha512,
  publicKeyFingerprint
} = require('./updateArtifactSignature');

const UPDATE_POLICY_SCHEMA = 1;
const UPDATE_POLICY_FIELD = 'algzUpdatePolicy';
const DEFAULT_SEMI_FORCED_GRACE_SECONDS = 5 * 60;
const MIN_SEMI_FORCED_GRACE_SECONDS = 60;
const MAX_SEMI_FORCED_GRACE_SECONDS = 60 * 60;
const MAX_ENCODED_UPDATE_POLICY_BYTES = 12 * 1024;
const UPDATE_POLICY_MODES = new Set(['optional', 'semi-forced', 'forced']);
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const ENVELOPE_KEYS = Object.freeze([
  'artifactName',
  'artifactSha512',
  'artifactSize',
  'gracePeriodSeconds',
  'mode',
  'originId',
  'productId',
  'schema',
  'signature',
  'version'
]);

function normalizeReleaseUpdatePolicy(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('update-policy-config-invalid');
  }
  const mode = String(value.mode || 'optional');
  if (!UPDATE_POLICY_MODES.has(mode)) throw new Error('update-policy-mode');
  const defaultGrace = mode === 'semi-forced' ? DEFAULT_SEMI_FORCED_GRACE_SECONDS : 0;
  const gracePeriodSeconds = value.gracePeriodSeconds === undefined
    ? defaultGrace
    : Number(value.gracePeriodSeconds);
  if (!Number.isSafeInteger(gracePeriodSeconds)) throw new Error('update-policy-grace');
  if (mode === 'semi-forced') {
    if (gracePeriodSeconds < MIN_SEMI_FORCED_GRACE_SECONDS
      || gracePeriodSeconds > MAX_SEMI_FORCED_GRACE_SECONDS) {
      throw new Error('update-policy-grace');
    }
  } else if (gracePeriodSeconds !== 0) {
    throw new Error('update-policy-grace');
  }
  return Object.freeze({ mode, gracePeriodSeconds });
}

function validateUpdatePolicyMetadata(metadata, options = {}) {
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') {
    throw new Error('update-policy-envelope-invalid');
  }
  if (metadata.schema !== UPDATE_POLICY_SCHEMA) throw new Error('update-policy-schema');
  if (metadata.productId !== PRODUCT_ID || metadata.originId !== ORIGIN_ID) {
    throw new Error('update-policy-origin');
  }
  if (typeof metadata.version !== 'string'
    || metadata.version.length > 64
    || !VERSION_PATTERN.test(metadata.version)) {
    throw new Error('update-policy-version');
  }
  if (typeof options.expectedVersion !== 'string' || metadata.version !== options.expectedVersion) {
    throw new Error('update-policy-version-mismatch');
  }
  if (!isSafeInstallerName(metadata.artifactName)) throw new Error('update-policy-artifact-name');
  if (!metadata.artifactName.includes(`-${metadata.version}-`)) {
    throw new Error('update-policy-artifact-name-version');
  }
  if (metadata.artifactName !== options.expectedArtifactName) {
    throw new Error('update-policy-artifact-name-mismatch');
  }
  if (!Number.isSafeInteger(metadata.artifactSize)
    || metadata.artifactSize < 1
    || metadata.artifactSize !== options.expectedSize) {
    throw new Error('update-policy-artifact-size');
  }
  if (typeof metadata.artifactSha512 !== 'string'
    || !/^[0-9a-f]{128}$/.test(metadata.artifactSha512)
    || metadata.artifactSha512 !== normalizeExpectedSha512(options.expectedSha512)) {
    throw new Error('update-policy-artifact-digest');
  }
  normalizeReleaseUpdatePolicy(metadata);
  return metadata;
}

function canonicalUpdatePolicyPayload(metadata) {
  return JSON.stringify({
    schema: Number(metadata.schema),
    productId: String(metadata.productId || ''),
    originId: String(metadata.originId || ''),
    version: String(metadata.version || ''),
    artifactName: String(metadata.artifactName || ''),
    artifactSize: Number(metadata.artifactSize),
    artifactSha512: String(metadata.artifactSha512 || ''),
    mode: String(metadata.mode || ''),
    gracePeriodSeconds: Number(metadata.gracePeriodSeconds)
  });
}

function encodeUpdatePolicyEnvelope(envelope) {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

function parseUpdatePolicyEnvelope(encodedEnvelope, options = {}) {
  if (typeof encodedEnvelope !== 'string'
    || encodedEnvelope.length < 8
    || encodedEnvelope.length > MAX_ENCODED_UPDATE_POLICY_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(encodedEnvelope)) {
    throw new Error('update-policy-envelope-encoding');
  }
  const bytes = Buffer.from(encodedEnvelope, 'base64url');
  if (bytes.toString('base64url') !== encodedEnvelope) {
    throw new Error('update-policy-envelope-encoding');
  }
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('update-policy-envelope-json');
  }
  if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object') {
    throw new Error('update-policy-envelope-invalid');
  }
  const keys = Object.keys(envelope).sort();
  if (keys.length !== ENVELOPE_KEYS.length
    || keys.some((key, index) => key !== ENVELOPE_KEYS[index])) {
    throw new Error('update-policy-envelope-fields');
  }
  validateUpdatePolicyMetadata(envelope, options);
  if (typeof envelope.signature !== 'string'
    || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) {
    throw new Error('update-policy-signature-encoding');
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature) {
    throw new Error('update-policy-signature-encoding');
  }
  return envelope;
}

function verifyUpdatePolicyEnvelope({
  encodedEnvelope,
  publicKeyPem,
  expectedVersion,
  expectedArtifactName,
  expectedSha512,
  expectedSize
}, expectedFingerprint = PINNED_PUBLIC_KEY_FINGERPRINT) {
  const envelope = parseUpdatePolicyEnvelope(encodedEnvelope, {
    expectedVersion,
    expectedArtifactName,
    expectedSha512,
    expectedSize
  });
  const key = publicKeyPem instanceof crypto.KeyObject && publicKeyPem.type === 'public'
    ? publicKeyPem
    : crypto.createPublicKey(publicKeyPem);
  if (publicKeyFingerprint(key) !== expectedFingerprint) throw new Error('update-policy-key-mismatch');
  const verified = crypto.verify(
    null,
    Buffer.from(canonicalUpdatePolicyPayload(envelope), 'utf8'),
    key,
    Buffer.from(envelope.signature, 'base64')
  );
  if (!verified) throw new Error('update-policy-signature-invalid');
  return Object.freeze({
    artifactName: envelope.artifactName,
    gracePeriodSeconds: envelope.gracePeriodSeconds,
    mode: envelope.mode,
    version: envelope.version
  });
}

module.exports = {
  DEFAULT_SEMI_FORCED_GRACE_SECONDS,
  MAX_ENCODED_UPDATE_POLICY_BYTES,
  MAX_SEMI_FORCED_GRACE_SECONDS,
  MIN_SEMI_FORCED_GRACE_SECONDS,
  UPDATE_POLICY_FIELD,
  UPDATE_POLICY_MODES,
  UPDATE_POLICY_SCHEMA,
  canonicalUpdatePolicyPayload,
  encodeUpdatePolicyEnvelope,
  normalizeReleaseUpdatePolicy,
  parseUpdatePolicyEnvelope,
  validateUpdatePolicyMetadata,
  verifyUpdatePolicyEnvelope
};
