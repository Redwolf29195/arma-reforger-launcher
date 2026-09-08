const crypto = require('node:crypto');
const path = require('node:path');

const MOD_ID_PATTERN = /^[0-9A-F]{16}$/i;

function findModsArray(document) {
  if (Array.isArray(document)) return document;
  if (!document || typeof document !== 'object') return null;
  if (Array.isArray(document.game?.mods)) return document.game.mods;
  if (Array.isArray(document.mods)) return document.mods;
  if (Array.isArray(document.preset?.mods)) return document.preset.mods;
  return null;
}

function normalizeMod(rawMod) {
  if (!rawMod || typeof rawMod !== 'object') return null;

  const rawId = rawMod.modId ?? rawMod.id ?? rawMod.assetId ?? rawMod.guid;
  const modId = String(rawId ?? '').trim().toUpperCase();
  if (!MOD_ID_PATTERN.test(modId)) return null;

  const name = String(rawMod.name ?? rawMod.assetName ?? modId).trim() || modId;
  const versionValue = rawMod.version ?? rawMod.revision?.version;
  const version = versionValue === undefined || versionValue === null
    ? ''
    : String(versionValue).trim();

  return {
    modId,
    name,
    version,
    required: rawMod.required !== false
  };
}

function derivePresetName(sourceName) {
  if (!sourceName) return 'Новый пресет';
  const extension = path.extname(sourceName);
  return path.basename(sourceName, extension) || 'Новый пресет';
}

function normalizePreset(document, options = {}) {
  const modsArray = findModsArray(document);
  if (!modsArray) {
    throw new Error('В JSON не найден массив game.mods или mods.');
  }

  const seen = new Set();
  const mods = [];
  for (const rawMod of modsArray) {
    const mod = normalizeMod(rawMod);
    if (!mod || seen.has(mod.modId)) continue;
    seen.add(mod.modId);
    mods.push(mod);
  }

  if (mods.length === 0) {
    throw new Error('JSON не содержит корректных GUID модов.');
  }

  const now = new Date().toISOString();
  return {
    formatVersion: 1,
    id: options.id || crypto.randomUUID(),
    name: String(options.name || document?.name || derivePresetName(options.sourceName)).trim(),
    sourceName: options.sourceName || '',
    createdAt: options.createdAt || now,
    updatedAt: now,
    mods
  };
}

function toServerJson(preset) {
  return {
    game: {
      mods: preset.mods.map((mod) => {
        const result = {
          modId: mod.modId,
          name: mod.name
        };
        if (mod.version) result.version = mod.version;
        if (mod.required === false) result.required = false;
        return result;
      })
    }
  };
}

function toServerModsText(mods) {
  const normalized = normalizePreset({ mods }, { name: 'Server mods' });
  return `${JSON.stringify(toServerJson(normalized), null, 2)}\n`;
}

function toServerModText(mod) {
  const normalized = normalizeMod(mod);
  if (!normalized) throw new Error('Некорректный GUID мода.');
  const result = {
    modId: normalized.modId,
    name: normalized.name
  };
  if (normalized.version) result.version = normalized.version;
  if (normalized.required === false) result.required = false;
  return `${JSON.stringify(result, null, 2)}\n`;
}

function stripMarkdownFence(value) {
  const source = String(value ?? '').replace(/^\uFEFF/, '').trim();
  const match = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : source;
}

function parseJsonDocument(text) {
  const source = stripMarkdownFence(text);
  if (!source) throw new Error('Вставьте JSON с модами.');

  const withoutTrailingComma = source.replace(/,\s*$/, '');
  const attempts = [source];

  // The Reforger manager can be copied as a comma-separated object fragment.
  if (source.startsWith('{')) attempts.push(`[${withoutTrailingComma}]`);
  if (/^["']?(?:game|mods)["']?\s*:/i.test(source)) attempts.push(`{${withoutTrailingComma}}`);

  let parseError;
  for (const candidate of [...new Set(attempts)]) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      parseError = error;
    }
  }

  throw new Error(`Некорректный JSON: ${parseError?.message || 'не удалось прочитать данные'}`);
}

function parsePresetText(text, options = {}) {
  const document = parseJsonDocument(text);
  return normalizePreset(document, options);
}

module.exports = {
  MOD_ID_PATTERN,
  findModsArray,
  normalizeMod,
  normalizePreset,
  parseJsonDocument,
  parsePresetText,
  toServerJson,
  toServerModText,
  toServerModsText
};
