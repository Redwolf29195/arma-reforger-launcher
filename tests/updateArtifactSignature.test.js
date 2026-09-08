'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  ARTIFACT_SIGNATURE_SCHEMA,
  MAX_SIGNATURE_ENVELOPE_BYTES,
  ORIGIN_ID,
  PINNED_PUBLIC_KEY_FINGERPRINT,
  PINNED_PUBLIC_KEY_PATH,
  PRODUCT_ID,
  canonicalArtifactSignaturePayload,
  hashAndInspectArtifact,
  normalizeExpectedSha512,
  parseArtifactSignatureEnvelope,
  publicKeyFingerprint,
  verifyArtifactEnvelopeSignature,
  verifySignedUpdateArtifactFiles,
  verifyUpdateArtifactFile,
  verifyUpdateArtifactFileAgainstFingerprint
} = require('../src/core/updateArtifactSignature');

const VERSION = '0.3.27';
const ARTIFACT_NAME = 'Arma-Reforger-Launcher-0.3.27-x64-Setup.exe';
const FIXTURE_BYTES = Buffer.from('ALGZ update artifact unit-test fixture.\n', 'utf8');

function envelopeBytes(envelope) {
  return Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
}

function sha512Base64(contents) {
  return crypto.createHash('sha512').update(contents).digest('base64');
}

async function createSignedFixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-update-artifact-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const version = options.version || VERSION;
  const signedArtifactName = options.artifactName || ARTIFACT_NAME;
  const artifactName = options.localName || ARTIFACT_NAME;
  const artifactPath = path.join(root, artifactName);
  const contents = options.contents || FIXTURE_BYTES;
  await fs.writeFile(artifactPath, contents);

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = {
    schema: ARTIFACT_SIGNATURE_SCHEMA,
    productId: PRODUCT_ID,
    originId: ORIGIN_ID,
    version,
    artifactName: signedArtifactName,
    size: contents.length,
    sha512: crypto.createHash('sha512').update(contents).digest('hex')
  };
  envelope.signature = crypto.sign(
    null,
    Buffer.from(canonicalArtifactSignaturePayload(envelope), 'utf8'),
    privateKey
  ).toString('base64');
  return {
    artifactPath,
    contents,
    envelope,
    fingerprint: publicKeyFingerprint(publicKey),
    privateKey,
    publicKey,
    root
  };
}

test('accepts a valid Ed25519 envelope and exact installer content', async (context) => {
  const fixture = await createSignedFixture(context);
  const result = await verifyUpdateArtifactFileAgainstFingerprint({
    envelope: fixture.envelope,
    publicKeyPem: fixture.publicKey,
    filePath: fixture.artifactPath,
    expectedVersion: VERSION,
    expectedArtifactName: ARTIFACT_NAME,
    expectedSha512: fixture.envelope.sha512,
    expectedSize: fixture.envelope.size
  }, fixture.fingerprint);

  assert.deepEqual(result, {
    artifactName: ARTIFACT_NAME,
    sha512: fixture.envelope.sha512,
    size: fixture.envelope.size,
    version: VERSION
  });
});

test('verifies a cached temp file against the signed asset name and latest.yml metadata', async (context) => {
  const fixture = await createSignedFixture(context, { localName: `temp-${ARTIFACT_NAME}` });
  const parsed = parseArtifactSignatureEnvelope(envelopeBytes(fixture.envelope), {
    expectedVersion: VERSION,
    expectedArtifactName: ARTIFACT_NAME
  });
  const result = await verifyUpdateArtifactFileAgainstFingerprint({
    envelope: parsed,
    publicKeyPem: fixture.publicKey,
    filePath: fixture.artifactPath,
    expectedVersion: VERSION,
    expectedArtifactName: ARTIFACT_NAME,
    expectedSha512: sha512Base64(fixture.contents),
    expectedSize: fixture.contents.length
  }, fixture.fingerprint);

  assert.equal(result.artifactName, ARTIFACT_NAME);
  assert.equal(result.version, VERSION);
});

test('file-pair API rejects non-adjacent, oversized, and non-pinned signatures', async (context) => {
  const fixture = await createSignedFixture(context);
  const signaturePath = `${fixture.artifactPath}.algz.json`;
  await fs.writeFile(signaturePath, envelopeBytes(fixture.envelope));

  await assert.rejects(
    verifySignedUpdateArtifactFiles({
      artifactPath: fixture.artifactPath,
      signaturePath: path.join(fixture.root, 'different.algz.json'),
      expectedVersion: VERSION
    }),
    /update-artifact-signature-path-mismatch/
  );
  await assert.rejects(
    verifySignedUpdateArtifactFiles({
      artifactPath: fixture.artifactPath,
      signaturePath,
      expectedVersion: VERSION
    }),
    /update-artifact-signature-invalid/
  );

  await fs.writeFile(signaturePath, Buffer.alloc(MAX_SIGNATURE_ENVELOPE_BYTES + 1, 0x20));
  await assert.rejects(
    verifySignedUpdateArtifactFiles({
      artifactPath: fixture.artifactPath,
      signaturePath,
      expectedVersion: VERSION
    }),
    /update-artifact-signature-file/
  );
});

