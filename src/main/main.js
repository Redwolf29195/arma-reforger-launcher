const { app, BrowserWindow, clipboard, dialog, ipcMain: electronIpcMain, shell, session } = require('electron');
const {
  buildFactoryResetRelaunchArguments,
  completeFactoryReset,
  createFactoryResetTicket,
  discardFactoryResetTicket,
  hasForbiddenPackagedRuntimeSwitch,
  prepareFactoryResetStartup
} = require('../core/factoryResetWorker');
const packagedRuntimeSwitchBlocked = app.isPackaged
  && hasForbiddenPackagedRuntimeSwitch(process.argv.slice(1));
const factoryResetStartup = packagedRuntimeSwitchBlocked
  ? { active: false }
  : prepareFactoryResetStartup(app, process.argv.slice(1));
const { acquireLauncherInstance } = require('./singleInstance');
let mainWindow;
if (!acquireLauncherInstance({ app, getMainWindow: () => mainWindow, factoryResetStartup })) return;
const { applyStableUpdateChannel, createLauncherUpdater } = require('./fastUpdater');
const autoUpdater = createLauncherUpdater();
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { findAddonsDirectory, findGameExecutable, findSteamExecutable } = require('../core/gameLocator');
const { findLinuxGameProfileDirectories } = require('../core/steamLinux');
const { isArmaReforgerRunning, isSteamRunning } = require('../core/gameProcess');
const { assessPreset, getMissingPresetMods, resolvePresetDependencies, scanMods } = require('../core/modScanner');
const { toServerModText, toServerModsText } = require('../core/presetParser');
const { transferPresetMods } = require('../core/presetTransfer');
const { removeInstalledMod } = require('../core/modManager');
const { translateToRussian } = require('../core/translationClient');
const {
  buildAddonDownloadArguments,
  buildLaunchArguments,
  buildSteamClientArguments,
  buildSteamLaunchUrl
} = require('../core/launchBuilder');
const { disableWorkshopMod, syncWorkshopSelection } = require('../core/workshopProfile');
const { syncGameProfileSettings } = require('../core/gameProfileSettings');
const { installWorkshopBridge } = require('../core/workshopBridge');
const { fetchWorkshopDetails, fetchWorkshopSearch, normalizeScenarioId } = require('../core/workshopDetails');
const { createServerConnectionController } = require('../core/serverConnectionController');
const { createNativeServerLauncher } = require('../core/serverNativeLauncher');
const { createServerJoinMonitor, cancelServerJoinRequest } = require('../core/serverJoinBridge');
const {
  fetchServerDetails,
  fetchServerList,
  normalizeServerAddress
} = require('../core/serverBrowser');
const {
  WORKSHOP_BRIDGE_MOD_ID,
  resolveWorkshopQueue
} = require('../core/workshopDownloadQueue');
const { createWorkshopDownloadController } = require('../core/workshopDownloadSession');
const { createInstalledModUpdater } = require('../core/installedModUpdates');
const SettingsStore = require('../core/settingsStore');
const PresetStore = require('../core/presetStore');
const WorkspaceStore = require('../core/workspaceStore');
const ModLogStore = require('../core/modLogStore');
const Logger = require('../core/logger');
const { createUpdatePushSubscriber } = require('../core/updatePush');
const { classifyUpdateError } = require('../core/updateError');
const { OFFICIAL_RELEASES_URL, readBuildIdentity } = require('../core/buildIdentity');
const {
  PINNED_PUBLIC_KEY_PATH,
  verifyUpdateArtifactFile
} = require('../core/updateArtifactSignature');
const { verifyUpdatePolicyEnvelope } = require('../core/updatePolicy');
const UpdateDeadlineStore = require('../core/updateDeadlineStore');
const { installEditingShortcuts } = require('./editingShortcuts');
const { createTrustedIpcRegistrar } = require('./ipcTrust');
const { fetchUpdateArtifactEnvelope } = require('./updateArtifactFetch');
const { createUpdateTrustPolicy, selectSignedInstallerUpdate } = require('./updateTrust');

let settingsStore;
let presetStore;
let workspaceStore;
let modLogStore;
let logger;
let installedMods = [];
let updaterState = 'idle';
let updateCheckPromise = null;
let availableUpdateInfo = null;
let availableUpdatePolicy = null;
let verifiedUpdateArtifact = null;
let updateEnvelopeCache = null;
let mandatoryInstallTimer = null;
let updateDeadlineStore;
let updateVerificationGeneration = 0;
let updateInstallStarted = false;
let updatePushSubscriber = null;
let lastPushUpdateCheckAt = 0;
let workspaceWriteQueue = Promise.resolve();
let factoryResetScheduled = false;
let buildIdentity = null;
let stopServerLaunchMonitor = null;
let updateTrustPolicy = Object.freeze({
  enabled: false,
  portable: false,
  verificationMode: 'disabled',
  updateConfigPath: ''
});
const workshopDownloads = createWorkshopDownloadController({
  isGameRunning: isArmaReforgerRunning,
  errorMessage: key => mainT(key)
});
const installedModUpdater = createInstalledModUpdater({
  getSettings: () => settingsStore.get(),
  scanInstalled: async settings => {
    installedMods = await scanMods(settings.addonsDirectory);
    return installedMods;
  },
  fetchDetails: fetchWorkshopDetails,
  isGameRunning: isArmaReforgerRunning,
  getDownloadStatus: settings => workshopDownloads.status(settings.profileDirectory),
  errorMessage: key => mainT(key),
  queueDownload: async (settings, items, plan) => {
    const gameExecutable = await findGameExecutable(settings.gameExecutable);
    if (!gameExecutable) throw new Error(mainT('gameNotFound'));
    return queueWorkshopDownload(settings, gameExecutable, items,
      `Updating ${plan.updateCount} installed Workshop mods`,
      { exactCollection: true, requireEmptyQueue: true });
  }
});
const FORCED_UPDATE_NOTICE_MS = 5_000;
const TRUSTED_RENDERER_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'armalaucher.com',
  'discord.gg',
  'github.com',
  'reforger.armaplatform.com',
  'reforgermods.com',
  'www.reforgermods.com'
]);
const ipcMain = createTrustedIpcRegistrar({
  ipcMain: electronIpcMain,
  getMainWindow: () => mainWindow,
  trustedRendererUrl: TRUSTED_RENDERER_URL,
  onRejected: (channel) => logger?.error(`Blocked untrusted IPC request for ${channel}`)
});

