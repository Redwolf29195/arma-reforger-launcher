const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { discoverLinuxSteam, findLinuxGameProfileDirectories, linuxSteamRootCandidates } = require('./steamLinux');

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

function defaultAddonsCandidates(options = {}) {
  const home = options.homeDirectory || os.homedir();
  if ((options.platform || process.platform) === 'win32') {
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

function steamRootCandidates(options = {}) {
  const home = options.homeDirectory || os.homedir();
  const platform = options.platform || process.platform;
  if (options.steamRoots) return options.steamRoots;
  if (platform === 'linux') return linuxSteamRootCandidates(options);
  if (platform === 'win32') {
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
    // Preserve the existing Windows/macOS discovery behavior.
  }
  return [...libraries];
}

function executableName(platform = process.platform) {
  return platform === 'win32' || platform === 'linux' ? 'ArmaReforgerSteam.exe' : 'ArmaReforgerSteam';
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

async function findSteamExecutable(preferredGamePath = '', options = {}) {
  const platform = options.platform || process.platform;
  const preferredRoot = steamRootFromGamePath(preferredGamePath);
  const roots = [...new Set([
    preferredRoot,
    ...(platform === 'win32' ? await steamRegistryRoots() : []),
    ...steamRootCandidates(options)
  ].filter(Boolean))];

  if (platform === 'win32') {
    for (const root of roots) {
      const candidate = path.join(root, 'steam.exe');
      if (await isFile(candidate)) return candidate;
    }
    return '';
  }

  const candidates = platform === 'darwin'
    ? ['/Applications/Steam.app/Contents/MacOS/steam_osx']
    : ['/usr/bin/steam', '/usr/games/steam', ...roots.map((root) => path.join(root, 'steam.sh'))];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return '';
}

function configuredExecutableCandidates(value, options = {}) {
  const configuredPath = normalizeConfiguredPath(value);
  if (!configuredPath) return [];

  const executable = executableName(options.platform || process.platform);
  return [...new Set([
    configuredPath,
    path.join(configuredPath, executable),
    path.join(configuredPath, 'steamapps', 'common', 'Arma Reforger', executable)
  ])];
}

async function resolveGameExecutable(value, options = {}) {
  const expectedName = executableName(options.platform || process.platform).toLowerCase();
  for (const candidate of configuredExecutableCandidates(value, options)) {
    if (path.basename(candidate).toLowerCase() !== expectedName) continue;
    if (await isFile(candidate)) return candidate;
  }
  return '';
}

async function findGameExecutable(preferredPath = '', options = {}) {
  const platform = options.platform || process.platform;
  const preferredExecutable = await resolveGameExecutable(preferredPath, options);
  if (preferredExecutable) return preferredExecutable;

  if (platform === 'linux') {
    const roots = [steamRootFromGamePath(preferredPath), ...steamRootCandidates(options)].filter(Boolean);
    const discovery = await discoverLinuxSteam({ ...options, steamRoots: roots });
    return discovery.installations[0]?.gameExecutable || '';
  }

  const candidates = [];
  for (const steamRoot of steamRootCandidates(options)) {
    for (const library of await readSteamLibraries(steamRoot)) {
      candidates.push(path.join(library, 'steamapps', 'common', 'Arma Reforger', executableName(platform)));
    }
  }

  if (platform === 'win32') {
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

async function findAddonsDirectory(preferredGamePath = '', options = {}) {
  if (preferredGamePath && typeof preferredGamePath === 'object') {
    options = preferredGamePath;
    preferredGamePath = '';
  }
  if ((options.platform || process.platform) === 'linux') {
    const profiles = await findLinuxGameProfileDirectories(preferredGamePath, options);
    if (preferredGamePath && profiles.length) return path.join(profiles[0], 'addons');
    for (const profile of profiles) {
      const addons = path.join(profile, 'addons');
      try { if ((await fs.stat(addons)).isDirectory()) return addons; } catch { /* Try next profile. */ }
    }
    // Keep future Workshop downloads in the discovered game's profile even before
    // its first mod download has created the addons directory.
    if (profiles.length) return path.join(profiles[0], 'addons');
  }
  for (const candidate of defaultAddonsCandidates(options)) {
    if (await exists(candidate)) return candidate;
  }
  return defaultAddonsCandidates(options)[0];
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
