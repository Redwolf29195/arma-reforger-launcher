const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { resolvePresetDependencies } = require('./modScanner');

function comparablePath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function cleanupCreatedPaths(paths) {
  for (const targetPath of [...paths].reverse()) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
    } catch {
      // The original mod remains untouched if cleanup is incomplete.
    }
  }
}

async function transferPresetMods({
  addonsDirectory,
  destinationDirectory,
  preset,
  installedMods,
  mode = 'copy',
  includeDependencies = true
}) {
  if (!['copy', 'move'].includes(mode)) throw new Error('Выберите копирование или перемещение модов.');
  if (!addonsDirectory) throw new Error('Папка addons не настроена.');
  if (!destinationDirectory) throw new Error('Выберите папку назначения.');
  if (!preset?.id || !Array.isArray(preset.mods) || preset.mods.length === 0) {
    throw new Error('Выбранный пресет не содержит модов.');
  }

  const addonsRoot = await fs.realpath(path.resolve(addonsDirectory));
  await fs.mkdir(path.resolve(destinationDirectory), { recursive: true });
  const destinationRoot = await fs.realpath(path.resolve(destinationDirectory));
  if (isInside(comparablePath(addonsRoot), comparablePath(destinationRoot))) {
    throw new Error('Выберите папку назначения вне текущей папки addons.');
  }

  const resolved = resolvePresetDependencies(preset, installedMods, { includeDependencies });
  if (resolved.mods.length > 1000) throw new Error('В пресете слишком много модов для одной операции.');
  const installedById = new Map(installedMods.map((mod) => [String(mod.modId || '').toUpperCase(), mod]));
  const missing = [];
  const transfers = [];
  const seenTargets = new Set();

  for (const requirement of resolved.mods) {
    const installed = installedById.get(String(requirement.modId || '').toUpperCase());
    if (!installed?.directoryPath) {
      missing.push(requirement.name || requirement.modId);
      continue;
    }
    const sourcePath = await fs.realpath(installed.directoryPath);
    if (comparablePath(path.dirname(sourcePath)) !== comparablePath(addonsRoot)) {
      throw new Error(`Мод находится вне настроенной папки addons: ${requirement.name || requirement.modId}.`);
    }
    const directoryName = path.basename(sourcePath);
    const targetPath = path.join(destinationRoot, directoryName);
    const targetKey = comparablePath(targetPath);
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);
    transfers.push({ modId: requirement.modId, name: requirement.name, sourcePath, targetPath, directoryName });
  }

  if (missing.length > 0) {
    throw new Error(`Сначала установите отсутствующие моды: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}.`);
  }
  if (transfers.length === 0) throw new Error('Не найдены установленные моды для переноса.');
  for (const item of transfers) {
    if (await pathExists(item.targetPath)) {
      throw new Error(`В выбранной папке уже существует мод: ${item.directoryName}.`);
    }
  }

  const stagingRoot = path.join(destinationRoot, `.arma-launcher-transfer-${crypto.randomUUID()}`);
  const finalizedTargets = [];
  await fs.mkdir(stagingRoot, { recursive: false });
  try {
    for (const item of transfers) {
      const stagedPath = path.join(stagingRoot, item.directoryName);
      await fs.cp(item.sourcePath, stagedPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true
      });
    }
    for (const item of transfers) {
      const stagedPath = path.join(stagingRoot, item.directoryName);
      await fs.rename(stagedPath, item.targetPath);
      finalizedTargets.push(item.targetPath);
    }
  } catch (error) {
    await cleanupCreatedPaths(finalizedTargets);
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }

  let removedCount = 0;
  const failedRemovals = [];
  if (mode === 'move') {
    for (const item of transfers) {
      try {
        if (comparablePath(path.dirname(item.sourcePath)) !== comparablePath(addonsRoot)) {
          throw new Error('Путь мода изменился во время операции.');
        }
        await fs.rm(item.sourcePath, { recursive: true, force: false });
        removedCount += 1;
      } catch {
        failedRemovals.push(item.name || item.modId);
      }
    }
  }

  return {
    mode,
    destinationDirectory: destinationRoot,
    transferredCount: transfers.length,
    removedCount,
    failedRemovalCount: failedRemovals.length,
    dependencyCount: resolved.dependencyCount
  };
}

module.exports = {
  comparablePath,
  isInside,
  transferPresetMods
};
