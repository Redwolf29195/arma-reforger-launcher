const api = window.reforgerLauncher;
const {
  t,
  setLanguage,
  getLanguage,
  locale,
  applyStaticTranslations,
  localizeError
} = window.launcherI18n;

const state = {
  appVersion: '0.1.0',
  platform: '',
  packaged: false,
  updateMode: 'development',
  buildIdentity: null,
  settings: {},
  presets: [],
  installedMods: [],
  activePreset: null,
  requirements: new Map(),
  selectedIds: new Set(),
  dirty: false,
  currentView: 'dashboard',
  modFilter: 'all',
  modSearch: '',
  modUpdatesChecking: false,
  workshopQuery: '',
  workshopCategory: '',
  workshopSort: 'subscribers',
  workshopPage: 1,
  workshopCount: 0,
  workshopPageSize: 16,
  workshopItems: [],
  workshopLoaded: false,
  workshopLoading: false,
  workshopError: '',
  serverQuery: '',
  serverSort: 'players_desc',
  serverPage: 1,
  serverPageSize: 50,
  serverItems: [],
  serverHasNext: false,
  serverLoaded: false,
  serverLoading: false,
  serverRefreshing: false,
  serverError: '',
  serverLastAttemptAt: 0,
  serverRefreshFailures: 0,
  selectedServerId: '',
  serverDetails: null,
  serverDetailsLoading: false,
  serverDetailsError: '',
  serverDetailsLastLoadedAt: 0,
  serverProviderUrl: 'https://reforgermods.com/servers',
  lastScan: null,
  busy: false,
  updateStatus: { state: 'idle' },
  modDownloadStatus: { state: 'idle', completed: 0, total: 0, failed: 0, progress: 0 },
  modDetails: null,
  modLogs: [],
  modLogCount: 0,
  modLogsLoaded: false,
  modLogsLoading: false,
  modLogSearch: '',
  modLogFilter: 'all',
  language: getLanguage()
};

let workspaceSaveChain = Promise.resolve();
let presetSaveChain = Promise.resolve();
let modDetailsRequest = 0;
let workshopScenarioRequest = 0;
let serverListRequest = 0;
let serverDetailsRequest = 0;
let modDownloadTimer = 0;
let modDownloadPollGeneration = 0;
let modDownloadPollFailures = 0;
let automaticModScanPromise = null;
let foregroundRefreshTimer = 0;
let mandatoryUpdateCountdownTimer = 0;
let acknowledgedMandatoryUpdate = '';
let serverSearchTimer = 0;
let serverSearchComposing = false;
let serverAutoRefreshTimer = 0;
let serverJoinWaitTimer = 0;
let serverJoinWaitRequest = 0;
let serverJoinWaiting = false;
let serverJoinWaitError = false;
let serverJoinBlockReason = '';
let serverJoinConnectGeneration = 0;
let activeServerJoinRequest = 0;
let cancelledServerJoinRequest = 0;
let pendingWorkshopMod = null;
let pendingServerJoin = null;
let pendingServerConnectionFailure = null;
let pendingModDeletionConfirmation = null;
let fileDragDepth = 0;
let licenseLoadState = 'idle';
let loadedLicenseText = '';

const buildIdentityStatuses = new Set([
  'open-source',
  'development'
]);
const windowsSignatureStatuses = new Set([
  'verified',
  'unsigned',
  'untrusted',
  'invalid',
  'development',
  'not-applicable',
  'unavailable'
]);

const workshopCardGalleries = new Map();
const favoriteWorkshopItemsCache = new Map();
const maximumDroppedPresetBytes = 4 * 1024 * 1024;
const automaticModScanMinimumAge = 60_000;

let installedModIndexSource = null;
let installedModIndex = new Map();
let installedDependentIndex = new Map();
let renderedHeaderActionsKey = '';

const imageViewer = {
  images: [],
  index: 0,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  startOffsetX: 0,
  startOffsetY: 0
};

const imageViewerMinScale = 1;
const imageViewerMaxScale = 5;
const imageViewerScaleStep = 0.25;

const activeModDownloadStates = new Set(['queued', 'waiting', 'preparing', 'downloading', 'failed', 'unknown']);
const serverRefreshIntervals = {
  specificSearch: 20_000,
  shortSearch: 45_000,
  browse: 120_000,
  maximumBackoff: 300_000
};
const serverJoinWaitInterval = 5_000;

const viewMetadata = {
  dashboard: ['view.dashboard.eyebrow', 'view.dashboard.title'],
  mods: ['view.mods.eyebrow', 'view.mods.title'],
  workshop: ['view.workshop.eyebrow', 'view.workshop.title'],
  servers: ['view.servers.eyebrow', 'view.servers.title'],
  presets: ['view.presets.eyebrow', 'view.presets.title'],
  parameters: ['view.parameters.eyebrow', 'view.parameters.title'],
  settings: ['view.settings.eyebrow', 'view.settings.title']
};

