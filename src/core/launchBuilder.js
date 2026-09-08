const path = require('node:path');
const { normalizeServerAddress } = require('./serverBrowser');

const ARMA_REFORGER_STEAM_APP_ID = '1874880';

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
  const mods = options.mods ?? [];
  const settings = options.settings ?? {};
  const ids = [...new Set(mods.map((mod) => String(mod.modId || '').toUpperCase()).filter(Boolean))];
  const serverAddress = options.serverAddress ? normalizeServerAddress(options.serverAddress) : '';
  if (ids.length === 0 && !serverAddress) throw new Error('Не выбран ни один мод.');

  const args = [];
  if (settings.profileDirectory) args.push('-profile', settings.profileDirectory);
  if (settings.addonsDirectory && !isDownloadDirectory(settings.addonsDirectory, settings.downloadRoot)) {
    args.push('-addonsDir', settings.addonsDirectory);
  }
  if (settings.downloadRoot) args.push('-addonDownloadDir', settings.downloadRoot);
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
  normalizeServerAddress(options.serverAddress);
  const token = String(options.joinToken || '');
  if (!/^[0-9a-f]{32}$/.test(token)) throw new Error('Некорректный идентификатор подключения.');
  if (!options.settings?.profileDirectory) throw new Error('Не задан профиль подключения.');
  const args = buildAddonDownloadArguments(options);
  const logsIndex = args.indexOf('-logsDir');
  args[logsIndex + 1] = path.join(options.settings.profileDirectory, 'logs', 'server-join');
  args.push('-algzJoinRequest', token);
  return args;
}

function buildAddonDownloadArguments(options) {
  const settings = options.settings ?? {};
  const bridgeDirectory = String(options.bridgeDirectory || '').trim();
  const bridgeModId = String(options.bridgeModId || '').trim().toUpperCase();
  if (!bridgeDirectory) throw new Error('Не найдена папка компонента Workshop.');
  if (!/^[0-9A-F]{16}$/.test(bridgeModId)) throw new Error('Некорректный GUID компонента Workshop.');

  const args = [];
  if (settings.profileDirectory) args.push('-profile', settings.profileDirectory);
  args.push('-addonsDir', bridgeDirectory);
  if (settings.downloadRoot) {
    args.push('-addonDownloadDir', settings.downloadRoot);
    args.push('-addonTempDir', path.join(settings.downloadRoot, 'temp'));
  }
  if (settings.profileDirectory) {
    args.push('-logsDir', path.join(settings.profileDirectory, 'logs', 'workshop-bridge'));
  }
  args.push('-addons', bridgeModId);
  args.push('-world', 'worlds/MainMenuWorld/MainMenuWorld.ent');
  if (settings.noSplash !== false) args.push('-noSplash');
  return args;
}

function normalizeDirectory(value) {
  const normalized = path.resolve(String(value || '').trim());
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isDownloadDirectory(addonsDirectory, downloadRoot) {
  if (!addonsDirectory || !downloadRoot) return false;
  return normalizeDirectory(addonsDirectory) === normalizeDirectory(path.join(downloadRoot, 'addons'));
}

function getLaunchWorkingDirectory(gameExecutable) {
  return path.dirname(gameExecutable);
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
  quoteLaunchArgument
};
