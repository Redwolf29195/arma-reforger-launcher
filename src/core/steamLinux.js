// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 ALGZ / ExtaZzZ and contributors.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const STEAM_APP_ID = '1874880';
const GAME_EXECUTABLE = 'ArmaReforgerSteam.exe';
const MAX_VDF_BYTES = 1024 * 1024;

function uniquePaths(values) {
  const seen = new Set();
  return values.filter(value => typeof value === 'string' && value.trim() && !value.includes('\0'))
    .map(value => path.normalize(value))
    .filter(value => {
      const key = process.platform === 'win32' ? value.toLowerCase() : value;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function linuxSteamRootCandidates({ homeDirectory = os.homedir(), env = process.env } = {}) {
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : path.join(homeDirectory, '.local', 'share');
  return uniquePaths([
    env.STEAM_PATH && path.isAbsolute(env.STEAM_PATH) ? env.STEAM_PATH : '',
    path.join(dataHome, 'Steam'),
    path.join(homeDirectory, '.local', 'share', 'Steam'),
    path.join(homeDirectory, '.steam', 'steam'),
    path.join(homeDirectory, '.steam', 'root'),
    // Discovery only: sandbox access and Flatpak launching are separate concerns.
    path.join(homeDirectory, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')
  ]);
}

// Steam uses Valve KeyValues, including comments and legacy numeric path entries.
function parseValveKeyValues(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_VDF_BYTES) throw new Error('Steam metadata is too large.');
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let tokenCount = 0;
  function token() {
    while (offset < source.length) {
      if (/\s/.test(source[offset])) { offset += 1; continue; }
      if (source.slice(offset, offset + 2) === '//') {
        const end = source.indexOf('\n', offset + 2);
        offset = end < 0 ? source.length : end + 1;
        continue;
      }
      break;
    }
    if (offset === source.length) return null;
    if (++tokenCount > 100000) throw new Error('Too many Steam metadata entries.');
    const first = source[offset++];
    if (first === '{' || first === '}') return { bracket: first };
    if (first !== '"') {
      let value = first;
      while (offset < source.length && !/[\s{}"]/.test(source[offset])) value += source[offset++];
      return { value };
    }
    let value = '';
    while (offset < source.length) {
      const character = source[offset++];
      if (character === '"') return { value };
      if (character === '\\' && ['"', '\\'].includes(source[offset])) value += source[offset++];
      else value += character;
    }
    throw new Error('Unterminated Steam metadata string.');
  }
  function object(depth = 0) {
    if (depth > 32) throw new Error('Steam metadata nesting is too deep.');
    const result = Object.create(null);
    for (;;) {
      const key = token();
      if (key === null) {
        if (depth) throw new Error('Unterminated Steam metadata object.');
        return result;
      }
      if (key.bracket === '}') {
        if (!depth) throw new Error('Unexpected Steam metadata closing bracket.');
        return result;
      }
      if (key.bracket) throw new Error('Invalid Steam metadata key.');
      const value = token();
      if (!value || value.bracket === '}') throw new Error('Missing Steam metadata value.');
      result[key.value] = value.bracket === '{' ? object(depth + 1) : value.value;
    }
  }
  return object();
}

function field(object, name) {
  if (!object || typeof object !== 'object') return undefined;
  const key = Object.keys(object).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : object[key];
}

async function readVdf(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_VDF_BYTES) throw new Error('Invalid Steam metadata file.');
    const buffer = Buffer.alloc(stats.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stats.size) throw new Error('Steam metadata changed during discovery.');
    return parseValveKeyValues(buffer.subarray(0, size).toString('utf8'));
  } finally {
    await handle.close();
  }
}

async function readSteamLibraries(steamRoot) {
  const libraries = [steamRoot];
  try {
    const data = await readVdf(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'));
    const entries = field(data, 'libraryfolders');
    for (const [key, value] of Object.entries(entries || {})) {
      if (!/^\d+$/.test(key)) continue;
      const candidate = typeof value === 'string' ? value : field(value, 'path');
      if (typeof candidate === 'string' && candidate.length <= 4096 && !candidate.includes('\0') && path.isAbsolute(candidate)) {
        libraries.push(candidate);
      }
      if (libraries.length >= 128) break;
    }
  } catch {
    // A missing, concurrently written or invalid VDF does not hide this root.
  }
  return uniquePaths(libraries);
}

async function existingDirectories(candidates) {
  const directories = [];
  for (const candidate of uniquePaths(candidates)) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) directories.push(await fs.realpath(candidate));
    } catch { /* A stale library or not-yet-created Proton prefix is normal. */ }
  }
  return uniquePaths(directories);
}

function steamLibraryFromGamePath(gameExecutable) {
  if (typeof gameExecutable !== 'string' || !gameExecutable.trim()) return '';
  const normalized = path.normalize(gameExecutable.trim().replace(/^"|"$/g, ''));
  const marker = `${path.sep}steamapps${path.sep}`;
  const index = normalized.indexOf(marker);
  return index > 0 ? normalized.slice(0, index) : '';
}

function protonPrefixCandidates(gameExecutable = '', libraries = []) {
  return uniquePaths([steamLibraryFromGamePath(gameExecutable), ...libraries])
    .map(library => path.join(library, 'steamapps', 'compatdata', STEAM_APP_ID, 'pfx'));
}

async function discoverLinuxSteam(options = {}) {
  const roots = await existingDirectories(options.steamRoots || linuxSteamRootCandidates(options));
  const candidates = [];
  for (const root of roots) candidates.push(...await readSteamLibraries(root));
  const libraries = await existingDirectories(candidates);
  const installations = [];
  for (const libraryPath of libraries) {
    try {
      const metadata = await readVdf(path.join(libraryPath, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`));
      const app = field(metadata, 'AppState');
      const installDirectory = field(app, 'installdir');
      if (field(app, 'appid') !== STEAM_APP_ID || typeof installDirectory !== 'string'
          || !installDirectory.trim() || /[\\/\0:]/.test(installDirectory)
          || ['.', '..'].includes(installDirectory)) continue;
      const gameDirectory = path.join(libraryPath, 'steamapps', 'common', installDirectory);
      const gameExecutable = path.join(gameDirectory, GAME_EXECUTABLE);
      if (!(await fs.stat(gameExecutable)).isFile()) continue;
      const compatDataDirectory = path.join(libraryPath, 'steamapps', 'compatdata', STEAM_APP_ID);
      installations.push({ libraryPath, gameDirectory, gameExecutable, compatDataDirectory, protonPrefix: path.join(compatDataDirectory, 'pfx') });
    } catch { /* Ignore incomplete installs and metadata for other games. */ }
  }
  return { roots, libraries, installations };
}

async function findLinuxGameProfileDirectories(gameExecutable = '', options = {}) {
  const discovery = await discoverLinuxSteam(options);
  const prefixes = await existingDirectories(protonPrefixCandidates(gameExecutable, [
    ...discovery.installations.map(installation => installation.libraryPath),
    ...discovery.libraries
  ]));
  const candidates = [];
  for (const prefix of prefixes) {
    const usersRoot = path.join(prefix, 'drive_c', 'users');
    let userNames = ['steamuser'];
    try {
      const entries = await fs.readdir(usersRoot, { withFileTypes: true });
      userNames.push(...entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink())
        && !['public', 'default', 'default user', 'all users'].includes(entry.name.toLowerCase()))
        .map(entry => entry.name).sort().slice(0, 64));
    } catch { /* Prefix may not have been initialized yet. */ }
    for (const user of new Set(userNames)) {
      for (const documents of ['Documents', 'My Documents']) {
        candidates.push(path.join(usersRoot, user, documents, 'My Games', 'ArmaReforger'));
      }
    }
  }
  // Leave room for the launcher's non-Proton fallbacks in its bounded settings
  // import list, and preserve the selected library's priority.
  return (await existingDirectories(candidates)).slice(0, 8);
}

module.exports = {
  GAME_EXECUTABLE,
  STEAM_APP_ID,
  discoverLinuxSteam,
  findLinuxGameProfileDirectories,
  linuxSteamRootCandidates,
  parseValveKeyValues,
  protonPrefixCandidates,
  readSteamLibraries,
  steamLibraryFromGamePath
};
