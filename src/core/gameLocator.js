const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function defaultAddonsCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(home, 'Documents', 'My Games', 'ArmaReforger', 'addons'),
      path.join(home, 'OneDrive', 'Documents', 'My Games', 'ArmaReforger', 'addons')
    ];
  }

  return [
    path.join(home, '.local', 'share', 'ArmaReforger', 'addons'),
    path.join(home, 'Documents', 'My Games', 'ArmaReforger', 'addons')
  ];
}

function steamRootCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Steam') : '',
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Steam') : '',
      process.env.STEAM_PATH || '',
      'C:\\Steam',
      'C:\\Programs\\Steam',
      'C:\\Program Files (x86)\\Steam'
    ].filter(Boolean);
  }

  return [
    path.join(home, '.steam', 'steam'),
    path.join(home, '.local', 'share', 'Steam')
  ];
}

async function readSteamLibraries(steamRoot) {
  const libraries = new Set([steamRoot]);
  const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  try {
    const vdf = await fs.readFile(vdfPath, 'utf8');
    for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      libraries.add(match[1].replace(/\\\\/g, '\\'));
    }
  } catch {
    // Steam may not be installed in this candidate.
  }
  return [...libraries];
}

function executableName() {
  return process.platform === 'win32' ? 'ArmaReforgerSteam.exe' : 'ArmaReforgerSteam';
}

function normalizeConfiguredPath(value) {
  const configuredPath = String(value || '').trim().replace(/^"|"$/g, '');
  return configuredPath ? path.normalize(configuredPath) : '';
}

function steamRootFromGamePath(value) {
  const configuredPath = normalizeConfiguredPath(value);
  if (!configuredPath) return '';
  const marker = `${path.sep}steamapps${path.sep}`.toLowerCase();
  const markerIndex = configuredPath.toLowerCase().indexOf(marker);
  return markerIndex > 0 ? configuredPath.slice(0, markerIndex) : '';
}

async function steamRegistryRoots() {
  if (process.platform !== 'win32') return [];
  const queries = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath']
  ];
  const roots = [];
  for (const [key, valueName] of queries) {
    try {
      const { stdout } = await execFileAsync('reg.exe', ['query', key, '/v', valueName], {
        encoding: 'utf8',
        windowsHide: true
      });
      const line = String(stdout || '').split(/\r?\n/).find((entry) => entry.includes(valueName) && /REG_\w+/.test(entry));
      const match = line?.match(/REG_\w+\s+(.+)$/);
      if (match?.[1]) roots.push(path.normalize(match[1].trim()));
    } catch {
      // Continue with the normal Steam locations.
    }
  }
  return roots;
}

async function findSteamExecutable(preferredGamePath = '') {
  const preferredRoot = steamRootFromGamePath(preferredGamePath);
  const roots = [...new Set([
    preferredRoot,
    ...await steamRegistryRoots(),
    ...steamRootCandidates()
  ].filter(Boolean))];

  if (process.platform === 'win32') {
    for (const root of roots) {
      const candidate = path.join(root, 'steam.exe');
      if (await isFile(candidate)) return candidate;
    }
    return '';
  }

  const candidates = process.platform === 'darwin'
    ? ['/Applications/Steam.app/Contents/MacOS/steam_osx']
    : ['/usr/bin/steam', '/usr/games/steam', ...roots.map((root) => path.join(root, 'steam.sh'))];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return '';
}

function configuredExecutableCandidates(value) {
  const configuredPath = normalizeConfiguredPath(value);
  if (!configuredPath) return [];

  const executable = executableName();
  return [...new Set([
    configuredPath,
    path.join(configuredPath, executable),
    path.join(configuredPath, 'steamapps', 'common', 'Arma Reforger', executable)
  ])];
}

async function resolveGameExecutable(value) {
  const expectedName = executableName().toLowerCase();
  for (const candidate of configuredExecutableCandidates(value)) {
    if (path.basename(candidate).toLowerCase() !== expectedName) continue;
    if (await isFile(candidate)) return candidate;
  }
  return '';
}

async function findGameExecutable(preferredPath = '') {
  const preferredExecutable = await resolveGameExecutable(preferredPath);
  if (preferredExecutable) return preferredExecutable;

  const candidates = [];
  for (const steamRoot of steamRootCandidates()) {
    for (const library of await readSteamLibraries(steamRoot)) {
      candidates.push(path.join(library, 'steamapps', 'common', 'Arma Reforger', executableName()));
    }
  }

  if (process.platform === 'win32') {
    for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
      const drive = String.fromCharCode(code);
      candidates.push(`${drive}:\\SteamLibrary\\steamapps\\common\\Arma Reforger\\ArmaReforgerSteam.exe`);
      candidates.push(`${drive}:\\Steam\\steamapps\\common\\Arma Reforger\\ArmaReforgerSteam.exe`);
    }
  }

  for (const candidate of [...new Set(candidates)]) {
    if (await isFile(candidate)) return candidate;
  }
  return '';
}

async function findAddonsDirectory() {
  for (const candidate of defaultAddonsCandidates()) {
    if (await exists(candidate)) return candidate;
  }
  return defaultAddonsCandidates()[0];
}

module.exports = {
  defaultAddonsCandidates,
  exists,
  findAddonsDirectory,
  findGameExecutable,
  findSteamExecutable,
  isFile,
  normalizeConfiguredPath,
  resolveGameExecutable,
  steamRootFromGamePath
};
