const fs = require('node:fs/promises');
const path = require('node:path');
const { readJsonFile } = require('./jsonFiles');
const { compareModVersions, modVersionsEqual, selectCurrentModVersion } = require('./modVersion');
const { MOD_ID_PATTERN } = require('./presetParser');

const DIRECTORY_GUID_PATTERN = /_([0-9A-F]{16})$/i;
const BUILTIN_ADDON_IDS = new Set(['5614BBCCBB55ED1C', '58D0FB3206B6F859']);

function normalizeDependency(rawDependency) {
  const modId = String(rawDependency?.assetId ?? rawDependency?.modId ?? '').trim().toUpperCase();
  if (!MOD_ID_PATTERN.test(modId)) return null;
  return {
    modId,
    name: String(rawDependency.assetName ?? rawDependency.name ?? modId).trim(),
    version: String(rawDependency.version ?? '').trim()
  };
}

async function readSmallText(filePath, maxBytes = 1024 * 1024) {
  const stats = await fs.stat(filePath);
  if (stats.size > maxBytes) throw new Error('Файл метаданных слишком большой.');
  return fs.readFile(filePath, 'utf8');
}

async function readProjectMetadata(directoryPath) {
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const hasWorkshopManifest = entries.some((entry) => entry.isFile()
    && /\.(?:gproj|pak|rdb)_.+_manifest\.json$/i.test(entry.name));
  const projectEntry = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.gproj')
    .sort((left, right) => {
      if (left.name.toLowerCase() === 'addon.gproj') return -1;
      if (right.name.toLowerCase() === 'addon.gproj') return 1;
      return left.name.localeCompare(right.name);
    })[0];
  if (!projectEntry) return { hasWorkshopManifest };

  try {
    const projectPath = path.join(directoryPath, projectEntry.name);
    const [text, stats] = await Promise.all([
      readSmallText(projectPath),
      fs.stat(projectPath)
    ]);
    const guid = text.match(/\bGUID\s+"([0-9A-F]{16})"/i)?.[1]?.toUpperCase() || '';
    const title = text.match(/\bTITLE\s+"([^"]+)"/i)?.[1] || '';
    const dependencyBlock = text.match(/\bDependencies\s*\{([\s\S]*?)\}/i)?.[1] || '';
    const dependencies = [...dependencyBlock.matchAll(/"([0-9A-F]{16})"/gi)]
      .map((match) => match[1].toUpperCase())
      .filter((modId) => modId !== guid && !BUILTIN_ADDON_IDS.has(modId))
      .map((modId) => ({ modId, name: '', version: '' }));
    return { guid, title, dependencies, metadataModifiedAt: stats.mtimeMs, hasWorkshopManifest };
  } catch {
    return { hasWorkshopManifest };
  }
}

async function readModDirectory(directoryPath) {
  const projectMetadata = await readProjectMetadata(directoryPath);
  const serverDataPath = path.join(directoryPath, 'ServerData.json');
  try {
    const [serverData, serverDataStats] = await Promise.all([
      readJsonFile(serverDataPath, 2 * 1024 * 1024),
      fs.stat(serverDataPath)
    ]);
    const modId = String(serverData.id ?? '').trim().toUpperCase();
    if (!MOD_ID_PATTERN.test(modId)) throw new Error('Некорректный GUID в ServerData.json.');

    const serverDependencies = (Array.isArray(serverData.revision?.dependencies) ? serverData.revision.dependencies : [])
      .map(normalizeDependency)
      .filter((dependency) => dependency && dependency.modId !== modId && !BUILTIN_ADDON_IDS.has(dependency.modId));
    const dependenciesById = new Map(serverDependencies.map((dependency) => [dependency.modId, dependency]));
    for (const dependency of projectMetadata?.dependencies || []) {
      if (!dependenciesById.has(dependency.modId)) dependenciesById.set(dependency.modId, dependency);
    }

    return {
      modId,
      name: String(serverData.name ?? modId).trim(),
      version: String(serverData.revision?.version ?? '').trim(),
      gameVersion: String(serverData.revision?.gameVersion ?? '').trim(),
      corrupted: serverData.revision?.corrupted === true,
      dependencies: [...dependenciesById.values()],
      directoryPath,
      metadataModifiedAt: serverDataStats.mtimeMs,
      source: 'ServerData.json'
    };
  } catch (serverDataError) {
    try {
      const directoryGuid = path.basename(directoryPath).match(DIRECTORY_GUID_PATTERN)?.[1]?.toUpperCase();
      const modId = projectMetadata?.guid || directoryGuid;
      if (!modId || !MOD_ID_PATTERN.test(modId)) throw serverDataError;

      // A Workshop transfer creates its directory/project before writing completion
      // metadata. Only a valid manual project may omit ServerData.json safely.
      const incomplete = !projectMetadata?.guid
        || projectMetadata.hasWorkshopManifest === true
        || serverDataError.code !== 'ENOENT';

      return {
        modId,
        name: projectMetadata?.title || path.basename(directoryPath).replace(DIRECTORY_GUID_PATTERN, ''),
        version: '',
        gameVersion: '',
        corrupted: incomplete,
        dependencies: projectMetadata?.dependencies || [],
        directoryPath,
        metadataModifiedAt: projectMetadata?.metadataModifiedAt || 0,
        source: 'addon.gproj'
      };
    } catch {
      return null;
    }
  }
}

