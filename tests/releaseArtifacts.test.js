'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  artifactNames, assertWindowsUpdateTarget, hashFile, linuxArtifactNames, parseReleaseArguments,
  publishVerifiedReleaseDirectory, validateLinuxArtifacts
} = require('../scripts/release-artifacts');
const version = '0.3.44';

function appImage() {
  const bytes = Buffer.alloc(96);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.set([0x41, 0x49, 2], 8);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt16LE(64, 52);
  return bytes;
}

function debianPackage() {
  const chunks = [Buffer.from('!<arch>\n')];
  for (const [name, data] of [['debian-binary', '2.0\n'], ['control.tar.gz', 'fake control'], ['data.tar.xz', 'fake data']]) {
    const contents = Buffer.from(data);
    chunks.push(Buffer.from(`${`${name}/`.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(contents.length).padEnd(10)}\x60\n`));
    chunks.push(contents);
    if (contents.length % 2) chunks.push(Buffer.from('\n'));
  }
  return Buffer.concat(chunks);
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-release-files-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const linuxDirectory = path.join(root, 'linux');
  await fs.mkdir(linuxDirectory);
  const [image, deb] = linuxArtifactNames(version);
  await fs.writeFile(path.join(linuxDirectory, image), appImage());
  await fs.writeFile(path.join(linuxDirectory, deb), debianPackage());
  return { root, linuxDirectory, image, deb };
}

async function windowsFixture(root) {
  const build = path.join(root, 'windows-build');
  await fs.mkdir(build);
  const names = artifactNames(version);
  const files = new Map();
  for (const name of names) {
    const filePath = path.join(build, name);
    await fs.writeFile(filePath, `verified fixture for ${name}`);
    files.set(name, { name, path: filePath, ...await hashFile(filePath) });
  }
  return { names, files };
}

test('Linux augmentation is opt-in and requires reuse-build with one explicit directory', () => {
  assert.deepEqual(parseReleaseArguments([]), { reuseBuild: false, linuxDirectory: '' });
  assert.equal(parseReleaseArguments(['--reuse-build', '--linux-directory', 'linux']).linuxDirectory, path.resolve('linux'));
  assert.throws(() => parseReleaseArguments(['--linux-directory', 'linux']), /requires --reuse-build/);
  assert.throws(() => parseReleaseArguments(['--reuse-build', '--linux-directory']), /directory path/);
  assert.throws(() => parseReleaseArguments(['--reuse-build', '--reuse-build']), /duplicate/);
  assert.throws(() => parseReleaseArguments(['--everything']), /Unsupported/);
  assert.equal(artifactNames(version).length, 5);
  assert.equal(artifactNames(version, { withLinux: true }).length, 7);
});

test('validates the exact two Linux package names, regular files, formats and digests', async context => {
  const { linuxDirectory } = await fixture(context);
  const validated = await validateLinuxArtifacts(linuxDirectory, version);
  assert.deepEqual(validated.names, linuxArtifactNames(version));
  assert.equal(validated.files.size, 2);
  for (const file of validated.files.values()) {
    assert.equal(file.size, (await fs.stat(file.path)).size);
    assert.match(file.sha256, /^[0-9A-F]{64}$/);
  }
});

test('rejects wrong names, wrong versions and unexpected source artifacts', async context => {
  const { linuxDirectory, image } = await fixture(context);
  await assert.rejects(validateLinuxArtifacts(linuxDirectory, '0.3.45'), /exactly the two/);
  await fs.rename(path.join(linuxDirectory, image), path.join(linuxDirectory, 'wrong.AppImage'));
  await assert.rejects(validateLinuxArtifacts(linuxDirectory, version), /exactly the two/);
  await fs.rename(path.join(linuxDirectory, 'wrong.AppImage'), path.join(linuxDirectory, image));
  await fs.writeFile(path.join(linuxDirectory, 'builder-debug.yml'), 'not a release asset');
  await assert.rejects(validateLinuxArtifacts(linuxDirectory, version), /exactly the two/);
});

test('rejects symlinked files, symlinked artifact directories and directories masquerading as packages', async context => {
  const { root, linuxDirectory, image } = await fixture(context);
  const alias = path.join(root, 'alias');
  await fs.symlink(linuxDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateLinuxArtifacts(alias, version), /regular directory/);
  const imagePath = path.join(linuxDirectory, image);
  await fs.unlink(imagePath);
  // Directory symlinks/junctions work without elevated Windows symlink privileges.
  await fs.symlink(root, imagePath, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateLinuxArtifacts(linuxDirectory, version), /regular file/);
  await fs.unlink(imagePath);
  await fs.mkdir(imagePath);
  await assert.rejects(validateLinuxArtifacts(linuxDirectory, version), /regular file/);
});

