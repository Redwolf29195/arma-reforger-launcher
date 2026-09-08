const path = require('node:path');
const { normalizeServerAddress } = require('./serverBrowser');

const ARMA_REFORGER_STEAM_APP_ID = '1874880';

function platformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

// Steam chooses Proton. Its default Wine Z: drive maps to the host filesystem
// root; keep settings and filesystem operations native, translating only at
// the Windows game's command-line boundary.
function toGamePath(value, platform = process.platform) {
  const source = String(value || '');
  if (platform !== 'linux') return source;
  if (!path.posix.isAbsolute(source) || /[\\\0\r\n]/.test(source)) {
    throw new Error('Linux game directories must be absolute native paths without backslashes.');
  }
  return `Z:${path.posix.normalize(source).replace(/\//g, '\\')}`;
}

function parseAdditionalArguments(value) {
  const source = String(value || '').trim();
  if (!source) return [];

  const argumentsList = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = '';
      else current += character;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        argumentsList.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }

  if (quote) throw new Error('В дополнительных параметрах не закрыта кавычка.');
  if (current) argumentsList.push(current);
  return argumentsList;
}

function buildLaunchArguments(options) {
  const platform = options.platform || process.platform;
  const mods = options.mods ?? [];
  const settings = options.settings ?? {};
  const ids = [...new Set(mods.map((mod) => String(mod.modId || '').toUpperCase()).filter(Boolean))];
  const serverAddress = options.serverAddress ? normalizeServerAddress(options.serverAddress) : '';
  if (ids.length === 0 && !serverAddress) throw new Error('Не выбран ни один мод.');

  const args = [];
  if (settings.profileDirectory) args.push('-profile', toGamePath(settings.profileDirectory, platform));
  if (settings.addonsDirectory && !isDownloadDirectory(settings.addonsDirectory, settings.downloadRoot, platform)) {
    args.push('-addonsDir', toGamePath(settings.addonsDirectory, platform));
  }
  if (settings.downloadRoot) args.push('-addonDownloadDir', toGamePath(settings.downloadRoot, platform));
  if (!serverAddress) args.push('-world', 'worlds/MainMenuWorld/MainMenuWorld.ent');
  if (settings.noSplash !== false) args.push('-noSplash');
  args.push(...parseAdditionalArguments(settings.additionalArguments));
  if (serverAddress) args.push('-client', serverAddress);
  return args;
}

// A bare -client starts RPL before the main menu's authenticated Room workflow.
// Hand the endpoint to our one-shot bridge instead; the native server browser
// remains responsible for version, password, Workshop, and queue dialogs.
function buildServerConnectArguments(options) {
  const platform = options.platform || process.platform;
  normalizeServerAddress(options.serverAddress);
  const token = String(options.joinToken || '');
  if (!/^[0-9a-f]{32}$/.test(token)) throw new Error('Некорректный идентификатор подключения.');
  if (!options.settings?.profileDirectory) throw new Error('Не задан профиль подключения.');
  const args = buildAddonDownloadArguments(options);
  const logsIndex = args.indexOf('-logsDir');
  args[logsIndex + 1] = toGamePath(platformPath(platform).join(options.settings.profileDirectory, 'logs', 'server-join'), platform);
  args.push('-algzJoinRequest', token);
  return args;
}

function buildAddonDownloadArguments(options) {
  const platform = options.platform || process.platform;
  const nativePath = platformPath(platform);
  const settings = options.settings ?? {};
  const bridgeDirectory = String(options.bridgeDirectory || '').trim();
  const bridgeModId = String(options.bridgeModId || '').trim().toUpperCase();
  if (!bridgeDirectory) throw new Error('Не найдена папка компонента Workshop.');
  if (!/^[0-9A-F]{16}$/.test(bridgeModId)) throw new Error('Некорректный GUID компонента Workshop.');

  const args = [];
  if (settings.profileDirectory) args.push('-profile', toGamePath(settings.profileDirectory, platform));
  args.push('-addonsDir', toGamePath(bridgeDirectory, platform));
  if (settings.downloadRoot) {
    args.push('-addonDownloadDir', toGamePath(settings.downloadRoot, platform));
    args.push('-addonTempDir', toGamePath(nativePath.join(settings.downloadRoot, 'temp'), platform));
  }
  if (settings.profileDirectory) {
    args.push('-logsDir', toGamePath(nativePath.join(settings.profileDirectory, 'logs', 'workshop-bridge'), platform));
  }
  args.push('-addons', bridgeModId);
  args.push('-world', 'worlds/MainMenuWorld/MainMenuWorld.ent');
  if (settings.noSplash !== false) args.push('-noSplash');
  return args;
}

function normalizeDirectory(value, platform) {
  const normalized = platformPath(platform).resolve(String(value || '').trim());
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isDownloadDirectory(addonsDirectory, downloadRoot, platform = process.platform) {
  if (!addonsDirectory || !downloadRoot) return false;
  return normalizeDirectory(addonsDirectory, platform) === normalizeDirectory(platformPath(platform).join(downloadRoot, 'addons'), platform);
}

function getLaunchWorkingDirectory(gameExecutable, platform = process.platform) {
  return platformPath(platform).dirname(gameExecutable);
}

function quoteLaunchArgument(value) {
  const argument = String(value ?? '');
  if (!argument) return '""';
  if (!/[\s"]/.test(argument)) return argument;
  const escaped = argument
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, '$1$1');
  return `"${escaped}"`;
}

function buildSteamClientArguments(gameArguments, appId = ARMA_REFORGER_STEAM_APP_ID) {
  return ['-applaunch', String(appId), ...(gameArguments || []).map((argument) => String(argument))];
}

function buildSteamLaunchUrl(gameArguments, appId = ARMA_REFORGER_STEAM_APP_ID) {
  const commandLine = (gameArguments || []).map(quoteLaunchArgument).join(' ');
  return `steam://run/${encodeURIComponent(String(appId))}//${encodeURIComponent(commandLine)}/`;
}

module.exports = {
  ARMA_REFORGER_STEAM_APP_ID,
  buildAddonDownloadArguments,
  buildLaunchArguments,
  buildServerConnectArguments,
  buildSteamClientArguments,
  buildSteamLaunchUrl,
  getLaunchWorkingDirectory,
  isDownloadDirectory,
  parseAdditionalArguments,
  quoteLaunchArgument,
  toGamePath
};
