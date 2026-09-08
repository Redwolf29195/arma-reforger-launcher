'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageMetadata = require('../package.json');
const {
  ARTIFACT_SIGNATURE_SCHEMA,
  MAX_SIGNATURE_ENVELOPE_BYTES,
  ORIGIN_ID,
  PINNED_PUBLIC_KEY_FINGERPRINT,
  PRODUCT_ID,
  SIGNATURE_FILE_SUFFIX,
  canonicalArtifactSignaturePayload,
  hashAndInspectArtifact,
  publicKeyFingerprint,
  validateArtifactSignatureMetadata,
  verifyArtifactEnvelopeSignature
} = require('../src/core/updateArtifactSignature');
const {
  UPDATE_POLICY_FIELD,
  UPDATE_POLICY_SCHEMA,
  canonicalUpdatePolicyPayload,
  encodeUpdatePolicyEnvelope,
  normalizeReleaseUpdatePolicy,
  validateUpdatePolicyMetadata,
  verifyUpdatePolicyEnvelope
} = require('../src/core/updatePolicy');

const projectRoot = path.resolve(__dirname, '..');
const defaultKeyRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'ALGZ', 'ReleaseKeys')
  : path.join(os.homedir(), '.algz', 'release-keys');

function parseArguments(argumentsList) {
  let directoryOverride = '';
  let rootOverride = '';
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!['--directory', '--root'].includes(argument) || index + 1 >= argumentsList.length) {
      throw new Error('Usage: node scripts/sign-release-artifacts.js [--directory <release-directory> | --root <output-root>]');
    }
    const value = String(argumentsList[index + 1] || '').trim();
    if (!value) throw new Error(`A path is required after ${argument}.`);
    if (argument === '--directory') {
      if (directoryOverride) throw new Error('--directory may be supplied only once.');
      directoryOverride = value;
    } else {
      if (rootOverride) throw new Error('--root may be supplied only once.');
      rootOverride = value;
    }
    index += 1;
  }
  if (directoryOverride && rootOverride) {
    throw new Error('--directory and --root are mutually exclusive.');
  }
  const outputDirectory = directoryOverride
    ? path.resolve(directoryOverride)
    : path.join(path.resolve(rootOverride || path.join(projectRoot, 'dist-local')), packageMetadata.version);
  return { outputDirectory };
}

function privateKeyPath() {
  return path.resolve(process.env.ALGZ_RELEASE_PRIVATE_KEY_FILE
    || path.join(defaultKeyRoot, 'algz-launcher-ed25519-private.pem'));
}

