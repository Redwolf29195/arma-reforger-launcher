'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  ORIGIN_ID,
  PRODUCT_ID,
  publicKeyFingerprint
} = require('../src/core/updateArtifactSignature');
const {
  UPDATE_POLICY_SCHEMA,
  canonicalUpdatePolicyPayload,
  encodeUpdatePolicyEnvelope,
  normalizeReleaseUpdatePolicy,
  parseUpdatePolicyEnvelope,
  verifyUpdatePolicyEnvelope
} = require('../src/core/updatePolicy');

const artifact = Object.freeze({
  artifactName: 'Arma-Reforger-Launcher-0.3.31-x64-Setup.exe',
  artifactSha512: 'ab'.repeat(64),
  artifactSize: 85_000_000,
  version: '0.3.31'
});

function createSignedPolicy(mode = 'semi-forced', gracePeriodSeconds = 300) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = {
    schema: UPDATE_POLICY_SCHEMA,
    productId: PRODUCT_ID,
    originId: ORIGIN_ID,
    version: artifact.version,
    artifactName: artifact.artifactName,
    artifactSize: artifact.artifactSize,
    artifactSha512: artifact.artifactSha512,
    mode,
    gracePeriodSeconds
  };
  envelope.signature = crypto.sign(
    null,
    Buffer.from(canonicalUpdatePolicyPayload(envelope), 'utf8'),
    privateKey
  ).toString('base64');
  return {
    encodedEnvelope: encodeUpdatePolicyEnvelope(envelope),
    envelope,
    fingerprint: publicKeyFingerprint(publicKey),
    publicKey
  };
}

function verifyFixture(fixture, overrides = {}) {
  return verifyUpdatePolicyEnvelope({
    encodedEnvelope: fixture.encodedEnvelope,
    publicKeyPem: fixture.publicKey,
    expectedVersion: artifact.version,
    expectedArtifactName: artifact.artifactName,
    expectedSha512: artifact.artifactSha512,
    expectedSize: artifact.artifactSize,
    ...overrides
  }, fixture.fingerprint);
}

test('normalizes optional, forced and five-minute semi-forced release policies', () => {
  assert.deepEqual(normalizeReleaseUpdatePolicy({}), {
    mode: 'optional',
    gracePeriodSeconds: 0
  });
  assert.deepEqual(normalizeReleaseUpdatePolicy({ mode: 'forced', gracePeriodSeconds: 0 }), {
    mode: 'forced',
    gracePeriodSeconds: 0
  });
  assert.deepEqual(normalizeReleaseUpdatePolicy({ mode: 'semi-forced' }), {
    mode: 'semi-forced',
    gracePeriodSeconds: 300
  });
  assert.throws(
    () => normalizeReleaseUpdatePolicy({ mode: 'semi-forced', gracePeriodSeconds: 30 }),
    /update-policy-grace/
  );
  assert.throws(
    () => normalizeReleaseUpdatePolicy({ mode: 'forced', gracePeriodSeconds: 300 }),
    /update-policy-grace/
  );
});

test('verifies a signed policy bound to the exact update artifact', () => {
  const fixture = createSignedPolicy();
  assert.deepEqual(verifyFixture(fixture), {
    artifactName: artifact.artifactName,
    gracePeriodSeconds: 300,
    mode: 'semi-forced',
    version: artifact.version
  });
});

test('rejects policy tampering and artifact metadata mismatches', () => {
  const fixture = createSignedPolicy();
  const tampered = {
    ...fixture.envelope,
    mode: 'forced',
    gracePeriodSeconds: 0
  };
  assert.throws(
    () => verifyFixture({ ...fixture, encodedEnvelope: encodeUpdatePolicyEnvelope(tampered) }),
    /update-policy-signature-invalid/
  );
  assert.throws(
    () => verifyFixture(fixture, { expectedSize: artifact.artifactSize + 1 }),
    /update-policy-artifact-size/
  );
  assert.throws(
    () => verifyFixture(fixture, { expectedSha512: 'cd'.repeat(64) }),
    /update-policy-artifact-digest/
  );
});

test('rejects malformed encodings, extra fields and the wrong public key', () => {
  const fixture = createSignedPolicy('forced', 0);
  assert.throws(() => parseUpdatePolicyEnvelope('not+base64', {
    expectedVersion: artifact.version,
    expectedArtifactName: artifact.artifactName,
    expectedSha512: artifact.artifactSha512,
    expectedSize: artifact.artifactSize
  }), /update-policy-envelope-encoding/);

  const extraField = encodeUpdatePolicyEnvelope({ ...fixture.envelope, ignored: true });
  assert.throws(
    () => verifyFixture({ ...fixture, encodedEnvelope: extraField }),
    /update-policy-envelope-fields/
  );

  const otherKey = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.throws(
    () => verifyUpdatePolicyEnvelope({
      encodedEnvelope: fixture.encodedEnvelope,
      publicKeyPem: otherKey,
      expectedVersion: artifact.version,
      expectedArtifactName: artifact.artifactName,
      expectedSha512: artifact.artifactSha512,
      expectedSize: artifact.artifactSize
    }, fixture.fingerprint),
    /update-policy-key-mismatch/
  );
});
