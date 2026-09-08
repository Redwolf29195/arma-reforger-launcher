const path = require('node:path');
const { preserveJsonRecoveryCopy, readJsonFile, writeJsonAtomic } = require('./jsonFiles');
const { normalizeMod } = require('./presetParser');

const MAX_WORKSPACE_MODS = 4096;
const PRESET_ID_PATTERN = /^[0-9a-f-]{20,}$/i;

function defaultWorkspace() {
  return {
    formatVersion: 1,
    activePresetId: '',
    name: '',
    dirty: false,
    mods: []
  };
}

function sanitizeWorkspace(value) {
  const result = defaultWorkspace();
  const activePresetId = String(value?.activePresetId || '').trim();
  result.activePresetId = PRESET_ID_PATTERN.test(activePresetId) ? activePresetId : '';
  result.name = String(value?.name || '').trim().slice(0, 80);
  result.dirty = value?.dirty === true;

  const seen = new Set();
  const sourceMods = Array.isArray(value?.mods) ? value.mods.slice(0, MAX_WORKSPACE_MODS) : [];
  for (const rawMod of sourceMods) {
    const mod = normalizeMod(rawMod);
    if (!mod || seen.has(mod.modId)) continue;
    seen.add(mod.modId);
    result.mods.push(mod);
  }
  return result;
}

class WorkspaceStore {
  constructor(userDataDirectory) {
    this.filePath = path.join(userDataDirectory, 'workspace.json');
    this.value = defaultWorkspace();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      this.value = sanitizeWorkspace(await readJsonFile(this.filePath, 4 * 1024 * 1024));
    } catch (error) {
      await preserveJsonRecoveryCopy(this.filePath, error);
      this.value = defaultWorkspace();
      await this.persist();
    }
    return this.get();
  }

  get() {
    return {
      ...this.value,
      mods: this.value.mods.map((mod) => ({ ...mod }))
    };
  }

  async save(value) {
    const next = sanitizeWorkspace(value);
    return this.enqueue(() => this.saveNow(next));
  }

  async saveNow(value) {
    await this.persist(value);
    this.value = value;
    return this.get();
  }

  async removeMod(modId, removedPresetIds = []) {
    return this.enqueue(() => this.removeModNow(modId, removedPresetIds));
  }

  async removeModNow(modId, removedPresetIds) {
    const normalizedId = String(modId || '').trim().toUpperCase();
    const removedIds = new Set(removedPresetIds.map((id) => String(id)));
    const next = this.get();
    next.mods = next.mods.filter((mod) => mod.modId !== normalizedId);
    if (removedIds.has(next.activePresetId)) {
      next.activePresetId = '';
      next.dirty = next.mods.length > 0;
    }
    if (next.mods.length === 0) {
      next.name = '';
      next.dirty = false;
    }
    return this.saveNow(next);
  }

  enqueue(operation) {
    const pending = this.writeQueue.then(operation);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async persist(value = this.value) {
    await writeJsonAtomic(this.filePath, value);
  }
}

module.exports = WorkspaceStore;
module.exports.sanitizeWorkspace = sanitizeWorkspace;
