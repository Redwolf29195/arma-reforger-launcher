const fs = require('node:fs/promises');
const path = require('node:path');
const { writeJsonAtomic } = require('./jsonFiles');

const MOD_ID_PATTERN = /^[0-9A-F]{16}$/;
const ACCOUNT_DIRECTORY_PATTERN = /^app\d+_user\d+$/i;
const WORKSHOP_FILE_PATTERN = /^I([0-9A-F]{16})\.json$/i;
let profileWriteQueue = Promise.resolve();

function enqueueProfileWrite(operation) {
  const pending = profileWriteQueue.then(operation);
  profileWriteQueue = pending.catch(() => {});
  return pending;
}

async function listDirectories(directoryPath) {
  try {
    return (await fs.readdir(directoryPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function findAccountName(saveRoots) {
  for (const saveRoot of saveRoots) {
    const accountNames = (await listDirectories(saveRoot))
      .filter((name) => ACCOUNT_DIRECTORY_PATTERN.test(name))
      .sort((left, right) => left.localeCompare(right));
    if (accountNames.length > 0) return accountNames[0];
  }
  return '';
}

async function readWorkshopState(filePath) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > 64 * 1024) return null;
    const value = JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function collectWorkshopIds(workshopDirectory) {
  try {
    const entries = await fs.readdir(workshopDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name.match(WORKSHOP_FILE_PATTERN)?.[1]?.toUpperCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeModIds(mods) {
  return new Set((mods || [])
    .map((mod) => String(mod?.modId || '').trim().toUpperCase())
    .filter((modId) => MOD_ID_PATTERN.test(modId)));
}

async function findSourceState(modId, workshopDirectories) {
  for (const directoryPath of workshopDirectories) {
    const state = await readWorkshopState(path.join(directoryPath, `I${modId}.json`));
    if (state) return state;
  }
  return null;
}

async function writeStateIfChanged(filePath, currentState, nextState) {
  if (currentState && JSON.stringify(currentState) === JSON.stringify(nextState)) return false;
  await writeJsonAtomic(filePath, nextState);
  return true;
}

async function syncWorkshopSelection(value) {
  return enqueueProfileWrite(() => syncWorkshopSelectionNow(value));
}

async function syncWorkshopSelectionNow({
  profileDirectory,
  fallbackProfileDirectories = [],
  installedMods = [],
  enabledMods = []
}) {
  const targetSaveRoot = path.join(profileDirectory, 'profile', '.save');
  const fallbackSaveRoots = [...new Set(fallbackProfileDirectories.filter(Boolean))]
    .map((directoryPath) => path.join(directoryPath, 'profile', '.save'));
  const accountName = await findAccountName([targetSaveRoot, ...fallbackSaveRoots]);
  if (!accountName) {
    return {
      skipped: true,
      reason: 'Профиль Steam ещё не создан. Один раз откройте Arma Reforger до главного меню.',
      enabled: 0,
      disabled: 0,
      updated: 0
    };
  }

  const targetWorkshopDirectory = path.join(targetSaveRoot, accountName, 'workshop');
  const fallbackWorkshopDirectories = fallbackSaveRoots
    .map((saveRoot) => path.join(saveRoot, accountName, 'workshop'));
  await fs.mkdir(targetWorkshopDirectory, { recursive: true });

  const installedIds = normalizeModIds(installedMods);
  const enabledIds = normalizeModIds(enabledMods);
  const existingIds = await collectWorkshopIds(targetWorkshopDirectory);
  const allIds = new Set([...installedIds, ...enabledIds, ...existingIds]);
  let updated = 0;

  for (const modId of allIds) {
    const targetPath = path.join(targetWorkshopDirectory, `I${modId}.json`);
    const currentState = await readWorkshopState(targetPath);
    const sourceState = currentState || await findSourceState(modId, fallbackWorkshopDirectories) || {};
    const nextState = {
      ...sourceState,
      m_bIsEnabled: enabledIds.has(modId),
      m_bIsFavorite: sourceState.m_bIsFavorite === true,
      m_bIsBlocked: sourceState.m_bIsBlocked === true,
      m_fMyRating: Number.isFinite(sourceState.m_fMyRating) ? sourceState.m_fMyRating : -1.0
    };
    if (await writeStateIfChanged(targetPath, currentState, nextState)) updated += 1;
  }

  return {
    skipped: false,
    accountDirectory: path.join(targetSaveRoot, accountName),
    enabled: enabledIds.size,
    disabled: [...allIds].filter((modId) => !enabledIds.has(modId)).length,
    updated
  };
}

async function disableWorkshopMod(value) {
  return enqueueProfileWrite(() => disableWorkshopModNow(value));
}

async function disableWorkshopModNow({ modId, profileDirectories = [] }) {
  const normalizedId = String(modId || '').trim().toUpperCase();
  if (!MOD_ID_PATTERN.test(normalizedId)) throw new Error('Некорректный GUID мода.');

  const roots = [...new Set(profileDirectories.filter(Boolean).map((value) => path.resolve(value)))];
  let updated = 0;
  for (const root of roots) {
    const saveRoot = path.join(root, 'profile', '.save');
    const accountNames = (await listDirectories(saveRoot)).filter((name) => ACCOUNT_DIRECTORY_PATTERN.test(name));
    for (const accountName of accountNames) {
      const statePath = path.join(saveRoot, accountName, 'workshop', `I${normalizedId}.json`);
      const currentState = await readWorkshopState(statePath);
      if (!currentState) continue;
      const nextState = { ...currentState, m_bIsEnabled: false };
      if (await writeStateIfChanged(statePath, currentState, nextState)) updated += 1;
    }
  }
  return { updated };
}

module.exports = {
  disableWorkshopMod,
  syncWorkshopSelection
};