const mainMessages = {
  en: {
    importPresetTitle: 'Import Arma Reforger preset JSON',
    jsonTooLarge: 'JSON is too large. Maximum size: 4 MB.',
    exportPresetTitle: 'Export Arma Reforger preset',
    friendFileTitle: 'Preset file for a friend',
    chooseGame: 'Select the Arma Reforger executable',
    application: 'Application',
    allFiles: 'All files',
    chooseAddons: 'Select the addons folder',
    chooseDownloads: 'Select the mod download folder',
    chooseProfile: 'Select the launcher profile folder',
    chooseFolder: 'Select a folder',
    choosePresetTransferFolder: 'Select a folder for preset mods',
    gameNotFound: 'The Steam version of Arma Reforger was not found. Install the game in Steam or check your Steam library.',
    modsNotReady: 'Mods are not ready: {names}.',
    versionsMismatch: 'Versions do not match: {names}.',
    noMissingMods: 'No missing mods were found. Mods installed in a different version are not downloaded automatically.',
    gameAlreadyRunning: 'Close Arma Reforger before applying a preset or starting mod downloads.',
    gameSettingsImportFailed: 'Could not prepare your Arma settings. Close the game, check access to the profile folders, and try again.',
    workshopDownloadBusy: 'A Workshop download is already being prepared. Please wait.',
    workshopUpdateQueuePending: 'A Workshop queue is already saved or running. Resume and finish it before updating installed mods.',
    modUpdateBusy: 'Installed mod updates are already being checked. Please wait.',
    modUpdateInvalidSelection: 'Select between 1 and 500 installed mods to update.',
    modUpdateNotInstalled: 'The mod is no longer installed. Rescan the mod folder.',
    modUpdateTimedOut: 'Workshop did not respond within the update check time limit. Try again.',
    modUpdateWrongMetadata: 'Workshop returned details for a different mod. The update was skipped.',
    modUpdateUnknownVersion: 'The latest Workshop version could not be verified. The mod was skipped.',
    modUpdateUnknownInstalledVersion: 'The installed version is unknown. The mod was preserved without updating.',
    modUpdateNewerCorrupted: 'The damaged local mod reports a newer version than Workshop. Automatic downgrade was blocked.',
    modUpdateSettingsChanged: 'Mod paths changed during the update check. Check the settings and try again.',
    modUpdateFilesChanged: 'Installed mods changed during the update check. Rescan and try again.',
    workshopResumeMissing: 'There is no saved Workshop queue to resume.',
    workshopBridgeMissing: 'The launcher Workshop component is missing. Repair or update the launcher.',
    workshopBridgeInstallFailed: 'Could not prepare the Workshop component in the game profile: {message}',
    workshopBridgeStartupFailed: 'The Workshop component did not start. Close Arma Reforger and click the mod download button again; the launcher will repair it automatically.',
    factoryResetGameRunning: 'Close Arma Reforger before performing a full launcher reset.',
    workshopPathsMissing: 'Set the launcher profile and Workshop download folders in Settings.',
    steamLaunchFailed: 'Could not pass the launch request to Steam: {message}',
    invalidModGuid: 'Invalid mod GUID.',
    serverModNotFound: 'The selected mod is no longer present in this server pack. Refresh the server and try again.',
    presetNotFound: 'The selected preset was not found.',
    modNotInPreset: 'The mod was not found in the selected preset.',
    choosePreset: 'Select a preset.',
    advancedModeRequired: 'Enable Advanced mode in Settings first.',
    presetTransferGameRunning: 'Close Arma Reforger before copying or moving preset mods.',
    presetTransferFailed: 'Could not transfer preset mods: {message}',
    workshopDetailsFailed: 'Could not load Workshop details: {message}',
    workshopSearchFailed: 'Could not search Workshop: {message}',
    translationFailed: 'Could not translate the mod description: {message}',
    invalidScenarioId: 'Invalid scenario ID.',
    checkUpdateFirst: 'Click “Check for updates” first and wait for an available version.',
    downloadUpdateFirst: 'Download the update first and wait for it to finish.',
    updateChannelUnavailable: 'The update service is temporarily unavailable. Please try again later.',
    updateNetworkUnavailable: 'Could not reach the update service. Check your internet connection and try again.',
    updateVerificationFailed: 'The update could not be verified and was not installed.',
    updateStorageFailed: 'The update could not be saved. Check free disk space and folder permissions.',
    updateUnknownError: 'Could not check for updates. Please try again later.',
    unsupportedRuntimeTitle: 'Unsupported launch arguments',
    unsupportedRuntimeMessage: 'Start the packaged launcher without remote-debugging, inspector or user-data-dir arguments. Use the development command to debug source builds.'
  },
  ru: {
    importPresetTitle: 'Импорт JSON пресета Arma Reforger',
    jsonTooLarge: 'JSON слишком большой. Максимальный размер: 4 МБ.',
    exportPresetTitle: 'Экспорт пресета Arma Reforger',
    friendFileTitle: 'Файл пресета для друга',
    chooseGame: 'Выберите исполняемый файл Arma Reforger',
    application: 'Приложение',
    allFiles: 'Все файлы',
    chooseAddons: 'Выберите папку addons',
    chooseDownloads: 'Выберите папку загрузки модов',
    chooseProfile: 'Выберите папку профиля лаунчера',
    chooseFolder: 'Выберите папку',
    choosePresetTransferFolder: 'Выберите папку для модов пресета',
    gameNotFound: 'Steam-версия Arma Reforger не найдена. Установите игру в Steam или проверьте библиотеку Steam.',
    modsNotReady: 'Не готовы моды: {names}.',
    versionsMismatch: 'Версии не совпадают: {names}.',
    noMissingMods: 'Отсутствующие моды не найдены. Моды с другой установленной версией автоматически не скачиваются.',
    gameAlreadyRunning: 'Закройте Arma Reforger перед применением пресета или загрузкой модов.',
    gameSettingsImportFailed: 'Не удалось подготовить ваши настройки Arma. Закройте игру, проверьте доступ к папкам профиля и повторите запуск.',
    workshopDownloadBusy: 'Загрузка Workshop уже подготавливается. Подождите.',
    workshopUpdateQueuePending: 'Уже есть сохранённая или активная очередь Workshop. Продолжите и завершите её перед обновлением модов.',
    modUpdateBusy: 'Проверка обновлений модов уже выполняется. Подождите.',
    modUpdateInvalidSelection: 'Выберите от 1 до 500 установленных модов для обновления.',
    modUpdateNotInstalled: 'Мод больше не установлен. Пересканируйте папку модов.',
    modUpdateTimedOut: 'Workshop не ответил за время проверки обновлений. Повторите попытку.',
    modUpdateWrongMetadata: 'Workshop вернул данные другого мода. Обновление пропущено.',
    modUpdateUnknownVersion: 'Не удалось проверить последнюю версию Workshop. Мод пропущен.',
    modUpdateUnknownInstalledVersion: 'Установленная версия неизвестна. Мод сохранён без обновления.',
    modUpdateNewerCorrupted: 'Повреждённый локальный мод сообщает версию новее Workshop. Автоматический откат заблокирован.',
    modUpdateSettingsChanged: 'Пути модов изменились во время проверки. Проверьте настройки и повторите попытку.',
    modUpdateFilesChanged: 'Установленные моды изменились во время проверки. Пересканируйте и повторите попытку.',
    workshopResumeMissing: 'Нет сохранённой очереди Workshop для продолжения.',
    workshopBridgeMissing: 'Служебный компонент Workshop отсутствует. Восстановите или обновите лаунчер.',
    workshopBridgeInstallFailed: 'Не удалось подготовить компонент Workshop в профиле игры: {message}',
    workshopBridgeStartupFailed: 'Компонент Workshop не запустился. Закройте Arma Reforger и снова нажмите кнопку загрузки модов — лаунчер восстановит его автоматически.',
    factoryResetGameRunning: 'Закройте Arma Reforger перед полным сбросом лаунчера.',
    workshopPathsMissing: 'Укажите в настройках папку профиля лаунчера и папку загрузки Workshop.',
    steamLaunchFailed: 'Не удалось передать запуск клиенту Steam: {message}',
    invalidModGuid: 'Некорректный GUID мода.',
    serverModNotFound: 'Выбранного мода больше нет в сборке сервера. Обновите сервер и попробуйте снова.',
    presetNotFound: 'Выбранный пресет не найден.',
    modNotInPreset: 'Мод не найден в выбранном пресете.',
    choosePreset: 'Выберите пресет.',
    advancedModeRequired: 'Сначала включите расширенный режим в настройках.',
    presetTransferGameRunning: 'Закройте Arma Reforger перед копированием или перемещением модов пресета.',
    presetTransferFailed: 'Не удалось перенести моды пресета: {message}',
    workshopDetailsFailed: 'Не удалось загрузить данные Workshop: {message}',
    workshopSearchFailed: 'Не удалось выполнить поиск в Workshop: {message}',
    translationFailed: 'Не удалось перевести описание мода: {message}',
    invalidScenarioId: 'Некорректный ID сценария.',
    checkUpdateFirst: 'Сначала нажмите «Проверить обновления» и дождитесь найденной версии.',
    downloadUpdateFirst: 'Сначала скачайте обновление и дождитесь завершения загрузки.',
    updateChannelUnavailable: 'Сервис обновлений временно недоступен. Попробуйте позже.',
    updateNetworkUnavailable: 'Не удалось связаться с сервисом обновлений. Проверьте интернет и повторите попытку.',
    updateVerificationFailed: 'Не удалось проверить подлинность обновления. Оно не было установлено.',
    updateStorageFailed: 'Не удалось сохранить обновление. Проверьте свободное место и доступ к папке.',
    updateUnknownError: 'Не удалось проверить обновления. Попробуйте позже.',
    unsupportedRuntimeTitle: 'Неподдерживаемые параметры запуска',
    unsupportedRuntimeMessage: 'Запустите установленный лаунчер без параметров remote-debugging, inspect и user-data-dir. Для отладки исходников используйте команду запуска в режиме разработки.'
  }
};

function mainT(key, parameters = {}) {
  const configuredLanguage = settingsStore?.get().language;
  const language = configuredLanguage === 'ru'
    || (!configuredLanguage && String(app.getLocale?.() || '').toLowerCase().startsWith('ru'))
    ? 'ru'
    : 'en';
  const value = mainMessages[language][key] || mainMessages.en[key] || key;
  return value.replace(/\{(\w+)\}/g, (_match, name) => String(parameters[name] ?? ''));
}

function safeUpdateErrorMessage(error) {
  const keys = {
    channel: 'updateChannelUnavailable',
    network: 'updateNetworkUnavailable',
    verification: 'updateVerificationFailed',
    storage: 'updateStorageFailed',
    unknown: 'updateUnknownError'
  };
  return mainT(keys[classifyUpdateError(error)] || keys.unknown);
}

