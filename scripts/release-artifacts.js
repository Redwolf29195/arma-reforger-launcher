// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

function artifactNames(version, { withLinux = false } = {}) {
  assert.match(version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  const setup = `Arma-Reforger-Launcher-${version}-x64-Setup.exe`;
  return [
    `Arma-Reforger-Launcher-${version}-x64-Portable.exe`, setup,
    `${setup}.algz.json`, `${setup}.blockmap`, 'latest.yml',
    ...(withLinux ? linuxArtifactNames(version) : [])
  ].sort();
}

function linuxArtifactNames(version) {
  assert.match(version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  return [`.AppImage`, `.deb`].map(extension => `Arma-Reforger-Launcher-${version}-linux-x64${extension}`);
}

function parseReleaseArguments(argumentsList) {
  const options = { reuseBuild: false, linuxDirectory: '' };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--reuse-build' && !options.reuseBuild) options.reuseBuild = true;
    else if (argument === '--linux-directory' && !options.linuxDirectory) {
      const value = argumentsList[++index];
      assert.ok(value && !value.startsWith('--'), '--linux-directory requires a directory path.');
      options.linuxDirectory = path.resolve(value);
    } else throw new Error(`Unsupported or duplicate argument: ${argument}`);
  }
  assert.ok(!options.linuxDirectory || options.reuseBuild, '--linux-directory requires --reuse-build.');
  return options;
}

async function regularDirectory(directory) {
  const status = await fs.lstat(directory);
  assert.ok(status.isDirectory() && !status.isSymbolicLink(), `Expected a regular directory: ${directory}`);
}

async function regularFile(filePath) {
  const status = await fs.lstat(filePath);
  assert.ok(status.isFile() && !status.isSymbolicLink(), `Expected a regular file: ${filePath}`);
  return status;
}

async function hashFile(filePath) {
  await regularFile(filePath);
  const handle = await fs.open(filePath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0));
  try {
    assert.ok((await handle.stat()).isFile(), `Expected a regular file: ${filePath}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); size += chunk.length; }
    return { size, sha256: hash.digest('hex').toUpperCase() };
  } finally { await handle.close(); }
}

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    assert.ok(bytesRead > 0, 'Truncated Linux artifact header.');
    offset += bytesRead;
  }
  return buffer;
}

async function validateLinuxHeader(filePath, name) {
  const status = await regularFile(filePath);
  const handle = await fs.open(filePath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0));
  try {
    if (name.endsWith('.AppImage')) {
      const header = await readAt(handle, 64, 0);
      assert.ok(header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
        && header[4] === 2 && header[5] === 1 && header[6] === 1
        && [2, 3].includes(header.readUInt16LE(16)) && header.readUInt16LE(18) === 62
        && header.readUInt16LE(52) === 64, 'AppImage must have a valid little-endian ELF64 x86-64 header.');
      assert.ok(header[8] === 0x41 && header[9] === 0x49 && header[10] === 2,
        'ELF file is not a type-2 AppImage.');
      assert.ok(status.size > 64, 'AppImage has no payload.');
    } else {
      assert.equal((await readAt(handle, 8, 0)).toString('ascii'), '!<arch>\n', 'Debian package must be an ar archive.');
      const members = [];
      let offset = 8;
      while (offset < status.size) {
        assert.ok(members.length < 16, 'Too many Debian archive members.');
        const header = await readAt(handle, 60, offset);
        assert.equal(header.subarray(58).toString('ascii'), '`\n', 'Invalid Debian ar member header.');
        const member = header.subarray(0, 16).toString('ascii').trim().replace(/\/$/, '');
        const sizeText = header.subarray(48, 58).toString('ascii').trim();
        assert.match(sizeText, /^\d+$/, 'Invalid Debian ar member size.');
        const size = Number(sizeText);
        assert.ok(Number.isSafeInteger(size) && offset + 60 + size <= status.size, 'Truncated Debian ar member.');
        if (members.length === 0) {
          assert.equal(member, 'debian-binary', 'Debian version member must be first.');
          assert.equal(size, 4, 'Invalid Debian version member size.');
          assert.equal((await readAt(handle, 4, offset + 60)).toString('ascii'), '2.0\n', 'Unsupported Debian package version.');
        }
        assert.ok(!members.includes(member), 'Duplicate Debian ar member.');
        members.push(member);
        offset += 60 + size + (size % 2);
      }
      assert.equal(offset, status.size, 'Invalid Debian ar padding.');
      assert.equal(members.length, 3, 'Debian package must contain its version, control and data members.');
      assert.match(members[1], /^control\.tar(?:\.(?:gz|xz|zst|bz2|lzma))?$/, 'Missing Debian control archive.');
      assert.match(members[2], /^data\.tar(?:\.(?:gz|xz|zst|bz2|lzma))?$/, 'Missing Debian data archive.');
    }
  } finally { await handle.close(); }
}

async function validateLinuxArtifacts(directory, version) {
  await regularDirectory(directory);
  const names = linuxArtifactNames(version);
  assert.deepEqual((await fs.readdir(directory)).sort(), [...names].sort(), 'Linux artifact directory must contain exactly the two expected packages.');
  const files = new Map();
  for (const name of names) {
    const filePath = path.join(directory, name);
    await validateLinuxHeader(filePath, name);
    files.set(name, { name, path: filePath, ...await hashFile(filePath) });
  }
  return { names, files };
}