const workshopCategoryKeys = {
  '': 'configurator.category.all',
  WEAPONS: 'configurator.category.weapons',
  VEHICLES: 'configurator.category.vehicles',
  CHARACTERS: 'configurator.category.characters',
  CLOTHING: 'configurator.category.clothing',
  TERRAINS: 'configurator.category.terrains',
  SCENARIOS_MP: 'configurator.category.scenariosMp',
  SCENARIOS_SP: 'configurator.category.scenariosSp',
  SYSTEMS: 'configurator.category.systems',
  EFFECTS: 'configurator.category.effects',
  PROPS: 'configurator.category.props'
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function statusLabel(status) {
  return t(`status.${status}`);
}

function errorMessage(error) {
  return localizeError(error?.message || error);
}

function confirmAction(message) {
  if ($('#mandatoryUpdateDialog')?.open) return Promise.resolve(false);
  return window.LauncherConfirmation.confirm({
    title: t('confirm.title'),
    message,
    confirmLabel: t('confirm.accept'),
    cancelLabel: t('confirm.cancel')
  });
}

function updateErrorMessage(error) {
  const firstLine = String(errorMessage(error) || '').split(/\r?\n/, 1)[0].trim();
  if (!firstLine || firstLine.length > 220 || /Error invoking remote method|HttpError|at [^(]+\(|Cannot find channel/i.test(firstLine)) {
    return t('update.unavailable');
  }
  return firstLine;
}

function requestWithTimeout(promise, milliseconds, message) {
  let timer = 0;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function serverRefreshBaseDelay() {
  const queryLength = state.serverQuery.trim().length;
  if (queryLength >= 4) return serverRefreshIntervals.specificSearch;
  if (queryLength >= 2) return serverRefreshIntervals.shortSearch;
  return serverRefreshIntervals.browse;
}

function serverRefreshDelay() {
  const multiplier = 2 ** Math.min(3, state.serverRefreshFailures);
  return Math.min(serverRefreshIntervals.maximumBackoff, serverRefreshBaseDelay() * multiplier);
}

function serverAutoRefreshEligible() {
  return state.currentView === 'servers'
    && !document.hidden
    && !serverSearchComposing
    && state.serverSort !== 'favorites'
    && state.serverQuery.trim().length !== 1;
}

function cancelServerAutoRefresh() {
  if (!serverAutoRefreshTimer) return;
  clearTimeout(serverAutoRefreshTimer);
  serverAutoRefreshTimer = 0;
}

function scheduleServerAutoRefresh() {
  cancelServerAutoRefresh();
  if (!serverAutoRefreshEligible() || !state.serverLoaded) return;
  const elapsed = Math.max(0, Date.now() - state.serverLastAttemptAt);
  const delay = Math.max(1_000, serverRefreshDelay() - elapsed);
  serverAutoRefreshTimer = setTimeout(() => {
    serverAutoRefreshTimer = 0;
    if (!serverAutoRefreshEligible()) return;
    if (state.serverLoading || state.serverRefreshing) {
      scheduleServerAutoRefresh();
      return;
    }
    loadServers({ refresh: true, silent: true, automatic: true });
  }, delay);
}

function refreshServersIfStale() {
  if (!serverAutoRefreshEligible() || !state.serverLoaded) {
    scheduleServerAutoRefresh();
    return;
  }
  const stale = Date.now() - state.serverLastAttemptAt >= serverRefreshDelay();
  if (stale && !state.serverLoading && !state.serverRefreshing) {
    loadServers({ refresh: true, silent: true, automatic: true });
    return;
  }
  scheduleServerAutoRefresh();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function parseComparableModVersion(value) {
  const source = String(value ?? '').trim().toLowerCase();
  const match = source.match(/^v?(\d+(?:\.\d+)*)(?:-([0-9a-z.-]+))?(?:\+[0-9a-z.-]+)?$/i);
  if (!match) return null;

  const parts = match[1].split('.').map((part) => BigInt(part));
  while (parts.length > 1 && parts.at(-1) === 0n) parts.pop();
  return { parts, prerelease: String(match[2] || '').toLowerCase() };
}

function compareModVersions(leftValue, rightValue) {
  const left = parseComparableModVersion(leftValue);
  const right = parseComparableModVersion(rightValue);
  if (!left || !right) return null;
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.parts[index] ?? 0n;
    const rightPart = right.parts[index] ?? 0n;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease, 'en', { numeric: true });
}

function modVersionsEqual(left, right) {
  const leftText = String(left ?? '').trim();
  const rightText = String(right ?? '').trim();
  return leftText.toLowerCase() === rightText.toLowerCase()
    || compareModVersions(leftText, rightText) === 0;
}

function selectCurrentModVersion(requiredValue, installedValue) {
  const required = String(requiredValue ?? '').trim();
  const installed = String(installedValue ?? '').trim();
  if (!installed) return required;
  if (!required || modVersionsEqual(required, installed)) return installed;
  const order = compareModVersions(installed, required);
  return order !== null && order > 0 ? installed : required;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toLocaleString(locale(), { maximumFractionDigits: unit < 2 ? 0 : 1 })} ${units[unit]}`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(locale());
}

function normalizeBuildIdentity(value) {
  const identity = value && !Array.isArray(value) && typeof value === 'object' ? value : {};
  const fallbackStatus = state.packaged ? 'open-source' : 'development';
  const status = buildIdentityStatuses.has(identity.status) ? identity.status : fallbackStatus;
  const authenticodeFallback = state.platform === 'win32'
    ? status === 'development' ? 'development' : 'unavailable'
    : 'not-applicable';
  const authenticode = windowsSignatureStatuses.has(identity.authenticode)
    ? identity.authenticode
    : authenticodeFallback;
  return {
    status,
    authenticode: state.platform === 'win32' ? authenticode : 'not-applicable',
    buildId: String(identity.buildId || '').slice(0, 96),
    builtAt: String(identity.builtAt || '').slice(0, 80),
    signer: String(identity.signer || '').slice(0, 300)
  };
}

function formatBuildTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('about.notAvailable');
  return date.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

function renderBuildIdentity() {
  const identity = normalizeBuildIdentity(state.buildIdentity);
  const statusKey = `about.status.${identity.status}`;
  const statusHelpKey = `${statusKey}Help`;
  const statusLabel = t(statusKey);

  const sidebarButton = $('#openAboutSidebar');
  sidebarButton.dataset.status = identity.status;
  sidebarButton.title = t('about.openSidebar');
  sidebarButton.setAttribute('aria-label', t('about.openSidebar'));
  const sidebarStatus = $('#sidebarBuildStatus');
  sidebarStatus.hidden = false;
  sidebarStatus.textContent = statusLabel;

  const settingRow = $('.about-setting-row');
  settingRow.dataset.status = identity.status;
  $('#aboutSettingsHeading').textContent = t('settings.aboutHeading');
  $('#aboutSettingsSubtitle').textContent = t('settings.aboutSubtitle');
  $('#aboutSettingsTitle').textContent = t('settings.aboutTitle');
  const settingsStatus = $('#aboutSettingsStatus');
  settingsStatus.hidden = false;
  settingsStatus.textContent = statusLabel;
  $('#aboutSettingsButton').textContent = t('settings.aboutButton');

  $('#aboutDialogKicker').textContent = t('about.kicker');
  $('#aboutDialogTitle').textContent = t('about.title');
  $('#aboutProductName').textContent = t('about.productName');
  const identityBanner = $('#aboutIdentityBanner');
  identityBanner.dataset.status = identity.status;
  identityBanner.title = '';
  const overallStatus = $('#aboutOverallStatus');
  overallStatus.hidden = false;
  overallStatus.textContent = statusLabel;
  $('#aboutStatusHelp').textContent = t(statusHelpKey);

  $('#aboutDeveloperLabel').textContent = t('about.developer');
  $('#aboutDeveloperValue').textContent = 'ALGZ / ExtaZzZ';
  $('#aboutDiscordValue').textContent = t('about.discordContact');
  $('#aboutVersionLabel').textContent = t('about.version');
  $('#aboutVersionValue').textContent = `v${state.appVersion}`;
  $('#aboutBuildIdLabel').textContent = t('about.buildId');
  $('#aboutBuildIdValue').textContent = identity.buildId || t('about.notAvailable');
  $('#aboutBuildIdValue').title = identity.buildId;
  $('#aboutBuiltAtLabel').textContent = t('about.builtAt');
  $('#aboutBuiltAtValue').textContent = identity.builtAt
    ? formatBuildTimestamp(identity.builtAt)
    : t('about.notAvailable');

  const integrityStatus = identity.status;
  const integrityCard = $('#aboutIntegrityCard');
  integrityCard.dataset.status = integrityStatus;
  $('#aboutIntegrityLabel').textContent = t('about.integrity');
  $('#aboutIntegrityStatus').textContent = t(`about.integrity.${integrityStatus}`);
  $('#aboutIntegrityHelp').textContent = t('about.integrityHelp');

  const windowsStatus = identity.authenticode;
  const windowsCard = $('#aboutWindowsCard');
  windowsCard.hidden = false;
  integrityCard.classList.remove('is-wide');
  windowsCard.dataset.status = windowsStatus;
  $('#aboutWindowsLabel').textContent = t('about.windowsSignature');
  $('#aboutWindowsStatus').textContent = t(`about.windows.${windowsStatus}`);
  $('#aboutWindowsSigner').textContent = t('about.signer', {
    signer: identity.signer || t('about.notAvailable')
  });

  $('#aboutOfficialSourceLabel').textContent = t('about.officialReleases');
  $('#aboutOfficialSourceHelp').textContent = t('about.officialSourceHelp');
  $('#aboutCopyright').textContent = t('about.copyright');
  $('#aboutTrademark').textContent = t('about.trademark');
  $('#aboutLicenseButton').textContent = t('about.viewLicense');
  $('#aboutCloseButton').textContent = t('about.close');
  $('#aboutReleasesButton').textContent = t('about.openReleases');
  renderLicenseDialog();
}

function renderLicenseDialog() {
  $('#licenseDialogKicker').textContent = t('about.licenseKicker');
  $('#licenseDialogTitle').textContent = t('about.licenseTitle');
  $('#licenseDialogNote').textContent = t('about.licenseNote');
  $('#licenseBackButton').textContent = t('about.licenseBack');
  $('#licenseCloseButton').textContent = t('about.close');
  const text = $('#licenseDialogText');
  text.classList.toggle('error', licenseLoadState === 'error');
  if (licenseLoadState === 'loaded') text.textContent = loadedLicenseText;
  else if (licenseLoadState === 'error') text.textContent = t('about.licenseUnavailable');
  else text.textContent = t('about.licenseLoading');
}

function openAboutDialog() {
  renderBuildIdentity();
  const dialog = $('#aboutDialog');
  if (!dialog.open) dialog.showModal();
}

async function openLicenseDialog() {
  const aboutDialog = $('#aboutDialog');
  if (aboutDialog.open) aboutDialog.close('license');
  const licenseDialog = $('#licenseDialog');
  if (!licenseDialog.open) licenseDialog.showModal();
  if (licenseLoadState === 'loaded' || licenseLoadState === 'loading') {
    renderLicenseDialog();
    return;
  }

  licenseLoadState = 'loading';
  renderLicenseDialog();
  try {
    if (typeof api.getLicenseText !== 'function') throw new Error('license-api-unavailable');
    const result = await api.getLicenseText();
    const licenseText = typeof result === 'string' ? result : result?.text;
    if (typeof licenseText !== 'string' || !licenseText.trim()) throw new Error('license-text-empty');
    loadedLicenseText = licenseText;
    licenseLoadState = 'loaded';
  } catch {
    loadedLicenseText = '';
    licenseLoadState = 'error';
  }
  renderLicenseDialog();
}

function returnToAboutDialog() {
  const licenseDialog = $('#licenseDialog');
  if (licenseDialog.open) licenseDialog.close('about');
  openAboutDialog();
}

async function openOfficialReleases() {
  try {
    if (typeof api.openOfficialReleases !== 'function') throw new Error('release-api-unavailable');
    await api.openOfficialReleases();
  } catch {
    showToast(t('about.releaseOpenError'), 'error');
  }
}

function formatCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) ? count.toLocaleString(locale()) : '—';
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('#toastRegion').append(toast);
  setTimeout(() => toast.remove(), 3800);
}

function setTitlebarStatus(message) {
  $('#titlebarStatus').textContent = message;
}

function setBusy(busy, message = t('busy.processing')) {
  state.busy = busy;
  setTitlebarStatus(busy ? message : t('common.ready'));
  const deleteSelectedButton = $('#deleteSelectedMods');
  if (deleteSelectedButton) {
    const selectedInstalledCount = [...state.selectedIds]
      .filter((modId) => installedById().get(modId)?.directoryPath).length;
    deleteSelectedButton.disabled = busy || selectedInstalledCount === 0;
  }
  renderLaunchState();
}

function installedById() {
  ensureInstalledModIndexes();
  return installedModIndex;
}

function ensureInstalledModIndexes() {
  if (installedModIndexSource === state.installedMods) return;
  installedModIndexSource = state.installedMods;
  installedModIndex = new Map();
  installedDependentIndex = new Map();
  for (const mod of state.installedMods) {
    const modId = String(mod.modId || '').toUpperCase();
    if (!modId) continue;
    installedModIndex.set(modId, mod);
    for (const dependency of mod.dependencies || []) {
      const dependencyId = String(dependency.modId || '').toUpperCase();
      if (!dependencyId) continue;
      const dependents = installedDependentIndex.get(dependencyId) || [];
      dependents.push(mod);
      installedDependentIndex.set(dependencyId, dependents);
    }
  }
}

function localDependentMods(modId, selectedOnly = false) {
  const normalizedId = String(modId || '').toUpperCase();
  ensureInstalledModIndexes();
  const dependents = installedDependentIndex.get(normalizedId) || [];
  return selectedOnly ? dependents.filter((mod) => state.selectedIds.has(mod.modId)) : dependents;
}

function modLogDescriptor(modOrId) {
  const supplied = typeof modOrId === 'object' && modOrId ? modOrId : {};
  const modId = String(supplied.modId || modOrId || '').toUpperCase();
  const local = installedById().get(modId);
  const requirement = state.requirements.get(modId);
  return {
    modId,
    name: supplied.name || requirement?.name || local?.name || modId,
    version: supplied.version || requirement?.version || local?.version || ''
  };
}

function currentModLogPreset(options = {}) {
  return {
    presetId: options.presetId || state.activePreset?.id || '',
    presetName: options.presetName || state.activePreset?.name || ''
  };
}

function recordModActions(actions) {
  const entries = (Array.isArray(actions) ? actions : []).flatMap((item) => {
    const mod = modLogDescriptor(item.mod);
    if (!/^[0-9A-F]{16}$/.test(mod.modId)) return [];
    return [{
      action: item.action,
      source: item.source || 'user',
      ...mod,
      ...currentModLogPreset(item),
      details: item.details || ''
    }];
  });
  if (entries.length === 0 || typeof api.recordModLogs !== 'function') return;

  api.recordModLogs(entries).then((savedEntries) => {
    const saved = Array.isArray(savedEntries) ? savedEntries : [];
    state.modLogCount = Math.min(1000, state.modLogCount + saved.length);
    if (state.modLogsLoaded) state.modLogs = [...saved, ...state.modLogs].slice(0, 1000);
    renderModLogSetting();
    if ($('#modLogsDialog').open) renderModLogs();
  }).catch(() => {});
}

function currentMods() {
  const installed = installedById();
  return [...state.selectedIds].map((modId) => {
    const requirement = state.requirements.get(modId);
    const local = installed.get(modId);
    return {
      modId,
      name: requirement?.name || local?.name || modId,
      version: selectCurrentModVersion(requirement?.version, local?.version),
      required: requirement?.required !== false
    };
  });
}

function assessMod(requirement) {
  const installed = installedById().get(requirement.modId);
  let status = 'ready';
  if (!installed) status = 'missing';
  else if (installed.corrupted) status = 'corrupted';
  else if (requirement.version && installed.version && !modVersionsEqual(requirement.version, installed.version)) status = 'version-mismatch';
  else if (requirement.version && !installed.version) status = 'version-unknown';
  return { requirement, installed, status };
}

function assessment() {
  return currentMods().map(assessMod);
}

function missingDownloadCount() {
  const installed = installedById();
  const visited = new Set();
  let missing = 0;

  function visit(requirement) {
    const modId = String(requirement?.modId || '').toUpperCase();
    if (!modId || visited.has(modId)) return;
    visited.add(modId);
    const local = installed.get(modId);
    if (!local) {
      missing += 1;
      return;
    }
    for (const dependency of local.dependencies || []) visit(dependency);
  }

  for (const mod of currentMods()) visit(mod);
  return missing;
}

function counts() {
  const rows = assessment();
  return {
    selected: rows.length,
    ready: rows.filter((row) => row.status === 'ready').length,
    missing: rows.filter((row) => row.status === 'missing' || row.status === 'corrupted').length,
    mismatch: rows.filter((row) => row.status === 'version-mismatch' || row.status === 'version-unknown').length
  };
}

function currentPresetName() {
  if (state.activePreset) return `${state.activePreset.name}${state.dirty ? ' *' : ''}`;
  if (state.selectedIds.size > 0) return t('preset.newDirty');
  return t('preset.none');
}

function snapshotPreset() {
  return {
    id: state.activePreset?.id,
    name: state.activePreset?.name || t('preset.new'),
    sourceName: state.activePreset?.sourceName || '',
    createdAt: state.activePreset?.createdAt,
    mods: currentMods()
  };
}

function workspaceSnapshot() {
  return {
    activePresetId: state.activePreset?.id || '',
    name: state.activePreset?.name || '',
    dirty: state.dirty,
    mods: currentMods()
  };
}

function selectionSignature(mods = currentMods()) {
  return JSON.stringify([...mods]
    .sort((left, right) => left.modId.localeCompare(right.modId))
    .map((mod) => [mod.modId, mod.version || '', mod.required !== false]));
}

function upsertPreset(preset) {
  state.presets = [...state.presets.filter((item) => item.id !== preset.id), preset]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function queueWorkspaceSave() {
  const value = workspaceSnapshot();
  workspaceSaveChain = workspaceSaveChain
    .catch(() => {})
    .then(() => api.saveWorkspace(value))
    .catch((error) => showToast(t('toast.workspaceSaveError', { message: errorMessage(error) }), 'error'));
  return workspaceSaveChain;
}

function queuePresetAutosave() {
  if (!state.activePreset || state.selectedIds.size === 0) return presetSaveChain;
  const value = snapshotPreset();
  const activePresetId = state.activePreset.id;
  const signature = selectionSignature(value.mods);
  presetSaveChain = presetSaveChain
    .catch(() => {})
    .then(() => api.savePreset(value))
    .then((preset) => {
      upsertPreset(preset);
      if (state.activePreset?.id === activePresetId && selectionSignature() === signature) {
        state.activePreset = preset;
        state.dirty = false;
        renderAll();
        queueWorkspaceSave();
      }
      return preset;
    })
    .catch((error) => showToast(t('toast.presetAutosaveError', { message: errorMessage(error) }), 'error'));
  return presetSaveChain;
}

function markSelectionChanged() {
  state.dirty = true;
  renderAll();
  queueWorkspaceSave();
  queuePresetAutosave();
}

async function waitForPendingSaves() {
  await presetSaveChain.catch(() => {});
  await workspaceSaveChain.catch(() => {});
}

function selectPreset(preset, options = {}) {
  state.activePreset = preset || null;
  state.requirements = new Map();
  state.selectedIds = new Set();
  const mods = Array.isArray(options.mods) ? options.mods : (preset?.mods || []);
  for (const mod of mods) {
    const modId = String(mod.modId).toUpperCase();
    state.selectedIds.add(modId);
    state.requirements.set(modId, { ...mod, modId });
  }
  state.dirty = options.dirty === true;
  renderAll();
  if (options.persist !== false) queueWorkspaceSave();
}

function restoreWorkspace(workspace) {
  const activePreset = state.presets.find((preset) => preset.id === workspace?.activePresetId) || null;
  const hasWorkspace = Boolean(
    workspace && Array.isArray(workspace.mods) &&
    (workspace.activePresetId || workspace.name || workspace.dirty || workspace.mods.length > 0)
  );
  if (activePreset && hasWorkspace) {
    selectPreset(activePreset, {
      mods: workspace.mods,
      dirty: workspace.dirty,
      persist: false
    });
    return;
  }
  if (hasWorkspace && workspace.mods.length > 0) {
    selectPreset(null, { mods: workspace.mods, dirty: true, persist: false });
    return;
  }
  selectPreset(state.presets[0] || null, { persist: false });
}

function renderView(view) {
  if (view === 'mods') renderMods();
  else if (view === 'workshop') renderWorkshop();
  else if (view === 'servers') renderServers();
  else if (view === 'presets') renderPresets();
  else if (view === 'parameters' || view === 'settings') renderSettings();
  else if (view === 'dashboard') renderLaunchState();
}

function setView(view, options = {}) {
  if (!viewMetadata[view]) return;
  const changed = state.currentView !== view;
  state.currentView = view;
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach((section) => {
    const active = section.id === `view-${view}`;
    section.classList.toggle('active', active);
    section.classList.toggle('view-entering', changed && active);
  });
  $('#pageEyebrow').textContent = t(viewMetadata[view][0]);
  $('#pageTitle').textContent = t(viewMetadata[view][1]);
  if (changed && options.render !== false) renderView(view);
  renderHeaderActions();
  if (view === 'workshop' && !state.workshopLoaded && !state.workshopLoading) {
    setTimeout(() => loadWorkshop(), 0);
  }
  if (view === 'servers') {
    if (!state.serverLoaded && !state.serverLoading) setTimeout(() => loadServers(), 0);
    else setTimeout(refreshServersIfStale, 0);
  } else {
    cancelServerAutoRefresh();
  }
  if (changed) scheduleForegroundRefresh();
}

function renderHeaderActions() {
  const container = $('#headerActions');
  const renderKey = `${state.currentView}:${state.activePreset ? 'saved' : 'new'}:${state.language}`;
  if (renderKey === renderedHeaderActionsKey) return;
  renderedHeaderActionsKey = renderKey;
  if (state.currentView === 'mods') {
    container.innerHTML = `
      <button class="button secondary" data-header-action="import"><img src="assets/icons/file-input.svg" alt="">${t('header.import')}</button>
      <button class="button secondary" data-header-action="share-file"><img src="assets/icons/send.svg" alt="">${t('header.friendFile')}</button>
      <button class="button primary" data-header-action="save"><img src="assets/icons/save.svg" alt="">${t(state.activePreset ? 'header.renamePreset' : 'header.savePreset')}</button>`;
  } else if (state.currentView === 'presets') {
    container.innerHTML = `<button class="button primary" data-header-action="import"><img src="assets/icons/file-input.svg" alt="">${t('header.importJson')}</button>`;
  } else {
    container.innerHTML = '';
  }
}

function renderSidebar() {
  $('#navModsCount').textContent = state.installedMods.length;
  $('#navPresetsCount').textContent = state.presets.length;
  $('#appVersion').textContent = `v${state.appVersion}`;
  const detection = $('#gameDetection');
  const hasGame = Boolean(state.settings.gameExecutable);
  detection.classList.toggle('missing', !hasGame);
  detection.querySelector('small').textContent = hasGame ? state.settings.gameExecutable : t('sidebar.notFound');
}

function renderDashboard(readiness = launchReadiness()) {
  const dashboard = $('#view-dashboard');
  if (!dashboard) return;
  document.querySelectorAll('[data-home-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.homeI18n);
  });

  const summary = counts();
  const hasGame = Boolean(state.settings.gameExecutable);
  const presetName = currentPresetName();
  $('#homePresetName').textContent = presetName;
  $('#homePresetName').title = presetName;
  $('#homePresetMeta').textContent = t('home.selectedMods', { count: summary.selected });
  $('#homeGameState').textContent = t(hasGame ? 'home.gameDetected' : 'home.gameMissing');
  $('#homeGameState').classList.toggle('danger-text', !hasGame);
  $('#homeInstalledMods').textContent = formatCount(state.installedMods.length);
  $('#homeModsMetric').textContent = formatCount(state.installedMods.length);
  $('#homePresetsMetric').textContent = formatCount(state.presets.length);

  const badge = $('#homeReadinessBadge');
  badge.classList.toggle('warning', readiness.type === 'warning');
  badge.classList.toggle('danger', readiness.type === 'danger');
  badge.title = readiness.message;
  $('#homeReadinessText').textContent = t(
    readiness.ready
      ? 'home.readyBadge'
      : readiness.type === 'danger'
        ? 'home.attentionBadge'
        : 'home.setupBadge'
  );
}

function combinedModRows() {
  const rowsById = new Map(state.installedMods.map((mod) => [mod.modId, mod]));
  for (const requirement of state.requirements.values()) {
    if (!rowsById.has(requirement.modId)) {
      rowsById.set(requirement.modId, {
        modId: requirement.modId,
        name: requirement.name,
        version: '',
        dependencies: [],
        corrupted: false,
        missing: true
      });
    }
  }
  return [...rowsById.values()];
}

function statusForListMod(mod) {
  const requirement = state.requirements.get(mod.modId) || {
    modId: mod.modId,
    name: mod.name,
    version: mod.version
  };
  return assessMod({
    ...requirement,
    version: selectCurrentModVersion(requirement.version, mod.version)
  }).status;
}

function renderDependencyControl() {
  $('#addDependencies').hidden = state.settings.autoAddDependencies !== false;
}

function installedModUpdateTargets() {
  const installedIds = [...installedById().values()]
    .filter((mod) => mod.directoryPath && /^[0-9A-F]{16}$/.test(mod.modId))
    .map((mod) => mod.modId);
  const selected = installedIds.filter((modId) => state.selectedIds.has(modId));
  return state.selectedIds.size ? selected : installedIds;
}

function renderModUpdateControls() {
  const button = $('#updateMods');
  if (!button) return;
  const targets = installedModUpdateTargets();
  const selected = state.selectedIds.size > 0;
  const downloadPending = activeModDownloadStates.has(state.modDownloadStatus?.state)
    || state.modDownloadStatus?.resumeAvailable === true;
  button.disabled = state.busy || downloadPending || !state.settings.gameExecutable || targets.length === 0;
  button.querySelector('span').textContent = t(state.modUpdatesChecking
    ? 'mods.updateChecking' : selected ? 'mods.updateSelected' : 'mods.updateAll');
  button.title = t(downloadPending ? 'mods.updateQueuePending'
    : selected && !targets.length ? 'mods.updateNoInstalledSelected' : 'mods.updateHint', { count: targets.length });
  button.setAttribute('aria-busy', String(state.modUpdatesChecking));
  $$('.update-mod-button').forEach((control) => {
    control.disabled = state.busy || downloadPending || !state.settings.gameExecutable;
    control.setAttribute('aria-busy', String(state.modUpdatesChecking));
  });
  renderModAcquisitionControls();
}

function modAcquisitionState(modId) {
  const installed = Boolean(installedById().get(String(modId || '').toUpperCase())?.directoryPath);
  const pending = activeModDownloadStates.has(state.modDownloadStatus?.state)
    || state.modDownloadStatus?.resumeAvailable === true;
  return { installed, pending, blocked: state.busy || pending || !state.settings.gameExecutable };
}

function renderModAcquisitionControls() {
  $$('[data-mod-download], [data-mod-update]').forEach((button) => {
    const updating = button.hasAttribute('data-mod-update');
    const modId = updating ? button.dataset.modUpdate : button.dataset.modDownload;
    const availability = modAcquisitionState(modId);
    const loading = button.closest('#modDetailsDialog') && state.modDetails?.loading;
    button.hidden = updating && !availability.installed;
    button.disabled = !modId || availability.blocked || loading
      || (updating ? !availability.installed : availability.installed);
    button.querySelector('span').textContent = t(updating ? 'workshop.update'
      : availability.installed ? 'workshop.installed' : 'workshop.download');
    if (button.id === 'downloadModDetails') {
      button.classList.toggle('primary', !availability.installed);
      button.classList.toggle('secondary', availability.installed);
    }
    button.title = t(!updating && availability.installed ? 'workshop.alreadyInstalled'
      : loading ? 'mods.detailsLoading'
      : availability.pending ? 'workshop.queuePending'
      : !state.settings.gameExecutable ? 'launch.gameNotFound'
      : updating ? 'workshop.updateHint' : 'workshop.download');
    button.setAttribute('aria-busy', String(state.busy || availability.pending));
  });
}

function renderMods() {
  const search = state.modSearch.toLocaleLowerCase(locale());
  const allRows = combinedModRows();
  let rows = allRows.filter((mod) => {
    const selected = state.selectedIds.has(mod.modId);
    const status = statusForListMod(mod);
    if (state.modFilter === 'selected' && !selected) return false;
    if (state.modFilter === 'problems' && status === 'ready') return false;
    return !search || mod.name.toLocaleLowerCase(locale()).includes(search) || mod.modId.toLowerCase().includes(search);
  });

  rows.sort((left, right) => {
    const selectedDifference = Number(state.selectedIds.has(right.modId)) - Number(state.selectedIds.has(left.modId));
    return selectedDifference || left.name.localeCompare(right.name, locale());
  });

  $('#modListSummary').textContent = t('mods.summary', {
    shown: rows.length,
    total: allRows.length,
    selected: state.selectedIds.size
  });
  const installed = installedById();
  const selectedInstalledCount = [...state.selectedIds]
    .filter((modId) => installed.get(modId)?.directoryPath).length;
  renderDependencyControl();
  $('#deleteSelectedMods').disabled = state.busy || selectedInstalledCount === 0;
  $('#deleteSelectedMods span').textContent = t('mods.deleteSelected');
  $('#modsTableBody').innerHTML = rows.length
    ? rows.map((mod) => {
      const selected = state.selectedIds.has(mod.modId);
      const requirement = state.requirements.get(mod.modId);
      const status = statusForListMod(mod);
      // The Mods view reports what is actually installed. A preset's pinned
      // version is still preserved and represented by the mismatch status.
      const versionText = mod.version || requirement?.version || '—';
      const dependencyCount = mod.dependencies?.length || 0;
      const dependentCount = localDependentMods(mod.modId).length;
      return `
        <div class="mod-row ${selected ? 'selected' : ''}" data-mod-id="${mod.modId}" role="button" tabindex="0" aria-label="${escapeHtml(t('mods.detailsAria', { name: mod.name }))}">
          <span><input class="checkbox mod-checkbox" type="checkbox" ${selected ? 'checked' : ''} aria-label="${escapeHtml(t('mods.chooseAria', { name: mod.name }))}"></span>
          <div class="mod-main"><strong>${escapeHtml(mod.name)}</strong><small>${mod.modId}</small></div>
          <span class="mod-version">${escapeHtml(versionText)}</span>
          <span class="relationship-count" data-dependencies="${dependencyCount}" data-dependents="${dependentCount}" title="${escapeHtml(t('mods.relationshipsHint', { dependencies: dependencyCount, dependents: dependentCount }))}">
            <span title="${escapeHtml(t('mods.dependenciesTitle'))}"><img src="assets/icons/git-branch.svg" alt=""><b>${dependencyCount}</b></span>
            <span title="${escapeHtml(t('mods.dependentsTitle'))}"><img src="assets/icons/share-2.svg" alt=""><b>${dependentCount}</b></span>
          </span>
          <span class="status-badge ${status}">${statusLabel(status)}</span>
          <div class="mod-actions">
            ${mod.directoryPath ? `<button class="icon-button update-mod-button" type="button" title="${escapeHtml(t('mods.updateOne', { name: mod.name }))}" aria-label="${escapeHtml(t('mods.updateOne', { name: mod.name }))}"><img src="assets/icons/refresh-cw.svg" alt=""></button>` : ''}
            <button class="icon-button workshop-button" title="${t('mods.openWorkshop')}"><img src="assets/icons/external-link.svg" alt=""></button>
            ${mod.directoryPath ? `<button class="button quiet danger-text delete-mod-button" type="button" title="${t('mods.delete')}"><img src="assets/icons/trash-2.svg" alt=""><span>${escapeHtml(t('mods.delete'))}</span></button>` : ''}
          </div>
        </div>`;
    }).join('')
    : `<div class="empty-state">${t('mods.notFound')}</div>`;
  renderModUpdateControls();
}

function workshopPageCount() {
  return Math.max(1, Math.ceil(state.workshopCount / Math.max(1, state.workshopPageSize)));
}

function workshopItemCanHaveScenarios(mod) {
  const tags = new Set((Array.isArray(mod?.tags) ? mod.tags : []).map((tag) => String(tag).toUpperCase()));
  return tags.has('TERRAINS') || tags.has('SCENARIOS_MP') || tags.has('SCENARIOS_SP');
}

function renderScenarioRows(scenarios) {
  return scenarios.map((scenario) => `
    <div class="workshop-scenario-row">
      <div class="workshop-scenario-identity">
        <strong title="${escapeHtml(scenario.name)}">${escapeHtml(scenario.name)}</strong>
        <code title="${escapeHtml(scenario.scenarioId)}">${escapeHtml(scenario.scenarioId)}</code>
      </div>
      <button class="button quiet workshop-copy-scenario" type="button" data-scenario-id="${escapeHtml(scenario.scenarioId)}" title="${escapeHtml(t('workshop.copyScenario'))}">
        <img src="assets/icons/copy.svg" alt=""><span>${escapeHtml(t('workshop.copy'))}</span>
      </button>
    </div>`).join('');
}

function renderWorkshopScenarioBlock(mod) {
  if (!workshopItemCanHaveScenarios(mod)) return '';
  if (mod.scenarios === null) {
    return `<div class="workshop-scenarios loading"><span class="details-loader" aria-hidden="true"></span>${escapeHtml(t('workshop.scenariosLoading'))}</div>`;
  }
  if (!Array.isArray(mod.scenarios) || mod.scenarios.length === 0) {
    return `<div class="workshop-scenarios empty"><span>${escapeHtml(t('workshop.noScenarios'))}</span></div>`;
  }
  return `
    <div class="workshop-scenarios">
      <span class="workshop-scenarios-label">${escapeHtml(t('workshop.scenarioId'))}</span>
      <div class="workshop-scenario-list">${renderScenarioRows(mod.scenarios)}</div>
    </div>`;
}

function favoriteWorkshopModIds() {
  return Array.isArray(state.settings.favoriteMods) ? state.settings.favoriteMods : [];
}

function isFavoriteWorkshopMod(modId) {
  return favoriteWorkshopModIds().includes(String(modId || '').toUpperCase());
}

async function toggleWorkshopFavorite(modId) {
  const normalizedModId = String(modId || '').toUpperCase();
  if (!normalizedModId) return;
  const wasFavorite = isFavoriteWorkshopMod(normalizedModId);
  const favoriteMods = wasFavorite
    ? favoriteWorkshopModIds().filter((item) => item !== normalizedModId)
    : [normalizedModId, ...favoriteWorkshopModIds()].slice(0, 500);
  try {
    state.settings = await api.saveSettings({ favoriteMods });
    if (state.workshopSort === 'favorites') {
      state.workshopPage = 1;
      await loadWorkshop();
    } else {
      renderWorkshop();
    }
    showToast(t(wasFavorite ? 'workshop.favoriteRemoved' : 'workshop.favoriteAdded'));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

function workshopItemFromDetails(details, fallbackModId) {
  const modId = String(details?.modId || fallbackModId || '').toUpperCase();
  return {
    modId,
    name: String(details?.name || modId),
    author: String(details?.author || ''),
    summary: String(details?.summary || ''),
    version: String(details?.version || ''),
    gameVersion: String(details?.gameVersion || ''),
    sizeBytes: Number(details?.sizeBytes || 0),
    ratingPercent: Number(details?.ratingPercent || 0),
    ratingCount: Number(details?.ratingCount || 0),
    downloads: Number(details?.downloads || 0),
    updatedAt: String(details?.updatedAt || ''),
    previewUrl: details?.previewUrls?.[0] || '',
    tags: Array.isArray(details?.tags) ? details.tags : [],
    scenarios: Array.isArray(details?.scenarios) ? details.scenarios : []
  };
}

async function resolveFavoriteWorkshopItems(modIds) {
  const items = new Array(modIds.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < modIds.length) {
      const index = nextIndex++;
      const modId = modIds[index];
      const cached = favoriteWorkshopItemsCache.get(modId);
      if (cached) {
        items[index] = cached;
        continue;
      }
      try {
        const details = await api.getModDetails(modId);
        const item = workshopItemFromDetails(details, modId);
        favoriteWorkshopItemsCache.set(modId, item);
        storeWorkshopCardGallery(item, details);
        items[index] = item;
      } catch {
        const item = workshopItemFromDetails(null, modId);
        favoriteWorkshopItemsCache.set(modId, item);
        items[index] = item;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, modIds.length) }, worker));
  return items;
}

async function searchFavoriteWorkshop() {
  const favoriteIds = favoriteWorkshopModIds();
  const resolved = await resolveFavoriteWorkshopItems(favoriteIds);
  const query = state.workshopQuery.trim().toLocaleLowerCase();
  const category = state.workshopCategory.toUpperCase();
  const filtered = resolved.filter((mod) => {
    const matchesQuery = !query || [mod.name, mod.modId, mod.author, mod.summary]
      .some((value) => String(value || '').toLocaleLowerCase().includes(query));
    const tags = new Set((mod.tags || []).map((tag) => String(tag || '').toUpperCase()));
    return matchesQuery && (!category || tags.has(category));
  });
  const pageSize = 16;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(1, state.workshopPage), pages);
  const start = (page - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    count: filtered.length,
    pageSize,
    page
  };
}

function getWorkshopCardGallery(mod) {
  let gallery = workshopCardGalleries.get(mod.modId);
  if (!gallery) {
    gallery = {
      images: mod.previewUrl ? [mod.previewUrl] : [],
      index: 0,
      loaded: false,
      promise: null
    };
    workshopCardGalleries.set(mod.modId, gallery);
  }
  return gallery;
}

function storeWorkshopCardGallery(mod, details) {
  const gallery = getWorkshopCardGallery(mod);
  const selected = gallery.images[gallery.index] || '';
  gallery.images = [...new Set([
    mod.previewUrl,
    ...(details?.previewUrls || []),
    ...(details?.screenshotUrls || [])
  ].filter(Boolean))];
  gallery.index = Math.max(0, gallery.images.indexOf(selected));
  gallery.loaded = true;
  return gallery;
}

function updateWorkshopCardGallery(modId) {
  const gallery = workshopCardGalleries.get(modId);
  const card = $(`#workshopGrid .workshop-card[data-mod-id="${modId}"]`);
  if (!gallery || !card) return;
  const image = card.querySelector('.workshop-preview-image');
  const url = gallery.images[gallery.index] || '';
  if (image && url) image.src = url;
  card.querySelectorAll('.workshop-gallery-arrow').forEach((button) => {
    button.hidden = gallery.images.length < 2;
  });
}

async function loadWorkshopCardGallery(mod) {
  const gallery = getWorkshopCardGallery(mod);
  if (gallery.loaded || gallery.promise) return gallery.promise;
  gallery.promise = api.getModDetails(mod.modId)
    .then((details) => storeWorkshopCardGallery(mod, details))
    .catch(() => {
      gallery.loaded = true;
      return gallery;
    })
    .finally(() => {
      gallery.promise = null;
      updateWorkshopCardGallery(mod.modId);
    });
  return gallery.promise;
}

function changeWorkshopCardGallery(mod, direction) {
  const gallery = getWorkshopCardGallery(mod);
  if (gallery.images.length < 2) return;
  gallery.index = (gallery.index + direction + gallery.images.length) % gallery.images.length;
  updateWorkshopCardGallery(mod.modId);
}

function renderWorkshopCards(items) {
  const installed = installedById();
  return items.map((mod) => {
    const local = installed.get(mod.modId);
    const favorite = isFavoriteWorkshopMod(mod.modId);
    const gallery = getWorkshopCardGallery(mod);
    const previewUrl = gallery.images[gallery.index] || mod.previewUrl || '';
    const galleryHidden = gallery.images.length < 2 ? 'hidden' : '';
    const addAction = `<button class="button primary workshop-add"><img src="assets/icons/plus.svg" alt="">${escapeHtml(t('workshop.add'))}</button>`;
    const audience = Number.isFinite(Number(mod.subscriberCount))
      ? t('workshop.subscribers', { count: formatCount(mod.subscriberCount) })
      : t('workshop.downloads', { count: formatCount(mod.downloads) });
    return `
      <article class="workshop-card" data-mod-id="${mod.modId}">
        <div class="workshop-preview-shell">
          <button class="workshop-favorite-toggle ${favorite ? 'active' : ''}" type="button" data-workshop-favorite="${escapeHtml(mod.modId)}" title="${escapeHtml(t(favorite ? 'workshop.removeFavorite' : 'workshop.addFavorite'))}" aria-label="${escapeHtml(t(favorite ? 'workshop.removeFavorite' : 'workshop.addFavorite'))}" aria-pressed="${favorite}"><span aria-hidden="true">★</span></button>
          <button class="workshop-preview workshop-details" type="button" aria-label="${escapeHtml(t('mods.detailsAria', { name: mod.name }))}">
            ${previewUrl
              ? `<img class="workshop-preview-image" src="${escapeHtml(previewUrl)}" alt="${escapeHtml(mod.name)}" loading="lazy" referrerpolicy="no-referrer">`
              : `<span>${escapeHtml(mod.name.slice(0, 1).toUpperCase())}</span>`}
            <b class="workshop-state ${local ? 'installed' : ''}">${escapeHtml(local ? t('workshop.installed') : t('workshop.available'))}</b>
          </button>
          <button class="workshop-gallery-arrow previous" type="button" data-workshop-gallery-direction="-1" ${galleryHidden} title="${escapeHtml(t('viewer.previous'))}" aria-label="${escapeHtml(t('viewer.previous'))}"><img src="assets/icons/chevron-left.svg" alt=""></button>
          <button class="workshop-gallery-arrow next" type="button" data-workshop-gallery-direction="1" ${galleryHidden} title="${escapeHtml(t('viewer.next'))}" aria-label="${escapeHtml(t('viewer.next'))}"><img src="assets/icons/chevron-right.svg" alt=""></button>
        </div>
        <div class="workshop-card-body">
          <div class="workshop-card-title"><strong title="${escapeHtml(mod.name)}">${escapeHtml(mod.name)}</strong><small>${mod.modId}</small></div>
          <p>${escapeHtml(mod.summary || t('mods.noDescription'))}</p>
          ${renderWorkshopScenarioBlock(mod)}
          <div class="workshop-meta">
            <span>${escapeHtml(mod.author || t('workshop.unknownAuthor'))}</span>
            <span>${escapeHtml(formatBytes(mod.sizeBytes))}</span>
            <span>${escapeHtml(audience)}</span>
            <span>${escapeHtml(`${mod.ratingPercent}%`)}</span>
          </div>
          <div class="workshop-card-actions">
            ${addAction}
            <button class="icon-button bordered workshop-details" title="${escapeHtml(t('workshop.details'))}"><img src="assets/icons/blocks.svg" alt=""></button>
            ${local ? `<button class="icon-button bordered workshop-delete danger-text" title="${escapeHtml(t('mods.delete'))}"><img src="assets/icons/trash-2.svg" alt=""></button>` : ''}
          </div>
          <div class="workshop-download-actions">
            <button class="button secondary workshop-install" type="button" data-mod-download="${escapeHtml(mod.modId)}" disabled><img src="assets/icons/download.svg" alt=""><span>${escapeHtml(t(local ? 'workshop.installed' : 'workshop.download'))}</span></button>
            <button class="button secondary workshop-update" type="button" data-mod-update="${escapeHtml(mod.modId)}" ${local ? 'disabled' : 'hidden'}><img src="assets/icons/refresh-cw.svg" alt=""><span>${escapeHtml(t('workshop.update'))}</span></button>
          </div>
        </div>
      </article>`;
  }).join('');
}

function renderWorkshop() {
  const grid = $('#workshopGrid');
  if (!grid) return;
  $('#workshopSort').value = state.workshopSort;
  $$('#configuratorCategories [data-category]').forEach((button) => {
    button.classList.toggle('active', button.dataset.category === state.workshopCategory);
    button.setAttribute('aria-pressed', String(button.dataset.category === state.workshopCategory));
  });
  $('#workshopSummary').textContent = state.workshopLoading
    ? t('workshop.loading')
    : state.workshopError
      ? t('workshop.error')
      : state.workshopSort === 'favorites'
        ? t('workshop.favoritesSummary', { count: formatCount(state.workshopCount) })
        : state.workshopCategory
        ? t('configurator.summary', {
            category: t(workshopCategoryKeys[state.workshopCategory]),
            count: formatCount(state.workshopCount)
          })
        : t('workshop.summary', { count: formatCount(state.workshopCount) });
  $('#workshopPageLabel').textContent = t('workshop.page', {
    page: state.workshopPage,
    pages: workshopPageCount()
  });
  $('#workshopPrevious').disabled = state.workshopLoading || state.workshopPage <= 1;
  $('#workshopNext').disabled = state.workshopLoading || state.workshopPage >= workshopPageCount();

  if (state.workshopLoading) {
    grid.innerHTML = `<div class="workshop-message"><span class="details-loader" aria-hidden="true"></span><strong>${escapeHtml(t('workshop.loading'))}</strong></div>`;
    return;
  }
  if (state.workshopError) {
    grid.innerHTML = `<div class="workshop-message error"><strong>${escapeHtml(t('workshop.error'))}</strong><span>${escapeHtml(state.workshopError)}</span></div>`;
    return;
  }
  if (state.workshopItems.length === 0) {
    grid.innerHTML = `<div class="workshop-message"><strong>${escapeHtml(t(state.workshopSort === 'favorites' ? 'workshop.emptyFavorites' : 'workshop.empty'))}</strong></div>`;
    return;
  }

  grid.innerHTML = renderWorkshopCards(state.workshopItems);
  renderModAcquisitionControls();
}

async function loadWorkshop(options = {}) {
  const scenarioRequest = ++workshopScenarioRequest;
  state.workshopLoading = true;
  state.workshopError = '';
  renderWorkshop();
  try {
    const result = state.workshopSort === 'favorites'
      ? await searchFavoriteWorkshop()
      : await api.searchWorkshop({
          query: state.workshopQuery,
          category: state.workshopCategory,
          sort: state.workshopSort,
          page: state.workshopPage,
          refresh: options.refresh === true
        });
    state.workshopItems = (result.items || []).map((item) => (
      workshopItemCanHaveScenarios(item) && item.scenarios === undefined
        ? { ...item, scenarios: null }
        : item
    ));
    for (const item of state.workshopItems) favoriteWorkshopItemsCache.set(item.modId, item);
    state.workshopCount = result.count || 0;
    state.workshopPageSize = result.pageSize || 16;
    state.workshopPage = result.page || state.workshopPage;
    state.workshopLoaded = true;
  } catch (error) {
    state.workshopError = errorMessage(error);
  } finally {
    state.workshopLoading = false;
    renderWorkshop();
  }
  if (!state.workshopError && scenarioRequest === workshopScenarioRequest) {
    hydrateWorkshopScenarios(scenarioRequest, state.workshopItems);
  }
}

async function hydrateWorkshopScenarios(requestId, items) {
  const queue = items.filter((item) => workshopItemCanHaveScenarios(item) && item.scenarios === null);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < queue.length && requestId === workshopScenarioRequest) {
      const mod = queue[nextIndex++];
      try {
        const details = await api.getModDetails(mod.modId);
        mod.scenarios = Array.isArray(details?.scenarios) ? details.scenarios : [];
        storeWorkshopCardGallery(mod, details);
      } catch {
        mod.scenarios = [];
      }
      if (requestId === workshopScenarioRequest && state.workshopItems.includes(mod)) renderWorkshop();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
}

async function copyScenarioId(scenarioId) {
  try {
    await api.copyScenarioId(scenarioId);
    showToast(t('workshop.scenarioCopied'));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

function handleWorkshopGridAction(event, items) {
  const card = event.target.closest('[data-mod-id]');
  if (!card) return;
  const mod = items.find((item) => item.modId === card.dataset.modId);
  if (!mod) return;
  const favorite = event.target.closest('[data-workshop-favorite]');
  if (favorite) {
    toggleWorkshopFavorite(favorite.dataset.workshopFavorite);
    return;
  }
  const galleryDirection = event.target.closest('[data-workshop-gallery-direction]');
  if (galleryDirection) {
    changeWorkshopCardGallery(mod, Number(galleryDirection.dataset.workshopGalleryDirection));
    return;
  }
  const scenarioCopy = event.target.closest('.workshop-copy-scenario');
  if (scenarioCopy) copyScenarioId(scenarioCopy.dataset.scenarioId);
  else if (event.target.closest('.workshop-install')) installWorkshopMod(mod);
  else if (event.target.closest('.workshop-update')) updateInstalledMods([mod.modId]);
  else if (event.target.closest('.workshop-add')) handleWorkshopAdd(mod);
  else if (event.target.closest('.workshop-delete')) deleteInstalledMod(mod.modId);
  else if (event.target.closest('.workshop-details')) openModDetails(mod.modId);
}

function serverModStatus(mod) {
  const installed = installedById().get(mod?.modId);
  if (!installed) return 'missing';
  if (installed.corrupted) return 'corrupted';
  if (mod.version && installed.version && !modVersionsEqual(mod.version, installed.version)) return 'version-mismatch';
  if (mod.version && !installed.version) return 'version-unknown';
  return 'ready';
}

function serverModCounts(mods = state.serverDetails?.mods || []) {
  const statuses = mods.map(serverModStatus);
  return {
    total: statuses.length,
    ready: statuses.filter((status) => status === 'ready').length,
    missing: statuses.filter((status) => ['missing', 'corrupted'].includes(status)).length,
    mismatch: statuses.filter((status) => ['version-mismatch', 'version-unknown'].includes(status)).length
  };
}

function favoriteServerItems() {
  return Array.isArray(state.settings.favoriteServers) ? state.settings.favoriteServers : [];
}

function isFavoriteServer(serverId) {
  return favoriteServerItems().some((server) => server.id === serverId);
}

function filteredFavoriteServers() {
  const query = state.serverQuery.trim().toLocaleLowerCase(locale());
  if (!query) return favoriteServerItems();
  return favoriteServerItems().filter((server) => [server.name, server.address, server.scenarioName]
    .some((value) => String(value || '').toLocaleLowerCase(locale()).includes(query)));
}

async function toggleServerFavorite(serverId) {
  const server = state.serverItems.find((item) => item.id === serverId)
    || (state.serverDetails?.server?.id === serverId ? state.serverDetails.server : null);
  if (!server) return;
  const wasFavorite = isFavoriteServer(serverId);
  const nextFavorites = wasFavorite
    ? favoriteServerItems().filter((item) => item.id !== serverId)
    : [{ ...server }, ...favoriteServerItems()].slice(0, 100);
  try {
    state.settings = await api.saveSettings({ favoriteServers: nextFavorites });
    if (state.serverSort === 'favorites') {
      state.serverItems = filteredFavoriteServers();
      state.serverPage = 1;
      state.serverHasNext = false;
      if (!state.serverItems.some((item) => item.id === state.selectedServerId)) {
        serverDetailsRequest += 1;
        state.selectedServerId = state.serverItems[0]?.id || '';
        state.serverDetails = null;
        state.serverDetailsError = '';
        state.serverDetailsLoading = false;
      }
    }
    renderServers();
    if (state.serverSort === 'favorites' && state.selectedServerId && !state.serverDetails) {
      loadServerDetails(state.selectedServerId);
    }
    showToast(t(wasFavorite ? 'servers.favoriteRemoved' : 'servers.favoriteAdded'));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

function renderServerDetails() {
  const container = $('#serverDetails');
  if (!container) return;
  if (state.serverDetailsLoading) {
    container.innerHTML = `<div class="server-details-placeholder"><span class="details-loader" aria-hidden="true"></span><strong>${escapeHtml(t('servers.detailsLoading'))}</strong></div>`;
    return;
  }
  if (state.serverDetailsError) {
    container.innerHTML = `<div class="server-message error"><strong>${escapeHtml(t('servers.detailsError'))}</strong><span>${escapeHtml(state.serverDetailsError)}</span></div>`;
    return;
  }
  if (!state.serverDetails) {
    container.innerHTML = `<div class="server-details-placeholder"><img src="assets/icons/server.svg" alt=""><strong>${escapeHtml(t('servers.selectServer'))}</strong></div>`;
    return;
  }

  const { server, mods } = state.serverDetails;
  const favorite = isFavoriteServer(server.id);
  const modCounts = serverModCounts(mods);
  const downloadActive = activeModDownloadStates.has(state.modDownloadStatus?.state);
  const modRows = mods.length
    ? mods.map((mod) => {
        const status = serverModStatus(mod);
        const installedVersion = installedById().get(mod.modId)?.version || mod.installedVersion || '';
        return `
          <div class="server-mod-row" data-mod-id="${escapeHtml(mod.modId)}">
            <div><strong title="${escapeHtml(mod.name)}">${escapeHtml(mod.name)}</strong><small>${escapeHtml(mod.modId)}</small></div>
            <span class="server-mod-version" title="${escapeHtml(mod.version || t('common.latest'))}">${escapeHtml(mod.version || t('common.latest'))}</span>
            <span class="status-badge ${status}" title="${escapeHtml(installedVersion ? t('servers.installedVersion', { version: installedVersion }) : '')}">${escapeHtml(statusLabel(status))}</span>
            ${status !== 'ready'
              ? `<button class="icon-button bordered server-mod-download" type="button" data-server-mod-download="${escapeHtml(mod.modId)}" ${state.busy || downloadActive ? 'disabled' : ''} title="${escapeHtml(t('servers.downloadMod'))}" aria-label="${escapeHtml(t('servers.downloadNamedMod', { name: mod.name }))}"><img src="assets/icons/download.svg" alt=""></button>`
              : '<span class="server-mod-action-placeholder" aria-hidden="true"></span>'}
          </div>`;
      }).join('')
    : `<div class="server-details-placeholder"><strong>${escapeHtml(t('servers.noMods'))}</strong></div>`;

  container.innerHTML = `
    <div class="server-details-content">
      <div class="server-details-header">
        <div class="server-details-actions">
          <button class="icon-button bordered server-favorite-toggle ${favorite ? 'active' : ''}" type="button" data-server-favorite="${escapeHtml(server.id)}" title="${escapeHtml(t(favorite ? 'servers.removeFavorite' : 'servers.addFavorite'))}" aria-label="${escapeHtml(t(favorite ? 'servers.removeFavorite' : 'servers.addFavorite'))}" aria-pressed="${favorite}"><span aria-hidden="true">★</span></button>
          <button class="button secondary" type="button" data-server-download ${state.busy || downloadActive || mods.length === 0 ? 'disabled' : ''}><img src="assets/icons/cloud-download.svg" alt="">${escapeHtml(t('servers.downloadPack'))}</button>
          <button class="button secondary" type="button" data-server-copy-json title="${escapeHtml(t('servers.copyJsonTitle'))}" ${state.busy || mods.length === 0 ? 'disabled' : ''}><img src="assets/icons/copy.svg" alt="">${escapeHtml(t('servers.copyJson'))}</button>
          <button class="button primary" type="button" data-server-connect ${state.busy ? 'disabled' : ''}><img src="assets/icons/play.svg" alt="">${escapeHtml(t('servers.connect'))}</button>
        </div>
        <div class="server-details-identity"><h2>${escapeHtml(server.name)}</h2><small>${escapeHtml(server.address)}</small></div>
      </div>
      <div class="server-facts">
        <div><span>${escapeHtml(t('servers.players'))}</span><strong>${escapeHtml(`${formatCount(server.playerCount)}/${formatCount(server.playerLimit)}`)}${server.queueCount ? ` +${formatCount(server.queueCount)}` : ''}</strong></div>
        <div><span>${escapeHtml(t('servers.scenario'))}</span><strong title="${escapeHtml(server.scenarioName)}">${escapeHtml(server.scenarioName || '—')}</strong></div>
        <div><span>${escapeHtml(t('servers.pack'))}</span><strong>${escapeHtml(t('servers.packValue', { count: mods.length, size: formatBytes(server.totalModSize) }))}</strong></div>
        <div><span>${escapeHtml(t('servers.gameVersion'))}</span><strong>${escapeHtml(server.gameVersion || '—')}</strong></div>
      </div>
      <div class="server-mod-heading"><h3>${escapeHtml(t('servers.serverMods'))}</h3><span>${escapeHtml(t('servers.modStatusSummary', { ready: modCounts.ready, problems: modCounts.missing + modCounts.mismatch }))}</span></div>
      <div class="server-mod-list">${modRows}</div>
    </div>`;
}

function renderServers() {
  const list = $('#serverList');
  if (!list) return;
  $('#serverSort').value = state.serverSort;
  $('#serverDirectLabel').textContent = t('servers.directLabel');
  $('#serverDirectHost').placeholder = t('servers.directHostPlaceholder');
  $('#serverDirectHost').setAttribute('aria-label', t('servers.directHostPlaceholder'));
  $('#serverDirectPort').placeholder = t('servers.directPortPlaceholder');
  $('#serverDirectPort').setAttribute('aria-label', t('servers.directPortPlaceholder'));
  $('#serverSummary').textContent = state.serverLoading
    ? t('servers.loading')
    : state.serverError
      ? t('servers.error')
      : state.serverSort === 'favorites'
        ? t('servers.favoritesSummary', { count: state.serverItems.length })
        : t('servers.summary', { count: state.serverItems.length, page: state.serverPage });
  $('#serverPageLabel').textContent = t('servers.page', { page: state.serverPage });
  $('#serverPrevious').disabled = state.serverLoading || state.serverPage <= 1;
  $('#serverNext').disabled = state.serverLoading || !state.serverHasNext;
  $('#serverProviderLink').textContent = t('servers.provider');
  $('#serverProviderLink').href = state.serverProviderUrl;

  if (state.serverLoading) {
    list.innerHTML = `<div class="server-message"><span class="details-loader" aria-hidden="true"></span><strong>${escapeHtml(t('servers.loading'))}</strong></div>`;
  } else if (state.serverError) {
    list.innerHTML = `<div class="server-message error"><strong>${escapeHtml(t('servers.error'))}</strong><span>${escapeHtml(state.serverError)}</span><button class="button secondary" type="button" data-server-retry>${escapeHtml(t('servers.retry'))}</button></div>`;
  } else if (state.serverItems.length === 0) {
    list.innerHTML = `<div class="server-message"><strong>${escapeHtml(t(state.serverSort === 'favorites' ? 'servers.emptyFavorites' : 'servers.empty'))}</strong></div>`;
  } else {
    list.innerHTML = state.serverItems.map((server) => {
      const favorite = isFavoriteServer(server.id);
      return `
      <div class="server-row ${server.id === state.selectedServerId ? 'active' : ''}" role="button" tabindex="0" data-server-id="${escapeHtml(server.id)}">
        <strong title="${escapeHtml(server.name)}">${escapeHtml(server.name)}</strong>
        <span class="server-player-count">${escapeHtml(`${formatCount(server.playerCount)}/${formatCount(server.playerLimit)}`)}</span>
        <button class="server-favorite-toggle ${favorite ? 'active' : ''}" type="button" data-server-favorite="${escapeHtml(server.id)}" title="${escapeHtml(t(favorite ? 'servers.removeFavorite' : 'servers.addFavorite'))}" aria-label="${escapeHtml(t(favorite ? 'servers.removeFavorite' : 'servers.addFavorite'))}" aria-pressed="${favorite}"><span aria-hidden="true">★</span></button>
        <small>${escapeHtml(server.scenarioName || server.address)}</small>
        <span class="server-row-meta">
          <span>${escapeHtml(server.address)}</span>
          ${server.queueCount ? `<span>${escapeHtml(t('servers.queue', { count: server.queueCount }))}</span>` : ''}
          ${server.passwordProtected ? `<span>${escapeHtml(t('servers.password'))}</span>` : ''}
          <span>${escapeHtml(formatBytes(server.totalModSize))}</span>
        </span>
      </div>`;
    }).join('');
  }
  renderServerDetails();
}

async function loadServerDetails(serverId, options = {}) {
  const request = ++serverDetailsRequest;
  const silent = options.silent === true
    && state.serverDetails?.server?.id === serverId;
  state.serverDetailsLoading = !silent;
  if (!silent) {
    state.serverDetailsError = '';
    state.serverDetails = null;
    renderServers();
  }
  try {
    const details = await api.getServerDetails(serverId, { refresh: options.refresh === true });
    if (request !== serverDetailsRequest || state.selectedServerId !== serverId) return;
    state.serverDetails = details;
    state.serverDetailsError = '';
    state.serverDetailsLastLoadedAt = Date.now();
  } catch (error) {
    if (request !== serverDetailsRequest || state.selectedServerId !== serverId) return;
    if (!silent) state.serverDetailsError = errorMessage(error);
  } finally {
    if (request === serverDetailsRequest) {
      state.serverDetailsLoading = false;
      renderServers();
    }
  }
}

function selectServer(serverId) {
  const normalizedId = String(serverId || '');
  if (!state.serverItems.some((server) => server.id === normalizedId)) return;
  state.selectedServerId = normalizedId;
  renderServers();
  loadServerDetails(normalizedId, { refresh: true });
}

async function loadServers(options = {}) {
  if (options.automatic && (state.serverLoading || state.serverRefreshing)) {
    scheduleServerAutoRefresh();
    return;
  }
  const request = ++serverListRequest;
  const silent = options.silent === true && state.serverLoaded;
  state.serverLoading = !silent;
  state.serverRefreshing = silent;
  if (!options.automatic) state.serverError = '';
  cancelServerAutoRefresh();
  if (!silent) renderServers();
  if (state.serverSort === 'favorites') {
    state.serverItems = filteredFavoriteServers();
    state.serverPage = 1;
    state.serverHasNext = false;
    state.serverLoaded = true;
    if (!state.serverItems.some((server) => server.id === state.selectedServerId)) {
      state.selectedServerId = state.serverItems[0]?.id || '';
      state.serverDetails = null;
    }
    if (request === serverListRequest) {
      state.serverLoading = false;
      state.serverRefreshing = false;
      renderServers();
      if (state.selectedServerId) loadServerDetails(state.selectedServerId, { refresh: true });
      scheduleServerAutoRefresh();
    }
    return;
  }
  try {
    const result = await requestWithTimeout(
      api.listServers({
        search: state.serverQuery,
        sort: state.serverSort,
        page: state.serverPage,
        pageSize: state.serverPageSize,
        refresh: options.refresh === true
      }),
      15_000,
      t('servers.timeout')
    );
    if (request !== serverListRequest) return;
    state.serverItems = result.items || [];
    state.serverPage = result.page || state.serverPage;
    state.serverPageSize = result.pageSize || state.serverPageSize;
    state.serverHasNext = result.hasNext === true;
    state.serverProviderUrl = result.providerUrl || state.serverProviderUrl;
    state.serverLoaded = true;
    state.serverLastAttemptAt = Date.now();
    state.serverRefreshFailures = 0;
    state.serverError = '';
    if (!state.serverItems.some((server) => server.id === state.selectedServerId)) {
      state.selectedServerId = state.serverItems[0]?.id || '';
      state.serverDetails = null;
    } else if (state.serverDetails?.server?.id === state.selectedServerId) {
      const refreshedServer = state.serverItems.find((server) => server.id === state.selectedServerId);
      state.serverDetails = {
        ...state.serverDetails,
        server: { ...state.serverDetails.server, ...refreshedServer }
      };
    }
  } catch (error) {
    if (request !== serverListRequest) return;
    state.serverLastAttemptAt = Date.now();
    state.serverRefreshFailures += 1;
    if (!options.automatic || !state.serverLoaded) state.serverError = errorMessage(error);
  } finally {
    if (request === serverListRequest) {
      state.serverLoading = false;
      state.serverRefreshing = false;
      renderServers();
      scheduleServerAutoRefresh();
    }
  }
  const serverDetailsStale = Date.now() - state.serverDetailsLastLoadedAt >= 60_000;
  if (request === serverListRequest && state.selectedServerId
    && (!options.automatic || !state.serverDetails || serverDetailsStale)) {
    loadServerDetails(state.selectedServerId, {
      refresh: true,
      silent: options.automatic === true
    });
  }
}

function serverCapacity(server = {}) {
  const playerCount = Math.max(0, Number(server.playerCount) || 0);
  const playerLimit = Math.max(0, Number(server.playerLimit) || 0);
  const queueCount = Math.max(0, Number(server.queueCount) || 0);
  return {
    playerCount,
    playerLimit,
    queueCount,
    full: playerLimit > 0 && playerCount >= playerLimit
  };
}

function cancelServerJoinWait() {
  if (serverJoinWaitTimer) clearTimeout(serverJoinWaitTimer);
  serverJoinWaitTimer = 0;
  serverJoinWaitRequest += 1;
  serverJoinWaiting = false;
  serverJoinWaitError = false;
  serverJoinBlockReason = '';
}

function serverJoinBlockMessageKey(reason = serverJoinBlockReason) {
  const messages = {
    offline: 'servers.join.offline',
    stale: 'servers.join.stale',
    'catalog-unavailable': 'servers.join.catalogUnavailable'
  };
  return messages[reason] || 'servers.join.unavailable';
}

function serverJoinIdentity(details) {
  const server = details?.server || details || {};
  const id = String(server.id || '').trim();
  if (id) return `id:${id}`;
  const address = String(server.address || '').trim().toLocaleLowerCase('en');
  return address ? `address:${address}` : '';
}

function mergePendingServerDetails(details) {
  if (!pendingServerJoin) return details;
  const currentIdentity = serverJoinIdentity(pendingServerJoin);
  const nextIdentity = serverJoinIdentity(details);
  if (currentIdentity && nextIdentity && currentIdentity !== nextIdentity) return details;
  return {
    ...pendingServerJoin,
    ...details,
    server: { ...pendingServerJoin.server, ...details.server },
    mods: Array.isArray(details.mods) ? details.mods : pendingServerJoin.mods
  };
}

function openServerJoinDialog(details) {
  if (!details?.server?.address) return;
  const dialog = $('#serverJoinDialog');
  const preserveForm = dialog.open
    && serverJoinIdentity(pendingServerJoin) === serverJoinIdentity(details);
  const preservedForm = preserveForm ? {
    savePreset: $('#serverSavePreset').checked,
    presetName: $('#serverPresetName').value
  } : null;
  if (!dialog.open) cancelServerJoinWait();
  pendingServerJoin = mergePendingServerDetails(details);
  details = pendingServerJoin;
  const hasMods = Array.isArray(details.mods) && details.mods.length > 0;
  const capacity = serverCapacity(details.server);
  const existingPreset = details.server.id
    ? state.presets.find((preset) => preset.sourceName === `server:${details.server.id}`)
    : null;
  const counts = serverModCounts(details.mods || []);
  $('#serverJoinEyebrow').textContent = t('servers.join.eyebrow');
  $('#serverJoinTitle').textContent = t('servers.join.title');
  $('#serverJoinName').textContent = details.server.name || details.server.address;
  $('#serverJoinAddress').textContent = details.server.address;
  const modFacts = hasMods
    ? `<span>${escapeHtml(t('servers.join.mods', { count: counts.total }))}</span><span>${escapeHtml(t('servers.join.ready', { count: counts.ready }))}</span><span>${escapeHtml(t('servers.join.downloads', { count: counts.missing + counts.mismatch }))}</span>`
    : `<span>${escapeHtml(t('servers.join.direct'))}</span>`;
  const capacityFacts = capacity.playerLimit > 0
    ? `<span class="${capacity.full ? 'server-capacity-full' : ''}">${escapeHtml(t('servers.join.players', {
        count: capacity.playerCount,
        limit: capacity.playerLimit
      }))}</span>${capacity.queueCount > 0
        ? `<span class="${capacity.full ? 'server-capacity-full' : ''}">${escapeHtml(t('servers.join.queue', { count: capacity.queueCount }))}</span>`
        : ''}`
    : '';
  $('#serverJoinFacts').innerHTML = `${capacityFacts}${modFacts}`;
  $('#serverSavePresetRow').hidden = !hasMods;
  const savePreset = hasMods && (preservedForm ? preservedForm.savePreset : true);
  $('#serverPresetNameField').hidden = !savePreset;
  $('#serverSavePreset').checked = savePreset;
  $('#serverSavePresetTitle').textContent = t(existingPreset ? 'servers.join.updatePresetTitle' : 'servers.join.savePresetTitle');
  $('#serverSavePresetHelp').textContent = t(existingPreset ? 'servers.join.updatePresetHelp' : 'servers.join.savePresetHelp');
  $('#serverPresetNameLabel').textContent = t('servers.join.presetName');
  $('#serverPresetName').value = preservedForm
    ? preservedForm.presetName
    : existingPreset?.name || t('servers.join.defaultPresetName', { name: details.server.name });
  const help = $('#serverJoinHelp');
  help.textContent = serverJoinWaiting
    ? t(serverJoinWaitError ? 'servers.join.waitError' : 'servers.join.waitHelp')
    : serverJoinBlockReason
      ? t(serverJoinBlockMessageKey())
      : t(hasMods ? 'servers.join.help' : 'servers.join.directHelp');
  help.dataset.state = serverJoinBlockReason ? 'warning' : '';
  const connecting = activeServerJoinRequest !== 0 || state.busy;
  const forceButton = $('#forceServerJoin');
  forceButton.hidden = !serverJoinBlockReason || serverJoinWaiting || connecting;
  forceButton.disabled = connecting;
  forceButton.querySelector('span').textContent = t('servers.join.connectAnyway');
  $('#confirmServerJoin').disabled = serverJoinWaiting || connecting;
  $('#confirmServerJoin span').textContent = t(
    serverJoinWaiting
      ? 'servers.join.waiting'
      : connecting
        ? 'servers.join.checking'
        : serverJoinBlockReason
          ? 'servers.join.retryCheck'
          : 'servers.connect'
  );
  if (!dialog.open) dialog.showModal();
}

function waitForServerSlot(server, retryAfterMs = serverJoinWaitInterval) {
  if (!pendingServerJoin?.server?.id || !$('#serverJoinDialog').open) return;
  if (serverJoinWaitTimer) clearTimeout(serverJoinWaitTimer);
  pendingServerJoin = mergePendingServerDetails({ server });
  serverJoinWaiting = true;
  serverJoinWaitError = false;
  serverJoinBlockReason = '';
  const request = ++serverJoinWaitRequest;
  const interval = Math.max(3_000, Math.min(15_000, Number(retryAfterMs) || serverJoinWaitInterval));
  openServerJoinDialog(pendingServerJoin);
  showToast(t('servers.join.fullWaiting', {
    count: serverCapacity(pendingServerJoin.server).playerCount,
    limit: serverCapacity(pendingServerJoin.server).playerLimit
  }));

  const check = async () => {
    if (request !== serverJoinWaitRequest || !serverJoinWaiting || !pendingServerJoin?.server?.id
      || !$('#serverJoinDialog').open) return;
    try {
      const refreshed = await requestWithTimeout(
        api.getServerDetails(pendingServerJoin.server.id, { refresh: true }),
        15_000,
        t('servers.timeout')
      );
      if (request !== serverJoinWaitRequest || !serverJoinWaiting || !$('#serverJoinDialog').open) return;
      pendingServerJoin = mergePendingServerDetails(refreshed);
      if (state.serverDetails?.server?.id === pendingServerJoin.server.id) {
        state.serverDetails = pendingServerJoin;
        state.serverDetailsLastLoadedAt = Date.now();
      }
      serverJoinWaitError = false;
      if (!serverCapacity(pendingServerJoin.server).full) {
        serverJoinWaiting = false;
        serverJoinWaitRequest += 1;
        openServerJoinDialog(pendingServerJoin);
        showToast(t('servers.join.slotAvailable'));
        await connectPendingServer();
        return;
      }
      openServerJoinDialog(pendingServerJoin);
    } catch {
      if (request !== serverJoinWaitRequest || !serverJoinWaiting || !$('#serverJoinDialog').open) return;
      serverJoinWaitError = true;
      openServerJoinDialog(pendingServerJoin);
    }
    if (request === serverJoinWaitRequest && serverJoinWaiting && $('#serverJoinDialog').open) {
      serverJoinWaitTimer = setTimeout(check, interval);
    }
  };

  serverJoinWaitTimer = setTimeout(check, interval);
}

async function downloadServerPack() {
  if (state.busy) return;
  const details = state.serverDetails;
  if (!details?.server?.id) return;
  const pendingMods = details.mods.filter((mod) => serverModStatus(mod) !== 'ready');
  try {
    setBusy(true, t('busy.downloadingServerPack'));
    renderServers();
    await waitForPendingSaves();
    await saveSettings(false);
    modDownloadPollGeneration++;
    const result = await api.downloadServerPack(details.server.id);
    if (result.alreadyReady) {
      showToast(t('servers.packReady'));
      return;
    }
    modDownloadPollGeneration++;
    state.modDownloadStatus = {
      state: 'queued',
      completed: 0,
      total: result.queuedCount || result.pendingCount,
      failed: 0,
      progress: 0
    };
    recordModActions(pendingMods.map((mod) => ({
      action: 'install',
      source: 'server',
      mod,
      details: details.server.name
    })));
    showToast(t('servers.downloadStarted', { count: result.queuedCount || result.pendingCount }));
    scheduleModDownloadPoll(800);
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
    scheduleModDownloadPoll(800);
    renderServers();
  }
}

async function downloadServerMod(modId) {
  if (state.busy) return;
  const details = state.serverDetails;
  const mod = details?.mods?.find((item) => item.modId === modId);
  if (!details?.server?.id || !mod) return;
  try {
    setBusy(true, t('busy.downloadingServerMod', { name: mod.name }));
    renderServers();
    await waitForPendingSaves();
    await saveSettings(false);
    modDownloadPollGeneration++;
    const result = await api.downloadServerMod(details.server.id, mod.modId);
    if (result.alreadyReady) {
      showToast(t('servers.modReady', { name: mod.name }));
      return;
    }
    modDownloadPollGeneration++;
    state.modDownloadStatus = {
      state: 'queued',
      completed: 0,
      total: result.queuedCount || 1,
      failed: 0,
      progress: 0
    };
    recordModActions([{
      action: 'install',
      source: 'server',
      mod,
      details: details.server.name
    }]);
    showToast(t('servers.modDownloadStarted', {
      name: mod.name,
      count: result.queuedCount || 1
    }));
    scheduleModDownloadPoll(800);
  } catch (error) {
    recordModActions([{ action: 'error', source: 'server', mod, details: errorMessage(error) }]);
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
    scheduleModDownloadPoll(800);
    renderServers();
  }
}

async function copyServerModsJson() {
  const mods = state.serverDetails?.mods || [];
  if (mods.length === 0) return;
  try {
    const result = await api.copyServerMods(mods);
    showToast(t('servers.jsonCopied', { count: result.count || mods.length }));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

function updateServerJoinDetails(result, expectedIdentity) {
  if (!result?.server && !Array.isArray(result?.mods)) return true;
  const resultIdentity = result?.server ? serverJoinIdentity(result) : expectedIdentity;
  if (expectedIdentity.startsWith('id:') && resultIdentity !== expectedIdentity) return false;
  pendingServerJoin = mergePendingServerDetails({
    ...(result.server ? { server: result.server } : {}),
    ...(Array.isArray(result.mods) ? { mods: result.mods } : {})
  });
  const serverId = pendingServerJoin?.server?.id;
  if (serverId) {
    state.serverItems = state.serverItems.map((server) => (
      server.id === serverId ? { ...server, ...pendingServerJoin.server } : server
    ));
    if (state.serverDetails?.server?.id === serverId) {
      state.serverDetails = {
        ...state.serverDetails,
        server: { ...state.serverDetails.server, ...pendingServerJoin.server },
        mods: Array.isArray(result.mods) ? result.mods : state.serverDetails.mods
      };
      state.serverDetailsLastLoadedAt = Date.now();
    }
  }
  return true;
}

function cancelActiveServerConnection() {
  serverJoinConnectGeneration += 1;
  if (!activeServerJoinRequest || cancelledServerJoinRequest === activeServerJoinRequest
    || typeof api.cancelServerConnect !== 'function') return;
  cancelledServerJoinRequest = activeServerJoinRequest;
  try {
    Promise.resolve(api.cancelServerConnect()).catch(() => {});
  } catch {
    // Closing the dialog must stay reliable even if the main process is exiting.
  }
}

async function connectPendingServer(options = {}) {
  const dialog = $('#serverJoinDialog');
  if (!pendingServerJoin || serverJoinWaiting || activeServerJoinRequest || state.busy || !dialog.open) return;
  const details = pendingServerJoin;
  const expectedIdentity = serverJoinIdentity(details);
  const savePreset = details.mods?.length > 0 && $('#serverSavePreset').checked;
  const presetName = savePreset ? $('#serverPresetName').value.trim() : '';
  const request = ++serverJoinConnectGeneration;
  activeServerJoinRequest = request;
  cancelledServerJoinRequest = 0;
  serverJoinBlockReason = '';
  setBusy(true, t('busy.connectingServer'));
  renderServers();
  openServerJoinDialog(pendingServerJoin);
  try {
    await waitForPendingSaves();
    if (request !== serverJoinConnectGeneration || !dialog.open) return;
    await saveSettings(false);
    if (request !== serverJoinConnectGeneration || !dialog.open) return;
    const result = await api.connectServer({
      serverId: details.server.id || '',
      address: details.server.address,
      name: details.server.name,
      mods: details.mods || [],
      savePreset,
      presetName,
      allowUnverified: options.allowUnverified === true
    });
    if (request !== serverJoinConnectGeneration || activeServerJoinRequest !== request || !dialog.open) return;
    if (result?.reason === 'cancelled') return;
    if (!updateServerJoinDetails(result, expectedIdentity)) {
      throw new Error(t('servers.join.unavailable'));
    }
    if (result.launched === false && result.reason === 'server-full') {
      waitForServerSlot(result.server, result.retryAfterMs);
      return;
    }
    if (result.launched === false) {
      serverJoinBlockReason = result.availability || 'unknown';
      showToast(t(serverJoinBlockMessageKey()), 'warning');
      return;
    }
    if (result.presets && result.preset) {
      state.presets = result.presets;
      selectPreset(result.preset);
      recordModActions((result.mods || []).map((mod) => ({
        action: result.presetCreated ? 'preset-add' : 'preset-update',
        source: 'server',
        mod,
        presetId: result.preset.id,
        presetName: result.preset.name,
        details: result.server.name
      })));
    }
    serverJoinBlockReason = '';
    activeServerJoinRequest = 0;
    cancelledServerJoinRequest = 0;
    setBusy(false);
    renderServers();
    dialog.close('connected');
    const launchMessage = t(result.connectionMode === 'native-menu' ? 'servers.launchingNative' : 'servers.connected', {
      name: result.server.name || result.server.address,
      count: result.selectedCount
    });
    showToast(result.presetSaveFailed ? `${launchMessage} ${t('servers.presetSaveFailed')}` : launchMessage, 'warning');
  } catch (error) {
    if (request === serverJoinConnectGeneration && dialog.open) {
      showToast(errorMessage(error), 'error');
    }
  } finally {
    if (activeServerJoinRequest === request) {
      activeServerJoinRequest = 0;
      cancelledServerJoinRequest = 0;
      setBusy(false);
      renderServers();
      if (dialog.open && pendingServerJoin) openServerJoinDialog(pendingServerJoin);
    }
  }
}

function serverConnectionFailureMessageKey(reason) {
  const messages = {
    'handshake-timeout': 'servers.failure.handshakeTimeout',
    'connection-failed': 'servers.failure.connectionFailed',
    'initialization-failed': 'servers.failure.initializationFailed',
    'native-join-unavailable': 'servers.failure.nativeUnavailable',
    'native-join-timeout': 'servers.failure.nativeTimeout'
  };
  return messages[reason] || 'servers.failure.unknown';
}

function renderServerConnectionFailure() {
  if (!pendingServerConnectionFailure) return;
  const failure = pendingServerConnectionFailure;
  const dialog = $('#serverConnectionFailureDialog');
  $('#serverConnectionFailureEyebrow').textContent = t('servers.failure.eyebrow');
  $('#serverConnectionFailureTitle').textContent = t('servers.failure.title');
  $('#serverConnectionFailureServer').textContent = failure.server?.name
    || failure.server?.address
    || '';
  $('#serverConnectionFailureMessage').textContent = t(serverConnectionFailureMessageKey(failure.reason), {
    address: failure.server?.address || ''
  });
  $('#serverConnectionFailureLogLabel').textContent = t('servers.failure.log');
  $('#serverConnectionFailureLogPath').textContent = failure.logPath;
  $('#serverConnectionFailureLog').hidden = !failure.logPath;
  $('#serverConnectionFailureOk span').textContent = t('servers.failure.ok');
  if (!$('#mandatoryUpdateDialog').open && !dialog.open) dialog.showModal();
}

function handleServerConnectionFailure(payload = {}) {
  pendingServerConnectionFailure = {
    server: payload.server && typeof payload.server === 'object' ? payload.server : null,
    reason: String(payload.reason || ''),
    logPath: String(payload.logPath || '').trim().slice(0, 1000)
  };
  renderServerConnectionFailure();
}

function closeServerConnectionFailure() {
  pendingServerConnectionFailure = null;
  const dialog = $('#serverConnectionFailureDialog');
  if (dialog.open) dialog.close('acknowledged');
}

function normalizeWorkshopRequirement(mod) {
  const modId = String(mod?.modId || '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(modId)) {
    showToast(errorMessage('Некорректный GUID мода.'), 'error');
    return null;
  }
  return {
    modId,
    name: mod.name || modId,
    version: mod.version || '',
    required: true
  };
}

function configuredWorkshopPreset() {
  return state.presets.find((preset) => preset.id === state.settings.defaultPresetId) || null;
}

function suggestedWorkshopPresetId() {
  if (state.activePreset && state.presets.some((preset) => preset.id === state.activePreset.id)) {
    return state.activePreset.id;
  }
  return state.presets[0]?.id || '';
}

function openAddToPresetDialog(mod) {
  const requirement = normalizeWorkshopRequirement(mod);
  if (!requirement) return;
  pendingWorkshopMod = requirement;
  const hasPresets = state.presets.length > 0;
  const select = $('#addToPresetSelect');
  select.innerHTML = state.presets.map((preset) => (
    `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`
  )).join('');
  select.disabled = !hasPresets;
  if (hasPresets) select.value = suggestedWorkshopPresetId();
  $('#addToPresetExistingField').hidden = !hasPresets;
  $('#addToPresetNewField').hidden = hasPresets;
  $('#rememberPresetRow').hidden = !hasPresets;
  $('#rememberPreset').checked = false;
  $('#addToPresetName').required = !hasPresets;
  $('#addToPresetName').value = hasPresets ? '' : t('workshop.newPresetDefaultName');
  $('#addToPresetModName').textContent = requirement.name;
  $('#addToPresetModId').textContent = requirement.modId;
  $('#addToPresetDialog').showModal();
  setTimeout(() => (hasPresets ? select : $('#addToPresetName')).focus(), 0);
}

async function persistWorkshopModToPreset({ mod, presetId = '', presetName = '', setDefault = false, closeDialog = false }) {
  try {
    setBusy(true, t('busy.addingToPreset'));
    await waitForPendingSaves();
    const result = await api.addModToPreset({ presetId, presetName, mod });
    state.presets = result.presets;
    if (result.created || state.activePreset?.id === result.preset.id) {
      selectPreset(result.preset);
    } else {
      renderAll();
    }
    if (result.created || setDefault) {
      state.settings = await api.saveSettings({ defaultPresetId: result.preset.id });
      renderSettings();
    }
    if (closeDialog) $('#addToPresetDialog').close();
    showToast(t(result.alreadyPresent ? 'workshop.updatedInPreset' : 'workshop.addedToPreset', {
      preset: result.preset.name
    }));
    recordModActions([{
      action: result.alreadyPresent ? 'preset-update' : 'preset-add',
      source: 'workshop',
      mod,
      presetId: result.preset.id,
      presetName: result.preset.name
    }]);
    return result;
  } catch (error) {
    recordModActions([{
      action: 'error',
      source: 'workshop',
      mod,
      presetId,
      presetName: presetName || state.presets.find((preset) => preset.id === presetId)?.name || '',
      details: errorMessage(error)
    }]);
    showToast(errorMessage(error), 'error');
    return null;
  } finally {
    setBusy(false);
  }
}

async function addWorkshopModToPreset() {
  if (!pendingWorkshopMod) return;
  const hasPresets = state.presets.length > 0;
  const presetId = hasPresets ? $('#addToPresetSelect').value : '';
  const presetName = hasPresets ? '' : $('#addToPresetName').value.trim();
  if (!hasPresets && !presetName) {
    $('#addToPresetName').focus();
    return;
  }
  await persistWorkshopModToPreset({
    mod: pendingWorkshopMod,
    presetId,
    presetName,
    setDefault: hasPresets && $('#rememberPreset').checked,
    closeDialog: true
  });
}

async function handleWorkshopAdd(mod) {
  const requirement = normalizeWorkshopRequirement(mod);
  if (!requirement) return;
  const defaultPreset = configuredWorkshopPreset();
  if (defaultPreset) {
    await persistWorkshopModToPreset({ mod: requirement, presetId: defaultPreset.id });
    return;
  }
  openAddToPresetDialog(requirement);
}

async function installWorkshopMod(mod) {
  const availability = modAcquisitionState(mod?.modId);
  if (availability.blocked || availability.installed) return;
  try {
    setBusy(true, t('busy.openingDownloads'));
    await waitForPendingSaves();
    await saveSettings(false);
    modDownloadPollGeneration++;
    const result = await api.installWorkshopMod(mod);
    if (result.alreadyInstalled) {
      state.installedMods = await api.scanMods();
      showToast(t('workshop.alreadyInstalled'));
      return;
    }
    modDownloadPollGeneration++;
    state.modDownloadStatus = {
      state: 'queued',
      completed: 0,
      total: result.queuedCount || 1,
      failed: 0,
      progress: 0
    };
    recordModActions([{
      action: 'install',
      source: 'workshop',
      mod,
      details: t('workshop.installStarted', { count: result.queuedCount || 1 })
    }]);
    showToast(t('workshop.installStarted', { count: result.queuedCount || 1 }));
    scheduleModDownloadPoll(800);
  } catch (error) {
    recordModActions([{ action: 'error', source: 'workshop', mod, details: errorMessage(error) }]);
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
    scheduleModDownloadPoll(800);
    renderWorkshop();
    if ($('#modDetailsDialog').open) renderModDetails();
  }
}

function detailFact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '—')}</strong></div>`;
}

function localDetailsFor(modId) {
  const local = installedById().get(modId);
  const requirement = state.requirements.get(modId);
  return {
    modId,
    name: local?.name || requirement?.name || modId,
    version: local?.version || '',
    status: statusForListMod(local || {
      modId,
      name: requirement?.name || modId,
      version: '',
      dependencies: [],
      missing: true
    })
  };
}

function dependencyStateMarkup(dependency) {
  const modId = String(dependency.modId || '').toUpperCase();
  const { installed, status } = assessMod({ ...dependency, modId });
  const labels = {
    ready: 'mods.dependencyInstalled',
    missing: 'mods.dependencyMissing',
    corrupted: 'mods.dependencyCorrupted',
    'version-mismatch': 'mods.dependencyMismatch',
    'version-unknown': 'mods.dependencyUnknown'
  };
  const tone = status === 'version-mismatch' || status === 'version-unknown' ? 'mismatch' : status;
  const hint = installed ? t('mods.dependencyVersions', {
    installed: installed.version || '—', required: dependency.version || t('common.latest')
  }) : t('mods.dependencyMissing');
  return `<span class="dependency-state ${tone}" data-dependency-status="${status}" title="${escapeHtml(hint)}">${escapeHtml(t(labels[status]))}</span>`;
}

function renderDependencyCards(dependencies) {
  return dependencies.map((dependency) => `
    <button class="mod-details-dependency" type="button" data-detail-mod-id="${escapeHtml(dependency.modId)}">
      <span><strong>${escapeHtml(dependency.name)}</strong><small>${escapeHtml(dependency.modId)}</small></span>
      <span class="mod-details-dependency-meta"><b>${escapeHtml(dependency.version || t('common.latest'))}</b>${dependencyStateMarkup(dependency)}</span>
    </button>`).join('');
}

function modDetailImages() {
  const details = state.modDetails?.data;
  if (!details) return [];
  return [...new Set([...(details.previewUrls || []), ...(details.screenshotUrls || [])])];
}

function setModDetailsImage(url) {
  if (!state.modDetails || !modDetailImages().includes(url)) return;
  state.modDetails.selectedImage = url;
  const hero = $('#modDetailsHero');
  const heroButton = $('#modDetailsHeroButton');
  if (hero) hero.src = url;
  if (heroButton) heroButton.dataset.openImage = url;
  $$('.mod-details-thumbnail').forEach((item) => {
    item.classList.toggle('active', item.dataset.imageUrl === url);
  });
}

function changeModDetailsImage(direction) {
  const images = modDetailImages();
  if (images.length < 2) return;
  const currentIndex = Math.max(0, images.indexOf(state.modDetails?.selectedImage));
  const nextIndex = (currentIndex + direction + images.length) % images.length;
  setModDetailsImage(images[nextIndex]);
}

function clampImageViewerOffset() {
  const stage = $('#imageViewerStage');
  const image = $('#imageViewerImage');
  if (!stage || !image || imageViewer.scale <= imageViewerMinScale) {
    imageViewer.offsetX = 0;
    imageViewer.offsetY = 0;
    return;
  }

  const stageRect = stage.getBoundingClientRect();
  const baseWidth = image.offsetWidth || stageRect.width;
  const baseHeight = image.offsetHeight || stageRect.height;
  const maxX = Math.max(0, ((baseWidth * imageViewer.scale) - stageRect.width) / 2);
  const maxY = Math.max(0, ((baseHeight * imageViewer.scale) - stageRect.height) / 2);
  imageViewer.offsetX = Math.max(-maxX, Math.min(maxX, imageViewer.offsetX));
  imageViewer.offsetY = Math.max(-maxY, Math.min(maxY, imageViewer.offsetY));
}

function renderImageViewerTransform() {
  clampImageViewerOffset();
  const image = $('#imageViewerImage');
  const stage = $('#imageViewerStage');
  if (!image || !stage) return;
  image.style.transform = `translate3d(${imageViewer.offsetX}px, ${imageViewer.offsetY}px, 0) scale(${imageViewer.scale})`;
  stage.classList.toggle('zoomed', imageViewer.scale > imageViewerMinScale);
  stage.classList.toggle('dragging', imageViewer.dragging);
  $('#imageViewerScale').textContent = `${Math.round(imageViewer.scale * 100)}%`;
  $('#imageViewerZoomOut').disabled = imageViewer.scale <= imageViewerMinScale;
  $('#imageViewerZoomIn').disabled = imageViewer.scale >= imageViewerMaxScale;
  $('#imageViewerReset').disabled = imageViewer.scale === imageViewerMinScale
    && imageViewer.offsetX === 0
    && imageViewer.offsetY === 0;
}

function renderImageViewer() {
  const count = imageViewer.images.length;
  const url = imageViewer.images[imageViewer.index] || '';
  const image = $('#imageViewerImage');
  image.src = url;
  image.alt = state.modDetails?.data?.name || state.modDetails?.modId || '';
  image.hidden = !url;
  $('#imageViewerCounter').textContent = count ? `${imageViewer.index + 1} / ${count}` : '';
  $('#imageViewerPrevious').hidden = count < 2;
  $('#imageViewerNext').hidden = count < 2;

  const labels = {
    closeImageViewer: t('viewer.close'),
    imageViewerPrevious: t('viewer.previous'),
    imageViewerNext: t('viewer.next'),
    imageViewerZoomOut: t('viewer.zoomOut'),
    imageViewerZoomIn: t('viewer.zoomIn'),
    imageViewerReset: t('viewer.reset')
  };
  Object.entries(labels).forEach(([id, label]) => {
    const button = $(`#${id}`);
    button.title = label;
    button.setAttribute('aria-label', label);
  });
  renderImageViewerTransform();
}

function resetImageViewerTransform() {
  imageViewer.scale = imageViewerMinScale;
  imageViewer.offsetX = 0;
  imageViewer.offsetY = 0;
  imageViewer.dragging = false;
  imageViewer.pointerId = null;
  renderImageViewerTransform();
}

function isImageViewerOpen() {
  return !$('#imageViewerDialog').hidden;
}

function openImageViewer(url) {
  const images = modDetailImages();
  const index = images.indexOf(url);
  if (index < 0) return;
  imageViewer.images = images;
  imageViewer.index = index;
  imageViewer.scale = imageViewerMinScale;
  imageViewer.offsetX = 0;
  imageViewer.offsetY = 0;
  $('#modDetailsDialog').classList.add('image-viewer-active');
  $('#imageViewerDialog').hidden = false;
  renderImageViewer();
}

function closeImageViewer() {
  if (!isImageViewerOpen()) return;
  $('#imageViewerDialog').hidden = true;
  $('#modDetailsDialog').classList.remove('image-viewer-active');
  imageViewer.images = [];
  resetImageViewerTransform();
}

function changeImageViewerImage(direction) {
  if (imageViewer.images.length < 2) return;
  imageViewer.index = (imageViewer.index + direction + imageViewer.images.length) % imageViewer.images.length;
  setModDetailsImage(imageViewer.images[imageViewer.index]);
  imageViewer.scale = imageViewerMinScale;
  imageViewer.offsetX = 0;
  imageViewer.offsetY = 0;
  renderImageViewer();
}

function setImageViewerScale(nextScale, anchor = null) {
  const previousScale = imageViewer.scale;
  const normalizedScale = Math.max(imageViewerMinScale, Math.min(imageViewerMaxScale, nextScale));
  if (normalizedScale === previousScale) return;

  if (anchor && normalizedScale > imageViewerMinScale) {
    const rect = $('#imageViewerStage').getBoundingClientRect();
    const anchorX = anchor.clientX - rect.left - (rect.width / 2);
    const anchorY = anchor.clientY - rect.top - (rect.height / 2);
    const ratio = normalizedScale / previousScale;
    imageViewer.offsetX = anchorX - ((anchorX - imageViewer.offsetX) * ratio);
    imageViewer.offsetY = anchorY - ((anchorY - imageViewer.offsetY) * ratio);
  } else if (normalizedScale === imageViewerMinScale) {
    imageViewer.offsetX = 0;
    imageViewer.offsetY = 0;
  }

  imageViewer.scale = normalizedScale;
  renderImageViewerTransform();
}

function renderModDetails() {
  const detailsState = state.modDetails;
  if (!detailsState) return;

  const local = localDetailsFor(detailsState.modId);
  const details = detailsState.data;
  $('#modDetailsSource').textContent = t('mods.detailsSource');
  $('#modDetailsTitle').textContent = details?.name || local.name;
  $('#downloadModDetails').dataset.modDownload = detailsState.modId;
  $('#updateModDetails').dataset.modUpdate = detailsState.modId;
  renderModAcquisitionControls();
  $('#openModDetailsWorkshop span').textContent = t('mods.openDetailsWorkshop');
  $('#copyModDetailsJson span').textContent = t('mods.copyJson');
  $('#copyModDetailsJson').title = t('mods.copyJsonTitle');
  $('#copyModDetailsJson').disabled = !details;
  $('#closeModDetails span').textContent = t('common.close');
  $('#closeModDetailsTop').title = t('common.close');

  if (detailsState.loading) {
    $('#modDetailsBody').innerHTML = `
      <div class="mod-details-loading">
        <span class="details-loader" aria-hidden="true"></span>
        <strong>${escapeHtml(t('mods.detailsLoading'))}</strong>
        <small>${detailsState.modId}</small>
      </div>`;
    return;
  }

  if (!details) {
    const localDependencies = installedById().get(detailsState.modId)?.dependencies || [];
    $('#modDetailsBody').innerHTML = `
      <div class="mod-details-message">
        <strong>${escapeHtml(t('mods.detailsUnavailable'))}</strong>
        <span>${escapeHtml(detailsState.error || '')}</span>
      </div>
      <div class="mod-details-facts local-only-facts">
        ${detailFact('GUID', local.modId)}
        ${detailFact(t('mods.installedVersion'), local.version || t('mods.notInstalledValue'))}
        ${detailFact(t('common.ready'), statusLabel(local.status))}
      </div>
      ${localDependencies.length ? `<section class="mod-details-section"><h3>${escapeHtml(t('mods.dependenciesTitle'))}</h3><div class="mod-details-dependencies">${renderDependencyCards(localDependencies)}</div></section>` : ''}`;
    return;
  }

  const images = modDetailImages();
  const hero = images.includes(detailsState.selectedImage) ? detailsState.selectedImage : (images[0] || '');
  detailsState.selectedImage = hero;
  const summary = details.summary || t('mods.noDescription');
  const originalDescription = details.description || t('mods.noDescription');
  const translatedDescription = detailsState.translatedDescription || '';
  const descriptionMode = detailsState.descriptionMode === 'ru' ? 'ru' : 'original';
  const description = descriptionMode === 'ru' && translatedDescription
    ? translatedDescription
    : originalDescription;
  const translationLoading = detailsState.translationLoading === true;
  const rating = `${details.ratingPercent}% (${formatCount(details.ratingCount)})`;
  const dependencies = details.dependencies?.length
    ? renderDependencyCards(details.dependencies)
    : `<p class="mod-details-muted">${escapeHtml(t('mods.noDependencies'))}</p>`;
  const localDependents = localDependentMods(details.modId);
  const dependents = localDependents.length
    ? localDependents.map((dependent) => `
      <button class="mod-details-dependency mod-details-dependent" type="button" data-detail-mod-id="${dependent.modId}">
        <span><strong>${escapeHtml(dependent.name)}</strong><small>${dependent.modId}</small></span>
        <span class="mod-details-dependency-meta"><b>${escapeHtml(dependent.version || t('common.latest'))}</b>${dependencyStateMarkup(dependent)}</span>
      </button>`).join('')
    : `<p class="mod-details-muted">${escapeHtml(t('mods.noDependents'))}</p>`;
  const versions = details.versions?.length
    ? details.versions.map((version) => `
      <div class="mod-version-row">
        <strong>${escapeHtml(version.version || '—')}</strong>
        <span>${escapeHtml(version.gameVersion || '—')}</span>
        <span>${escapeHtml(formatBytes(version.sizeBytes))}</span>
        <span>${escapeHtml(formatDate(version.createdAt))}</span>
      </div>`).join('')
    : '';
  const scenarios = Array.isArray(details.scenarios) && details.scenarios.length
    ? renderScenarioRows(details.scenarios)
    : '';

  $('#modDetailsBody').innerHTML = `
    <div class="mod-details-intro">
      <div class="mod-details-gallery">
        ${hero ? `<div class="mod-details-hero-wrap"><button type="button" id="modDetailsHeroButton" class="mod-details-hero mod-details-hero-button" data-open-image="${escapeHtml(hero)}" title="${escapeHtml(t('viewer.open'))}" aria-label="${escapeHtml(t('viewer.open'))}">
          <img id="modDetailsHero" src="${escapeHtml(hero)}" alt="${escapeHtml(details.name)}" referrerpolicy="no-referrer">
        </button>
          <button class="mod-details-gallery-arrow previous" type="button" data-detail-gallery-direction="-1" ${images.length < 2 ? 'hidden' : ''} title="${escapeHtml(t('viewer.previous'))}" aria-label="${escapeHtml(t('viewer.previous'))}"><img src="assets/icons/chevron-left.svg" alt=""></button>
          <button class="mod-details-gallery-arrow next" type="button" data-detail-gallery-direction="1" ${images.length < 2 ? 'hidden' : ''} title="${escapeHtml(t('viewer.next'))}" aria-label="${escapeHtml(t('viewer.next'))}"><img src="assets/icons/chevron-right.svg" alt=""></button>
        </div>` : `<div class="mod-details-hero">
          ${hero
            ? ''
            : `<div class="mod-details-no-image">${escapeHtml(details.name.slice(0, 1).toUpperCase())}</div>`}
        </div>`}
        ${images.length > 1 ? `<div class="mod-details-thumbnails">${images.map((url, index) => `
          <button type="button" class="mod-details-thumbnail ${url === hero ? 'active' : ''}" data-image-url="${escapeHtml(url)}" aria-label="${index + 1}">
            <img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">
          </button>`).join('')}</div>` : ''}
      </div>
      <div class="mod-details-overview">
        <div class="mod-details-identity">
          <p>${escapeHtml(summary)}</p>
          <span class="status-badge ${local.status}">${escapeHtml(statusLabel(local.status))}</span>
        </div>
        <div class="mod-details-facts">
          ${detailFact(t('mods.author'), details.author)}
          ${detailFact('GUID', details.modId)}
          ${detailFact(t('mods.installedVersion'), local.version || t('mods.notInstalledValue'))}
          ${detailFact(t('mods.workshopVersion'), details.version)}
          ${detailFact(t('mods.gameVersion'), details.gameVersion)}
          ${detailFact(t('mods.size'), formatBytes(details.sizeBytes))}
          ${detailFact(t('mods.downloads'), formatCount(details.downloads))}
          ${detailFact(t('mods.rating'), rating)}
          ${detailFact(t('mods.updated'), formatDate(details.updatedAt))}
          ${detailFact(t('mods.created'), formatDate(details.createdAt))}
        </div>
      </div>
    </div>
    <section class="mod-details-section">
      <div class="mod-details-section-heading">
        <h3>${escapeHtml(t('mods.descriptionTitle'))}</h3>
        <div class="description-language-toggle" role="group" aria-label="${escapeHtml(t('mods.descriptionTitle'))}">
          <button type="button" data-description-mode="ru" class="${descriptionMode === 'ru' ? 'active' : ''}" ${translationLoading || !details.description ? 'disabled' : ''} aria-pressed="${descriptionMode === 'ru'}">${escapeHtml(translationLoading ? t('mods.descriptionTranslating') : t('mods.descriptionRussian'))}</button>
          <button type="button" data-description-mode="original" class="${descriptionMode === 'original' ? 'active' : ''}" aria-pressed="${descriptionMode === 'original'}">${escapeHtml(t('mods.descriptionOriginal'))}</button>
        </div>
      </div>
      <div class="mod-details-copy">${escapeHtml(description)}</div>
    </section>
    ${details.changelog ? `<section class="mod-details-section"><h3>${escapeHtml(t('mods.changelogTitle'))}</h3><div class="mod-details-copy">${escapeHtml(details.changelog)}</div></section>` : ''}
    ${scenarios ? `<section class="mod-details-section"><h3>${escapeHtml(t('workshop.scenariosTitle'))}</h3><div class="workshop-scenario-list mod-details-scenarios">${scenarios}</div></section>` : ''}
    <section class="mod-details-section">
      <h3>${escapeHtml(t('mods.dependenciesTitle'))}</h3>
      <div class="mod-details-dependencies">${dependencies}</div>
    </section>
    <section class="mod-details-section">
      <h3>${escapeHtml(t('mods.dependentsTitle'))}</h3>
      <div class="mod-details-dependencies">${dependents}</div>
    </section>
    ${details.tags?.length ? `<section class="mod-details-section"><h3>${escapeHtml(t('mods.tagsTitle'))}</h3><div class="mod-details-tags">${details.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div></section>` : ''}
    ${versions ? `<section class="mod-details-section"><h3>${escapeHtml(t('mods.versionsTitle'))}</h3><div class="mod-version-list">${versions}</div></section>` : ''}`;
}

async function openModDetails(modId) {
  const normalizedId = String(modId || '').toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(normalizedId)) return;
  const requestId = ++modDetailsRequest;
  state.modDetails = {
    modId: normalizedId,
    loading: true,
    data: null,
    error: '',
    descriptionMode: 'original',
    translatedDescription: '',
    translationLoading: false
  };
  const dialog = $('#modDetailsDialog');
  if (!dialog.open) dialog.showModal();
  renderModDetails();

  try {
    const data = await api.getModDetails(normalizedId);
    if (requestId !== modDetailsRequest) return;
    state.modDetails = {
      modId: normalizedId,
      loading: false,
      data,
      error: '',
      descriptionMode: 'original',
      translatedDescription: '',
      translationLoading: false
    };
  } catch (error) {
    if (requestId !== modDetailsRequest) return;
    state.modDetails = {
      modId: normalizedId,
      loading: false,
      data: null,
      error: errorMessage(error),
      descriptionMode: 'original',
      translatedDescription: '',
      translationLoading: false
    };
  }
  renderModDetails();
}

async function copyCurrentModJson() {
  const details = state.modDetails?.data;
  if (!details) return;
  try {
    await api.copyModJson({
      modId: details.modId,
      name: details.name,
      version: details.version
    });
    showToast(t('mods.jsonCopied'));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

async function translateCurrentModDescription() {
  const detailsState = state.modDetails;
  if (!detailsState?.data?.description || detailsState.translationLoading) return;
  detailsState.descriptionMode = 'ru';
  if (detailsState.translatedDescription) {
    renderModDetails();
    return;
  }
  detailsState.translationLoading = true;
  renderModDetails();
  try {
    const result = await api.translateModDescription(detailsState.modId);
    if (state.modDetails !== detailsState) return;
    detailsState.translatedDescription = String(result?.text || '');
    if (!detailsState.translatedDescription) detailsState.descriptionMode = 'original';
  } catch (error) {
    if (state.modDetails !== detailsState) return;
    detailsState.descriptionMode = 'original';
    showToast(errorMessage(error), 'error');
  } finally {
    if (state.modDetails === detailsState) {
      detailsState.translationLoading = false;
      renderModDetails();
    }
  }
}

function closeModDetails() {
  modDetailsRequest += 1;
  closeImageViewer();
  $('#modDetailsDialog').close();
}

function renderPresets() {
  $('#presetList').innerHTML = state.presets.length
    ? state.presets.map((preset) => `
      <button class="preset-item ${state.activePreset?.id === preset.id ? 'active' : ''}" data-preset-id="${escapeHtml(preset.id)}">
        <span><strong>${escapeHtml(preset.name)}</strong><small>${new Date(preset.updatedAt).toLocaleString(locale())}</small></span>
        <b>${preset.mods.length}</b>
      </button>`).join('')
    : `<div class="empty-state">${t('presets.noneSaved')}</div>`;

  const preset = state.activePreset || (state.selectedIds.size ? snapshotPreset() : null);
  $('#presetDetailsName').textContent = preset ? currentPresetName() : t('presets.none');
  $('#editPreset').disabled = !state.activePreset;
  $('#exportPreset').disabled = !preset;
  $('#sharePreset').disabled = !preset;
  $('#shareFilePreset').disabled = !preset;
  $('#deletePreset').disabled = !state.activePreset;
  const transferButton = $('#transferPresetMods');
  transferButton.hidden = state.settings.advancedMode !== true;
  transferButton.disabled = state.busy || !state.activePreset;
  transferButton.querySelector('span').textContent = t('presets.transferMods');
  if (!preset) {
    $('#presetFacts').innerHTML = '';
    $('#presetModList').innerHTML = `<div class="empty-state">${t('presets.importHint')}</div>`;
    return;
  }

  const summary = counts();
  $('#presetFacts').innerHTML = `
    <div class="preset-fact"><span>${t('presets.factMods')}</span><strong>${summary.selected}</strong></div>
    <div class="preset-fact"><span>${t('presets.factReady')}</span><strong>${summary.ready}</strong></div>
    <div class="preset-fact"><span>${t('presets.factProblems')}</span><strong>${summary.missing + summary.mismatch}</strong></div>`;
  const installed = installedById();
  $('#presetModList').innerHTML = assessment().map((row) => {
    const canDelete = Boolean(installed.get(row.requirement.modId)?.directoryPath);
    return `
      <div class="compact-mod-row" data-mod-id="${escapeHtml(row.requirement.modId)}">
        <div><strong>${escapeHtml(row.requirement.name)}</strong><small>${row.requirement.modId}</small></div>
        <span>${escapeHtml(row.requirement.version || t('common.latest'))}</span>
        <span class="status-badge ${row.status}">${statusLabel(row.status)}</span>
        <button class="button quiet danger-text preset-delete-mod" type="button" data-delete-installed-mod="${escapeHtml(row.requirement.modId)}" ${canDelete ? '' : 'disabled'} title="${escapeHtml(canDelete ? t('mods.delete') : t('toast.modNotInstalled'))}"><img src="assets/icons/trash-2.svg" alt=""><span>${escapeHtml(t('mods.delete'))}</span></button>
      </div>`;
  }).join('');
}

function modLogCategory(action) {
  if (['preset-add', 'preset-update', 'import'].includes(action)) return 'added';
  if (['enable', 'auto-enable'].includes(action)) return 'enabled';
  if (['disable', 'auto-disable'].includes(action)) return 'disabled';
  if (action === 'install') return 'installed';
  if (['delete', 'preset-remove'].includes(action)) return 'deleted';
  return 'errors';
}

function renderModLogSetting() {
  $('#modLogsSettingHeading').textContent = t('settings.modLogsHeading');
  $('#modLogsSettingSubtitle').textContent = t('settings.modLogsSubtitle');
  $('#modLogsSettingTitle').textContent = t('settings.modLogsTitle');
  $('#modLogsSettingHelp').textContent = t('settings.modLogsHelp');
  $('#modLogsFooterSettingTitle').textContent = t('settings.modLogsFooterTitle');
  $('#modLogsFooterSettingHelp').textContent = t('settings.modLogsFooterHelp');
  $('#settingShowModLogsFooter').checked = state.settings.showModLogsFooter !== false;
  $('#openModLogs span').textContent = t('settings.openModLogs');
  $('#modLogCount').textContent = formatCount(state.modLogCount);
  const footerButton = $('#footerModLogs');
  footerButton.hidden = state.settings.showModLogsFooter === false;
  footerButton.title = t('footer.openModLogs');
  $('#footerModLogsLabel').textContent = t('footer.modLogs');
  $('#footerModLogsCount').textContent = formatCount(state.modLogCount);
}

function formatModLogTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(locale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function renderModLogs() {
  $('#modLogsEyebrow').textContent = t('modLogs.eyebrow');
  $('#modLogsTitle').textContent = t('modLogs.title');
  $('#modLogsDragHandle').title = t('modLogs.movePanel');
  $('#modLogsResizeHandle').title = t('modLogs.resizePanel');
  $('#modLogsResizeHandle').setAttribute('aria-label', t('modLogs.resizePanel'));
  $('#closeModLogsTop').title = t('common.close');
  $('#modLogsSearch').placeholder = t('modLogs.search');
  $('#modLogsSearch').value = state.modLogSearch;
  $('#modLogHeadTime').textContent = t('modLogs.head.time');
  $('#modLogHeadAction').textContent = t('modLogs.head.action');
  $('#modLogHeadMod').textContent = t('modLogs.head.mod');
  $('#modLogHeadPreset').textContent = t('modLogs.head.preset');
  $('#modLogHeadDetails').textContent = t('modLogs.head.details');
  $('#modLogHeadManage').textContent = t('modLogs.head.manage');
  $('#clearModLogs span').textContent = t('modLogs.delete');
  $('#closeModLogs span').textContent = t('common.close');

  const filterOptions = ['all', 'added', 'enabled', 'disabled', 'installed', 'deleted', 'errors'];
  $('#modLogsFilter').innerHTML = filterOptions.map((filter) => (
    `<option value="${filter}">${escapeHtml(t(`modLogs.filter.${filter}`))}</option>`
  )).join('');
  $('#modLogsFilter').value = state.modLogFilter;

  const search = state.modLogSearch.toLocaleLowerCase(locale());
  const visible = state.modLogs.filter((entry) => {
    if (state.modLogFilter !== 'all' && modLogCategory(entry.action) !== state.modLogFilter) return false;
    if (!search) return true;
    return [entry.name, entry.modId, entry.version, entry.presetName, entry.details]
      .some((value) => String(value || '').toLocaleLowerCase(locale()).includes(search));
  });

  if (state.modLogsLoading) {
    $('#modLogsList').innerHTML = `<div class="mod-logs-empty">${escapeHtml(t('modLogs.loading'))}</div>`;
  } else if (visible.length === 0) {
    $('#modLogsList').innerHTML = `<div class="mod-logs-empty">${escapeHtml(t('modLogs.empty'))}</div>`;
  } else {
    $('#modLogsList').innerHTML = visible.map((entry) => {
      const category = modLogCategory(entry.action);
      const details = entry.details || t(`modLogs.source.${entry.source}`);
      const preset = state.presets.find((item) => item.id === entry.presetId);
      const canRemove = Boolean(preset?.mods?.some((mod) => mod.modId === entry.modId));
      const removeTitle = t(canRemove ? 'modLogs.removeFromPreset' : 'modLogs.removeUnavailable');
      return `
        <div class="mod-log-row" data-log-id="${escapeHtml(entry.id)}">
          <span class="mod-log-time">${escapeHtml(formatModLogTime(entry.timestamp))}</span>
          <span class="mod-log-action ${category}">${escapeHtml(t(`modLogs.action.${entry.action}`))}</span>
          <span class="mod-log-mod"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.modId)}${entry.version ? ` · ${escapeHtml(entry.version)}` : ''}</small></span>
          <span class="mod-log-preset">${escapeHtml(entry.presetName || '—')}</span>
          <span class="mod-log-details" title="${escapeHtml(details)}">${escapeHtml(details)}</span>
          <button class="icon-button bordered mod-log-remove" type="button" data-log-remove="${escapeHtml(entry.id)}" title="${escapeHtml(removeTitle)}" aria-label="${escapeHtml(removeTitle)}" ${canRemove ? '' : 'disabled'}><img src="assets/icons/minus.svg" alt=""></button>
        </div>`;
    }).join('');
  }

  $('#modLogsSummary').textContent = t('modLogs.summary', { shown: visible.length, total: state.modLogs.length });
  $('#clearModLogs').disabled = state.modLogsLoading || state.modLogs.length === 0;
}

async function openModLogs() {
  const dialog = $('#modLogsDialog');
  if (!dialog.open) dialog.show();
  requestAnimationFrame(constrainModLogsPanel);
  state.modLogsLoading = true;
  renderModLogs();
  try {
    state.modLogs = await api.listModLogs();
    state.modLogCount = state.modLogs.length;
    state.modLogsLoaded = true;
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    state.modLogsLoading = false;
    renderModLogSetting();
    renderModLogs();
  }
}

function constrainModLogsPanel() {
  const dialog = $('#modLogsDialog');
  if (!dialog.open) return;
  const rect = dialog.getBoundingClientRect();
  const maximumWidth = Math.max(240, window.innerWidth - 16);
  const maximumHeight = Math.max(220, window.innerHeight - 16);
  const minimumWidth = Math.min(520, maximumWidth);
  const minimumHeight = Math.min(300, maximumHeight);
  const width = Math.max(minimumWidth, Math.min(rect.width, maximumWidth));
  const height = Math.max(minimumHeight, Math.min(rect.height, maximumHeight));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8));
  dialog.style.left = `${left}px`;
  dialog.style.top = `${top}px`;
  dialog.style.right = 'auto';
  dialog.style.bottom = 'auto';
  dialog.style.maxWidth = 'none';
  dialog.style.maxHeight = 'none';
  dialog.style.width = `${width}px`;
  dialog.style.height = `${height}px`;
}

function startModLogsPanelPointerAction(event, mode) {
  if (event.button !== 0) return;
  if (mode === 'move' && event.target.closest('button')) return;
  const dialog = $('#modLogsDialog');
  const rect = dialog.getBoundingClientRect();
  const start = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
  dialog.style.left = `${rect.left}px`;
  dialog.style.top = `${rect.top}px`;
  dialog.style.right = 'auto';
  dialog.style.bottom = 'auto';
  dialog.style.maxWidth = 'none';
  dialog.style.maxHeight = 'none';
  dialog.style.width = `${rect.width}px`;
  dialog.style.height = `${rect.height}px`;
  event.preventDefault();

  const onPointerMove = (moveEvent) => {
    if (moveEvent.pointerId !== start.pointerId) return;
    const deltaX = moveEvent.clientX - start.x;
    const deltaY = moveEvent.clientY - start.y;
    if (mode === 'move') {
      const maximumLeft = Math.max(8, window.innerWidth - start.width - 8);
      const maximumTop = Math.max(8, window.innerHeight - start.height - 8);
      dialog.style.left = `${Math.max(8, Math.min(start.left + deltaX, maximumLeft))}px`;
      dialog.style.top = `${Math.max(8, Math.min(start.top + deltaY, maximumTop))}px`;
      return;
    }

    const maximumWidth = Math.max(240, window.innerWidth - start.left - 8);
    const maximumHeight = Math.max(220, window.innerHeight - start.top - 8);
    const minimumWidth = Math.min(520, maximumWidth);
    const minimumHeight = Math.min(300, maximumHeight);
    dialog.style.width = `${Math.max(minimumWidth, Math.min(start.width + deltaX, maximumWidth))}px`;
    dialog.style.height = `${Math.max(minimumHeight, Math.min(start.height + deltaY, maximumHeight))}px`;
  };
  const finish = (endEvent) => {
    if (endEvent.pointerId !== start.pointerId) return;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
  };
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

async function removeLoggedModFromPreset(logId) {
  const entry = state.modLogs.find((item) => item.id === logId);
  const preset = state.presets.find((item) => item.id === entry?.presetId);
  const presetMod = preset?.mods?.find((mod) => mod.modId === entry?.modId);
  if (!entry || !preset || !presetMod) {
    showToast(t('modLogs.removeUnavailable'), 'warning');
    renderModLogs();
    return;
  }

  const confirmationKey = preset.mods.length === 1 ? 'modLogs.removeLastConfirm' : 'modLogs.removeConfirm';
  if (!await confirmAction(t(confirmationKey, { mod: presetMod.name, preset: preset.name }))) return;

  try {
    await waitForPendingSaves();
    setBusy(true, t('busy.savingPreset'));
    const result = await api.removeModFromPreset({ presetId: preset.id, modId: presetMod.modId });
    state.presets = result.presets;
    if (state.settings.defaultPresetId && !state.presets.some((item) => item.id === state.settings.defaultPresetId)) {
      state.settings = await api.saveSettings({ defaultPresetId: '' });
    }
    restoreWorkspace(result.workspace);
    renderModLogs();
    recordModActions([{
      action: 'preset-remove',
      source: 'user',
      mod: result.removedMod || presetMod,
      presetId: preset.id,
      presetName: preset.name
    }]);
    showToast(t(result.presetRemoved ? 'modLogs.removedWithPreset' : 'modLogs.removedFromPreset', {
      preset: preset.name
    }));
  } catch (error) {
    recordModActions([{
      action: 'error',
      source: 'system',
      mod: presetMod,
      presetId: preset.id,
      presetName: preset.name,
      details: errorMessage(error)
    }]);
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function clearModLogs() {
  if (!await confirmAction(t('modLogs.deleteConfirm'))) return;
  try {
    await api.clearModLogs();
    state.modLogs = [];
    state.modLogCount = 0;
    state.modLogsLoaded = true;
    renderModLogSetting();
    renderModLogs();
    showToast(t('modLogs.deleted'));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

function renderSettings() {
  $('#settingNoSplash').checked = state.settings.noSplash !== false;
  $('#settingAllowMismatch').checked = state.settings.allowVersionMismatch === true;
  $('#settingAutoUpdate').checked = state.settings.autoUpdate !== false;
  $('#settingAutoUpdate').disabled = state.updateMode === 'manual';
  $('#settingAutoAddDependencies').checked = state.settings.autoAddDependencies !== false;
  $('#settingConfirmModDeletion').checked = state.settings.confirmModDeletion !== false;
  $('#settingAdvancedMode').checked = state.settings.advancedMode === true;
  renderDependencyControl();
  $('#autoDependenciesSettingTitle').textContent = t('settings.autoDependenciesTitle');
  $('#autoDependenciesSettingHelp').textContent = t('settings.autoDependenciesHelp');
  $('#confirmModDeletionSettingTitle').textContent = t('settings.confirmModDeletionTitle');
  $('#confirmModDeletionSettingHelp').textContent = t('settings.confirmModDeletionHelp');
  $('#advancedModeHeading').textContent = t('settings.advancedHeading');
  $('#advancedModeSubtitle').textContent = t('settings.advancedSubtitle');
  $('#advancedModeTitle').textContent = t('settings.advancedTitle');
  $('#advancedModeHelp').textContent = t('settings.advancedHelp');
  $('#settingAdditionalArgs').value = state.settings.additionalArguments || '';
  $('#settingGamePath').value = state.settings.gameExecutable || '';
  $('#settingAddonsPath').value = state.settings.addonsDirectory || '';
  $('#settingDownloadsPath').value = state.settings.downloadRoot || '';
  $('#settingProfilePath').value = state.settings.profileDirectory || '';
  const defaultPreset = $('#settingDefaultPreset');
  const configuredPresetExists = state.presets.some((preset) => preset.id === state.settings.defaultPresetId);
  defaultPreset.innerHTML = [
    `<option value="">${escapeHtml(t(state.presets.length ? 'settings.defaultPresetAsk' : 'settings.defaultPresetAutoCreate'))}</option>`,
    ...state.presets.map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`)
  ].join('');
  defaultPreset.value = configuredPresetExists ? state.settings.defaultPresetId : '';
  defaultPreset.disabled = state.presets.length === 0;
  renderModLogSetting();
  renderUpdateStatus();
}

function launchReadiness() {
  const summary = counts();
  if (!state.settings.gameExecutable) return { ready: false, type: 'danger', message: t('launch.gameNotFound') };
  if (summary.selected === 0) return { ready: false, type: 'warning', message: t('launch.selectMods') };
  if (summary.missing > 0) return { ready: false, type: 'danger', message: t('launch.notReady', { count: summary.missing }) };
  if (summary.mismatch > 0 && !state.settings.allowVersionMismatch) {
    return { ready: false, type: 'warning', message: t('launch.otherVersions', { count: summary.mismatch }) };
  }
  return { ready: true, type: 'ready', message: t('launch.ready', { count: summary.selected }) };
}

function renderLaunchState() {
  const readiness = launchReadiness();
  const downloadCount = missingDownloadCount();
  const downloadStatus = state.modDownloadStatus || {};
  const downloadActive = activeModDownloadStates.has(downloadStatus.state);
  const downloadResumable = downloadStatus.resumeAvailable === true;
  $('#footerPresetName').textContent = currentPresetName();
  const status = $('#footerStatus');
  status.className = `footer-status ${readiness.type}`;
  status.querySelector('span:last-child').textContent = state.busy
    ? t('busy.processing')
    : downloadActive
      ? t('downloadMissing.active', {
          completed: downloadStatus.completed || 0,
          total: downloadStatus.total || 0,
          progress: downloadStatus.progress || 0
        })
      : downloadStatus.state === 'paused'
        ? t('downloadMissing.paused')
        : downloadResumable ? t('downloadMissing.retryReady') : readiness.message;
  const downloadButton = $('#downloadMissingMods');
  downloadButton.querySelector('span').textContent = downloadActive
    ? t('downloadMissing.progress', {
        completed: downloadStatus.completed || 0,
        total: downloadStatus.total || 0,
        progress: downloadStatus.progress || 0
      })
    : downloadResumable ? t('downloadMissing.resume') : t('downloadMissing.button', { count: downloadCount });
  downloadButton.title = t(downloadResumable ? 'downloadMissing.resumeTitle' : 'downloadMissing.title');
  downloadButton.disabled = state.busy || downloadActive || !state.settings.gameExecutable || (!downloadResumable && downloadCount === 0);
  $('#launchGame').disabled = state.busy || downloadActive || !readiness.ready;
  renderModUpdateControls();
  renderDashboard(readiness);
}

function renderAll() {
  renderSidebar();
  renderBuildIdentity();
  if (state.currentView !== 'dashboard') renderView(state.currentView);
  renderLaunchState();
  setView(state.currentView, { render: false });
}

function selectModDependencyTree(rootIds, options = {}) {
  const localById = installedById();
  const includeDependencies = options.includeDependencies !== false;
  const normalizedRoots = [...new Set(rootIds.map((modId) => String(modId || '').toUpperCase()))]
    .filter((modId) => /^[0-9A-F]{16}$/.test(modId));
  const rootSet = new Set(normalizedRoots);
  const queue = normalizedRoots.map((modId) => ({ modId, source: state.requirements.get(modId) }));
  const visited = new Set();
  const added = new Set();

  while (queue.length) {
    const { modId, source = {} } = queue.shift();
    if (visited.has(modId)) continue;
    visited.add(modId);
    const local = localById.get(modId);
    if (!state.selectedIds.has(modId)) {
      state.selectedIds.add(modId);
      added.add(modId);
    }
    if (!state.requirements.has(modId)) {
      state.requirements.set(modId, {
        modId,
        name: source.name || local?.name || modId,
        version: source.version || local?.version || '',
        required: true
      });
    }
    if (includeDependencies) {
      for (const dependency of local?.dependencies || []) {
        const dependencyId = String(dependency.modId || '').toUpperCase();
        if (/^[0-9A-F]{16}$/.test(dependencyId)) queue.push({ modId: dependencyId, source: dependency });
      }
    }
  }

  return {
    addedCount: added.size,
    dependencyCount: [...added].filter((modId) => !rootSet.has(modId)).length,
    addedIds: [...added]
  };
}

function disableModAndDependents(modId) {
  const normalizedId = String(modId || '').toUpperCase();
  if (!state.selectedIds.has(normalizedId)) return { removedCount: 0, dependentCount: 0, removedMods: [] };
  const queue = [normalizedId];
  const removed = new Set();

  while (queue.length) {
    const currentId = queue.shift();
    if (removed.has(currentId) || !state.selectedIds.has(currentId)) continue;
    removed.add(currentId);
    for (const dependent of localDependentMods(currentId, true)) queue.push(dependent.modId);
  }

  const removedMods = [...removed].map(modLogDescriptor);
  for (const removedId of removed) {
    state.selectedIds.delete(removedId);
    state.requirements.delete(removedId);
  }
  return { removedCount: removed.size, dependentCount: Math.max(0, removed.size - 1), removedMods };
}

function toggleMod(modId, selected) {
  const normalizedId = String(modId || '').toUpperCase();
  if (selected) {
    const result = selectModDependencyTree([normalizedId], {
      includeDependencies: state.settings.autoAddDependencies !== false
    });
    if (result.addedCount === 0) return;
    markSelectionChanged();
    recordModActions(result.addedIds.map((addedId) => ({
      action: addedId === normalizedId ? 'enable' : 'auto-enable',
      source: addedId === normalizedId ? 'user' : 'dependency',
      mod: addedId
    })));
    if (result.dependencyCount > 0) showToast(t('toast.dependenciesAdded', { count: result.dependencyCount }));
    return;
  }

  const result = disableModAndDependents(normalizedId);
  if (result.removedCount === 0) return;
  markSelectionChanged();
  recordModActions(result.removedMods.map((mod, index) => ({
    action: index === 0 ? 'disable' : 'auto-disable',
    source: index === 0 ? 'user' : 'dependency',
    mod
  })));
  if (result.dependentCount > 0) showToast(t('toast.dependentsDisabled', { count: result.dependentCount }), 'warning');
}

function selectAllMods() {
  if (state.installedMods.length === 0) {
    showToast(t('toast.noInstalledMods'), 'warning');
    return;
  }

  const addedMods = state.installedMods.filter((mod) => !state.selectedIds.has(mod.modId));
  for (const mod of state.installedMods) {
    state.selectedIds.add(mod.modId);
    state.requirements.set(mod.modId, {
      modId: mod.modId,
      name: mod.name || mod.modId,
      version: mod.version || '',
      required: true
    });
  }
  markSelectionChanged();
  recordModActions(addedMods.map((mod) => ({ action: 'enable', source: 'user', mod })));
  showToast(t('toast.selectedAll', { count: state.installedMods.length }));
}

function addDependencies() {
  const result = selectModDependencyTree([...state.selectedIds]);
  if (result.addedCount > 0) {
    markSelectionChanged();
    recordModActions(result.addedIds.map((modId) => ({ action: 'auto-enable', source: 'dependency', mod: modId })));
    showToast(t('toast.dependenciesAdded', { count: result.addedCount }));
  } else {
    showToast(t('toast.dependenciesSelected'), 'warning');
  }
}

async function rescanMods() {
  try {
    setBusy(true, t('busy.scanning'));
    state.installedMods = await api.scanMods();
    state.lastScan = new Date();
    renderAll();
    if ($('#modDetailsDialog').open) renderModDetails();
    showToast(t('toast.modsFound', { count: state.installedMods.length }));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

function modInventorySignature(mods = state.installedMods) {
  return JSON.stringify((Array.isArray(mods) ? mods : [])
    .map((mod) => [
      mod.modId,
      mod.version || '',
      mod.corrupted === true,
      Number(mod.metadataModifiedAt || 0)
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

async function refreshInstalledModsSilently() {
  const lastScanAt = state.lastScan ? new Date(state.lastScan).getTime() : 0;
  if (state.busy || automaticModScanPromise || !state.settings.addonsDirectory) return false;
  if (lastScanAt && Date.now() - lastScanAt < automaticModScanMinimumAge) return false;
  const previousSignature = modInventorySignature();
  automaticModScanPromise = api.scanMods();
  try {
    const nextMods = await automaticModScanPromise;
    state.lastScan = new Date();
    if (modInventorySignature(nextMods) === previousSignature) return false;
    state.installedMods = nextMods;
    renderAll();
    if ($('#modDetailsDialog').open) renderModDetails();
    if (state.currentView === 'servers' && state.selectedServerId) {
      loadServerDetails(state.selectedServerId, {
        refresh: true,
        silent: Boolean(state.serverDetails)
      });
    }
    return true;
  } catch {
    return false;
  } finally {
    automaticModScanPromise = null;
  }
}

function scheduleForegroundRefresh() {
  if (foregroundRefreshTimer) clearTimeout(foregroundRefreshTimer);
  foregroundRefreshTimer = setTimeout(() => {
    foregroundRefreshTimer = 0;
    if (document.hidden) return;
    refreshInstalledModsSilently();
    refreshServersIfStale();
  }, 350);
}

function requestModDeletionConfirmation(mod, dependencyWarning, options = {}) {
  if (state.settings.confirmModDeletion === false) return Promise.resolve(true);
  const count = Math.max(1, Number(options.count) || 1);
  $('#deleteModDialogTitle').textContent = t(count > 1 ? 'confirm.deleteModsTitle' : 'confirm.deleteModTitle');
  $('#deleteModMessage').textContent = count > 1
    ? t('confirm.deleteMods', { count, names: options.names || mod.name, dependencies: dependencyWarning })
    : t('confirm.deleteMod', { name: mod.name, dependencies: dependencyWarning });
  $('#deleteModDontAskLabel').textContent = t('confirm.deleteModDontAsk');
  $('#deleteModDontAsk').checked = false;
  $('#cancelDeleteMod').textContent = state.language === 'ru' ? 'Отмена' : 'Cancel';
  $('#cancelDeleteModTop').title = t('common.close');
  $('#confirmDeleteMod span').textContent = t(count > 1 ? 'mods.deleteSelected' : 'mods.delete');
  const dialog = $('#deleteModDialog');
  if (!dialog.open) dialog.showModal();
  return new Promise((resolve) => {
    pendingModDeletionConfirmation = resolve;
  });
}

async function finishModDeletionConfirmation(confirmed) {
  const resolve = pendingModDeletionConfirmation;
  if (!resolve) return;
  pendingModDeletionConfirmation = null;
  const disableReminder = confirmed && $('#deleteModDontAsk').checked;
  if ($('#deleteModDialog').open) $('#deleteModDialog').close(confirmed ? 'confirm' : 'cancel');
  if (disableReminder) {
    try {
      state.settings = await api.saveSettings({ confirmModDeletion: false });
    } catch (error) {
      showToast(errorMessage(error), 'error');
    }
  }
  resolve(confirmed);
}

async function deleteInstalledMod(modId) {
  const mod = installedById().get(modId);
  if (!mod?.directoryPath) {
    showToast(t('toast.modNotInstalled'), 'warning');
    return;
  }

  const dependents = state.installedMods.filter((item) => (
    item.modId !== modId && item.dependencies?.some((dependency) => dependency.modId === modId)
  ));
  const dependencyWarning = dependents.length > 0
    ? t('confirm.modDependents', {
      names: dependents.slice(0, 4).map((item) => item.name).join(', '),
      more: dependents.length > 4 ? t('confirm.andOthers') : ''
    })
    : '';
  const confirmed = await requestModDeletionConfirmation(mod, dependencyWarning);
  if (!confirmed) return;

  try {
    await waitForPendingSaves();
    setBusy(true, t('busy.deletingMod'));
    const result = await api.deleteMod(modId);
    state.installedMods = result.installedMods;
    state.presets = result.presets;
    if (state.settings.defaultPresetId && !state.presets.some((preset) => preset.id === state.settings.defaultPresetId)) {
      state.settings = await api.saveSettings({ defaultPresetId: '' });
    }
    state.lastScan = new Date();
    restoreWorkspace(result.workspace);
    renderAll();
    const presetInfo = result.updatedPresets || result.removedPresets
      ? t('toast.presetUpdateInfo', { updated: result.updatedPresets, removed: result.removedPresets })
      : '';
    showToast(t('toast.modDeleted', { name: result.removed.name, details: presetInfo }));
    recordModActions([{ action: 'delete', source: 'user', mod: result.removed }]);
  } catch (error) {
    recordModActions([{ action: 'error', source: 'system', mod, details: errorMessage(error) }]);
    showToast(t('toast.modDeleteFailed', { message: errorMessage(error) }), 'error');
  } finally {
    setBusy(false);
    renderMods();
  }
}

async function deleteSelectedInstalledMods() {
  const installed = installedById();
  const mods = [...state.selectedIds]
    .map((modId) => installed.get(modId))
    .filter((mod) => mod?.directoryPath);
  if (mods.length === 0) {
    showToast(t('toast.modNotInstalled'), 'warning');
    return;
  }
  if (mods.length === 1) {
    await deleteInstalledMod(mods[0].modId);
    return;
  }

  const selected = new Set(mods.map((mod) => mod.modId));
  const dependents = state.installedMods.filter((item) => (
    !selected.has(item.modId) && item.dependencies?.some((dependency) => selected.has(dependency.modId))
  ));
  const dependencyWarning = dependents.length > 0
    ? t('confirm.modDependents', {
      names: dependents.slice(0, 4).map((item) => item.name).join(', '),
      more: dependents.length > 4 ? t('confirm.andOthers') : ''
    })
    : '';
  const names = mods.slice(0, 5).map((mod) => mod.name).join(', ')
    + (mods.length > 5 ? t('confirm.andOthers') : '');
  const confirmed = await requestModDeletionConfirmation(mods[0], dependencyWarning, {
    count: mods.length,
    names
  });
  if (!confirmed) return;

  const deleted = [];
  const failed = [];
  let lastResult = null;
  try {
    await waitForPendingSaves();
    setBusy(true, t('busy.deletingMod'));
    for (const mod of mods) {
      try {
        lastResult = await api.deleteMod(mod.modId);
        deleted.push(lastResult.removed || mod);
      } catch (error) {
        failed.push({ mod, error });
      }
    }
    if (lastResult) {
      state.installedMods = lastResult.installedMods;
      state.presets = lastResult.presets;
      if (state.settings.defaultPresetId && !state.presets.some((preset) => preset.id === state.settings.defaultPresetId)) {
        state.settings = await api.saveSettings({ defaultPresetId: '' });
      }
      state.lastScan = new Date();
      restoreWorkspace(lastResult.workspace);
      renderAll();
    }
    if (deleted.length) {
      recordModActions(deleted.map((mod) => ({ action: 'delete', source: 'user', mod })));
    }
    if (failed.length) {
      recordModActions(failed.map(({ mod, error }) => ({
        action: 'error',
        source: 'system',
        mod,
        details: errorMessage(error)
      })));
      showToast(t('toast.modsDeletePartial', { deleted: deleted.length, failed: failed.length }), 'error');
    } else {
      showToast(t('toast.modsDeleted', { count: deleted.length }));
    }
  } catch (error) {
    showToast(t('toast.modDeleteFailed', { message: errorMessage(error) }), 'error');
  } finally {
    setBusy(false);
    renderMods();
  }
}

function finishPresetImport(preset) {
  state.presets = [...state.presets.filter((item) => item.id !== preset.id), preset]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  selectPreset(preset);
  setView('presets');
  $('#importDialog').close();
  recordModActions((preset.mods || []).map((mod) => ({
    action: 'import',
    source: 'import',
    mod,
    presetId: preset.id,
    presetName: preset.name
  })));
  showToast(t('toast.presetImported', { name: preset.name }));
}

function openImportDialog(prefill = null) {
  const hasPrefill = typeof prefill?.text === 'string';
  $('#importPresetName').value = hasPrefill ? String(prefill.name || '').slice(0, 80) : '';
  $('#presetJsonInput').value = hasPrefill ? prefill.text : '';
  if (!$('#importDialog').open) $('#importDialog').showModal();
  setTimeout(() => $('#presetJsonInput').focus(), 0);
}

function droppedPresetFileSupported(file) {
  return Boolean(file && /\.(?:json|txt)$/i.test(String(file.name || '')));
}

function setFileDropOverlayVisible(visible) {
  const overlay = $('#fileDropOverlay');
  overlay.hidden = !visible;
  overlay.setAttribute('aria-hidden', String(!visible));
}

async function handleDroppedPresetFiles(files) {
  const dropped = [...(files || [])];
  if (dropped.length !== 1 || !droppedPresetFileSupported(dropped[0])) {
    showToast(t('presets.dropUnsupported'), 'warning');
    return;
  }
  const file = dropped[0];
  if (file.size > maximumDroppedPresetBytes) {
    showToast(t('presets.dropTooLarge'), 'warning');
    return;
  }
  try {
    const text = await file.text();
    openImportDialog({
      text,
      name: String(file.name || '').replace(/\.(?:json|txt)$/i, '')
    });
  } catch (error) {
    showToast(t('presets.dropReadFailed', { message: errorMessage(error) }), 'error');
  }
}

async function importPresetFile() {
  try {
    const preset = await api.importPreset();
    if (!preset) return;
    state.presets = await api.listPresets();
    finishPresetImport(preset);
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

async function importPresetText() {
  const text = $('#presetJsonInput').value.trim();
  if (!text) {
    showToast(t('toast.pasteJson'), 'warning');
    return;
  }

  try {
    setBusy(true, t('busy.importingPreset'));
    const preset = await api.importPresetText({
      text,
      name: $('#importPresetName').value.trim()
    });
    state.presets = await api.listPresets();
    finishPresetImport(preset);
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function pastePresetJson() {
  try {
    const text = await api.readPresetClipboard();
    if (!text.trim()) {
      showToast(t('toast.clipboardEmpty'), 'warning');
      return;
    }
    $('#presetJsonInput').value = text;
    $('#presetJsonInput').focus();
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

function editActivePreset() {
  if (!state.activePreset) return;
  setView('mods');
  showToast(t('toast.editingPreset', { name: state.activePreset.name }));
}

function openPresetDialog() {
  if (state.selectedIds.size === 0) {
    showToast(t('toast.chooseOneMod'), 'warning');
    return;
  }
  const editing = Boolean(state.activePreset);
  $('#presetDialogTitle').textContent = t(editing ? 'dialog.editTitle' : 'dialog.saveTitle');
  $('#confirmPresetSave').textContent = t(editing ? 'dialog.saveChanges' : 'dialog.save');
  $('#presetNameInput').value = state.activePreset?.name || t('preset.new');
  $('#dialogSummary').textContent = t('dialog.modCount', { count: state.selectedIds.size });
  $('#presetDialog').showModal();
  setTimeout(() => $('#presetNameInput').select(), 0);
}

async function savePreset() {
  const name = $('#presetNameInput').value.trim();
  if (!name) return;
  try {
    await waitForPendingSaves();
    setBusy(true, t('busy.savingPreset'));
    const value = snapshotPreset();
    value.name = name;
    const preset = await api.savePreset(value);
    state.presets = await api.listPresets();
    selectPreset(preset);
    $('#presetDialog').close();
    showToast(t('toast.presetSaved', { name: preset.name }));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function exportPreset() {
  const preset = snapshotPreset();
  try {
    if (await api.exportPreset(preset)) showToast(t('toast.presetExported'));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

async function sharePreset() {
  const preset = snapshotPreset();
  try {
    await api.copyPreset(preset);
    showToast(t('toast.presetCopied'));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

async function sharePresetFile() {
  if (state.selectedIds.size === 0) {
    showToast(t('toast.chooseModsForFile'), 'warning');
    return;
  }
  try {
    await waitForPendingSaves();
    const result = await api.sharePresetFile(snapshotPreset());
    if (result?.filePath) showToast(t('toast.friendFileReady'));
  } catch (error) {
    showToast(t('toast.friendFileFailed', { message: errorMessage(error) }), 'error');
  }
}

async function deleteActivePreset() {
  const preset = state.activePreset;
  if (!preset) return;
  if (!await confirmAction(t('confirm.deletePreset', { name: preset.name }))) return;
  try {
    await waitForPendingSaves();
    const result = await api.deletePreset(preset.id);
    state.presets = result.presets;
    if (state.settings.defaultPresetId && !state.presets.some((preset) => preset.id === state.settings.defaultPresetId)) {
      state.settings = await api.saveSettings({ defaultPresetId: '' });
    }
    restoreWorkspace(result.workspace);
    renderAll();
    showToast(t('toast.presetDeleted'));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

function renderPresetTransferDialog() {
  const preset = state.activePreset;
  const mode = $('input[name="presetTransferMode"]:checked')?.value === 'move' ? 'move' : 'copy';
  $('#presetTransferTitle').textContent = t('presets.transferTitle');
  $('#presetTransferName').textContent = preset?.name || t('presets.none');
  $('#presetTransferSummary').textContent = t('presets.transferSummary', { count: preset?.mods?.length || 0 });
  $('#presetTransferCopyTitle').textContent = t('presets.transferCopyTitle');
  $('#presetTransferCopyHelp').textContent = t('presets.transferCopyHelp');
  $('#presetTransferMoveTitle').textContent = t('presets.transferMoveTitle');
  $('#presetTransferMoveHelp').textContent = t('presets.transferMoveHelp');
  $('#presetTransferWarning').textContent = t('presets.transferWarning');
  $('#presetTransferWarning').hidden = mode !== 'move';
  $('#presetTransferHelp').textContent = t('presets.transferHelp');
  $('#cancelPresetTransfer').textContent = t('presets.transferCancel');
  $('#confirmPresetTransfer span').textContent = t('presets.transferSelectFolder');
}

function openPresetTransferDialog() {
  if (state.settings.advancedMode !== true || !state.activePreset || state.busy) return;
  const copyMode = $('input[name="presetTransferMode"][value="copy"]');
  if (copyMode) copyMode.checked = true;
  renderPresetTransferDialog();
  $('#presetTransferDialog').showModal();
}

async function transferActivePresetMods() {
  const preset = state.activePreset;
  if (state.settings.advancedMode !== true || !preset || state.busy) return;
  const mode = $('input[name="presetTransferMode"]:checked')?.value === 'move' ? 'move' : 'copy';
  try {
    const destinationDirectory = await api.choosePresetTransferDirectory();
    if (!destinationDirectory) return;
    if (mode === 'move' && !await confirmAction(t('confirm.movePresetMods', {
      name: preset.name,
      destination: destinationDirectory
    }))) return;

    setBusy(true, t('busy.transferringPresetMods'));
    renderPresets();
    await waitForPendingSaves();
    const result = await api.transferPresetMods({
      presetId: preset.id,
      destinationDirectory,
      mode
    });
    state.installedMods = Array.isArray(result?.installedMods) ? result.installedMods : state.installedMods;
    if ($('#presetTransferDialog').open) $('#presetTransferDialog').close('success');
    renderAll();
    if (mode === 'move' && result.failedRemovalCount > 0) {
      showToast(t('toast.presetModsMovePartial', {
        count: result.transferredCount,
        failed: result.failedRemovalCount
      }), 'warning');
    } else {
      showToast(t(mode === 'move' ? 'toast.presetModsMoved' : 'toast.presetModsCopied', {
        count: result.transferredCount,
        destination: result.destinationDirectory || destinationDirectory
      }));
    }
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
    renderPresets();
  }
}

function collectSettings() {
  return {
    gameExecutable: $('#settingGamePath').value,
    addonsDirectory: $('#settingAddonsPath').value,
    downloadRoot: $('#settingDownloadsPath').value,
    profileDirectory: $('#settingProfilePath').value,
    noSplash: $('#settingNoSplash').checked,
    allowVersionMismatch: $('#settingAllowMismatch').checked,
    additionalArguments: $('#settingAdditionalArgs').value,
    defaultPresetId: $('#settingDefaultPreset').value,
    autoUpdate: $('#settingAutoUpdate').checked,
    showModLogsFooter: $('#settingShowModLogsFooter').checked,
    autoAddDependencies: $('#settingAutoAddDependencies').checked,
    confirmModDeletion: $('#settingConfirmModDeletion').checked,
    advancedMode: $('#settingAdvancedMode').checked,
    language: state.language
  };
}

async function changeLanguage(nextLanguage) {
  const normalized = nextLanguage === 'ru' ? 'ru' : 'en';
  if (state.language === normalized) return;
  state.language = setLanguage(normalized);
  state.settings.language = state.language;
  setTitlebarStatus(state.busy ? t('busy.processing') : t('common.ready'));
  renderAll();
  if (state.currentView !== 'settings' && state.currentView !== 'parameters') renderSettings();
  if ($('#modDetailsDialog').open) renderModDetails();
  if (isImageViewerOpen()) renderImageViewer();
  if ($('#modLogsDialog').open) renderModLogs();
  if ($('#serverJoinDialog').open && pendingServerJoin) openServerJoinDialog(pendingServerJoin);
  if ($('#serverConnectionFailureDialog').open && pendingServerConnectionFailure) renderServerConnectionFailure();
  if ($('#presetTransferDialog').open) renderPresetTransferDialog();
  if ($('#mandatoryUpdateDialog').open) renderMandatoryUpdateDialog();
  try {
    state.settings = await api.saveSettings({ language: state.language });
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

async function saveSettings(showConfirmation = true) {
  const previousAddonsDirectory = state.settings.addonsDirectory;
  const previousAutoUpdate = state.settings.autoUpdate !== false;
  try {
    state.settings = await api.saveSettings(collectSettings());
    renderAll();
    if (previousAddonsDirectory !== state.settings.addonsDirectory) await rescanMods();
    if (state.packaged && !previousAutoUpdate && state.settings.autoUpdate !== false) {
      setTimeout(() => checkUpdates(true), 0);
    }
    if (showConfirmation) showToast(t('toast.settingsSaved'));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  }
}

async function browseSetting(kind) {
  const mapping = {
    game: ['settingGamePath', api.chooseGameExecutable],
    addons: ['settingAddonsPath', () => api.chooseDirectory('addons')],
    downloads: ['settingDownloadsPath', () => api.chooseDirectory('downloads')],
    profile: ['settingProfilePath', () => api.chooseDirectory('profile')]
  };
  const target = mapping[kind];
  if (!target) return;
  const selected = await target[1]();
  if (selected) $(`#${target[0]}`).value = selected;
}

async function launchGame() {
  try {
    setBusy(true, t('busy.launching'));
    await waitForPendingSaves();
    await saveSettings(false);
    const result = await api.launch({ mods: currentMods(), presetName: currentPresetName() });
    const dependencies = result.dependencyCount
      ? t('toast.dependencies', { count: result.dependencyCount })
      : '';
    showToast(t('toast.launched', { count: result.selectedCount, dependencies }));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function updateInstalledMods(modIds = installedModUpdateTargets()) {
  if (state.busy || activeModDownloadStates.has(state.modDownloadStatus?.state)
      || state.modDownloadStatus?.resumeAvailable === true) return;
  const targets = [...new Set(modIds)].filter((modId) => installedById().get(modId)?.directoryPath);
  if (!targets.length) return;
  state.modUpdatesChecking = true;
  setBusy(true, t('mods.updateChecking'));
  try {
    await waitForPendingSaves();
    const result = await api.updateInstalledMods({ modIds: targets });
    const skipped = Number(result.skippedCount || 0);
    if (result.queuedCount > 0) {
      modDownloadPollGeneration++;
      state.modDownloadStatus = {
        state: 'queued', completed: 0, total: result.queuedCount, failed: 0, progress: 0
      };
      const details = t('mods.updateStarted', { count: result.updateCount, total: result.queuedCount });
      recordModActions((result.updates || []).map((mod) => ({
        action: 'install', source: 'workshop', mod, details
      })));
      showToast(details);
      scheduleModDownloadPoll(800);
    } else if (result.alreadyUpToDate && skipped === 0) {
      showToast(t('mods.updateCurrent', { count: result.checkedCount }));
    } else if (skipped === 0) {
      showToast(t('mods.updateNothing'), 'warning');
    }
    if (skipped > 0) {
      showToast(t('mods.updateSkipped', { count: skipped, checked: result.checkedCount }), 'warning');
    }
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    state.modUpdatesChecking = false;
    setBusy(false);
    renderMods();
    // A failed game launch can still leave a durable queue to resume.
    scheduleModDownloadPoll(800);
  }
}

async function downloadMissingMods() {
  if (state.busy) return;
  const resume = state.modDownloadStatus?.resumeAvailable === true;
  try {
    setBusy(true, t('busy.openingDownloads'));
    if (!resume) {
      await waitForPendingSaves();
      await saveSettings(false);
    }
    modDownloadPollGeneration++;
    const result = resume
      ? await api.resumeModDownload()
      : await api.downloadMissingMods({ mods: currentMods(), presetName: currentPresetName() });
    modDownloadPollGeneration++;
    state.modDownloadStatus = {
      state: 'queued',
      completed: 0,
      total: result.queuedCount || result.missingCount,
      failed: 0,
      progress: 0
    };
    showToast(t('toast.missingDownloadStarted', { count: result.queuedCount || result.missingCount }));
    scheduleModDownloadPoll(800);
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
    scheduleModDownloadPoll(800);
  }
}

function scheduleModDownloadPoll(delay = 1000) {
  if (modDownloadTimer) clearTimeout(modDownloadTimer);
  modDownloadTimer = setTimeout(pollModDownloadStatus, delay);
}

async function pollModDownloadStatus() {
  modDownloadTimer = 0;
  const generation = ++modDownloadPollGeneration;
  const previousState = state.modDownloadStatus?.state || 'idle';
  try {
    const nextStatus = await api.getModDownloadStatus();
    if (generation !== modDownloadPollGeneration) return;
    state.modDownloadStatus = nextStatus;
    modDownloadPollFailures = 0;
    renderLaunchState();
    if (activeModDownloadStates.has(state.modDownloadStatus.state)) {
      scheduleModDownloadPoll();
      return;
    }

    if (activeModDownloadStates.has(previousState)) {
      if (state.modDownloadStatus.state === 'complete') {
        showToast(t('toast.missingDownloadComplete', { count: state.modDownloadStatus.completed }));
      } else if (state.modDownloadStatus.state === 'partial') {
        showToast(t('toast.missingDownloadPartial', state.modDownloadStatus), 'warning');
      } else if (state.modDownloadStatus.state === 'error') {
        showToast(t('toast.missingDownloadFailed', { message: state.modDownloadStatus.message || 'Workshop' }), 'error');
      } else if (state.modDownloadStatus.state === 'paused') {
        showToast(t('downloadMissing.paused'), 'warning');
      }
      const rescannedMods = await api.scanMods();
      if (generation !== modDownloadPollGeneration) return;
      state.installedMods = rescannedMods;
      state.lastScan = new Date();
      renderAll();
      if ($('#modDetailsDialog').open) renderModDetails();
      if (state.selectedServerId) loadServerDetails(state.selectedServerId);
    }
  } catch (error) {
    if (generation !== modDownloadPollGeneration) return;
    modDownloadPollFailures++;
    if (modDownloadPollFailures === 1) showToast(errorMessage(error), 'error');
    // Transient file locks/IPC failures must not permanently stop progress.
    scheduleModDownloadPoll(Math.min(10_000, 1000 * 2 ** Math.min(modDownloadPollFailures, 4)));
  }
}

function renderUpdateStatus() {
  const status = state.updateStatus || { state: 'idle' };
  const label = $('#updateStatus');
  const checkButton = $('#checkUpdates');
  const downloadButton = $('#downloadUpdate');
  const installButton = $('#installUpdate');
  const titlebarButton = $('#titlebarUpdate');
  checkButton.disabled = ['checking', 'downloading', 'verifying'].includes(status.state);
  downloadButton.hidden = status.state !== 'available';
  installButton.hidden = status.state !== 'downloaded';
  const titlebarVisible = ['available', 'downloading', 'verifying', 'downloaded'].includes(status.state);
  titlebarButton.hidden = !titlebarVisible;
  titlebarButton.disabled = status.state === 'downloading' || status.state === 'verifying';
  titlebarButton.classList.toggle('ready', status.state === 'downloaded');
  const titlebarLabel = titlebarButton.querySelector('span');
  if (status.state === 'available') {
    titlebarLabel.textContent = t('update.titlebarAvailable', { version: status.info?.version || '' }).trim();
    titlebarButton.title = t('update.titlebarAvailableHint');
  } else if (status.state === 'downloading') {
    titlebarLabel.textContent = t('update.titlebarDownloading', { percent: Math.round(status.progress?.percent || 0) });
    titlebarButton.title = titlebarLabel.textContent;
  } else if (status.state === 'verifying') {
    titlebarLabel.textContent = t('update.titlebarVerifying');
    titlebarButton.title = t('update.titlebarVerifyingHint');
  } else if (status.state === 'downloaded') {
    titlebarLabel.textContent = t('update.titlebarReady');
    titlebarButton.title = t('update.titlebarReadyHint');
  }
  if (status.state === 'idle') {
    label.textContent = state.settings.autoUpdate === false
      ? t('settings.autoUpdateOff')
      : t('settings.updatesReady');
  } else if (status.state === 'checking') label.textContent = t('update.checking');
  else if (status.state === 'available') label.textContent = t('update.available', { version: status.info?.version || '' });
  else if (status.state === 'current') label.textContent = t('update.current');
  else if (status.state === 'downloading') label.textContent = t('update.downloading', { percent: Math.round(status.progress?.percent || 0) });
  else if (status.state === 'verifying') label.textContent = t('update.verifying');
  else if (status.state === 'downloaded') {
    label.textContent = status.mandatory ? t('update.mandatoryReady') : t('update.downloaded');
  }
  else if (status.state === 'manual') label.textContent = t('update.manual');
  else if (status.state === 'error') label.textContent = t('update.error', { message: updateErrorMessage(status.message) });
}

function stopMandatoryUpdateCountdown() {
  if (mandatoryUpdateCountdownTimer) clearTimeout(mandatoryUpdateCountdownTimer);
  mandatoryUpdateCountdownTimer = 0;
}

function mandatoryCountdownText(deadline) {
  const remainingSeconds = Math.max(0, Math.ceil((Number(deadline || 0) - Date.now()) / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function mandatoryUpdateKey(mandatory) {
  if (!mandatory) return '';
  return `${String(mandatory.version || '')}:${Number(mandatory.deadline || 0)}`;
}

function acknowledgeMandatoryUpdate() {
  const mandatory = state.updateStatus?.mandatory;
  if (mandatory?.mode !== 'semi-forced') return;
  acknowledgedMandatoryUpdate = mandatoryUpdateKey(mandatory);
  stopMandatoryUpdateCountdown();
  const dialog = $('#mandatoryUpdateDialog');
  if (dialog.open) dialog.close('acknowledged');
}

function renderMandatoryUpdateDialog() {
  stopMandatoryUpdateCountdown();
  const mandatory = state.updateStatus?.state === 'downloaded'
    ? state.updateStatus.mandatory
    : null;
  const dialog = $('#mandatoryUpdateDialog');
  if (!mandatory || !['forced', 'semi-forced'].includes(mandatory.mode)) {
    if (dialog.open) dialog.close('inactive');
    return;
  }

  const forced = mandatory.mode === 'forced';
  if (!forced && acknowledgedMandatoryUpdate === mandatoryUpdateKey(mandatory)) {
    if (dialog.open) dialog.close('acknowledged');
    return;
  }
  const countdown = mandatoryCountdownText(mandatory.deadline);
  const expired = countdown === '00:00';
  const version = mandatory.version || state.updateStatus.info?.version || '';
  $('#mandatoryUpdateEyebrow').textContent = t('update.mandatory.eyebrow');
  $('#mandatoryUpdateTitle').textContent = t(
    forced ? 'update.mandatory.forcedTitle' : 'update.mandatory.semiForcedTitle',
    { version }
  );
  $('#mandatoryUpdateVersion').textContent = t('update.mandatory.version', { version });
  $('#mandatoryUpdateMessage').textContent = t(
    forced ? 'update.mandatory.forcedMessage' : 'update.mandatory.semiForcedMessage'
  );
  const gameState = $('#mandatoryUpdateGameState');
  gameState.classList.toggle('running', mandatory.gameRunning === true);
  $('#mandatoryUpdateGameText').textContent = t(
    mandatory.gameRunning === true
      ? 'update.mandatory.gameRunning'
      : 'update.mandatory.gameStopped'
  );
  $('#mandatoryUpdateCountdown').textContent = countdown;
  $('#mandatoryUpdateCountdownLabel').textContent = t(
    forced ? 'update.mandatory.forcedCountdown' : 'update.mandatory.semiForcedCountdown'
  );
  $('#mandatoryUpdateNote').textContent = t('update.mandatory.note');
  const acknowledgeButton = $('#mandatoryUpdateAcknowledge');
  acknowledgeButton.hidden = forced;
  acknowledgeButton.querySelector('span').textContent = t('update.mandatory.acknowledge');
  const installButton = $('#mandatoryUpdateInstall');
  installButton.disabled = expired;
  installButton.querySelector('span').textContent = t(
    expired ? 'update.mandatory.installing' : 'update.mandatory.install'
  );

  if (!dialog.open) {
    $$('dialog[open]').forEach((openDialog) => openDialog.close('mandatory-update'));
    dialog.showModal();
  }
  if (!expired) mandatoryUpdateCountdownTimer = setTimeout(renderMandatoryUpdateDialog, 250);
}

function handleUpdateStatus(status) {
  const previousState = state.updateStatus?.state;
  const previousMandatoryKey = mandatoryUpdateKey(state.updateStatus?.mandatory);
  const nextMandatoryKey = mandatoryUpdateKey(status.mandatory);
  if (previousMandatoryKey !== nextMandatoryKey) acknowledgedMandatoryUpdate = '';
  state.updateStatus = status;
  renderUpdateStatus();
  renderMandatoryUpdateDialog();
  if (status.state === 'downloaded' && !status.mandatory && previousState !== 'downloaded') {
    showToast(t('toast.updateReady'));
  }
}

async function checkUpdates(silent = false) {
  try {
    // Startup checks must never read or persist controls from a hidden settings
    // page. Manual checks still save intentional edits made by the user.
    if (!silent) await saveSettings(false);
    const result = await api.checkForUpdates();
    if (result.state === 'development' && !silent) showToast(t('toast.updatePackagedOnly'), 'warning');
    else if (result.state === 'manual') {
      handleUpdateStatus({ state: 'manual' });
      if (!silent) {
        await api.openOfficialReleases();
        showToast(t('toast.updateManual'), 'warning');
      }
    }
    else if (result.state !== 'development') {
      handleUpdateStatus({
        state: result.state,
        info: { version: result.version || '' },
        message: result.message || ''
      });
      if (result.state === 'error' && !silent) showToast(updateErrorMessage(result.message), 'error');
    }
  } catch (error) {
    const message = updateErrorMessage(error);
    handleUpdateStatus({ state: 'error', message });
    if (!silent) showToast(message, 'error');
  }
}

async function downloadUpdate() {
  try {
    handleUpdateStatus({ state: 'downloading', progress: { percent: 0 } });
    await api.downloadUpdate();
  } catch (error) {
    const message = updateErrorMessage(error);
    handleUpdateStatus({ state: 'error', message });
    showToast(message, 'error');
  }
}

function installUpdate() {
  api.installUpdate().catch((error) => showToast(errorMessage(error), 'error'));
}

function handleTitlebarUpdate() {
  const updateState = state.updateStatus?.state;
  if (updateState === 'available') downloadUpdate();
  else if (updateState === 'downloaded') installUpdate();
}

async function repairLauncher() {
  try {
    setBusy(true, t('busy.repairing'));
    const result = await api.repair();
    state.installedMods = await api.scanMods();
    state.presets = await api.listPresets();
    renderAll();
    showToast(t('toast.repaired', { presets: result.presets, mods: result.mods }));
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  $$('[data-language]').forEach((button) => {
    button.addEventListener('click', () => changeLanguage(button.dataset.language));
  });
  $('#windowMinimize').addEventListener('click', api.minimizeWindow);
  $('#windowMaximize').addEventListener('click', api.maximizeWindow);
  $('#windowClose').addEventListener('click', async () => {
    await waitForPendingSaves();
    api.closeWindow();
  });
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('[data-home-view]').forEach((button) => button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    if (dialog?.open) dialog.close();
    setView(button.dataset.homeView);
  }));
  $('#homeManualOpen').addEventListener('click', () => {
    const dialog = $('#homeManualDialog');
    if (!dialog.open) dialog.showModal();
  });
  $('#openAboutSidebar').addEventListener('click', openAboutDialog);
  $('#openAboutSettings').addEventListener('click', openAboutDialog);
  $('#openLicense').addEventListener('click', openLicenseDialog);
  $('#licenseBackToAbout').addEventListener('click', returnToAboutDialog);
  $('#openOfficialReleases').addEventListener('click', openOfficialReleases);

  const dragContainsFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragenter', (event) => {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    fileDragDepth += 1;
    setFileDropOverlayVisible(true);
  });
  document.addEventListener('dragover', (event) => {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!dragContainsFiles(event) && $('#fileDropOverlay').hidden) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0) setFileDropOverlayVisible(false);
  });
  document.addEventListener('drop', (event) => {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    fileDragDepth = 0;
    setFileDropOverlayVisible(false);
    handleDroppedPresetFiles(event.dataTransfer?.files);
  });
  window.addEventListener('blur', () => {
    fileDragDepth = 0;
    setFileDropOverlayVisible(false);
  });

  $('#headerActions').addEventListener('click', (event) => {
    const action = event.target.closest('[data-header-action]')?.dataset.headerAction;
    if (action === 'import') openImportDialog();
    if (action === 'share-file') sharePresetFile();
    if (action === 'save') openPresetDialog();
  });

  $('#modSearch').addEventListener('input', (event) => {
    state.modSearch = event.target.value.trim();
    renderMods();
  });
  $('#workshopSearchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    state.workshopQuery = $('#workshopSearch').value.trim();
    state.workshopPage = 1;
    loadWorkshop({ refresh: true });
  });
  $('#workshopSort').addEventListener('change', (event) => {
    state.workshopSort = event.target.value;
    state.workshopPage = 1;
    loadWorkshop();
  });
  $('#refreshWorkshop').addEventListener('click', () => loadWorkshop({ refresh: true }));
  $('#workshopPrevious').addEventListener('click', () => {
    if (state.workshopPage <= 1) return;
    state.workshopPage -= 1;
    loadWorkshop();
  });
  $('#workshopNext').addEventListener('click', () => {
    if (state.workshopPage >= workshopPageCount()) return;
    state.workshopPage += 1;
    loadWorkshop();
  });
  $('#workshopGrid').addEventListener('click', (event) => {
    handleWorkshopGridAction(event, state.workshopItems);
  });
  $('#workshopGrid').addEventListener('pointerover', (event) => {
    const card = event.target.closest('.workshop-card[data-mod-id]');
    if (!card || card.contains(event.relatedTarget)) return;
    const mod = state.workshopItems.find((item) => item.modId === card.dataset.modId);
    if (mod) loadWorkshopCardGallery(mod);
  });
  $('#configuratorCategories').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (!button || button.dataset.category === state.workshopCategory) return;
    state.workshopCategory = button.dataset.category;
    state.workshopQuery = '';
    $('#workshopSearch').value = '';
    state.workshopPage = 1;
    loadWorkshop();
  });
  $('#serverSearchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (serverSearchComposing || event.isComposing) return;
    if (serverSearchTimer) clearTimeout(serverSearchTimer);
    serverSearchTimer = 0;
    const input = $('#serverSearch');
    const query = input.value.trim();
    if (query.length === 1) {
      input.setCustomValidity(t('servers.searchMinimum'));
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    state.serverQuery = query;
    state.serverPage = 1;
    loadServers({ refresh: true });
  });
  const handleServerSearchInput = (event) => {
    const input = event.currentTarget;
    input.setCustomValidity('');
    if (serverSearchTimer) clearTimeout(serverSearchTimer);
    serverSearchTimer = 0;
    if (serverSearchComposing || event.isComposing) return;
    const query = input.value.trim();
    state.serverQuery = query;
    if (query.length === 1) {
      scheduleServerAutoRefresh();
      return;
    }
    serverSearchTimer = setTimeout(() => {
      serverSearchTimer = 0;
      state.serverPage = 1;
      loadServers({ refresh: true });
    }, 400);
  };
  $('#serverSearch').addEventListener('input', handleServerSearchInput);
  $('#serverSearch').addEventListener('compositionstart', () => {
    serverSearchComposing = true;
    if (serverSearchTimer) clearTimeout(serverSearchTimer);
    serverSearchTimer = 0;
    cancelServerAutoRefresh();
  });
  $('#serverSearch').addEventListener('compositionend', (event) => {
    serverSearchComposing = false;
    handleServerSearchInput(event);
  });
  $('#serverSort').addEventListener('change', (event) => {
    state.serverSort = event.target.value;
    state.serverPage = 1;
    loadServers();
  });
  $('#refreshServers').addEventListener('click', () => loadServers({ refresh: true }));
  $('#serverPrevious').addEventListener('click', () => {
    if (state.serverPage <= 1) return;
    state.serverPage -= 1;
    loadServers();
  });
  $('#serverNext').addEventListener('click', () => {
    if (!state.serverHasNext) return;
    state.serverPage += 1;
    loadServers();
  });
  $('#serverList').addEventListener('click', (event) => {
    if (event.target.closest('[data-server-retry]')) {
      loadServers({ refresh: true });
      return;
    }
    const favorite = event.target.closest('[data-server-favorite]');
    if (favorite) {
      event.stopPropagation();
      toggleServerFavorite(favorite.dataset.serverFavorite);
      return;
    }
    const row = event.target.closest('[data-server-id]');
    if (row) selectServer(row.dataset.serverId);
  });
  $('#serverList').addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key) || event.target.closest('button')) return;
    const row = event.target.closest('[data-server-id]');
    if (!row) return;
    event.preventDefault();
    selectServer(row.dataset.serverId);
  });
  $('#serverDetails').addEventListener('click', (event) => {
    const favorite = event.target.closest('[data-server-favorite]');
    if (favorite) {
      toggleServerFavorite(favorite.dataset.serverFavorite);
      return;
    }
    if (event.target.closest('[data-server-download]')) {
      downloadServerPack();
      return;
    }
    const modDownload = event.target.closest('[data-server-mod-download]');
    if (modDownload) {
      downloadServerMod(modDownload.dataset.serverModDownload);
      return;
    }
    if (event.target.closest('[data-server-copy-json]')) {
      copyServerModsJson();
      return;
    }
    if (event.target.closest('[data-server-connect]')) {
      openServerJoinDialog(state.serverDetails);
      return;
    }
    const modRow = event.target.closest('[data-mod-id]');
    if (modRow) openModDetails(modRow.dataset.modId);
  });
  $('#serverDirectForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy || activeServerJoinRequest) return;
    const hostInput = $('#serverDirectHost');
    const portInput = $('#serverDirectPort');
    const host = hostInput.value.trim();
    const portText = portInput.value.trim();
    const port = Number.parseInt(portText, 10);
    hostInput.setCustomValidity('');
    portInput.setCustomValidity('');
    if (!host || /[\s:/\\?#]/.test(host)) {
      hostInput.setCustomValidity(t('servers.directInvalidHost'));
      hostInput.reportValidity();
      return;
    }
    if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) {
      portInput.setCustomValidity(t('servers.directInvalidPort'));
      portInput.reportValidity();
      return;
    }
    const address = `${host}:${port}`;
    openServerJoinDialog({ server: { id: '', name: address, address }, mods: [] });
  });
  $('#serverDirectHost').addEventListener('input', (event) => event.currentTarget.setCustomValidity(''));
  $('#serverDirectPort').addEventListener('input', (event) => {
    event.currentTarget.value = event.currentTarget.value.replace(/\D/g, '').slice(0, 5);
    event.currentTarget.setCustomValidity('');
  });
  $('#serverJoinForm').addEventListener('submit', (event) => {
    event.preventDefault();
    connectPendingServer();
  });
  $('#forceServerJoin').addEventListener('click', () => connectPendingServer({ allowUnverified: true }));
  $$('#serverJoinDialog [data-dialog-close]').forEach((button) => {
    button.addEventListener('click', cancelActiveServerConnection);
  });
  $('#serverJoinDialog').addEventListener('cancel', cancelActiveServerConnection);
  $('#serverSavePreset').addEventListener('change', (event) => {
    $('#serverPresetNameField').hidden = !event.target.checked;
  });
  $('#serverJoinDialog').addEventListener('close', () => {
    // A previous close event may arrive just after the dialog has already been
    // opened again. Do not cancel the new connection attempt in that case.
    if ($('#serverJoinDialog').open) return;
    cancelActiveServerConnection();
    cancelServerJoinWait();
    pendingServerJoin = null;
  });
  $('#serverConnectionFailureOk').addEventListener('click', closeServerConnectionFailure);
  $('#serverConnectionFailureDialog').addEventListener('cancel', (event) => event.preventDefault());
  $('#modFilter').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.modFilter = button.dataset.filter;
    $$('#modFilter button').forEach((item) => item.classList.toggle('active', item === button));
    renderMods();
  });
  $('#modsTableBody').addEventListener('change', (event) => {
    const checkbox = event.target.closest('.mod-checkbox');
    if (!checkbox) return;
    const modId = checkbox.closest('[data-mod-id]').dataset.modId;
    toggleMod(modId, checkbox.checked);
  });
  $('#modsTableBody').addEventListener('click', (event) => {
    const updateButton = event.target.closest('.update-mod-button');
    if (updateButton) {
      updateInstalledMods([updateButton.closest('[data-mod-id]').dataset.modId]);
      return;
    }
    const deleteButton = event.target.closest('.delete-mod-button');
    if (deleteButton) {
      deleteInstalledMod(deleteButton.closest('[data-mod-id]').dataset.modId);
      return;
    }
    const workshopButton = event.target.closest('.workshop-button');
    if (workshopButton) {
      api.openWorkshop(workshopButton.closest('[data-mod-id]').dataset.modId).catch((error) => showToast(errorMessage(error), 'error'));
      return;
    }
    if (event.target.closest('input, button')) return;
    const row = event.target.closest('.mod-row');
    if (row) openModDetails(row.dataset.modId);
  });
  $('#modsTableBody').addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key) || event.target.closest('input, button')) return;
    const row = event.target.closest('.mod-row');
    if (!row) return;
    event.preventDefault();
    openModDetails(row.dataset.modId);
  });
  $('#closeModDetailsTop').addEventListener('click', closeModDetails);
  $('#closeModDetails').addEventListener('click', closeModDetails);
  $('#openModDetailsWorkshop').addEventListener('click', () => {
    if (!state.modDetails?.modId) return;
    api.openWorkshop(state.modDetails.modId).catch((error) => showToast(errorMessage(error), 'error'));
  });
  $('#downloadModDetails').addEventListener('click', () => {
    if ($('#downloadModDetails').disabled || !state.modDetails) return;
    installWorkshopMod(state.modDetails.data || localDetailsFor(state.modDetails.modId));
  });
  $('#updateModDetails').addEventListener('click', () => {
    if ($('#updateModDetails').disabled || !state.modDetails) return;
    updateInstalledMods([state.modDetails.modId]);
  });
  $('#copyModDetailsJson').addEventListener('click', copyCurrentModJson);
  $('#modDetailsBody').addEventListener('click', (event) => {
    const galleryDirection = event.target.closest('[data-detail-gallery-direction]');
    if (galleryDirection) {
      changeModDetailsImage(Number(galleryDirection.dataset.detailGalleryDirection));
      return;
    }
    const descriptionMode = event.target.closest('[data-description-mode]');
    if (descriptionMode) {
      if (descriptionMode.dataset.descriptionMode === 'ru') translateCurrentModDescription();
      else {
        state.modDetails.descriptionMode = 'original';
        renderModDetails();
      }
      return;
    }
    const scenarioCopy = event.target.closest('.workshop-copy-scenario');
    if (scenarioCopy) {
      copyScenarioId(scenarioCopy.dataset.scenarioId);
      return;
    }
    const dependency = event.target.closest('[data-detail-mod-id]');
    if (dependency) {
      openModDetails(dependency.dataset.detailModId);
      return;
    }
    const imageOpener = event.target.closest('[data-open-image]');
    if (imageOpener) {
      openImageViewer(imageOpener.dataset.openImage);
      return;
    }
    const thumbnail = event.target.closest('[data-image-url]');
    if (!thumbnail || !$('#modDetailsHero')) return;
    setModDetailsImage(thumbnail.dataset.imageUrl);
  });
  $('#closeImageViewer').addEventListener('click', closeImageViewer);
  $('#imageViewerPrevious').addEventListener('click', () => changeImageViewerImage(-1));
  $('#imageViewerNext').addEventListener('click', () => changeImageViewerImage(1));
  $('#imageViewerZoomOut').addEventListener('click', () => setImageViewerScale(imageViewer.scale - imageViewerScaleStep));
  $('#imageViewerZoomIn').addEventListener('click', () => setImageViewerScale(imageViewer.scale + imageViewerScaleStep));
  $('#imageViewerReset').addEventListener('click', resetImageViewerTransform);
  $('#imageViewerImage').addEventListener('load', renderImageViewerTransform);
  $('#modDetailsDialog').addEventListener('cancel', (event) => {
    if (!isImageViewerOpen()) return;
    event.preventDefault();
    closeImageViewer();
  });
  $('#imageViewerStage').addEventListener('wheel', (event) => {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setImageViewerScale(imageViewer.scale + (direction * imageViewerScaleStep), event);
  }, { passive: false });
  $('#imageViewerStage').addEventListener('dblclick', (event) => {
    if (imageViewer.scale > imageViewerMinScale) resetImageViewerTransform();
    else setImageViewerScale(2, event);
  });
  $('#imageViewerStage').addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || imageViewer.scale <= imageViewerMinScale) return;
    event.preventDefault();
    imageViewer.dragging = true;
    imageViewer.pointerId = event.pointerId;
    imageViewer.startX = event.clientX;
    imageViewer.startY = event.clientY;
    imageViewer.startOffsetX = imageViewer.offsetX;
    imageViewer.startOffsetY = imageViewer.offsetY;
    event.currentTarget.setPointerCapture(event.pointerId);
    renderImageViewerTransform();
  });
  $('#imageViewerStage').addEventListener('pointermove', (event) => {
    if (!imageViewer.dragging || event.pointerId !== imageViewer.pointerId) return;
    imageViewer.offsetX = imageViewer.startOffsetX + event.clientX - imageViewer.startX;
    imageViewer.offsetY = imageViewer.startOffsetY + event.clientY - imageViewer.startY;
    renderImageViewerTransform();
  });
  const endImageViewerPan = (event) => {
    if (!imageViewer.dragging || event.pointerId !== imageViewer.pointerId) return;
    imageViewer.dragging = false;
    imageViewer.pointerId = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    renderImageViewerTransform();
  };
  $('#imageViewerStage').addEventListener('pointerup', endImageViewerPan);
  $('#imageViewerStage').addEventListener('pointercancel', endImageViewerPan);
  document.addEventListener('keydown', (event) => {
    if (!isImageViewerOpen()) return;
    if (event.key === 'Escape') closeImageViewer();
    else if (event.key === 'ArrowLeft') changeImageViewerImage(-1);
    else if (event.key === 'ArrowRight') changeImageViewerImage(1);
    else if (event.key === '+' || event.key === '=') setImageViewerScale(imageViewer.scale + imageViewerScaleStep);
    else if (event.key === '-') setImageViewerScale(imageViewer.scale - imageViewerScaleStep);
    else if (event.key === '0') resetImageViewerTransform();
    else return;
    event.preventDefault();
  });
  $('#rescanMods').addEventListener('click', rescanMods);
  $('#selectAllMods').addEventListener('click', selectAllMods);
  $('#updateMods')?.addEventListener('click', () => updateInstalledMods());
  $('#addDependencies').addEventListener('click', addDependencies);
  $('#deleteSelectedMods').addEventListener('click', deleteSelectedInstalledMods);
  $('#clearSelection').addEventListener('click', () => {
    const removedMods = [...state.selectedIds].map(modLogDescriptor);
    state.selectedIds.clear();
    state.requirements.clear();
    markSelectionChanged();
    recordModActions(removedMods.map((mod) => ({ action: 'disable', source: 'user', mod })));
  });

  $('#importPreset').addEventListener('click', openImportDialog);
  $('#newPreset').addEventListener('click', () => {
    selectPreset(null, { dirty: true });
    setView('mods');
  });
  $('#presetList').addEventListener('click', (event) => {
    const item = event.target.closest('[data-preset-id]');
    if (!item) return;
    selectPreset(state.presets.find((preset) => preset.id === item.dataset.presetId));
  });
  $('#presetModList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-installed-mod]');
    if (button && !button.disabled) deleteInstalledMod(button.dataset.deleteInstalledMod);
  });
  $('#editPreset').addEventListener('click', editActivePreset);
  $('#exportPreset').addEventListener('click', exportPreset);
  $('#sharePreset').addEventListener('click', sharePreset);
  $('#shareFilePreset').addEventListener('click', sharePresetFile);
  $('#transferPresetMods').addEventListener('click', openPresetTransferDialog);
  $('#deletePreset').addEventListener('click', deleteActivePreset);
  $('#presetTransferForm').addEventListener('submit', (event) => {
    event.preventDefault();
    transferActivePresetMods();
  });
  $$('input[name="presetTransferMode"]').forEach((input) => {
    input.addEventListener('change', renderPresetTransferDialog);
  });
  $('#presetForm').addEventListener('submit', (event) => {
    event.preventDefault();
    savePreset();
  });
  $('#addToPresetForm').addEventListener('submit', (event) => {
    event.preventDefault();
    addWorkshopModToPreset();
  });
  $('#addToPresetDialog').addEventListener('close', () => {
    pendingWorkshopMod = null;
  });
  $('#importPresetFile').addEventListener('click', importPresetFile);
  $('#pastePresetJson').addEventListener('click', pastePresetJson);
  $$('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    if (dialog?.open) dialog.close('cancel');
  }));
  $('#deleteModForm').addEventListener('submit', (event) => {
    event.preventDefault();
    finishModDeletionConfirmation(true);
  });
  $('#cancelDeleteMod').addEventListener('click', () => finishModDeletionConfirmation(false));
  $('#cancelDeleteModTop').addEventListener('click', () => finishModDeletionConfirmation(false));
  $('#deleteModDialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    finishModDeletionConfirmation(false);
  });
  $('#deleteModDialog').addEventListener('close', () => {
    if (!pendingModDeletionConfirmation) return;
    const resolve = pendingModDeletionConfirmation;
    pendingModDeletionConfirmation = null;
    resolve(false);
  });
  $('#importForm').addEventListener('submit', (event) => {
    event.preventDefault();
    importPresetText();
  });

  $$('[data-browse]').forEach((button) => button.addEventListener('click', () => browseSetting(button.dataset.browse)));
  $('#saveSettings').addEventListener('click', () => saveSettings(true));
  $('#saveParameters').addEventListener('click', () => saveSettings(true));
  $('#openModLogs').addEventListener('click', openModLogs);
  $('#footerModLogs').addEventListener('click', openModLogs);
  $('#closeModLogsTop').addEventListener('click', () => $('#modLogsDialog').close());
  $('#closeModLogs').addEventListener('click', () => $('#modLogsDialog').close());
  $('#clearModLogs').addEventListener('click', clearModLogs);
  $('#modLogsSearch').addEventListener('input', (event) => {
    state.modLogSearch = event.target.value;
    renderModLogs();
  });
  $('#modLogsFilter').addEventListener('change', (event) => {
    state.modLogFilter = event.target.value;
    renderModLogs();
  });
  $('#modLogsList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-log-remove]');
    if (!button || button.disabled) return;
    removeLoggedModFromPreset(button.dataset.logRemove);
  });
  $('#modLogsDragHandle').addEventListener('pointerdown', (event) => startModLogsPanelPointerAction(event, 'move'));
  $('#modLogsResizeHandle').addEventListener('pointerdown', (event) => startModLogsPanelPointerAction(event, 'resize'));
  window.addEventListener('resize', constrainModLogsPanel);
  $('#resetSettings').addEventListener('click', async () => {
    if (!await confirmAction(t('confirm.reset'))) return;
    try {
      setBusy(true, t('busy.factoryReset'));
      await api.factoryReset();
    } catch (error) {
      setBusy(false);
      showToast(errorMessage(error), 'error');
    }
  });
  $('#checkUpdates').addEventListener('click', () => checkUpdates(false));
  $('#downloadUpdate').addEventListener('click', downloadUpdate);
  $('#installUpdate').addEventListener('click', installUpdate);
  $('#mandatoryUpdateAcknowledge').addEventListener('click', acknowledgeMandatoryUpdate);
  $('#mandatoryUpdateInstall').addEventListener('click', installUpdate);
  $('#mandatoryUpdateDialog').addEventListener('cancel', (event) => event.preventDefault());
  $('#mandatoryUpdateDialog').addEventListener('close', () => {
    if (pendingServerConnectionFailure) renderServerConnectionFailure();
  });
  $('#titlebarUpdate').addEventListener('click', handleTitlebarUpdate);
  $('#repairLauncher').addEventListener('click', repairLauncher);
  $('#openDataFolder').addEventListener('click', api.openUserData);
  $('#downloadMissingMods').addEventListener('click', downloadMissingMods);
  $('#launchGame').addEventListener('click', launchGame);
  api.onUpdateStatus(handleUpdateStatus);
  if (typeof api.onServerConnectionFailure === 'function') {
    api.onServerConnectionFailure(handleServerConnectionFailure);
  }
  window.addEventListener('focus', scheduleForegroundRefresh);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (foregroundRefreshTimer) clearTimeout(foregroundRefreshTimer);
      foregroundRefreshTimer = 0;
      cancelServerAutoRefresh();
      return;
    }
    scheduleForegroundRefresh();
  });
}

