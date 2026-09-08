const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeFileAtomic, writeJsonAtomic } = require('./jsonFiles');

const MAX_FILES = 256;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 1024;
const MANIFEST_PATH = 'profile/ALGZLauncherGameSettingsSync.json';
const BACKUP_PATH = 'profile/ALGZLauncherGameSettingsBackups';
const ACCOUNT_PATTERN = /^app1874880_user\d+$/i;
const PREFERENCE_PATTERN = /^(?:ReforgerEngineSettings|ReforgerGameSettings|InputUserSettings)\.conf$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const syncQueues = new Map();

function keyFor(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function hash(bytes) {
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

async function canonicalProfilePath(value) {
  let candidate = path.resolve(value);
  const missingParts = [];
  for (;;) {
    try {
      const existing = await fs.realpath(candidate);
      if (!(await fs.stat(existing)).isDirectory()) throw new Error('Game profile path is not a directory.');
      return path.join(existing, ...missingParts.reverse());
    } catch (error) {
      const parent = path.dirname(candidate);
      if (error.code !== 'ENOENT' || parent === candidate) throw error;
      missingParts.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function isNested(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function statOrNull(filePath) {
  try { return await fs.lstat(filePath); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function safeParts(relativePath) {
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))) {
    throw new Error('Unsafe game settings path.');
  }
  return parts;
}

async function safeDirectory(root, relativePath, create = false) {
  let directory = root;
  for (const part of safeParts(relativePath)) {
    directory = path.join(directory, part);
    let stats = await statOrNull(directory);
    if (!stats && create) {
      await fs.mkdir(directory);
      stats = await fs.lstat(directory);
    }
    if (!stats) return null;
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Unsafe game settings directory.');
  }
  return directory;
}

async function safeFile(root, relativePath, createParents = false) {
  const parts = safeParts(relativePath);
  const directory = await safeDirectory(root, parts.slice(0, -1).join('/'), createParents);
  if (!directory) return null;
  const filePath = path.join(directory, parts.at(-1));
  const stats = await statOrNull(filePath);
  if (stats && (stats.isSymbolicLink() || !stats.isFile())) throw new Error('Unsafe game settings file.');
  return { filePath, stats };
}

async function readBounded(filePath, maximumBytes = MAX_FILE_BYTES) {
  const handle = await fs.open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) throw new Error('Game settings file exceeds the size limit.');
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('Game settings changed while being read.');
    }
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

function isPreferencePath(relativePath) {
  try { safeParts(relativePath); } catch { return false; }
  const match = relativePath.match(/^profile\/\.save\/(?:settings|app1874880_user\d+\/settings)\/(.+)$/i);
  if (!match) return false;
  if (PREFERENCE_PATTERN.test(match[1])) return true;
  const parts = match[1].split('/');
  return parts[0].toLowerCase() === 'custominputconfigs' && parts.length >= 2
    && parts.length <= MAX_DEPTH + 2 && /\.conf$/i.test(parts.at(-1));
}

async function collectPreferences(root) {
  const files = [];
  let totalBytes = 0;
  let scannedEntries = 0;
  let emptyFiles = 0;
  async function entries(relativePath) {
    const directory = await safeDirectory(root, relativePath);
    if (!directory) return [];
    const result = await fs.readdir(directory, { withFileTypes: true });
    scannedEntries += result.length;
    if (scannedEntries > MAX_ENTRIES) throw new Error('Too many game settings entries.');
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function add(relativePath) {
    const entry = await safeFile(root, relativePath);
    if (!entry?.stats) return;
    if (!entry.stats.size) { emptyFiles += 1; return; }
    if (files.length >= MAX_FILES) throw new Error('Too many game settings files.');
    if (entry.stats.size > MAX_FILE_BYTES || totalBytes + entry.stats.size > MAX_TOTAL_BYTES) {
      throw new Error('Game settings exceed the size limit.');
    }
    const bytes = await readBounded(entry.filePath);
    if (!bytes.length) throw new Error('Game settings file is empty.');
    if (totalBytes + bytes.length > MAX_TOTAL_BYTES) throw new Error('Game settings exceed the size limit.');
    totalBytes += bytes.length;
    files.push({ relativePath, bytes, sourceHash: hash(bytes) });
  }
  async function custom(relativePath, depth = 0) {
    if (depth > MAX_DEPTH) throw new Error('Game settings directory is too deep.');
    for (const entry of await entries(relativePath)) {
      const childPath = `${relativePath}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Unsafe game settings symbolic link.');
      if (entry.isDirectory()) await custom(childPath, depth + 1);
      else if (/\.conf$/i.test(entry.name)) await add(childPath);
    }
  }
  async function settings(relativePath) {
    for (const entry of await entries(relativePath)) {
      if (PREFERENCE_PATTERN.test(entry.name)) await add(`${relativePath}/${entry.name}`);
      else if (entry.name.toLowerCase() === 'custominputconfigs') await custom(`${relativePath}/${entry.name}`);
    }
  }
  for (const entry of await entries('profile/.save')) {
    if (entry.name.toLowerCase() === 'settings') await settings(`profile/.save/${entry.name}`);
    else if (ACCOUNT_PATTERN.test(entry.name)) await settings(`profile/.save/${entry.name}/settings`);
  }
  if (files.length && emptyFiles) throw new Error('Game settings file is empty.');
  return files;
}

async function loadManifest(root) {
  const manifestFile = await safeFile(root, MANIFEST_PATH);
  if (!manifestFile?.stats) return { formatVersion: 1, sourceDirectory: '', files: {} };
  const document = JSON.parse((await readBounded(manifestFile.filePath, 512 * 1024)).toString('utf8').replace(/^\uFEFF/, ''));
  if (document?.formatVersion !== 1 || typeof document.sourceDirectory !== 'string'
    || !document.files || typeof document.files !== 'object' || Array.isArray(document.files)
    || Object.keys(document.files).length > MAX_ENTRIES) throw new Error('Invalid game settings sync manifest.');
  const files = {};
  for (const [relativePath, record] of Object.entries(document.files)) {
    const validHash = (value) => typeof value === 'string' && HASH_PATTERN.test(value);
    if (!isPreferencePath(relativePath) || !record || typeof record !== 'object'
      || !(validHash(record.sourceHash) || record.sourceHash === null)
      || !(validHash(record.appliedHash) || record.appliedHash === null)
      || (!record.pending && (!validHash(record.sourceHash) || !validHash(record.appliedHash)))) {
      throw new Error('Invalid game settings sync manifest.');
    }
    if (record.pending && (!validHash(record.pending.sourceHash)
      || !(record.pending.beforeHash === null || validHash(record.pending.beforeHash)))) {
      throw new Error('Invalid pending game settings sync.');
    }
    const key = keyFor(relativePath);
    if (Object.hasOwn(files, key)) throw new Error('Duplicate game settings sync path.');
    files[key] = {
      sourceHash: record.sourceHash, appliedHash: record.appliedHash,
      ...(record.pending ? { pending: { sourceHash: record.pending.sourceHash, beforeHash: record.pending.beforeHash } } : {})
    };
  }
  return { formatVersion: 1, sourceDirectory: document.sourceDirectory, files };
}

async function readTarget(root, relativePath) {
  const file = await safeFile(root, relativePath);
  return file?.stats ? readBounded(file.filePath) : null;
}

async function syncNow(root, sourceProfileDirectories) {
  let sourceDirectory = '';
  let sourceFiles = [];
  for (const candidate of sourceProfileDirectories) {
    let resolved;
    try { resolved = await fs.realpath(path.resolve(candidate)); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (keyFor(resolved) === keyFor(root)) {
      return { copied: 0, preserved: 0, conflicts: [], sourceDirectory: resolved, skipped: true, backupDirectory: '' };
    }
    const files = await collectPreferences(resolved);
    if (!files.length) continue;
    sourceDirectory = resolved;
    sourceFiles = files;
    break;
  }
  const result = { copied: 0, preserved: 0, conflicts: [], sourceDirectory, skipped: false, backupDirectory: '' };
  if (!sourceFiles.length || keyFor(sourceDirectory) === keyFor(root)) {
    result.skipped = true;
    return result;
  }
  if (isNested(sourceDirectory, root) || isNested(root, sourceDirectory)) {
    throw new Error('Game settings source and target profiles must not be nested.');
  }
  await fs.mkdir(root, { recursive: true });
  if (keyFor(await fs.realpath(root)) !== keyFor(root)) throw new Error('Game profile path changed during settings sync.');

  const manifest = await loadManifest(root);
  manifest.sourceDirectory = sourceDirectory;
  // Validate every destination before copying the first setting.
  for (const file of sourceFiles) await safeFile(root, file.relativePath);
  await safeDirectory(root, BACKUP_PATH);
  const persistManifest = async () => {
    if (Object.keys(manifest.files).length > MAX_ENTRIES) throw new Error('Too many tracked game settings files.');
    const target = await safeFile(root, MANIFEST_PATH, true);
    await writeJsonAtomic(target.filePath, manifest);
  };
  const backup = async (bytes) => {
    const relativePath = `${BACKUP_PATH}/${hash(bytes)}.conf`;
    const target = await safeFile(root, relativePath, true);
    if (target.stats) {
      if (hash(await readBounded(target.filePath)) !== hash(bytes)) throw new Error('Invalid game settings backup.');
    } else {
      await writeFileAtomic(target.filePath, bytes);
    }
    result.backupDirectory = path.join(root, ...BACKUP_PATH.split('/'));
  };

  for (const file of sourceFiles) {
    const key = keyFor(file.relativePath);
    let current = await readTarget(root, file.relativePath);
    let currentHash = hash(current);
    let record = manifest.files[key];
    if (record?.pending) {
      const pending = record.pending;
      if (currentHash === pending.beforeHash) {
        // Replacement never happened. Retain the previous committed baseline.
        if (record.sourceHash === null) delete manifest.files[key];
        else delete record.pending;
      } else {
        // A different target may be an edit made after a successful copy whose
        // final manifest write failed. Never treat that target as first-run data.
        manifest.files[key] = { sourceHash: pending.sourceHash, appliedHash: pending.sourceHash };
      }
      await persistManifest();
      record = manifest.files[key];
    }

    if (currentHash === file.sourceHash) {
      if (record?.sourceHash !== file.sourceHash || record?.appliedHash !== file.sourceHash) {
        manifest.files[key] = { sourceHash: file.sourceHash, appliedHash: file.sourceHash };
        await persistManifest();
      }
      result.preserved += 1;
      continue;
    }
    if (current !== null && record?.sourceHash === file.sourceHash) {
      result.preserved += 1;
      continue;
    }
    if (current !== null && record && currentHash !== record.appliedHash) {
      result.preserved += 1;
      result.conflicts.push(file.relativePath);
      continue;
    }

    if (current !== null) await backup(current);
    manifest.files[key] = {
      sourceHash: record?.sourceHash ?? null,
      appliedHash: record?.appliedHash ?? null,
      pending: { sourceHash: file.sourceHash, beforeHash: currentHash }
    };
    await persistManifest();
    const target = await safeFile(root, file.relativePath, true);
    // A preferences editor may have changed the target during backup/journaling.
    current = await readTarget(root, file.relativePath);
    if (hash(current) !== currentHash) {
      result.preserved += 1;
      result.conflicts.push(file.relativePath);
    } else {
      await writeFileAtomic(target.filePath, file.bytes);
      result.copied += 1;
    }
    manifest.files[key] = { sourceHash: file.sourceHash, appliedHash: file.sourceHash };
    await persistManifest();
  }
  return result;
}

async function syncGameProfileSettings({ profileDirectory, sourceProfileDirectories = [] } = {}) {
  if (typeof profileDirectory !== 'string' || !profileDirectory.trim()) throw new Error('Game profile directory is missing.');
  if (!Array.isArray(sourceProfileDirectories) || sourceProfileDirectories.length > 16
    || sourceProfileDirectories.some((value) => typeof value !== 'string')) throw new Error('Invalid game settings source directories.');
  const root = await canonicalProfilePath(profileDirectory);
  const key = keyFor(root);
  const previous = syncQueues.get(key) || Promise.resolve();
  const sources = [...new Set(sourceProfileDirectories.map((value) => value.trim()).filter(Boolean))];
  const pending = previous.catch(() => {}).then(() => syncNow(root, sources));
  syncQueues.set(key, pending);
  try { return await pending; } finally {
    if (syncQueues.get(key) === pending) syncQueues.delete(key);
  }
}

module.exports = { syncGameProfileSettings };