function publishUpdateStatus(status) {
  updaterState = status.state;
  sendUpdateStatus(status);
}

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:status', status);
}

function isTransientUpdateError(error) {
  return /CONNECTION_(?:RESET|CLOSED|REFUSED|ABORTED)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|NETWORK_CHANGED/i.test(error?.message || '');
}

function clearVerifiedUpdateArtifact() {
  updateVerificationGeneration += 1;
  if (mandatoryInstallTimer) clearTimeout(mandatoryInstallTimer);
  mandatoryInstallTimer = null;
  updateInstallStarted = false;
  verifiedUpdateArtifact = null;
  autoUpdater.autoInstallOnAppQuit = false;
}

function publicUpdatePolicy(policy) {
  return {
    gracePeriodSeconds: Number(policy?.gracePeriodSeconds || 0),
    mode: String(policy?.mode || 'optional'),
    version: String(policy?.version || '')
  };
}

async function verifySignedUpdatePolicy(updateInfo) {
  const descriptor = selectSignedInstallerUpdate(updateInfo);
  const encodedEnvelope = String(updateInfo?.algzUpdatePolicy || '');
  if (!encodedEnvelope) throw new Error('update-policy-missing');
  const publicKeyPem = await fs.readFile(PINNED_PUBLIC_KEY_PATH);
  return verifyUpdatePolicyEnvelope({
    encodedEnvelope,
    publicKeyPem,
    expectedVersion: descriptor.version,
    expectedArtifactName: descriptor.artifactName,
    expectedSha512: descriptor.sha512,
    expectedSize: descriptor.size
  });
}

function revealMandatoryUpdateWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function beginVerifiedUpdateInstall(reason = 'user') {
  if (!updateTrustPolicy.enabled || updaterState !== 'downloaded' || !verifiedUpdateArtifact) {
    throw new Error(mainT('downloadUpdateFirst'));
  }
  if (updateInstallStarted) return true;
  updateInstallStarted = true;
  if (mandatoryInstallTimer) clearTimeout(mandatoryInstallTimer);
  mandatoryInstallTimer = null;
  logger?.info(`Starting verified update installation (${reason})`);
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (error) {
    updateInstallStarted = false;
    throw error;
  }
  return true;
}

async function activateMandatoryUpdate(updateInfo, policy, descriptor, verificationGeneration) {
  const graceMilliseconds = policy.mode === 'semi-forced'
    ? policy.gracePeriodSeconds * 1_000
    : FORCED_UPDATE_NOTICE_MS;
  // A persisted timestamp is only timing data: both the installer and signed
  // policy have already been verified before this function is called.
  const [savedDeadline, gameRunning] = await Promise.all([
    updateDeadlineStore.getOrCreate({ descriptor, policy, noticeMilliseconds: graceMilliseconds })
      .catch((cause) => {
        const error = new Error('Could not persist the mandatory update deadline', { cause });
        error.code = 'UPDATE_DEADLINE_STORAGE';
        throw error;
      }),
    isArmaReforgerRunning().catch((error) => {
      logger?.info(`Could not determine game state for mandatory update: ${error.message}`);
      return false;
    })
  ]);
  if (verificationGeneration !== updateVerificationGeneration) return;
  const mandatory = Object.freeze({
    deadline: savedDeadline.deadline,
    gameRunning,
    gracePeriodSeconds: policy.mode === 'semi-forced'
      ? policy.gracePeriodSeconds
      : Math.ceil(FORCED_UPDATE_NOTICE_MS / 1_000),
    mode: policy.mode,
    version: String(updateInfo?.version || policy.version || '')
  });
  // Closing the launcher preserves the deadline; it must not bypass the
  // remaining grace period by triggering electron-updater's quit handler.
  autoUpdater.autoInstallOnAppQuit = false;
  publishUpdateStatus({
    state: 'downloaded',
    info: updateInfo,
    mandatory
  });
  revealMandatoryUpdateWindow();
  if (mandatoryInstallTimer) clearTimeout(mandatoryInstallTimer);
  mandatoryInstallTimer = setTimeout(() => {
    if (verificationGeneration !== updateVerificationGeneration) return;
    try {
      beginVerifiedUpdateInstall(`${policy.mode}-deadline`);
    } catch (error) {
      logger?.error(`Mandatory update installation failed: ${error.message}`);
      publishUpdateStatus({ state: 'error', message: mainT('updateStorageFailed') });
    }
  }, Math.max(0, mandatory.deadline - Date.now()));
}

async function loadUpdateEnvelope(descriptor) {
  if (updateEnvelopeCache
    && updateEnvelopeCache.version === descriptor.version
    && updateEnvelopeCache.artifactName === descriptor.artifactName
    && updateEnvelopeCache.sha512 === descriptor.sha512
    && updateEnvelopeCache.size === descriptor.size) {
    return updateEnvelopeCache.contents;
  }
  return fetchUpdateArtifactEnvelope({
    artifactName: descriptor.artifactName
  });
}

async function verifyAlgzUpdateArtifact(updateInfo, filePath) {
  const descriptor = selectSignedInstallerUpdate(updateInfo);
  const [envelope, publicKeyPem] = await Promise.all([
    loadUpdateEnvelope(descriptor),
    fs.readFile(PINNED_PUBLIC_KEY_PATH)
  ]);
  try {
    const verified = await verifyUpdateArtifactFile({
      envelope,
      publicKeyPem,
      filePath,
      expectedVersion: descriptor.version,
      expectedArtifactName: descriptor.artifactName,
      expectedSha512: descriptor.sha512,
      expectedSize: descriptor.size
    });
    updateEnvelopeCache = { ...descriptor, contents: envelope };
    return verified;
  } catch (error) {
    if (updateEnvelopeCache?.contents === envelope) updateEnvelopeCache = null;
    throw error;
  }
}

async function verifyDownloadedUpdate(updateInfo) {
  const downloadedFile = String(updateInfo?.downloadedFile || '');
  if (updateTrustPolicy.verificationMode === 'algz-ed25519') {
    return verifyAlgzUpdateArtifact(updateInfo, downloadedFile);
  }
  if (updateTrustPolicy.verificationMode === 'authenticode') {
    const signer = String(buildIdentity?.windowsPublisher || '');
    if (!signer) throw new Error('update-publisher-missing');
    const verificationError = await autoUpdater.verifyUpdateCodeSignature([signer], downloadedFile);
    if (verificationError !== null) throw new Error('update-publisher-invalid');
    return Object.freeze({ artifactName: path.basename(downloadedFile), version: String(updateInfo?.version || '') });
  }
  throw new Error('update-verification-disabled');
}

async function handleDownloadedUpdate(updateInfo) {
  clearVerifiedUpdateArtifact();
  const verificationGeneration = updateVerificationGeneration;
  const signedUpdateInfo = availableUpdateInfo || updateInfo;
  publishUpdateStatus({ state: 'verifying', info: { version: String(updateInfo?.version || '') } });
  try {
    const [verification, policy] = await Promise.all([
      verifyDownloadedUpdate(updateInfo),
      verifySignedUpdatePolicy(signedUpdateInfo)
    ]);
    if (verificationGeneration !== updateVerificationGeneration) return;
    availableUpdatePolicy = policy;
    verifiedUpdateArtifact = Object.freeze({ ...verification, updatePolicy: publicUpdatePolicy(policy) });
    const mandatory = policy.mode !== 'optional';
    autoUpdater.autoInstallOnAppQuit = !mandatory && settingsStore?.get().autoUpdate !== false;
    if (mandatory) {
      await activateMandatoryUpdate(updateInfo, policy, selectSignedInstallerUpdate(signedUpdateInfo), verificationGeneration);
    }
    else publishUpdateStatus({ state: 'downloaded', info: updateInfo });
  } catch (error) {
    if (verificationGeneration !== updateVerificationGeneration) return;
    logger?.error(`Downloaded update preparation failed: ${error.message}`);
    clearVerifiedUpdateArtifact();
    publishUpdateStatus({
      state: 'error',
      message: mainT(error.code === 'UPDATE_DEADLINE_STORAGE' ? 'updateStorageFailed' : 'updateVerificationFailed')
    });
  }
}

