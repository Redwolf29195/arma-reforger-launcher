/*! Copyright (c) 2026 ALGZ / ExtaZzZ. SPDX-License-Identifier: GPL-3.0-only */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseReleaseArguments, publishVerifiedReleaseDirectory, validateLinuxArtifacts } = require('./release-artifacts');

const packageMetadata = require('../package.json');
const { readBlockMap } = require('../src/main/fastUpdater');
const {
  PINNED_PUBLIC_KEY_PATH,
  verifySignedUpdateArtifactFiles
} = require('../src/core/updateArtifactSignature');
const {
  UPDATE_POLICY_FIELD,
  normalizeReleaseUpdatePolicy,
  verifyUpdatePolicyEnvelope
} = require('../src/core/updatePolicy');

const projectRoot = path.resolve(__dirname, '..');
const buildRoot = path.join(projectRoot, 'dist-public-unsigned');
const releaseRoot = path.join(projectRoot, 'dist-release');

function fail(message) {
  throw new Error(message);
}

function assertVersion(version) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    fail(`Invalid release version: ${version}`);
  }
  return version;
}

function assertVersionDirectory(target, root, version) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== path.join(resolvedRoot, version)
    || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(`Unsafe release directory: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function runNode(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${code ?? signal}): node ${argumentsList.join(' ')}`));
    });
  });
}

async function regularFile(filePath) {
  const status = await fsp.lstat(filePath);
  if (!status.isFile() || status.isSymbolicLink()) fail(`Expected a regular file: ${filePath}`);
  return status;
}

async function sha256(filePath) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY);
  try {
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex').toUpperCase();
  } finally {
    await handle.close();
  }
}

async function sha512(filePath) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY);
  try {
    const hash = crypto.createHash('sha512');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest();
  } finally {
    await handle.close();
  }
}

function oneMatch(text, expression, field) {
  const matches = [...text.matchAll(expression)];
  if (matches.length !== 1) fail(`latest.yml must contain exactly one ${field}.`);
  return matches[0][1].trim();
}

function parseLatestYaml(contents) {
  return {
    version: oneMatch(contents, /^version:\s*(\S+)\s*$/gm, 'version'),
    url: oneMatch(contents, /^[ \t]*-[ \t]+url:[ \t]*(\S+)[ \t]*$/gm, 'file URL'),
    fileSha512: oneMatch(contents, /^[ \t]+sha512:[ \t]*(\S+)[ \t]*$/gm, 'file SHA-512'),
    fileSize: Number(oneMatch(contents, /^[ \t]+size:[ \t]*(\d+)[ \t]*$/gm, 'file size')),
    path: oneMatch(contents, /^path:\s*(\S+)\s*$/gm, 'path'),
    sha512: oneMatch(contents, /^sha512:\s*(\S+)\s*$/gm, 'top-level SHA-512'),
    updatePolicy: oneMatch(
      contents,
      new RegExp(`^${UPDATE_POLICY_FIELD}:\\s*(\\S+)\\s*$`, 'gm'),
      'signed ALGZ update policy'
    )
  };
}

async function checkStagedJavaScript() {
  const root = path.join(projectRoot, '.build', 'app', 'src');
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath);
    }
  }
  files.sort((left, right) => left.localeCompare(right, 'en'));
  for (const filePath of files) await runNode(['--check', filePath]);
  if (files.length < 1) fail('No staged JavaScript files were found.');
  return files.length;
}

