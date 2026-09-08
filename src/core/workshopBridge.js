const fs = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomic } = require('./jsonFiles');

const pendingInstallations = new Map();

const WORKSHOP_BRIDGE_DIRECTORY_NAME = 'ALGZLauncherWorkshopBridge';
const REQUIRED_BRIDGE_FILES = [
  'addon.gproj',
  'resourceDatabase.rdb',
  path.join('Scripts', 'Game', 'ALGZLauncherWorkshopBridge.c')
];

async function readRequiredFiles(directoryPath) {
  const files = new Map();
  for (const relativePath of REQUIRED_BRIDGE_FILES) {
    const filePath = path.join(directoryPath, relativePath);
    const value = await fs.readFile(filePath);
    if (value.length === 0) throw new Error(`Workshop bridge file is empty: ${relativePath}`);
    files.set(relativePath, value);
  }
  return files;
}

async function installWorkshopBridge({ sourceDirectory, profileDirectory }) {
  const source = path.resolve(String(sourceDirectory || '').trim());
  const profile = path.resolve(String(profileDirectory || '').trim());
  if (!String(sourceDirectory || '').trim()) throw new Error('Workshop bridge source directory is missing.');
  if (!String(profileDirectory || '').trim()) throw new Error('Workshop profile directory is missing.');

  const key = process.platform === 'win32' ? profile.toLowerCase() : profile;
  const previous = pendingInstallations.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => installWorkshopBridgeNow(source, profile));
  pendingInstallations.set(key, pending);
  try {
    return await pending;
  } finally {
    if (pendingInstallations.get(key) === pending) pendingInstallations.delete(key);
  }
}

async function installWorkshopBridgeNow(source, profile) {
  const sourceFiles = await readRequiredFiles(source);
  const addonsDirectory = path.join(profile, 'profile', 'addons');
  const targetDirectory = path.join(addonsDirectory, WORKSHOP_BRIDGE_DIRECTORY_NAME);
  await fs.mkdir(targetDirectory, { recursive: true });

  for (const [relativePath, value] of sourceFiles) {
    const targetPath = path.join(targetDirectory, relativePath);
    await writeFileAtomic(targetPath, value);
  }

  const installedFiles = await readRequiredFiles(targetDirectory);
  for (const [relativePath, sourceValue] of sourceFiles) {
    if (!sourceValue.equals(installedFiles.get(relativePath))) {
      throw new Error(`Workshop bridge verification failed: ${relativePath}`);
    }
  }

  return {
    addonsDirectory,
    projectPath: path.join(targetDirectory, 'addon.gproj'),
    targetDirectory
  };
}

module.exports = {
  REQUIRED_BRIDGE_FILES,
  WORKSHOP_BRIDGE_DIRECTORY_NAME,
  installWorkshopBridge
};
