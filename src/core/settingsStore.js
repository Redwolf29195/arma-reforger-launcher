const path = require('node:path');
const { preserveJsonRecoveryCopy, readJsonFile, writeJsonAtomic } = require('./jsonFiles');

const ALLOWED_SETTINGS = new Set([
  'gameExecutable',
  'addonsDirectory',
  'downloadRoot',
  'profileDirectory',
  'noSplash',
  'allowVersionMismatch',
  'additionalArguments',
  'defaultPresetId',
  'autoUpdate',
  'showModLogsFooter',
  'autoAddDependencies',
  'confirmModDeletion',
  'advancedMode',
  'favoriteMods',
  'favoriteServers',
  'language'
]);

const MOD_ID_PATTERN = /^[0-9a-f]{16}$/i;
const SERVER_ID_PATTERN = /^(?:\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function sanitizeFavoriteMods(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const modIds = [];
  for (const entry of value) {
    const modId = String(typeof entry === 'string' ? entry : entry?.modId || '').trim().toUpperCase();
    if (!MOD_ID_PATTERN.test(modId) || seen.has(modId)) continue;
    seen.add(modId);
    modIds.push(modId);
    if (modIds.length >= 500) break;
  }
  return modIds;
}

function sanitizeFavoriteServers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const servers = [];
  for (const entry of value) {
    const id = String(entry?.id || '').trim().toLowerCase();
    if (!SERVER_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    servers.push({
      id,
      name: String(entry?.name || id).trim().slice(0, 180) || id,
      address: String(entry?.address || '').trim().slice(0, 260),
      playerCount: Math.max(0, Number(entry?.playerCount) || 0),
      playerLimit: Math.max(0, Number(entry?.playerLimit) || 0),
      queueCount: Math.max(0, Number(entry?.queueCount) || 0),
      scenarioName: String(entry?.scenarioName || '').trim().slice(0, 180),
      gameVersion: String(entry?.gameVersion || '').trim().slice(0, 40),
      official: entry?.official === true,
      passwordProtected: entry?.passwordProtected === true,
      totalModSize: Math.max(0, Number(entry?.totalModSize) || 0),
      tags: (Array.isArray(entry?.tags) ? entry.tags : []).map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean).slice(0, 20),
      status: String(entry?.status || '').trim().toLowerCase().slice(0, 20),
      lastUpdated: String(entry?.lastUpdated || '').trim().slice(0, 60)
    });
    if (servers.length >= 100) break;
  }
  return servers;
}

class SettingsStore {
  constructor(userDataDirectory, detectedDefaults = {}) {
    this.userDataDirectory = userDataDirectory;
    this.filePath = path.join(userDataDirectory, 'settings.json');
    this.defaults = {
      gameExecutable: detectedDefaults.gameExecutable || '',
      addonsDirectory: detectedDefaults.addonsDirectory || '',
      downloadRoot: detectedDefaults.addonsDirectory
        ? path.dirname(detectedDefaults.addonsDirectory)
        : '',
      profileDirectory: path.join(userDataDirectory, 'reforger'),
      noSplash: true,
      allowVersionMismatch: true,
      additionalArguments: '',
      defaultPresetId: '',
      autoUpdate: true,
      showModLogsFooter: true,
      autoAddDependencies: true,
      confirmModDeletion: true,
      advancedMode: false,
      favoriteMods: [],
      favoriteServers: [],
      language: 'en'
    };
    this.value = { ...this.defaults };
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const stored = await readJsonFile(this.filePath, 1024 * 1024);
      this.value = this.sanitize({ ...this.defaults, ...stored });
    } catch (error) {
      await preserveJsonRecoveryCopy(this.filePath, error);
      this.value = { ...this.defaults };
      await this.persist();
    }
    return this.get();
  }

  get() {
    return {
      ...this.value,
      favoriteMods: [...this.value.favoriteMods],
      favoriteServers: this.value.favoriteServers.map((server) => ({ ...server, tags: [...server.tags] }))
    };
  }

  async update(patch) {
    return this.enqueue(async () => {
      const next = this.sanitize({ ...this.value, ...patch });
      await this.persist(next);
      this.value = next;
      return this.get();
    });
  }

  async reset() {
    return this.enqueue(async () => {
      const next = this.sanitize(this.defaults);
      await this.persist(next);
      this.value = next;
      return this.get();
    });
  }

  enqueue(operation) {
    const pending = this.writeQueue.then(operation);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  sanitize(value) {
    const result = { ...this.defaults };
    for (const [key, fieldValue] of Object.entries(value || {})) {
      if (ALLOWED_SETTINGS.has(key)) result[key] = fieldValue;
    }

    for (const key of ['gameExecutable', 'addonsDirectory', 'downloadRoot', 'profileDirectory', 'additionalArguments', 'defaultPresetId']) {
      result[key] = String(result[key] ?? '').trim();
    }
    if (!/^[0-9a-f-]{20,}$/i.test(result.defaultPresetId)) result.defaultPresetId = '';
    result.noSplash = result.noSplash !== false;
    result.allowVersionMismatch = result.allowVersionMismatch === true;
    result.autoUpdate = result.autoUpdate !== false;
    result.showModLogsFooter = result.showModLogsFooter !== false;
    result.autoAddDependencies = result.autoAddDependencies !== false;
    result.confirmModDeletion = result.confirmModDeletion !== false;
    result.advancedMode = result.advancedMode === true;
    result.favoriteMods = sanitizeFavoriteMods(result.favoriteMods);
    result.favoriteServers = sanitizeFavoriteServers(result.favoriteServers);
    result.language = result.language === 'ru' ? 'ru' : 'en';
    return result;
  }

  async persist(value = this.value) {
    await writeJsonAtomic(this.filePath, value);
  }
}

module.exports = SettingsStore;