test('rejects non-AppImage ELF, wrong architecture, truncated binaries and invalid Debian archives', async context => {
  const { linuxDirectory, image, deb } = await fixture(context);
  const imagePath = path.join(linuxDirectory, image);
  let bytes = appImage();
  bytes.writeUInt16LE(183, 18);
  await fs.writeFile(imagePath, bytes);
  await assert.rejects(validateLinuxArtifacts(linuxDirectory, version), /x86-64/);
  bytes = appImage(); bytes[8] = 0;
  await fs.writeFile(imagePath, bytes);
  await assert.rejects(validateLinuxArtifacts(linuxDirectory, version), /not a type-2 AppImage/);
  await fs.writeFile(imagePath, 'MZ');
  await assert.rejects(validateLinuxArtifacts(linuxDirectory, version), /Truncated/);
  await fs.writeFile(imagePath, appImage());
  await fs.writeFile(path.join(linuxDirectory, deb), 'not an ar archive');
  await assert.rejects(validateLinuxArtifacts(linuxDirectory, version), /ar archive/);
  await fs.writeFile(path.join(linuxDirectory, deb), Buffer.from('!<arch>\n'));
  await assert.rejects(validateLinuxArtifacts(linuxDirectory, version), /version, control and data/);
});

test('creates and re-verifies Windows-only releases, then adds only the two verified Linux files', async context => {
  const { root, linuxDirectory } = await fixture(context);
  const windows = await windowsFixture(root);
  const release = path.join(root, version);
  assert.equal(await publishVerifiedReleaseDirectory(windows, release, version), 'created');
  assert.equal(await publishVerifiedReleaseDirectory(windows, release, version), 'verified-existing');
  const before = new Map(await Promise.all(windows.names.map(async name => [name, (await fs.stat(path.join(release, name))).mtimeMs])));
  const linux = await validateLinuxArtifacts(linuxDirectory, version);
  const combined = { names: [...windows.names, ...linux.names], files: new Map([...windows.files, ...linux.files]) };
  const copied = [];
  const copyFile = async (source, destination, flags) => { copied.push(path.basename(source)); return fs.copyFile(source, destination, flags); };
  assert.equal(await publishVerifiedReleaseDirectory(combined, release, version, { copyFile }), 'augmented-linux');
  assert.ok(copied.every(name => linux.names.includes(name)), 'No Windows file may be recopied during augmentation.');
  assert.deepEqual((await fs.readdir(release)).sort(), artifactNames(version, { withLinux: true }));
  for (const name of windows.names) assert.equal((await fs.stat(path.join(release, name))).mtimeMs, before.get(name));
  assert.equal(await publishVerifiedReleaseDirectory(combined, release, version), 'verified-existing');
  await assert.rejects(publishVerifiedReleaseDirectory(windows, release, version), /exact five/);
});

test('Windows digest mismatches stop augmentation before copying any Linux file', async context => {
  const { root, linuxDirectory } = await fixture(context);
  const windows = await windowsFixture(root);
  const release = path.join(root, version);
  await publishVerifiedReleaseDirectory(windows, release, version);
  const changed = windows.names[0];
  const original = await fs.readFile(path.join(release, changed));
  original[0] ^= 1;
  await fs.writeFile(path.join(release, changed), original);
  const linux = await validateLinuxArtifacts(linuxDirectory, version);
  const combined = { names: [...windows.names, ...linux.names], files: new Map([...windows.files, ...linux.files]) };
  let copies = 0;
  await assert.rejects(publishVerifiedReleaseDirectory(combined, release, version, { copyFile: async () => { copies += 1; } }), /differs from the verified build/);
  assert.equal(copies, 0);
  assert.deepEqual((await fs.readdir(release)).sort(), windows.names);
});

test('unexpected release assets prevent augmentation and a failed second copy rolls back only new Linux files', async context => {
  const { root, linuxDirectory } = await fixture(context);
  const windows = await windowsFixture(root);
  const release = path.join(root, version);
  await publishVerifiedReleaseDirectory(windows, release, version);
  const linux = await validateLinuxArtifacts(linuxDirectory, version);
  const combined = { names: [...windows.names, ...linux.names], files: new Map([...windows.files, ...linux.files]) };
  await fs.writeFile(path.join(release, 'extra.txt'), 'extra');
  await assert.rejects(publishVerifiedReleaseDirectory(combined, release, version), /exactly five Windows files or seven/);
  await fs.unlink(path.join(release, 'extra.txt'));
  let additions = 0;
  const copyFile = async (source, destination, flags) => {
    if (path.dirname(destination) === release && ++additions === 2) throw new Error('Simulated copy failure');
    return fs.copyFile(source, destination, flags);
  };
  await assert.rejects(publishVerifiedReleaseDirectory(combined, release, version, { copyFile }), /Simulated copy failure/);
  assert.deepEqual((await fs.readdir(release)).sort(), windows.names);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
});

test('latest.yml remains a single Windows NSIS installer update even in a seven-file release', () => {
  const setup = `Arma-Reforger-Launcher-${version}-x64-Setup.exe`;
  const yaml = `version: ${version}\nfiles:\n  - url: ${setup}\npath: ${setup}\n`;
  assert.doesNotThrow(() => assertWindowsUpdateTarget(yaml, version));
  assert.throws(() => assertWindowsUpdateTarget(yaml.replaceAll(setup, linuxArtifactNames(version)[0]), version), /Windows Setup/);
  assert.throws(() => assertWindowsUpdateTarget(`${yaml}  - url: ${linuxArtifactNames(version)[0]}\n`, version), /exactly one/);
});
