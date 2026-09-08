const fs = require('node:fs/promises');
const path = require('node:path');
const { readJsonFile, writeJsonAtomic } = require('./jsonFiles');
const { normalizeMod, normalizePreset, parsePresetText, toServerJson } = require('./presetParser');

const PRESET_ID_PATTERN = /^[0-9a-f-]{20,}$/i;
const SERVER_ID_PATTERN = /^(?:\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

class PresetStore {
  constructor(userDataDirectory) {
    this.directory = path.join(userDataDirectory, 'presets');
    this.pendingMutation = Promise.resolve();
  }

  mutate(operation) {
    const pending = this.pendingMutation.then(operation);
    this.pendingMutation = pending.catch(() => {});
    return pending;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true });
  }

  async list() {
    await this.initialize();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const presets = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
      try {
        const preset = await readJsonFile(path.join(this.directory, entry.name), 4 * 1024 * 1024);
        if (typeof preset?.id === 'string' && PRESET_ID_PATTERN.test(preset.id)
          && `${preset.id}.json`.toLowerCase() === entry.name.toLowerCase()
          && Array.isArray(preset.mods)) presets.push(preset);
      } catch {
        // An invalid preset is ignored and left untouched for manual recovery.
      }
    }
    return presets.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async importFromFile(filePath) {
    const text = await fs.readFile(filePath, 'utf8');
    const preset = parsePresetText(text, { sourceName: path.basename(filePath) });
    await this.write(preset);
    return preset;
  }

  async importFromText(text, options = {}) {
    const preset = parsePresetText(text, {
      name: options.name,
      sourceName: options.sourceName || 'Вставленный JSON'
    });
    await this.write(preset);
    return preset;
  }

  async save(value) {
    return this.mutate(() => this.saveNow(value));
  }

  async saveNow(value) {
    const preset = normalizePreset(
      { name: value.name, mods: value.mods },
      {
        id: value.id,
        name: value.name,
        sourceName: value.sourceName,
        createdAt: value.createdAt
      }
    );
    await this.writeNow(preset);
    return preset;
  }

  async addMod(value) {
    return this.mutate(() => this.addModNow(value));
  }

  async addModNow({ presetId, presetName, mod } = {}) {
    const normalizedMod = normalizeMod(mod);
    if (!normalizedMod) throw new Error('Некорректный GUID мода.');

    const presets = await this.list();
    const targetId = String(presetId || '').trim();
    let target = targetId ? presets.find((preset) => preset.id === targetId) : null;
    const created = presets.length === 0;
    if (targetId && !target) throw new Error('Выбранный пресет не найден.');
    if (!target && !created) throw new Error('Выберите пресет.');
    if (!target) {
      target = {
        name: String(presetName || '').trim() || 'Workshop',
        mods: []
      };
    }

    const existing = target.mods.find((item) => item.modId === normalizedMod.modId);
    const nextMod = existing
      ? {
          ...existing,
          name: normalizedMod.name || existing.name,
          version: normalizedMod.version || existing.version || '',
          required: true
        }
      : normalizedMod;
    const mods = [
      ...target.mods.filter((item) => item.modId !== normalizedMod.modId),
      nextMod
    ];
    const preset = await this.saveNow({ ...target, mods });
    return {
      preset,
      presets: await this.list(),
      created,
      alreadyPresent: Boolean(existing)
    };
  }

  async saveServerPreset(value) {
    return this.mutate(() => this.saveServerPresetNow(value));
  }

  async saveServerPresetNow({ serverId, serverName, presetName, mods } = {}) {
    const normalizedServerId = String(serverId || '').trim().toLowerCase();
    if (!SERVER_ID_PATTERN.test(normalizedServerId)) {
      throw new Error('Некорректный идентификатор сервера.');
    }

    const sourceName = `server:${normalizedServerId}`;
    const presets = await this.list();
    const existing = presets.find((preset) => preset.sourceName === sourceName) || null;
    const requestedName = String(presetName || '').trim().slice(0, 80);
    const fallbackName = `Server - ${String(serverName || normalizedServerId).trim()}`.slice(0, 80);
    const preset = await this.saveNow({
      id: existing?.id,
      name: requestedName || existing?.name || fallbackName,
      sourceName,
      createdAt: existing?.createdAt,
      mods
    });
    return {
      preset,
      presets: await this.list(),
      created: !existing
    };
  }

  async removeMod(value) {
    return this.mutate(() => this.removeModNow(value));
  }

  async removeModNow({ presetId, modId } = {}) {
    const targetId = String(presetId || '').trim();
    const normalizedId = String(modId || '').trim().toUpperCase();
    if (!/^[0-9a-f-]{20,}$/i.test(targetId)) throw new Error('Выбранный пресет не найден.');
    if (!/^[0-9A-F]{16}$/.test(normalizedId)) throw new Error('Некорректный GUID мода.');

    const presets = await this.list();
    const target = presets.find((preset) => preset.id === targetId);
    if (!target) throw new Error('Выбранный пресет не найден.');
    const removedMod = target.mods.find((mod) => mod.modId === normalizedId);
    if (!removedMod) throw new Error('Мод не найден в выбранном пресете.');

    const mods = target.mods.filter((mod) => mod.modId !== normalizedId);
    let preset = null;
    if (mods.length === 0) {
      await this.removeNow(target.id);
    } else {
      preset = await this.saveNow({ ...target, mods });
    }

    return {
      preset,
      presets: await this.list(),
      removedMod,
      presetRemoved: mods.length === 0
    };
  }

  async write(preset) {
    return this.mutate(() => this.writeNow(preset));
  }

  async writeNow(preset) {
    if (typeof preset?.id !== 'string' || !PRESET_ID_PATTERN.test(preset.id)) {
      throw new Error('Некорректный идентификатор пресета.');
    }
    await this.initialize();
    await writeJsonAtomic(path.join(this.directory, `${preset.id}.json`), preset);
  }

  async remove(id) {
    return this.mutate(() => this.removeNow(id));
  }

  async removeNow(id) {
    if (!/^[0-9a-f-]{20,}$/i.test(String(id))) throw new Error('Некорректный идентификатор пресета.');
    await fs.rm(path.join(this.directory, `${id}.json`), { force: true });
  }

  async removeModFromAll(modId) {
    return this.mutate(() => this.removeModFromAllNow(modId));
  }

  async removeModFromAllNow(modId) {
    const normalizedId = String(modId || '').trim().toUpperCase();
    const presets = await this.list();
    const removedPresetIds = [];
    let updatedPresets = 0;

    for (const preset of presets) {
      const mods = preset.mods.filter((mod) => mod.modId !== normalizedId);
      if (mods.length === preset.mods.length) continue;
      if (mods.length === 0) {
        await this.removeNow(preset.id);
        removedPresetIds.push(preset.id);
        continue;
      }
      await this.saveNow({ ...preset, mods });
      updatedPresets += 1;
    }

    return {
      presets: await this.list(),
      updatedPresets,
      removedPresetIds
    };
  }

  async exportToFile(preset, filePath) {
    await writeJsonAtomic(filePath, toServerJson(preset));
  }

  async exportShareFile(preset, filePath) {
    const serverJson = toServerJson(preset);
    await writeJsonAtomic(filePath, {
      format: 'arma-reforger-launcher-preset',
      formatVersion: 1,
      name: String(preset?.name || 'Arma Reforger preset').trim(),
      exportedAt: new Date().toISOString(),
      game: serverJson.game
    });
  }

  toShareText(preset) {
    return `${JSON.stringify(toServerJson(preset), null, 2)}\n`;
  }
}

module.exports = PresetStore;