test('rejects installer tampering and signed-size disagreement', async (context) => {
  const tampered = await createSignedFixture(context);
  await fs.appendFile(tampered.artifactPath, 'tampered');
  await assert.rejects(
    verifyUpdateArtifactFileAgainstFingerprint({
      envelope: tampered.envelope,
      publicKeyPem: tampered.publicKey,
      filePath: tampered.artifactPath,
      expectedVersion: VERSION,
      expectedArtifactName: ARTIFACT_NAME,
      expectedSha512: tampered.envelope.sha512,
      expectedSize: tampered.envelope.size
    }, tampered.fingerprint),
    /update-artifact-content-mismatch/
  );

  const valid = await createSignedFixture(context);
  await assert.rejects(
    verifyUpdateArtifactFileAgainstFingerprint({
      envelope: valid.envelope,
      publicKeyPem: valid.publicKey,
      filePath: valid.artifactPath,
      expectedVersion: VERSION,
      expectedArtifactName: ARTIFACT_NAME,
      expectedSha512: valid.envelope.sha512,
      expectedSize: valid.envelope.size + 1
    }, valid.fingerprint),
    /update-artifact-metadata-mismatch/
  );
});

test('rejects a forged signature and any non-pinned public key', async (context) => {
  const fixture = await createSignedFixture(context);
  const signature = Buffer.from(fixture.envelope.signature, 'base64');
  signature[0] ^= 0xff;
  const forged = { ...fixture.envelope, signature: signature.toString('base64') };
  await assert.rejects(
    verifyUpdateArtifactFileAgainstFingerprint({
      envelope: forged,
      publicKeyPem: fixture.publicKey,
      filePath: fixture.artifactPath,
      expectedVersion: VERSION,
      expectedArtifactName: ARTIFACT_NAME,
      expectedSha512: fixture.envelope.sha512,
      expectedSize: fixture.envelope.size
    }, fixture.fingerprint),
    /update-artifact-signature-invalid/
  );

  await assert.rejects(
    verifyUpdateArtifactFile({
      envelope: fixture.envelope,
      publicKeyPem: fixture.publicKey,
      filePath: fixture.artifactPath,
      expectedVersion: VERSION,
      expectedArtifactName: ARTIFACT_NAME,
      expectedSha512: fixture.envelope.sha512,
      expectedSize: fixture.envelope.size
    }),
    /update-artifact-key-mismatch/
  );
});

test('rejects replay to another version before reading the installer', async (context) => {
  const fixture = await createSignedFixture(context);
  assert.throws(
    () => parseArtifactSignatureEnvelope(envelopeBytes(fixture.envelope), {
      expectedVersion: '0.3.28',
      expectedArtifactName: ARTIFACT_NAME
    }),
    /update-artifact-version-mismatch/
  );
});

test('rejects traversal, URLs, encoded separators, and unexpected envelope fields', async (context) => {
  const fixture = await createSignedFixture(context);
  for (const artifactName of [
    '../Arma-Reforger-Launcher-0.3.27-x64-Setup.exe',
    'https://evil.invalid/Arma-Reforger-Launcher-0.3.27-x64-Setup.exe',
    'Arma-Reforger-Launcher-0.3.27-%2f-Setup.exe',
    'Arma-Reforger-Launcher-0.3.27\\x64-Setup.exe'
  ]) {
    assert.throws(
      () => parseArtifactSignatureEnvelope(envelopeBytes({
        ...fixture.envelope,
        artifactName
      }), { expectedVersion: VERSION, expectedArtifactName: artifactName }),
      /update-artifact-name/
    );
  }

  assert.throws(
    () => parseArtifactSignatureEnvelope(envelopeBytes({
      ...fixture.envelope,
      mirror: 'https://evil.invalid/'
    }), { expectedVersion: VERSION, expectedArtifactName: ARTIFACT_NAME }),
    /update-artifact-envelope-fields/
  );
});

test('bounds signature metadata and strictly decodes SHA-512 from latest.yml', async (context) => {
  const fixture = await createSignedFixture(context);
  assert.throws(
    () => parseArtifactSignatureEnvelope(' '.repeat(MAX_SIGNATURE_ENVELOPE_BYTES + 1), {
      expectedVersion: VERSION,
      expectedArtifactName: ARTIFACT_NAME
    }),
    /update-artifact-envelope-size/
  );
  assert.equal(
    normalizeExpectedSha512(sha512Base64(fixture.contents)),
    fixture.envelope.sha512
  );
  assert.throws(() => normalizeExpectedSha512('not-a-digest'), /update-artifact-metadata-digest/);
});

test('canonical payload and low-level verifier bind every security field', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const contents = Buffer.from('fixture');
  const envelope = {
    schema: ARTIFACT_SIGNATURE_SCHEMA,
    productId: PRODUCT_ID,
    originId: ORIGIN_ID,
    version: VERSION,
    artifactName: ARTIFACT_NAME,
    size: contents.length,
    sha512: crypto.createHash('sha512').update(contents).digest('hex')
  };
  envelope.signature = crypto.sign(
    null,
    Buffer.from(canonicalArtifactSignaturePayload(envelope), 'utf8'),
    privateKey
  ).toString('base64');

  const fingerprint = publicKeyFingerprint(publicKey);
  assert.equal(verifyArtifactEnvelopeSignature(envelope, publicKey, fingerprint), true);
  assert.throws(
    () => verifyArtifactEnvelopeSignature({ ...envelope, size: contents.length + 1 }, publicKey, fingerprint),
    /update-artifact-signature-invalid/
  );
});

test('streaming SHA-512 inspection reports exact file bytes', async (context) => {
  const fixture = await createSignedFixture(context);
  const inspected = await hashAndInspectArtifact(fixture.artifactPath);
  assert.equal(inspected.size, fixture.contents.length);
  assert.equal(inspected.sha512, fixture.envelope.sha512);
  assert.equal(inspected.artifactName, ARTIFACT_NAME);
});

test('the packaged public key still matches the immutable pin', async () => {
  const publicKeyPem = await fs.readFile(PINNED_PUBLIC_KEY_PATH);
  assert.equal(publicKeyFingerprint(publicKeyPem), PINNED_PUBLIC_KEY_FINGERPRINT);
});