function assertWindowsUpdateTarget(contents, version) {
  const setup = `Arma-Reforger-Launcher-${version}-x64-Setup.exe`;
  for (const [expression, expected, field] of [
    [/^version:\s*(\S+)\s*$/gm, version, 'version'],
    [/^path:\s*(\S+)\s*$/gm, setup, 'path'],
    [/^[ \t]*-[ \t]+url:[ \t]*(\S+)[ \t]*$/gm, setup, 'file URL']
  ]) {
    const matches = [...contents.matchAll(expression)];
    assert.equal(matches.length, 1, `latest.yml must have exactly one ${field}.`);
    assert.equal(matches[0][1], expected, `latest.yml ${field} must identify the Windows Setup installer.`);
  }
}

async function verifyFiles(directory, names, files) {
  for (const name of names) {
    const expected = files.get(name);
    assert.ok(expected && /^[0-9a-f]{64}$/i.test(expected.sha256), `Missing verified digest: ${name}`);
    const actual = await hashFile(path.join(directory, name));
    assert.equal(actual.size, expected.size, `Existing release file size differs from the verified build: ${name}`);
    assert.equal(actual.sha256, expected.sha256.toUpperCase(), `Existing release file differs from the verified build: ${name}`);
  }
}

async function publishVerifiedReleaseDirectory(validated, releaseDirectory, version, { copyFile = fs.copyFile } = {}) {
  const windowsNames = artifactNames(version);
  const withLinux = validated.names.length === 7;
  const expectedNames = artifactNames(version, { withLinux });
  assert.deepEqual([...validated.names].sort(), expectedNames, 'Invalid verified release file set.');
  const parent = path.dirname(path.resolve(releaseDirectory));
  assert.equal(path.basename(releaseDirectory), version, 'Unsafe release version directory.');
  await regularDirectory(parent);
  let currentNames = null;
  try {
    await regularDirectory(releaseDirectory);
    currentNames = (await fs.readdir(releaseDirectory)).sort();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (currentNames) {
    const exactFinal = currentNames.length === expectedNames.length && currentNames.every((name, index) => name === expectedNames[index]);
    if (exactFinal) {
      await verifyFiles(releaseDirectory, expectedNames, validated.files);
      return 'verified-existing';
    }
    assert.ok(withLinux, 'Existing release directory is not the exact five-file set.');
    assert.deepEqual(currentNames, windowsNames, 'Existing release directory must contain exactly five Windows files or seven release files.');
    // Nothing is added until all five authenticated Windows artifacts match.
    await verifyFiles(releaseDirectory, windowsNames, validated.files);
  }

  const staged = path.join(parent, `.${version}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  assert.ok(path.resolve(staged).startsWith(`${parent}${path.sep}`), 'Unsafe release staging directory.');
  await fs.mkdir(staged);
  const copyNames = currentNames ? linuxArtifactNames(version) : expectedNames;
  const added = [];
  try {
    for (const name of copyNames) {
      await regularFile(validated.files.get(name).path);
      await copyFile(validated.files.get(name).path, path.join(staged, name), fsSync.constants.COPYFILE_EXCL);
    }
    await verifyFiles(staged, copyNames, validated.files);
    if (!currentNames) {
      await fs.rename(staged, releaseDirectory);
      return 'created';
    }
    await regularDirectory(releaseDirectory);
    assert.deepEqual((await fs.readdir(releaseDirectory)).sort(), windowsNames, 'Release directory changed before Linux augmentation.');
    await verifyFiles(releaseDirectory, windowsNames, validated.files);
    for (const name of copyNames) {
      await copyFile(path.join(staged, name), path.join(releaseDirectory, name), fsSync.constants.COPYFILE_EXCL);
      added.push(name);
    }
    assert.deepEqual((await fs.readdir(releaseDirectory)).sort(), expectedNames, 'Release directory changed during Linux augmentation.');
    await verifyFiles(releaseDirectory, expectedNames, validated.files);
    return 'augmented-linux';
  } catch (error) {
    // Roll back only files created by this invocation, never pre-existing files.
    for (const name of added) {
      const target = path.join(releaseDirectory, name);
      try {
        const actual = await hashFile(target);
        if (actual.sha256 === validated.files.get(name).sha256.toUpperCase()) await fs.unlink(target);
      } catch { /* Preserve any file changed concurrently rather than deleting it. */ }
    }
    throw error;
  } finally {
    // Only this freshly created sibling staging directory may be removed.
    assert.ok(path.resolve(staged).startsWith(`${parent}${path.sep}`)
      && path.basename(staged).startsWith(`.${version}-`) && path.basename(staged).endsWith('.tmp'));
    await fs.rm(staged, { recursive: true, force: true });
  }
}

module.exports = {
  artifactNames, assertWindowsUpdateTarget, hashFile, linuxArtifactNames, parseReleaseArguments,
  publishVerifiedReleaseDirectory, regularDirectory, regularFile, validateLinuxArtifacts, validateLinuxHeader
};
