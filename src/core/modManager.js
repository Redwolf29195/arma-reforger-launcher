const fs = require('node:fs/promises');
const path = require('node:path');
const { MOD_ID_PATTERN } = require('./presetParser');

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function removeInstalledMod({ addonsDirectory, installedMods, modId }) {
  const normalizedId = String(modId || '').trim().toUpperCase();
  if (!MOD_ID_PATTERN.test(normalizedId)) throw new Error('Некорректный GUID мода.');
  if (!addonsDirectory) throw new Error('Папка установленных модов не настроена.');

  const mod = (installedMods || []).find((item) => item.modId === normalizedId);
  if (!mod?.directoryPath) throw new Error('Установленный мод не найден. Обновите список модов.');

  const addonsRoot = await fs.realpath(addonsDirectory);
  const targetDirectory = await fs.realpath(mod.directoryPath);
  if (comparablePath(path.dirname(targetDirectory)) !== comparablePath(addonsRoot)) {
    throw new Error('Удаление отменено: каталог мода находится вне настроенной папки addons.');
  }

  const stats = await fs.stat(targetDirectory);
  if (!stats.isDirectory()) throw new Error('Каталог установленного мода не найден.');

  await fs.rm(targetDirectory, {
    recursive: true,
    force: false,
    maxRetries: 3,
    retryDelay: 150
  });

  return {
    modId: normalizedId,
    name: mod.name || normalizedId,
    directoryPath: targetDirectory
  };
}

module.exports = {
  removeInstalledMod
};
