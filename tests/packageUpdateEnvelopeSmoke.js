'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

async function main() {
  const [appPath, artifactName, expectedVersion] = process.argv.slice(2);
  if (!appPath || !artifactName || !expectedVersion) {
    throw new Error('Usage: electron tests/packageUpdateEnvelopeSmoke.js <app.asar> <artifact-name> <version>');
  }

  await app.whenReady();
  const packagedRoot = path.resolve(appPath);
  const fetchModule = require(path.join(packagedRoot, 'src', 'main', 'updateArtifactFetch.js'));
  const signatureModule = require(path.join(packagedRoot, 'src', 'core', 'updateArtifactSignature.js'));
  const envelopeBytes = await fetchModule.fetchUpdateArtifactEnvelope({ artifactName });
  const envelope = signatureModule.parseArtifactSignatureEnvelope(envelopeBytes, {
    expectedVersion,
    expectedArtifactName: artifactName
  });
  const publicKey = fs.readFileSync(signatureModule.PINNED_PUBLIC_KEY_PATH);
  signatureModule.verifyArtifactEnvelopeSignature(
    envelope,
    publicKey,
    signatureModule.PINNED_PUBLIC_KEY_FINGERPRINT
  );
  process.stdout.write(`${JSON.stringify({
    artifactName: envelope.artifactName,
    bytes: envelopeBytes.length,
    signatureVerified: true,
    version: envelope.version
  })}\n`);
}

main().then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    app.exit(1);
  }
);