async function handleAvailableUpdate(info) {
  availableUpdateInfo = info;
  availableUpdatePolicy = null;
  clearVerifiedUpdateArtifact();
  const verificationGeneration = updateVerificationGeneration;
  let policy;
  try {
    policy = await verifySignedUpdatePolicy(info);
  } catch (error) {
    if (verificationGeneration !== updateVerificationGeneration) return;
    logger?.error(`Signed update policy rejected: ${error.message}`);
    availableUpdatePolicy = null;
    clearVerifiedUpdateArtifact();
    publishUpdateStatus({ state: 'error', message: mainT('updateVerificationFailed') });
    return;
  }
  if (verificationGeneration !== updateVerificationGeneration) return;
  availableUpdatePolicy = policy;
  publishUpdateStatus({ state: 'available', info, updatePolicy: publicUpdatePolicy(policy) });
  if (settingsStore?.get().autoUpdate !== false || policy.mode !== 'optional') {
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      logger?.error(`Automatic update download failed: ${error.message}`);
    }
  }
}

async function checkForUpdatesWithRetry() {
  if (!updateTrustPolicy.enabled) throw new Error('Trusted automatic updates are unavailable for this build.');
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await autoUpdater.checkForUpdates();
    } catch (error) {
      if (!isTransientUpdateError(error) || attempt === attempts) throw error;
      logger?.info(`Update check retry ${attempt + 1}/${attempts}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
    }
  }
  return null;
}

function requestUpdateCheck() {
  if (!updateCheckPromise) {
    updateCheckPromise = checkForUpdatesWithRetry().finally(() => {
      updateCheckPromise = null;
    });
  }
  return updateCheckPromise;
}

async function handleUpdatePushSignal(signal) {
  if (!updateTrustPolicy.enabled) return;
  if (signal.version === app.getVersion()) return;
  if (['checking', 'available', 'downloading', 'verifying', 'downloaded'].includes(updaterState)) return;
  if (Date.now() - lastPushUpdateCheckAt < 30_000) return;

  lastPushUpdateCheckAt = Date.now();
  logger?.info(`Instant update signal received for version ${signal.version}`);
  try {
    await requestUpdateCheck();
  } catch (error) {
    logger?.error(`Instant update check failed: ${error.message}`);
  }
}

function syncUpdatePushSubscription(settings = settingsStore?.get() || {}) {
  const enabled = updateTrustPolicy.enabled;
  if (!enabled) {
    updatePushSubscriber?.stop();
    return;
  }

  if (!updatePushSubscriber) {
    updatePushSubscriber = createUpdatePushSubscriber({
      onUpdate: handleUpdatePushSignal,
      onStatus: (status) => {
        if (status.state === 'connected') logger?.info('Instant update channel connected');
        else if (status.state === 'reconnecting' && status.error) {
          logger?.info(`Instant update channel reconnecting: ${status.error}`);
        }
      }
    });
  }
  updatePushSubscriber.start();
}

function applyUpdaterPreferences(settings = settingsStore?.get() || {}) {
  if (!updateTrustPolicy.enabled) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    return;
  }
  applyStableUpdateChannel(autoUpdater);
  const autoUpdate = settings.autoUpdate !== false;
  autoUpdater.autoDownload = false;
  const mandatory = verifiedUpdateArtifact?.updatePolicy?.mode !== undefined
    && verifiedUpdateArtifact.updatePolicy.mode !== 'optional';
  autoUpdater.autoInstallOnAppQuit = Boolean(verifiedUpdateArtifact) && autoUpdate && !mandatory;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.disableDifferentialDownload = false;
  autoUpdater.disableWebInstaller = true;
}

function configureUpdaterEvents() {
  if (!updateTrustPolicy.enabled) return;
  autoUpdater.logger = {
    info: (message) => logger?.info(`[updater] ${message}`),
    warn: (message) => logger?.info(`[updater warning] ${message}`),
    error: (message) => logger?.error(`[updater] ${message}`)
  };
  applyUpdaterPreferences();
  if (updateTrustPolicy.verificationMode === 'algz-ed25519') {
    autoUpdater.verifyUpdateCodeSignature = async (_publisherNames, filePath) => {
      try {
        await verifyAlgzUpdateArtifact(availableUpdateInfo, filePath);
        return null;
      } catch (error) {
        logger?.error(`ALGZ update artifact signature rejected: ${error.message}`);
        return 'ALGZ Ed25519 artifact signature verification failed';
      }
    };
  }
  autoUpdater.on('checking-for-update', () => {
    availableUpdateInfo = null;
    availableUpdatePolicy = null;
    updateEnvelopeCache = null;
    clearVerifiedUpdateArtifact();
    publishUpdateStatus({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    handleAvailableUpdate(info).catch((error) => {
      logger?.error(`Update policy handler failed: ${error.message}`);
      publishUpdateStatus({ state: 'error', message: mainT('updateVerificationFailed') });
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    availableUpdateInfo = null;
    availableUpdatePolicy = null;
    updateEnvelopeCache = null;
    clearVerifiedUpdateArtifact();
    publishUpdateStatus({ state: 'current', info });
  });
  autoUpdater.on('download-progress', (progress) => publishUpdateStatus({ state: 'downloading', progress }));
  autoUpdater.on('update-downloaded', (info) => {
    handleDownloadedUpdate(info).catch((error) => {
      logger?.error(`Downloaded update verification handler failed: ${error.message}`);
      clearVerifiedUpdateArtifact();
      publishUpdateStatus({ state: 'error', message: mainT('updateVerificationFailed') });
    });
  });
  autoUpdater.on('error', (error) => {
    logger?.error(`Update error: ${error.message}`);
    availableUpdatePolicy = null;
    clearVerifiedUpdateArtifact();
    publishUpdateStatus({ state: 'error', message: safeUpdateErrorMessage(error) });
  });
}

async function initializeStores() {
  const userData = app.getPath('userData');
  const [gameExecutable, addonsDirectory] = await Promise.all([
    findGameExecutable(),
    findAddonsDirectory()
  ]);
  settingsStore = new SettingsStore(userData, { gameExecutable, addonsDirectory });
  presetStore = new PresetStore(userData);
  workspaceStore = new WorkspaceStore(userData);
  modLogStore = new ModLogStore(userData);
  logger = new Logger(userData);
  updateDeadlineStore = new UpdateDeadlineStore(userData);
  await settingsStore.load();
  const storedSettings = settingsStore.get();
  const resolvedExecutable = await findGameExecutable(storedSettings.gameExecutable);
  if (resolvedExecutable && resolvedExecutable !== storedSettings.gameExecutable) {
    await settingsStore.update({ gameExecutable: resolvedExecutable });
  }
  await presetStore.initialize();
  await workspaceStore.load();
  await modLogStore.load();
}

function publicBuildIdentity() {
  const identity = buildIdentity || {};
  return {
    status: String(identity.status || 'unknown'),
    releaseTier: String(identity.releaseTier || 'unknown'),
    version: String(identity.version || app.getVersion()),
    buildId: String(identity.buildId || ''),
    builtAt: String(identity.builtAt || ''),
    license: String(identity.license || 'GPL-3.0-only'),
    authenticode: String(identity.authenticode || 'unknown'),
    signer: String(identity.signer || ''),
    officialReleasesUrl: String(identity.officialReleasesUrl || OFFICIAL_RELEASES_URL),
    versionReleaseUrl: String(identity.versionReleaseUrl || '')
  };
}

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function configureSessionSecurity() {
  const launcherSession = session.defaultSession;
  launcherSession.setPermissionCheckHandler(() => false);
  launcherSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (typeof launcherSession.setDevicePermissionHandler === 'function') {
    launcherSession.setDevicePermissionHandler(() => false);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 850,
    minWidth: 1040,
    minHeight: 680,
    frame: false,
    backgroundColor: '#17191b',
    show: false,
    title: 'Arma Reforger Launcher',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false
    }
  });

  installEditingShortcuts(mainWindow.webContents);
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== TRUSTED_RENDERER_URL) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function registerWindowHandlers() {
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());
}

async function scanInstalledMods() {
  const settings = settingsStore.get();
  installedMods = await scanMods(settings.addonsDirectory);
  logger.info(`Scanned ${installedMods.length} mods in ${settings.addonsDirectory || '<not configured>'}`);
  return installedMods;
}

function enqueueWorkspaceWrite(operation) {
  const result = workspaceWriteQueue.then(operation);
  workspaceWriteQueue = result.catch(() => {});
  return result;
}

function registerDataHandlers() {
  ipcMain.handle('launcher:bootstrap', async () => {
    const [presets, mods] = await Promise.all([presetStore.list(), scanInstalledMods()]);
    return {
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      buildIdentity: publicBuildIdentity(),
      updateMode: updateTrustPolicy.enabled ? 'automatic' : app.isPackaged ? 'manual' : 'development',
      settings: settingsStore.get(),
      presets,
      installedMods: mods,
      workspace: workspaceStore.get(),
      modLogCount: modLogStore.count()
    };
  });

  ipcMain.handle('mod-logs:list', () => modLogStore.list());
  ipcMain.handle('mod-logs:add', (_event, entry) => modLogStore.append(entry));
  ipcMain.handle('mod-logs:add-many', (_event, entries) => modLogStore.appendMany(entries));
  ipcMain.handle('mod-logs:clear', () => modLogStore.clear());

  ipcMain.handle('mods:scan', scanInstalledMods);
  ipcMain.handle('mods:details', async (_event, modId) => {
    try {
      return await fetchWorkshopDetails(modId);
    } catch (error) {
      logger.error(`Workshop details error for ${String(modId || '')}: ${error.message}`);
      throw new Error(mainT('workshopDetailsFailed', { message: error.message }));
    }
  });
  ipcMain.handle('mods:translate-description', async (_event, modId) => {
    try {
      const details = await fetchWorkshopDetails(modId);
      return await translateToRussian(details.description);
    } catch (error) {
      logger.error(`Workshop description translation error for ${String(modId || '')}: ${error.message}`);
      throw new Error(mainT('translationFailed', { message: error.message }));
    }
  });
  ipcMain.handle('workshop:search', async (_event, payload) => {
    try {
      return await fetchWorkshopSearch(payload);
    } catch (error) {
      logger.error(`Workshop search error: ${error.message}`);
      throw new Error(mainT('workshopSearchFailed', { message: error.message }));
    }
  });
  ipcMain.handle('clipboard:copy-scenario', (_event, value) => {
    let scenarioId;
    try {
      scenarioId = normalizeScenarioId(value);
    } catch {
      throw new Error(mainT('invalidScenarioId'));
    }
    clipboard.writeText(scenarioId);
    return true;
  });
  ipcMain.handle('clipboard:copy-mod', (_event, mod) => {
    const text = toServerModText(mod);
    clipboard.writeText(text);
    return { modId: JSON.parse(text).modId };
  });
  ipcMain.handle('mods:delete', async (_event, modId) => {
    const settings = settingsStore.get();
    const removed = await removeInstalledMod({
      addonsDirectory: settings.addonsDirectory,
      installedMods,
      modId
    });
    const presetUpdate = await presetStore.removeModFromAll(removed.modId);
    const workspace = await enqueueWorkspaceWrite(() => workspaceStore.removeMod(
      removed.modId,
      presetUpdate.removedPresetIds
    ));

    let workshopStatesUpdated = 0;
    try {
      const workshopResult = await disableWorkshopMod({
        modId: removed.modId,
        profileDirectories: [
          settings.profileDirectory,
          settings.downloadRoot,
          settings.addonsDirectory ? path.dirname(settings.addonsDirectory) : ''
        ]
      });
      workshopStatesUpdated = workshopResult.updated;
    } catch (error) {
      logger.error(`Could not disable Workshop state for ${removed.modId}: ${error.message}`);
    }

    const mods = await scanInstalledMods();
    logger.info(`Deleted mod ${removed.modId} from ${removed.directoryPath}`);
    return {
      removed,
      installedMods: mods,
      presets: presetUpdate.presets,
      workspace,
      updatedPresets: presetUpdate.updatedPresets,
      removedPresets: presetUpdate.removedPresetIds.length,
      workshopStatesUpdated
    };
  });
  ipcMain.handle('workspace:save', (_event, value) => (
    enqueueWorkspaceWrite(() => workspaceStore.save(value))
  ));
  ipcMain.handle('presets:list', () => presetStore.list());
  ipcMain.handle('presets:save', (_event, preset) => presetStore.save(preset));
  ipcMain.handle('presets:add-mod', async (_event, payload) => {
    try {
      return await presetStore.addMod(payload);
    } catch (error) {
      if (error.message === 'Выбранный пресет не найден.') throw new Error(mainT('presetNotFound'));
      if (error.message === 'Выберите пресет.') throw new Error(mainT('choosePreset'));
      if (error.message === 'Некорректный GUID мода.') throw new Error(mainT('invalidModGuid'));
      throw error;
    }
  });
  ipcMain.handle('presets:remove-mod', async (_event, payload) => {
    try {
      const result = await presetStore.removeMod(payload);
      let workspace = workspaceStore.get();
      if (workspace.activePresetId === String(payload?.presetId || '')) {
        const nextPreset = result.preset || result.presets[0] || null;
        workspace = await enqueueWorkspaceWrite(() => workspaceStore.save({
          activePresetId: nextPreset?.id || '',
          name: nextPreset?.name || '',
          dirty: false,
          mods: nextPreset?.mods || []
        }));
      }
      return { ...result, workspace };
    } catch (error) {
      if (error.message === 'Выбранный пресет не найден.') throw new Error(mainT('presetNotFound'));
      if (error.message === 'Мод не найден в выбранном пресете.') throw new Error(mainT('modNotInPreset'));
      if (error.message === 'Некорректный GUID мода.') throw new Error(mainT('invalidModGuid'));
      throw error;
    }
  });
  ipcMain.handle('presets:delete', async (_event, id) => {
    await presetStore.remove(id);
    const presets = await presetStore.list();
    let workspace = workspaceStore.get();
    if (workspace.activePresetId === String(id)) {
      const nextPreset = presets[0] || null;
      workspace = await enqueueWorkspaceWrite(() => workspaceStore.save({
        activePresetId: nextPreset?.id || '',
        name: nextPreset?.name || '',
        dirty: false,
        mods: nextPreset?.mods || []
      }));
    }
    return { presets, workspace };
  });

  ipcMain.handle('presets:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mainT('importPresetTitle'),
      properties: ['openFile'],
      filters: [{ name: 'Arma Reforger JSON', extensions: ['json'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return presetStore.importFromFile(result.filePaths[0]);
  });

  ipcMain.handle('presets:import-text', async (_event, payload) => {
    const text = String(payload?.text || '');
    if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) {
      throw new Error(mainT('jsonTooLarge'));
    }
    return presetStore.importFromText(text, { name: payload?.name });
  });

  ipcMain.handle('presets:copy', (_event, preset) => {
    clipboard.writeText(presetStore.toShareText(preset));
    return true;
  });

  ipcMain.handle('presets:choose-transfer-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mainT('choosePresetTransferFolder'),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? '' : result.filePaths[0];
  });

  ipcMain.handle('presets:transfer-mods', async (_event, payload = {}) => {
    const settings = settingsStore.get();
    if (settings.advancedMode !== true) throw new Error(mainT('advancedModeRequired'));
    if (await isArmaReforgerRunning()) throw new Error(mainT('presetTransferGameRunning'));
    const presetId = String(payload.presetId || '');
    const preset = (await presetStore.list()).find((item) => item.id === presetId);
    if (!preset) throw new Error(mainT('presetNotFound'));
    try {
      installedMods = await scanMods(settings.addonsDirectory);
      const result = await transferPresetMods({
        addonsDirectory: settings.addonsDirectory,
        destinationDirectory: String(payload.destinationDirectory || ''),
        preset,
        installedMods,
        mode: payload.mode === 'move' ? 'move' : 'copy',
        includeDependencies: settings.autoAddDependencies !== false
      });
      installedMods = await scanMods(settings.addonsDirectory);
      logger.info(
        `${result.mode === 'move' ? 'Moved' : 'Copied'} ${result.transferredCount} preset mods ` +
        `from ${settings.addonsDirectory} to ${result.destinationDirectory}`
      );
      return { ...result, installedMods };
    } catch (error) {
      logger.error(`Preset mod transfer error for ${presetId}: ${error.message}`);
      throw new Error(mainT('presetTransferFailed', { message: error.message }));
    }
  });

  ipcMain.handle('clipboard:read-preset', () => clipboard.readText());

  ipcMain.handle('presets:export', async (_event, preset) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: mainT('exportPresetTitle'),
      defaultPath: `${String(preset.name || 'preset').replace(/[<>:"/\\|?*]+/g, '_')}.json`,
      filters: [{ name: 'Arma Reforger JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return false;
    await presetStore.exportToFile(preset, result.filePath);
    return true;
  });

  ipcMain.handle('presets:share-file', async (_event, preset) => {
    const safeName = String(preset?.name || 'Arma Reforger preset').replace(/[<>:"/\\|?*]+/g, '_').trim();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: mainT('friendFileTitle'),
      defaultPath: path.join(app.getPath('downloads'), `${safeName || 'Arma Reforger preset'}.json`),
      filters: [{ name: 'Arma Reforger preset', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return null;
    await presetStore.exportShareFile(preset, result.filePath);
    shell.showItemInFolder(result.filePath);
    return { filePath: result.filePath };
  });
}

function serverModAssessment(mods) {
  return assessPreset({ mods }, installedMods);
}

async function resolveGameExecutable() {
  let settings = settingsStore.get();
  const gameExecutable = await findGameExecutable(settings.gameExecutable);
  if (!gameExecutable) throw new Error(mainT('gameNotFound'));
  if (gameExecutable !== settings.gameExecutable) {
    settings = await settingsStore.update({ gameExecutable });
  }
  return { settings, gameExecutable };
}

function registerServerHandlers() {
  ipcMain.handle('servers:list', async (_event, payload) => {
    try {
      return await fetchServerList(payload);
    } catch (error) {
      logger.error(`Server catalog error: ${error.message}`);
      throw error;
    }
  });

  ipcMain.handle('servers:details', async (_event, serverId, options = {}) => {
    try {
      const details = await fetchServerDetails(serverId, { refresh: options.refresh === true });
      installedMods = await scanMods(settingsStore.get().addonsDirectory);
      const assessment = serverModAssessment(details.mods);
      return {
        ...details,
        mods: assessment.map(({ installed, ...mod }) => ({
          ...mod,
          installedVersion: installed?.version || ''
        }))
      };
    } catch (error) {
      logger.error(`Server details error for ${String(serverId || '')}: ${error.message}`);
      throw error;
    }
  });

  ipcMain.handle('servers:copy-mods', (_event, mods) => {
    const text = toServerModsText(mods);
    clipboard.writeText(text);
    return { count: JSON.parse(text).game.mods.length };
  });

  ipcMain.handle('servers:download', async (_event, serverId) => {
    const details = await fetchServerDetails(serverId, { refresh: true });
    const { settings, gameExecutable } = await resolveGameExecutable();
    installedMods = await scanMods(settings.addonsDirectory);
    const pendingMods = serverModAssessment(details.mods)
      .filter((mod) => mod.status !== 'ready')
      .map(({ installed: _installed, status: _status, ...mod }) => mod);
    if (pendingMods.length === 0) {
      return { alreadyReady: true, queuedCount: 0, server: details.server };
    }

    const result = await queueWorkshopDownload(
      settings,
      gameExecutable,
      pendingMods,
      `Opening Workshop bridge for server ${details.server.name} (${pendingMods.length} mods)`,
      { exactCollection: true }
    );
    return { ...result, server: details.server, pendingCount: pendingMods.length };
  });

  ipcMain.handle('servers:download-mod', async (_event, serverId, requestedModId) => {
    const modId = String(requestedModId || '').trim().toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(modId)) throw new Error(mainT('invalidModGuid'));

    const details = await fetchServerDetails(serverId, { refresh: true });
    const selectedMod = details.mods.find((mod) => mod.modId === modId);
    if (!selectedMod) throw new Error(mainT('serverModNotFound'));

    const { settings, gameExecutable } = await resolveGameExecutable();
    installedMods = await scanMods(settings.addonsDirectory);
    const assessment = serverModAssessment([selectedMod])[0];
    if (assessment?.status === 'ready') {
      return { alreadyReady: true, queuedCount: 0, mod: selectedMod, server: details.server };
    }

    const root = {
      modId: selectedMod.modId,
      name: selectedMod.name,
      version: selectedMod.version || ''
    };
    const result = await queueWorkshopDownload(
      settings,
      gameExecutable,
      [root],
      `Opening Workshop bridge for server mod ${root.name} (${root.modId})`
    );
    return { ...result, mod: root, server: details.server, pendingCount: 1 };
  });

  const launchNativeServer = createNativeServerLauncher({
    prepareBridge: prepareWorkshopBridge,
    prepareProfile: prepareGameProfile,
    launchThroughSteam,
    log: (message) => logger.error(`Native join cleanup: ${message}`)
  });
  const serverConnections = createServerConnectionController({
    fetchDetails: fetchServerDetails,
    assessMods: serverModAssessment,
    resolveGame: resolveGameExecutable,
    ensureGameClosed: async () => {
      if (await isArmaReforgerRunning()) throw new Error(mainT('gameAlreadyRunning'));
    },
    launch: async (game, connection, isCancelled) => {
      if (!game.settings.profileDirectory || !game.settings.downloadRoot) throw new Error(mainT('workshopPathsMissing'));
      logger.info(`Opening native server browser for ${connection.server.name} at ${connection.server.address}`);
      try {
        return await launchNativeServer(game, connection, isCancelled);
      } catch (error) {
        logger.error(`Server connection launch error: ${error.message}`);
        if (error.code === 'GAME_PROFILE_SETTINGS_FAILED') throw error;
        throw new Error(mainT('steamLaunchFailed', { message: error.message }));
      }
    },
    cancelLaunch: (launch) => launch.joinRequest ? cancelServerJoinRequest(launch.joinRequest) : undefined,
    monitor: (server, startedAt, launch) => {
      stopServerLaunchMonitor?.();
      const request = launch.joinRequest;
      if (!request) return;
      const report = (reason) => {
          logger.info(`Native server join not ready (${reason}) at ${server.address}; status: ${request.statusPath}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('servers:connection-failure', {
              server, reason, logPath: request.statusPath
            });
            mainWindow.flashFrame(true);
          }
      };
      stopServerLaunchMonitor = createServerJoinMonitor({
        statusPath: request.statusPath,
        token: request.token,
        startedAt: request.startedAt || startedAt,
        onStatus: (status) => logger.info(`Native server join ${status.state}: ${status.message}`),
        onTerminal: (status) => {
          if (status.state === 'error') report('native-join-unavailable');
          // "joining" acknowledges handoff to Arma's own dialogs, not entry
          // into the server. Never report a successful connection here.
        },
        onTimeout: () => {
          void cancelServerJoinRequest({ ...request, preserveStatus: true })
            .catch((error) => logger.info(`Join request cleanup: ${error.message}`));
          report('native-join-timeout');
        },
        onError: (error) => logger.info(`Could not inspect native server join status: ${error.message}`)
      });
    },
    savePreset: (preset) => presetStore.saveServerPreset(preset),
    log: (message) => logger.info(message)
  });
  ipcMain.handle('servers:connect', (_event, payload) => serverConnections.connect(payload));
  ipcMain.handle('servers:cancel-connect', () => serverConnections.cancel());
}

function registerSettingsHandlers() {
  ipcMain.handle('settings:choose-game', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mainT('chooseGame'),
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: mainT('application'), extensions: ['exe'] }]
        : [{ name: mainT('allFiles'), extensions: ['*'] }]
    });
    return result.canceled ? '' : result.filePaths[0];
  });

  ipcMain.handle('settings:choose-directory', async (_event, kind) => {
    const titles = {
      addons: mainT('chooseAddons'),
      downloads: mainT('chooseDownloads'),
      profile: mainT('chooseProfile')
    };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: titles[kind] || mainT('chooseFolder'),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? '' : result.filePaths[0];
  });

  ipcMain.handle('settings:save', async (_event, patch) => {
    const settings = await settingsStore.update(patch);
    applyUpdaterPreferences(settings);
    syncUpdatePushSubscription(settings);
    return settings;
  });

  ipcMain.handle('settings:reset', async () => {
    const settings = await settingsStore.reset();
    applyUpdaterPreferences(settings);
    syncUpdatePushSubscription(settings);
    return settings;
  });
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      ...options
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid || 0);
    });
  });
}

async function launchThroughSteam(gameExecutable, gameArguments, isCancelled = () => false) {
  const steamExecutable = await findSteamExecutable(gameExecutable);
  if (isCancelled()) return { cancelled: true };
  if (steamExecutable) {
    await spawnDetached(steamExecutable, buildSteamClientArguments(gameArguments), {
      cwd: path.dirname(steamExecutable)
    });
    return { method: 'steam-client', target: steamExecutable };
  }

  const steamUrl = buildSteamLaunchUrl(gameArguments);
  await shell.openExternal(steamUrl);
  return { method: 'steam-protocol', target: 'steam://run/1874880' };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function launchWithExactArguments(gameExecutable, gameArguments, purpose = 'game', isCancelled = () => false) {
  // Proton is selected and initialized by Steam. A Windows executable cannot
  // be spawned as a native Linux process, even when Steam is already running.
  if (process.platform === 'linux') return launchThroughSteam(gameExecutable, gameArguments, isCancelled);
  const steamExecutable = await findSteamExecutable(gameExecutable);
  if (isCancelled()) return { cancelled: true };
  if (steamExecutable) {
    try {
      const steamWasRunning = await isSteamRunning();
      if (isCancelled()) return { cancelled: true };
      if (!steamWasRunning) {
        await spawnDetached(steamExecutable, ['-silent'], { cwd: path.dirname(steamExecutable) });
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !isCancelled() && !await isSteamRunning()) await wait(500);
        if (isCancelled()) return { cancelled: true };
        if (!await isSteamRunning()) {
          logger.error(`Steam did not become ready for direct ${purpose} launch; using the Steam client`);
          return launchThroughSteam(gameExecutable, gameArguments, isCancelled);
        }
        // Give a newly started Steam client a moment to finish initializing its API.
        await wait(2500);
      }
      // Starting the executable directly keeps every argument intact. Steam only
      // needs to be running in the background for authentication and Workshop.
    } catch (error) {
      logger.error(`Could not prepare Steam before direct ${purpose} launch: ${error.message}`);
    }
  }

  try {
    if (isCancelled()) return { cancelled: true };
    await spawnDetached(gameExecutable, gameArguments, { cwd: path.dirname(gameExecutable) });
    return { method: 'direct-steam-session', target: gameExecutable };
  } catch (error) {
    logger.error(`Direct ${purpose} launch failed, falling back to Steam: ${error.message}`);
    return launchThroughSteam(gameExecutable, gameArguments, isCancelled);
  }
}

function getWorkshopBridgeDirectory() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'launcher-addons');
  return path.join(app.getAppPath(), 'support');
}

async function validateWorkshopBridge() {
  const bridgeDirectory = getWorkshopBridgeDirectory();
  const sourceDirectory = path.join(bridgeDirectory, 'ALGZLauncherWorkshopBridge');
  const projectPath = path.join(sourceDirectory, 'addon.gproj');
  try {
    await fs.access(projectPath);
  } catch {
    throw new Error(mainT('workshopBridgeMissing'));
  }
  return bridgeDirectory;
}

async function prepareGameProfile(settings) {
  if (!settings.profileDirectory) throw new Error(mainT('workshopPathsMissing'));
  const userHome = app.getPath('home');
  const protonProfiles = process.platform === 'linux'
    ? await findLinuxGameProfileDirectories(settings.gameExecutable, { homeDirectory: userHome }) : [];
  const sourceProfileDirectories = [
    ...protonProfiles,
    path.join(app.getPath('documents'), 'My Games', 'ArmaReforger'),
    path.join(userHome, 'Documents', 'My Games', 'ArmaReforger'),
    path.join(userHome, 'OneDrive', 'Documents', 'My Games', 'ArmaReforger'),
    ...(process.platform === 'win32' ? [] : [path.join(userHome, '.local', 'share', 'ArmaReforger')]),
    settings.downloadRoot,
    settings.addonsDirectory ? path.dirname(settings.addonsDirectory) : ''
  ].filter(Boolean);
  try {
    const result = await syncGameProfileSettings({
      profileDirectory: settings.profileDirectory,
      sourceProfileDirectories
    });
    if (!result.skipped) {
      logger.info(`Arma user settings prepared: ${result.copied} copied, ${result.preserved} preserved, ${result.conflicts.length} conflicts. Source: ${result.sourceDirectory}`);
      if (result.conflicts.length) logger.info('Conflicting Arma settings were preserved in the launcher profile. Original settings and backups remain available.');
    }
    return result;
  } catch (error) {
    logger.error(`Arma user settings preparation failed: ${error.message}`);
    const failure = new Error(mainT('gameSettingsImportFailed'));
    failure.code = 'GAME_PROFILE_SETTINGS_FAILED';
    throw failure;
  }
}

async function prepareWorkshopBridge(profileDirectory) {
  const bundledDirectory = await validateWorkshopBridge();
  try {
    return await installWorkshopBridge({
      sourceDirectory: path.join(bundledDirectory, 'ALGZLauncherWorkshopBridge'),
      profileDirectory
    });
  } catch (error) {
    logger.error(`Workshop bridge profile installation failed: ${error.message}`);
    throw new Error(mainT('workshopBridgeInstallFailed', { message: error.message }));
  }
}

async function queueWorkshopDownload(settings, gameExecutable, rootMods, logLabel, options = {}) {
  if (!settings.profileDirectory || !settings.downloadRoot) throw new Error(mainT('workshopPathsMissing'));
  return workshopDownloads.start(settings.profileDirectory, async (savedItems) => {
    await prepareGameProfile(settings);
    await fs.mkdir(settings.profileDirectory, { recursive: true });
    await fs.mkdir(settings.downloadRoot, { recursive: true });
    await fs.mkdir(path.join(settings.downloadRoot, 'temp'), { recursive: true });
    await fs.mkdir(path.join(settings.profileDirectory, 'logs', 'workshop-bridge'), { recursive: true });
    const bridge = await prepareWorkshopBridge(settings.profileDirectory);
    const queue = savedItems || options.exactCollection === true
      ? { items: savedItems || rootMods, failedDetails: [] }
      : await resolveWorkshopQueue(rootMods);
    const args = buildAddonDownloadArguments({
      settings, bridgeDirectory: bridge.addonsDirectory, bridgeModId: WORKSHOP_BRIDGE_MOD_ID
    });
    return { ...queue, bridge, args };
  }, async (prepared, items, isCancelled) => {
    logger.info(`${logLabel} (${items.length} including dependencies)`);
    logger.info(`Workshop bridge prepared and verified in ${prepared.bridge.targetDirectory}`);
    if (prepared.failedDetails.length > 0) {
      logger.info(`Workshop dependency metadata unavailable for ${prepared.failedDetails.length} mods; roots remain queued`);
    }
    let steamLaunch;
    try {
      steamLaunch = await launchWithExactArguments(gameExecutable, prepared.args, 'Workshop bridge', isCancelled);
    } catch (error) {
      logger.error(`Steam addon download launch error: ${error.message}`);
      throw new Error(mainT('steamLaunchFailed', { message: error.message }));
    }
    if (steamLaunch.cancelled) return steamLaunch;
    return {
      launched: true,
      launchMethod: steamLaunch.method,
      arguments: prepared.args,
      dependencyCount: Math.max(0, items.length - rootMods.length),
      metadataWarnings: prepared.failedDetails.length
    };
  }, { resume: options.resume === true, requireEmptyQueue: options.requireEmptyQueue === true });
}

function registerGameHandlers() {
  ipcMain.handle('mods:update', (_event, payload) => installedModUpdater.update(payload));
  ipcMain.handle('game:launch', async (_event, payload) => {
    let settings = settingsStore.get();
    const gameExecutable = await findGameExecutable(settings.gameExecutable);
    if (!gameExecutable) {
      throw new Error(mainT('gameNotFound'));
    }
    if (gameExecutable !== settings.gameExecutable) {
      settings = await settingsStore.update({ gameExecutable });
    }

    const preset = { mods: payload.mods || [] };
    const resolution = resolvePresetDependencies(preset, installedMods, {
      includeDependencies: settings.autoAddDependencies !== false
    });
    const assessment = assessPreset({ mods: resolution.mods }, installedMods);
    const blockers = assessment.filter((mod) => mod.status === 'missing' || mod.status === 'corrupted');
    const versionBlockers = assessment.filter((mod) => mod.status === 'version-mismatch');
    if (blockers.length > 0) {
      throw new Error(mainT('modsNotReady', { names: blockers.slice(0, 3).map((mod) => mod.name).join(', ') }));
    }
    if (versionBlockers.length > 0 && !settings.allowVersionMismatch) {
      throw new Error(mainT('versionsMismatch', { names: versionBlockers.slice(0, 3).map((mod) => mod.name).join(', ') }));
    }
    if (await isArmaReforgerRunning()) throw new Error(mainT('gameAlreadyRunning'));

    await prepareGameProfile(settings);
    await fs.mkdir(settings.profileDirectory, { recursive: true });
    if (settings.downloadRoot) await fs.mkdir(settings.downloadRoot, { recursive: true });
    const workshopState = await syncWorkshopSelection({
      profileDirectory: settings.profileDirectory,
      fallbackProfileDirectories: [
        ...(process.platform === 'linux'
          ? await findLinuxGameProfileDirectories(gameExecutable, { homeDirectory: app.getPath('home') }) : []),
        settings.downloadRoot,
        settings.addonsDirectory ? path.dirname(settings.addonsDirectory) : ''
      ],
      installedMods,
      enabledMods: resolution.mods
    });
    if (workshopState.skipped) logger.info(`Workshop profile sync skipped: ${workshopState.reason}`);
    else logger.info(
      `Workshop profile synced: ${workshopState.enabled} enabled, ` +
      `${workshopState.disabled} disabled, ${workshopState.updated} files updated`
    );
    const args = buildLaunchArguments({ mods: resolution.mods, settings });
    logger.info(
      `Launching Steam App 1874880 with ${resolution.selectedCount} selected mods ` +
      `and ${resolution.dependencyCount} resolved dependencies`
    );
    let steamLaunch;
    try {
      steamLaunch = await launchThroughSteam(gameExecutable, args);
    } catch (error) {
      logger.error(`Steam launch error: ${error.message}`);
      throw new Error(mainT('steamLaunchFailed', { message: error.message }));
    }
    return {
      launched: true,
      launchMethod: steamLaunch.method,
      arguments: args,
      selectedCount: resolution.selectedCount,
      dependencyCount: resolution.dependencyCount,
      totalCount: resolution.mods.length,
      workshopProfileSynced: !workshopState.skipped
    };
  });

  ipcMain.handle('game:download-missing', async (_event, payload) => {
    let settings = settingsStore.get();
    const gameExecutable = await findGameExecutable(settings.gameExecutable);
    if (!gameExecutable) throw new Error(mainT('gameNotFound'));
    if (gameExecutable !== settings.gameExecutable) {
      settings = await settingsStore.update({ gameExecutable });
    }

    installedMods = await scanMods(settings.addonsDirectory);
    const preset = { mods: payload?.mods || [] };
    const resolution = resolvePresetDependencies(preset, installedMods);
    const missingMods = getMissingPresetMods({ mods: resolution.mods }, installedMods);
    if (missingMods.length === 0) throw new Error(mainT('noMissingMods'));
    const result = await queueWorkshopDownload(
      settings,
      gameExecutable,
      missingMods,
      `Opening Arma Reforger Workshop bridge for ${missingMods.length} missing mods`
    );

    return {
      ...result,
      missingCount: missingMods.length,
      missingModIds: missingMods.map((mod) => mod.modId)
    };
  });

  ipcMain.handle('workshop:install', async (_event, mod) => {
    const modId = String(mod?.modId || '').trim().toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(modId)) throw new Error(mainT('invalidModGuid'));

    let settings = settingsStore.get();
    const gameExecutable = await findGameExecutable(settings.gameExecutable);
    if (!gameExecutable) throw new Error(mainT('gameNotFound'));
    if (gameExecutable !== settings.gameExecutable) {
      settings = await settingsStore.update({ gameExecutable });
    }
    installedMods = await scanMods(settings.addonsDirectory);
    const root = {
      modId,
      name: String(mod?.name || modId),
      version: String(mod?.version || '')
    };
    if (assessPreset({ mods: [root] }, installedMods)[0]?.status === 'ready') {
      return { alreadyInstalled: true, queuedCount: 0, dependencyCount: 0, modId };
    }
    const result = await queueWorkshopDownload(
      settings,
      gameExecutable,
      [root],
      `Opening Arma Reforger Workshop bridge for ${root.name} (${modId})`
    );
    return { ...result, modId };
  });

  ipcMain.handle('game:resume-download', async () => {
    const settings = settingsStore.get();
    const gameExecutable = await findGameExecutable(settings.gameExecutable);
    if (!gameExecutable) throw new Error(mainT('gameNotFound'));
    return queueWorkshopDownload(settings, gameExecutable, [], 'Resuming saved Workshop queue', { resume: true });
  });
  ipcMain.handle('game:download-status', () => workshopDownloads.status(settingsStore.get().profileDirectory));
}

function registerSystemHandlers() {
  ipcMain.handle('launcher:license', async () => {
    const contents = await fs.readFile(path.join(app.getAppPath(), 'LICENSE'), 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > 128 * 1024) throw new Error('License document is invalid.');
    return contents;
  });

  ipcMain.handle('system:open-official-releases', async () => {
    await shell.openExternal(OFFICIAL_RELEASES_URL);
    return true;
  });

  ipcMain.handle('system:open-workshop', async (_event, modId) => {
    const normalizedId = String(modId || '').toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(normalizedId)) throw new Error(mainT('invalidModGuid'));
    await shell.openExternal(`https://reforger.armaplatform.com/workshop/${normalizedId}`);
    return true;
  });

  ipcMain.handle('system:open-user-data', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('system:repair', async () => {
    await session.defaultSession.clearCache();
    await presetStore.initialize();
    const settings = settingsStore.get();
    if (settings.profileDirectory) await fs.mkdir(settings.profileDirectory, { recursive: true });
    return {
      cacheCleared: true,
      presets: (await presetStore.list()).length,
      mods: (await scanInstalledMods()).length
    };
  });

  ipcMain.handle('system:factory-reset', async () => {
    if (factoryResetScheduled) return { restarting: true };
    if (await isArmaReforgerRunning()) throw new Error(mainT('factoryResetGameRunning'));
    factoryResetScheduled = true;
    let resetTicket;
    try {
      updatePushSubscriber?.stop();
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData();

      resetTicket = await createFactoryResetTicket(app, process.pid);
      const relaunchExecutable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      const relaunchArguments = app.isPackaged ? [] : process.argv.slice(1);
      app.relaunch({
        execPath: relaunchExecutable,
        args: buildFactoryResetRelaunchArguments(relaunchArguments, resetTicket.nonce)
      });

      setTimeout(() => app.exit(0), 250);
      return { restarting: true };
    } catch (error) {
      if (resetTicket?.nonce) await discardFactoryResetTicket(app, resetTicket.nonce).catch(() => {});
      factoryResetScheduled = false;
      throw error;
    }
  });
}

function registerUpdateHandlers() {
  ipcMain.handle('updates:check', async () => {
    if (!app.isPackaged) return { state: 'development' };
    if (!updateTrustPolicy.enabled) return { state: 'manual' };
    if (['checking', 'downloading', 'verifying', 'downloaded'].includes(updaterState)) {
      return { state: updaterState, version: String(availableUpdateInfo?.version || '') };
    }
    const settings = settingsStore.get();
    applyUpdaterPreferences(settings);
    try {
      const result = await requestUpdateCheck();
      return { state: updaterState, version: result?.updateInfo?.version || '' };
    } catch (error) {
      const message = safeUpdateErrorMessage(error);
      logger?.error(`Manual update check failed: ${error.message}`);
      publishUpdateStatus({ state: 'error', message });
      return { state: 'error', message };
    }
  });
  ipcMain.handle('updates:download', async () => {
    if (!updateTrustPolicy.enabled) throw new Error(mainT('updateVerificationFailed'));
    if (updaterState !== 'available') {
      throw new Error(mainT('checkUpdateFirst'));
    }
    await autoUpdater.downloadUpdate();
    return true;
  });
  ipcMain.handle('updates:install', () => {
    if (!updateTrustPolicy.enabled) throw new Error(mainT('updateVerificationFailed'));
    return beginVerifiedUpdateInstall('user');
  });
}

app.whenReady().then(async () => {
  if (packagedRuntimeSwitchBlocked) {
    dialog.showErrorBox(mainT('unsupportedRuntimeTitle'), mainT('unsupportedRuntimeMessage'));
    app.exit(78);
    return;
  }

  buildIdentity = await readBuildIdentity({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    executablePath: process.execPath
  });

  updateTrustPolicy = createUpdateTrustPolicy({
    appPath: app.getAppPath(),
    packaged: app.isPackaged,
    platform: process.platform,
    buildIdentity,
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE
  });
  if (updateTrustPolicy.enabled) autoUpdater.updateConfigPath = updateTrustPolicy.updateConfigPath;

  if (factoryResetStartup.active) {
    try {
      await completeFactoryReset(factoryResetStartup);
      app.relaunch({
        execPath: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
        args: factoryResetStartup.cleanRelaunchArguments
      });
      app.exit(0);
    } catch (error) {
      console.error(`Factory reset failed: ${error.message}`);
      app.exit(1);
    }
    return;
  }

  configureSessionSecurity();
  await initializeStores();
  configureUpdaterEvents();
  syncUpdatePushSubscription();
  registerWindowHandlers();
  registerDataHandlers();
  registerServerHandlers();
  registerSettingsHandlers();
  registerGameHandlers();
  registerSystemHandlers();
  registerUpdateHandlers();
  createWindow();
}).catch((error) => {
  console.error(`Launcher startup failed: ${error?.stack || error}`);
  dialog.showErrorBox('Arma Reforger Launcher', 'The launcher could not start safely. Reinstall it from the official ALGZ release page.');
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  workshopDownloads.cancelPendingStart();
  // Invalidate in-flight verification/activation without deleting its durable
  // deadline. Restart must reverify the artifact before restoring installation.
  updateVerificationGeneration += 1;
  stopServerLaunchMonitor?.();
  if (mandatoryInstallTimer) clearTimeout(mandatoryInstallTimer);
  mandatoryInstallTimer = null;
  updatePushSubscriber?.stop();
});

app.on('activate', () => {
  if (!factoryResetStartup.active && BrowserWindow.getAllWindows().length === 0) createWindow();
});
