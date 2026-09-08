const crypto = require('node:crypto');
const path = require('node:path');

const { preserveJsonRecoveryCopy, readJsonFile, writeJsonAtomic } = require('./jsonFiles');

const MAX_ENTRIES = 1000;
const MOD_ID_PATTERN = /^[0-9A-F]{16}$/;
const ALLOWED_ACTIONS = new Set([
  'preset-add',
  'preset-update',
  'preset-remove',
  'install',
  'enable',
  'auto-enable',
  'disable',
  'auto-disable',
  'import',
  'delete',
  'error'
]);
const ALLOWED_SOURCES = new Set(['user', 'dependency', 'workshop', 'server', 'import', 'system']);

function cleanText(value, maximumLength) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, maximumLength);
}

function normalizeEntry(value, options = {}) {
  const action = cleanText(value?.action, 32);
  const modId = String(value?.modId || '').trim().toUpperCase();
  if (!ALLOWED_ACTIONS.has(action)) throw new Error('Invalid mod log action.');
  if (!MOD_ID_PATTERN.test(modId)) throw new Error('Invalid mod GUID for log entry.');

  const timestampValue = options.preserveTimestamp ? new Date(value?.timestamp) : new Date();
  const timestamp = Number.isNaN(timestampValue.getTime()) ? new Date().toISOString() : timestampValue.toISOString();
  const source = cleanText(value?.source, 24);
  return {
    id: options.preserveId && /^[0-9a-f-]{20,}$/i.test(String(value?.id || ''))
      ? String(value.id)
      : crypto.randomUUID(),
    timestamp,
    action,
    source: ALLOWED_SOURCES.has(source) ? source : 'user',
    modId,
    name: cleanText(value?.name, 160) || modId,
    version: cleanText(value?.version, 80),
    presetId: cleanText(value?.presetId, 80),
    presetName: cleanText(value?.presetName, 120),
    details: cleanText(value?.details, 500)
  };
}

class ModLogStore {
  constructor(userDataDirectory) {
    this.filePath = path.join(userDataDirectory, 'mod-logs.json');
    this.entries = [];
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const document = await readJsonFile(this.filePath, 8 * 1024 * 1024);
      const source = Array.isArray(document?.entries) ? document.entries : [];
      this.entries = source.slice(0, MAX_ENTRIES).flatMap((entry) => {
        try {
          return [normalizeEntry(entry, { preserveId: true, preserveTimestamp: true })];
        } catch {
          return [];
        }
      });
    } catch (error) {
      await preserveJsonRecoveryCopy(this.filePath, error);
      this.entries = [];
      await this.persist();
    }
    return this.list();
  }

  async append(value) {
    const entries = await this.appendMany([value]);
    return entries[0];
  }

  async appendMany(values) {
    return this.enqueue(async () => {
      const entries = (Array.isArray(values) ? values : []).slice(0, MAX_ENTRIES).map((value) => normalizeEntry(value));
      if (entries.length === 0) return [];
      const nextEntries = [...entries, ...this.entries].slice(0, MAX_ENTRIES);
      await this.persist(nextEntries);
      this.entries = nextEntries;
      return entries.map((entry) => ({ ...entry }));
    });
  }

  async list() {
    await this.writeQueue.catch(() => {});
    return this.entries.map((entry) => ({ ...entry }));
  }

  count() {
    return this.entries.length;
  }

  async clear() {
    return this.enqueue(async () => {
      await this.persist([]);
      this.entries = [];
      return true;
    });
  }

  enqueue(operation) {
    const result = this.writeQueue.catch(() => {}).then(operation);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  persist(entries = this.entries) {
    return writeJsonAtomic(this.filePath, {
      formatVersion: 1,
      entries
    });
  }
}

module.exports = ModLogStore;