function expectedInstallerPattern(version) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^Arma-Reforger-Launcher-${escapedVersion}-(?:x64|ia32|arm64)-Setup\\.exe$`);
}

async function writeTextAtomically(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    try {
      await fs.promises.rename(temporaryPath, filePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      const existing = await fs.promises.lstat(filePath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error('Refusing to replace a non-file release metadata target.');
      }
      await fs.promises.unlink(filePath);
      await fs.promises.rename(temporaryPath, filePath);
    }
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
}

async function attachSignedUpdatePolicy({ outputDirectory, artifacts, privateKey, publicKey }) {
  const latestPath = path.join(outputDirectory, 'latest.yml');
  const latestStatus = await fs.promises.lstat(latestPath);
  if (latestStatus.isSymbolicLink() || !latestStatus.isFile() || latestStatus.size > 256 * 1024) {
    throw new Error('latest.yml is unavailable or invalid.');
  }
  const latestContents = await fs.promises.readFile(latestPath, 'utf8');
  const pathMatches = [...latestContents.matchAll(/^path:\s*(\S+)\s*$/gm)];
  if (pathMatches.length !== 1) throw new Error('latest.yml must contain exactly one installer path.');
  const artifact = artifacts.get(pathMatches[0][1]);
  if (!artifact) throw new Error('latest.yml does not identify a signed Setup artifact.');

  const releasePolicy = normalizeReleaseUpdatePolicy(packageMetadata.algzUpdatePolicy || {});
  const envelope = {
    schema: UPDATE_POLICY_SCHEMA,
    productId: PRODUCT_ID,
    originId: ORIGIN_ID,
    version: packageMetadata.version,
    artifactName: artifact.artifactName,
    artifactSize: artifact.size,
    artifactSha512: artifact.sha512,
    mode: releasePolicy.mode,
    gracePeriodSeconds: releasePolicy.gracePeriodSeconds
  };
  validateUpdatePolicyMetadata(envelope, {
    expectedVersion: packageMetadata.version,
    expectedArtifactName: artifact.artifactName,
    expectedSha512: artifact.sha512,
    expectedSize: artifact.size
  });
  envelope.signature = crypto.sign(
    null,
    Buffer.from(canonicalUpdatePolicyPayload(envelope), 'utf8'),
    privateKey
  ).toString('base64');
  const encodedEnvelope = encodeUpdatePolicyEnvelope(envelope);
  verifyUpdatePolicyEnvelope({
    encodedEnvelope,
    publicKeyPem: publicKey,
    expectedVersion: packageMetadata.version,
    expectedArtifactName: artifact.artifactName,
    expectedSha512: artifact.sha512,
    expectedSize: artifact.size
  });

  const withoutExistingPolicy = latestContents.replace(
    new RegExp(`^${UPDATE_POLICY_FIELD}:\\s*\\S+\\s*\\r?\\n?`, 'gm'),
    ''
  ).trimEnd();
  await writeTextAtomically(latestPath, `${withoutExistingPolicy}\n${UPDATE_POLICY_FIELD}: ${encodedEnvelope}\n`);
  return releasePolicy;
}

async function main() {
  const { outputDirectory } = parseArguments(process.argv.slice(2));
  const directoryStatus = await fs.promises.lstat(outputDirectory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new Error('Release output directory is invalid.');
  }

  const keyPath = privateKeyPath();
  const keyStatus = await fs.promises.lstat(keyPath);
  if (keyStatus.isSymbolicLink() || !keyStatus.isFile()) {
    throw new Error('ALGZ release private key is unavailable.');
  }
  const privateKey = crypto.createPrivateKey(await fs.promises.readFile(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('ALGZ release key must be Ed25519.');
  const publicKey = crypto.createPublicKey(privateKey);
  if (publicKeyFingerprint(publicKey) !== PINNED_PUBLIC_KEY_FINGERPRINT) {
    throw new Error('ALGZ release private key does not match the pinned launcher public key.');
  }

  const installerPattern = expectedInstallerPattern(packageMetadata.version);
  const entries = await fs.promises.readdir(outputDirectory, { withFileTypes: true });
  const installers = entries
    .filter((entry) => entry.isFile() && installerPattern.test(entry.name))
    .map((entry) => path.join(outputDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (installers.length < 1) {
    throw new Error(`No version ${packageMetadata.version} NSIS Setup installers were found.`);
  }

  const signedNames = [];
  const artifacts = new Map();
  for (const installerPath of installers) {
    const artifact = await hashAndInspectArtifact(installerPath);
    artifacts.set(artifact.artifactName, artifact);
    const envelope = {
      schema: ARTIFACT_SIGNATURE_SCHEMA,
      productId: PRODUCT_ID,
      originId: ORIGIN_ID,
      version: packageMetadata.version,
      artifactName: artifact.artifactName,
      size: artifact.size,
      sha512: artifact.sha512
    };
    validateArtifactSignatureMetadata(envelope, {
      expectedVersion: packageMetadata.version,
      expectedArtifactName: artifact.artifactName
    });
    envelope.signature = crypto.sign(
      null,
      Buffer.from(canonicalArtifactSignaturePayload(envelope), 'utf8'),
      privateKey
    ).toString('base64');
    verifyArtifactEnvelopeSignature(envelope, publicKey, PINNED_PUBLIC_KEY_FINGERPRINT);

    const contents = `${JSON.stringify(envelope, null, 2)}\n`;
    if (Buffer.byteLength(contents, 'utf8') > MAX_SIGNATURE_ENVELOPE_BYTES) {
      throw new Error('Generated artifact signature envelope is too large.');
    }
    await writeTextAtomically(`${installerPath}${SIGNATURE_FILE_SUFFIX}`, contents);
    signedNames.push(artifact.artifactName);
  }

  const releasePolicy = await attachSignedUpdatePolicy({
    outputDirectory,
    artifacts,
    privateKey,
    publicKey
  });

  process.stdout.write(
    `Signed ${signedNames.length} NSIS Setup artifact(s) with ${releasePolicy.mode} update policy`
      + `${releasePolicy.mode === 'semi-forced' ? ` (${releasePolicy.gracePeriodSeconds}s)` : ''}:\n`
      + `${signedNames.join('\n')}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exitCode = 1;
});
