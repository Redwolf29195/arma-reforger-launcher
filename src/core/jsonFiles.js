const fs = require('node:fs/promises');
const { COPYFILE_EXCL } = require('node:fs').constants;
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const pendingWrites = new Map();

async function preserveJsonRecoveryCopy(filePath, error) {
  if (error?.code === 'ENOENT') return;
  const recoveryPath = `${filePath}.recovery.${Date.now()}.${randomUUID()}.bak`;
  // Do not reset unreadable state unless its original bytes remain recoverable.
  await fs.copyFile(filePath, recoveryPath, COPYFILE_EXCL);
}

async function readJsonFile(filePath, maxBytes = 8 * 1024 * 1024) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error('Указанный путь не является файлом.');
  }
  if (stats.size > maxBytes) {
    throw new Error(`JSON слишком большой: ${Math.ceil(stats.size / 1024 / 1024)} МБ.`);
  }

  const text = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Некорректный JSON: ${error.message}`);
  }
}

async function writeJsonAtomic(filePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  return writeFileAtomic(filePath, content);
}

async function writeFileAtomic(filePath, value) {
  const content = Buffer.isBuffer(value) ? Buffer.from(value) : String(value);
  const destination = path.resolve(filePath);
  const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
  const previous = pendingWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
      // Rename replaces the destination atomically; deleting it first loses the
      // previous document if replacement fails and exposes a gap to readers.
      await fs.rename(temporaryPath, destination);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  });
  pendingWrites.set(key, pending);
  try {
    await pending;
  } finally {
    if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
  }
}

module.exports = {
  preserveJsonRecoveryCopy,
  readJsonFile,
  writeFileAtomic,
  writeJsonAtomic
};
