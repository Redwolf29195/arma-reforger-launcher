const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePreset,
  parsePresetText,
  toServerJson,
  toServerModText,
  toServerModsText
} = require('../src/core/presetParser');

test('imports mods from a standard Arma Reforger server JSON', () => {
  const preset = normalizePreset({
    game: {
      mods: [
        { modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.10' },
        { modId: '646b350f36c6d3e4', name: 'Duplicate', version: '1.0.0' },
        { modId: 'invalid', name: 'Invalid' }
      ]
    }
  }, { name: 'Test' });

  assert.equal(preset.name, 'Test');
  assert.equal(preset.mods.length, 1);
  assert.deepEqual(preset.mods[0], {
    modId: '646B350F36C6D3E4',
    name: 'Breachable Doors',
    version: '1.1.10',
    required: true
  });
});

test('exports only the standard game.mods fields', () => {
  const document = toServerJson({
    mods: [
      { modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.10', required: true },
      { modId: '618C2492CC62D0D5', name: 'Gs BTR-90', version: '', required: false }
    ]
  });

  assert.deepEqual(document, {
    game: {
      mods: [
        { modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.10' },
        { modId: '618C2492CC62D0D5', name: 'Gs BTR-90', required: false }
      ]
    }
  });
});

test('copies a ready server mod JSON document with normalized exact versions', () => {
  const document = JSON.parse(toServerModsText([
    { modId: '646b350f36c6d3e4', name: 'Breachable Doors', version: '1.1.10', sizeBytes: 123 },
    { modId: '646B350F36C6D3E4', name: 'Duplicate', version: '0.0.1' },
    { modId: '618C2492CC62D0D5', name: 'Gs BTR-90', version: '3.1.0' }
  ]));

  assert.deepEqual(document, {
    game: {
      mods: [
        { modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.10' },
        { modId: '618C2492CC62D0D5', name: 'Gs BTR-90', version: '3.1.0' }
      ]
    }
  });
});

test('copies one ready mod object for a server mod array', () => {
  assert.equal(toServerModText({
    modId: '646b350f36c6d3e4',
    name: 'Breachable Doors',
    version: '1.1.10'
  }), `${JSON.stringify({
    modId: '646B350F36C6D3E4',
    name: 'Breachable Doors',
    version: '1.1.10'
  }, null, 2)}\n`);
});

test('imports a copied comma-separated mod fragment', () => {
  const preset = parsePresetText(`
    { "modId": "646B350F36C6D3E4", "name": "Breachable Doors", "version": "1.1.10" },
    { "modId": "618C2492CC62D0D5", "name": "Gs BTR-90", "version": "3.1.0" },
  `, { name: 'Shared preset' });

  assert.equal(preset.name, 'Shared preset');
  assert.equal(preset.mods.length, 2);
  assert.equal(preset.mods[1].modId, '618C2492CC62D0D5');
});

test('imports JSON copied from a markdown code block', () => {
  const preset = parsePresetText('```json\n[{"modId":"646B350F36C6D3E4"}]\n```');
  assert.equal(preset.mods.length, 1);
});