async function scanMods(addonsDirectory) {
  if (!addonsDirectory) return [];

  let entries;
  try {
    entries = await fs.readdir(addonsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(addonsDirectory, entry.name));

  const mods = [];
  const concurrency = 12;
  for (let index = 0; index < directories.length; index += concurrency) {
    const chunk = directories.slice(index, index + concurrency);
    const results = await Promise.all(chunk.map(readModDirectory));
    mods.push(...results.filter(Boolean));
  }

  const unique = new Map();
  for (const mod of mods) {
    const existing = unique.get(mod.modId);
    if (!existing) {
      unique.set(mod.modId, mod);
      continue;
    }

    const versionOrder = compareModVersions(mod.version, existing.version);
    const hasVersionWhenExistingDoesNot = Boolean(mod.version) && !existing.version;
    const versionsHaveNoOrder = versionOrder === null || versionOrder === 0;
    const hasNewerMetadata = versionsHaveNoOrder
      && Boolean(mod.version) === Boolean(existing.version)
      && Number(mod.metadataModifiedAt || 0) > Number(existing.metadataModifiedAt || 0);
    if (hasVersionWhenExistingDoesNot || versionOrder > 0 || hasNewerMetadata) unique.set(mod.modId, mod);
  }

  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name, 'ru'));
}

function assessPreset(preset, installedMods) {
  const installedById = new Map(installedMods.map((mod) => [mod.modId, mod]));
  return preset.mods.map((requiredMod) => {
    const installed = installedById.get(requiredMod.modId);
    let status = 'ready';
    if (!installed) status = 'missing';
    else if (installed.corrupted) status = 'corrupted';
    else if (requiredMod.version && installed.version && !modVersionsEqual(requiredMod.version, installed.version)) status = 'version-mismatch';
    else if (requiredMod.version && !installed.version) status = 'version-unknown';

    return {
      ...requiredMod,
      installed,
      status
    };
  });
}

function getMissingPresetMods(preset, installedMods) {
  return assessPreset(preset, installedMods)
    .filter((mod) => mod.status === 'missing')
    .map(({ installed: _installed, status: _status, ...mod }) => mod);
}

function resolvePresetDependencies(preset, installedMods, options = {}) {
  const requestedMods = Array.isArray(preset?.mods) ? preset.mods : [];
  const includeDependencies = options.includeDependencies !== false;
  const requestedById = new Map(requestedMods.map((mod) => [String(mod.modId).toUpperCase(), mod]));
  const installedById = new Map(installedMods.map((mod) => [mod.modId, mod]));
  const selectedIds = new Set(requestedById.keys());
  const resolved = [];
  const missingDependencies = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(requirement) {
    const modId = String(requirement?.modId || '').toUpperCase();
    if (!MOD_ID_PATTERN.test(modId) || visited.has(modId)) return;
    if (visiting.has(modId)) return;

    visiting.add(modId);
    const installed = installedById.get(modId);
    if (includeDependencies) {
      for (const dependency of installed?.dependencies || []) {
        const requestedDependency = requestedById.get(dependency.modId);
        visit(requestedDependency || { ...dependency, required: true });
      }
    }
    visiting.delete(modId);
    visited.add(modId);

    const source = requestedById.get(modId) || requirement;
    if (!installed && !selectedIds.has(modId)) missingDependencies.push(source);
    resolved.push({
      modId,
      name: source.name || installed?.name || modId,
      version: selectCurrentModVersion(source.version, installed?.version),
      required: source.required !== false
    });
  }

  for (const mod of requestedMods) visit(mod);

  return {
    mods: resolved,
    selectedCount: selectedIds.size,
    dependencyCount: resolved.filter((mod) => !selectedIds.has(mod.modId)).length,
    missingDependencies
  };
}

module.exports = {
  assessPreset,
  getMissingPresetMods,
  readModDirectory,
  resolvePresetDependencies,
  scanMods
};