async function validateBuild(buildDirectory, version) {
  const setupName = `Arma-Reforger-Launcher-${version}-x64-Setup.exe`;
  const portableName = `Arma-Reforger-Launcher-${version}-x64-Portable.exe`;
  const names = [
    portableName,
    setupName,
    `${setupName}.algz.json`,
    `${setupName}.blockmap`,
    'latest.yml'
  ];
  const files = new Map();
  for (const name of names) {
    const filePath = path.join(buildDirectory, name);
    const status = await regularFile(filePath);
    files.set(name, { name, path: filePath, size: status.size });
  }

  const setup = files.get(setupName);
  const latest = parseLatestYaml(await fsp.readFile(files.get('latest.yml').path, 'utf8'));
  if (latest.version !== version || latest.url !== setupName || latest.path !== setupName) {
    fail('latest.yml does not identify the expected release installer.');
  }
  if (!Number.isSafeInteger(latest.fileSize) || latest.fileSize !== setup.size) {
    fail('latest.yml installer size does not match the Setup file.');
  }
  if (latest.fileSha512 !== latest.sha512) fail('latest.yml SHA-512 fields disagree.');
  const latestDigest = Buffer.from(latest.sha512, 'base64');
  if (latestDigest.length !== 64 || latestDigest.toString('base64') !== latest.sha512) {
    fail('latest.yml contains an invalid SHA-512 value.');
  }
  const actualSha512 = await sha512(setup.path);
  if (!crypto.timingSafeEqual(actualSha512, latestDigest)) fail('Setup SHA-512 does not match latest.yml.');

  const verifiedPolicy = verifyUpdatePolicyEnvelope({
    encodedEnvelope: latest.updatePolicy,
    publicKeyPem: await fsp.readFile(PINNED_PUBLIC_KEY_PATH),
    expectedVersion: version,
    expectedArtifactName: setupName,
    expectedSha512: latest.sha512,
    expectedSize: setup.size
  });
  const configuredPolicy = normalizeReleaseUpdatePolicy(packageMetadata.algzUpdatePolicy || {});
  if (verifiedPolicy.mode !== configuredPolicy.mode
    || verifiedPolicy.gracePeriodSeconds !== configuredPolicy.gracePeriodSeconds) {
    fail('Signed update policy does not match package.json.');
  }

  await verifySignedUpdateArtifactFiles({
    artifactPath: setup.path,
    signaturePath: files.get(`${setupName}.algz.json`).path,
    expectedVersion: version
  });

  const blockmap = readBlockMap(await fsp.readFile(files.get(`${setupName}.blockmap`).path));
  const blockmapSize = blockmap.files[0].sizes.reduce((total, size) => total + size, 0);
  if (blockmapSize !== setup.size) fail('Blockmap byte total does not match the Setup file.');

  for (const file of files.values()) file.sha256 = await sha256(file.path);
  return { files, names, portableName, setupName, updatePolicy: verifiedPolicy };
}

async function main() {
  const { reuseBuild, linuxDirectory } = parseReleaseArguments(process.argv.slice(2));
  if (process.platform !== 'win32') fail('The Windows release pipeline must run on Windows.');

  const version = assertVersion(packageMetadata.version);
  const buildDirectory = assertVersionDirectory(path.join(buildRoot, version), buildRoot, version);
  const releaseDirectory = assertVersionDirectory(path.join(releaseRoot, version), releaseRoot, version);

  if (!reuseBuild) {
    if (fs.existsSync(buildDirectory)) fail(`Build directory already exists: ${buildDirectory}`);
    if (fs.existsSync(releaseDirectory)) fail(`Release directory already exists: ${releaseDirectory}`);
    await runNode(['--test', 'tests/*.test.js']);
    await runNode(['node_modules/electron/cli.js', 'tests/uiSmoke.js']);
    await runNode(['node_modules/electron/cli.js', 'tests/serverUiSmoke.js']);
    await runNode(['scripts/prepare-build.js', '--public-unsigned']);
    const stagedCount = await checkStagedJavaScript();
    process.stdout.write(`Verified syntax of ${stagedCount} staged JavaScript files.\n`);
    await runNode([
      'node_modules/electron-builder/cli.js',
      '--publish',
      'never',
      '--win',
      'portable',
      'nsis',
      `--config.directories.output=dist-public-unsigned/${version}`
    ]);
    await runNode(['scripts/sign-release-artifacts.js', '--directory', buildDirectory]);
  }
  await runNode([
      'node_modules/electron/cli.js',
      'tests/packageIdentitySmoke.js',
      path.join(buildDirectory, 'win-unpacked', 'resources', 'app.asar'),
      path.join(buildDirectory, 'win-unpacked', 'resources'),
      path.join(buildDirectory, 'win-unpacked', 'Arma Reforger Launcher.exe'),
      version,
      'public-unsigned'
    ]);
  await runNode([
      'node_modules/@electron/fuses/dist/bin.js',
      'read',
      '--app',
      path.join(buildDirectory, 'win-unpacked', 'Arma Reforger Launcher.exe')
    ]);

  const validated = await validateBuild(buildDirectory, version);
  if (linuxDirectory) {
    const linux = await validateLinuxArtifacts(linuxDirectory, version);
    validated.names.push(...linux.names);
    for (const [name, file] of linux.files) validated.files.set(name, file);
  }
  await fsp.mkdir(releaseRoot, { recursive: true });
  const result = await publishVerifiedReleaseDirectory(validated, releaseDirectory, version);
  const report = [...validated.files.values()]
    .map(({ name, size, sha256: digest }) => ({ name, size, sha256: digest }));
  process.stdout.write(`${JSON.stringify({
    version,
    result,
    releaseDirectory,
    updatePolicy: validated.updatePolicy,
    files: report
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