async function bootstrap() {
  applyStaticTranslations();
  bindEvents();
  try {
    setBusy(true, t('busy.loading'));
    const data = await api.bootstrap();
    state.appVersion = data.appVersion;
    state.platform = data.platform;
    state.packaged = data.packaged;
    state.updateMode = data.updateMode || (data.packaged ? 'manual' : 'development');
    state.buildIdentity = data.buildIdentity || null;
    state.settings = data.settings;
    state.language = setLanguage(data.settings.language || 'en');
    state.presets = data.presets;
    state.installedMods = data.installedMods;
    state.modLogCount = Number(data.modLogCount || 0);
    try {
      state.modDownloadStatus = await api.getModDownloadStatus();
    } catch (error) {
      showToast(errorMessage(error), 'error');
      scheduleModDownloadPoll(2000);
    }
    state.lastScan = new Date();
    restoreWorkspace(data.workspace);
    // Initialize hidden form controls once so later user actions can safely read
    // them without rendering every hidden page on each state change.
    renderSettings();
    queueWorkspaceSave();
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    setBusy(false);
    renderAll();
    if (state.packaged && state.updateMode === 'automatic') setTimeout(() => checkUpdates(true), 1500);
    if (activeModDownloadStates.has(state.modDownloadStatus?.state)) scheduleModDownloadPoll();
  }
}

bootstrap();
