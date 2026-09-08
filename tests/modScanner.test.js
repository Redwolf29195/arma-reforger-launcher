const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { assessPreset, getMissingPresetMods, resolvePresetDependencies, scanMods } = require('../src/core/modScanner');

test('reads ServerData.json without scanning mod archives', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-launcher-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const modDirectory = path.join(root, 'Example_646B350F36C6D3E4');
  await fs.mkdir(modDirectory);
  await fs.writeFile(path.join(modDirectory, 'ServerData.json'), JSON.stringify({
    id: '646B350F36C6D3E4',
    name: 'Example',
    revision: {
      version: '1.2.3',
      gameVersion: '1.7.0.54',
      corrupted: false,
      dependencies: [
        { assetId: '618C2492CC62D0D5', assetName: 'Dependency', version: '2.0.0' }
      ]
    }
  }));
  await fs.writeFile(path.join(modDirectory, 'data.pak'), 'not-read-by-scanner');

  const mods = await scanMods(root);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].version, '1.2.3');
  assert.equal(mods[0].dependencies[0].modId, '618C2492CC62D0D5');
});

test('merges dependencies from addon.gproj when Workshop metadata omits them', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-launcher-gproj-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const modDirectory = path.join(root, 'Example_646B350F36C6D3E4');
  await fs.mkdir(modDirectory);
  await fs.writeFile(path.join(modDirectory, 'ServerData.json'), JSON.stringify({
    id: '646B350F36C6D3E4',
    name: 'Example',
    revision: { version: '1.0.0', corrupted: false, dependencies: [] }
  }));
  await fs.writeFile(path.join(modDirectory, 'addon.gproj'), `GameProject {
    GUID "646B350F36C6D3E4"
    TITLE "Example"
    Dependencies { "58D0FB3206B6F859" "618C2492CC62D0D5" }
  }`);

  const mods = await scanMods(root);
  assert.deepEqual(mods[0].dependencies, [
    { modId: '618C2492CC62D0D5', name: '', version: '' }
  ]);
});

test('uses the highest installed revision even when an older copy was touched later', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-launcher-revisions-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const modId = '646B350F36C6D3E4';
  const oldDirectory = path.join(root, `Example-old_${modId}`);
  const newDirectory = path.join(root, `Example-new_${modId}`);
  await fs.mkdir(oldDirectory);
  await fs.mkdir(newDirectory);
  const oldMetadata = path.join(oldDirectory, 'ServerData.json');
  const newMetadata = path.join(newDirectory, 'ServerData.json');
  await fs.writeFile(oldMetadata, JSON.stringify({
    id: modId,
    name: 'Example',
    revision: { version: '1.0.0', corrupted: false, dependencies: [] }
  }));
  await fs.writeFile(newMetadata, JSON.stringify({
    id: modId,
    name: 'Example',
    revision: { version: '2.0.0', corrupted: false, dependencies: [] }
  }));
  await fs.utimes(oldMetadata, new Date('2026-01-03T00:00:00Z'), new Date('2026-01-03T00:00:00Z'));
  await fs.utimes(newMetadata, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));

  const mods = await scanMods(root);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].version, '2.0.0');
  assert.equal(mods[0].directoryPath, newDirectory);
});

test('does not report harmless version formatting differences as a mismatch', () => {
  const result = assessPreset({ mods: [
    { modId: '646B350F36C6D3E4', name: 'Example', version: 'v2.0' }
  ] }, [
    { modId: '646B350F36C6D3E4', name: 'Example', version: '2.0.0', corrupted: false }
  ]);

  assert.equal(result[0].status, 'ready');
});

test('reports version mismatch and missing mods', () => {
  const result = assessPreset({ mods: [
    { modId: '646B350F36C6D3E4', name: 'Example', version: '2.0.0' },
    { modId: '618C2492CC62D0D5', name: 'Missing', version: '1.0.0' }
  ] }, [
    { modId: '646B350F36C6D3E4', name: 'Example', version: '1.0.0', corrupted: false }
  ]);

  assert.equal(result[0].status, 'version-mismatch');
  assert.equal(result[1].status, 'missing');
});

test('selects only absent mods for download', () => {
  const result = getMissingPresetMods({ mods: [
    { modId: '646B350F36C6D3E4', name: 'Different version', version: '2.0.0' },
    { modId: '618C2492CC62D0D5', name: 'Missing', version: '1.0.0' },
    { modId: '5994AD5A9F33BE57', name: 'Corrupted', version: '1.0.0' }
  ] }, [
    { modId: '646B350F36C6D3E4', name: 'Different version', version: '1.0.0', corrupted: false },
    { modId: '5994AD5A9F33BE57', name: 'Corrupted', version: '1.0.0', corrupted: true }
  ]);

  assert.deepEqual(result.map((mod) => mod.modId), ['618C2492CC62D0D5']);
});

test('resolves installed dependencies before selected mods', () => {
  const result = resolvePresetDependencies({ mods: [
    { modId: '646B350F36C6D3E4', name: 'Main', version: '1.0.0' }
  ] }, [
    {
      modId: '646B350F36C6D3E4',
      name: 'Main',
      version: '1.0.0',
      dependencies: [{ modId: '618C2492CC62D0D5', name: 'Dependency', version: '2.0.0' }]
    },
    {
      modId: '618C2492CC62D0D5',
      name: 'Dependency',
      version: '2.0.0',
      dependencies: []
    }
  ]);

  assert.deepEqual(result.mods.map((mod) => mod.modId), [
    '618C2492CC62D0D5',
    '646B350F36C6D3E4'
  ]);
  assert.equal(result.selectedCount, 1);
  assert.equal(result.dependencyCount, 1);
});

test('keeps only explicitly selected mods when automatic dependencies are disabled', () => {
  const result = resolvePresetDependencies({ mods: [
    { modId: '646B350F36C6D3E4', name: 'Main', version: '1.0.0' }
  ] }, [
    {
      modId: '646B350F36C6D3E4',
      name: 'Main',
      version: '1.0.0',
      dependencies: [{ modId: '618C2492CC62D0D5', name: 'Dependency', version: '2.0.0' }]
    },
    {
      modId: '618C2492CC62D0D5',
      name: 'Dependency',
      version: '2.0.0',
      dependencies: []
    }
  ], { includeDependencies: false });

  assert.deepEqual(result.mods.map((mod) => mod.modId), ['646B350F36C6D3E4']);
  assert.equal(result.selectedCount, 1);
  assert.equal(result.dependencyCount, 0);
});

test('refreshes an older preset revision from the newer installed mod', () => {
  const result = resolvePresetDependencies({ mods: [
    { modId: '646B350F36C6D3E4', name: 'Main', version: '1.5.0' }
  ] }, [
    { modId: '646B350F36C6D3E4', name: 'Main', version: '2.0.0', dependencies: [] }
  ]);

  assert.equal(result.mods[0].version, '2.0.0');
});

test('retains version and corruption state when Workshop dependency metadata is malformed', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-launcher-malformed-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const modDirectory = path.join(root, 'Example_646B350F36C6D3E4');
  await fs.mkdir(modDirectory);
  await fs.writeFile(path.join(modDirectory, 'ServerData.json'), JSON.stringify({
    id: '646B350F36C6D3E4', name: 'Example', revision: {
      version: '1.2.3', corrupted: true, dependencies: { incomplete: true }
    }
  }));
  const [mod] = await scanMods(root);
  assert.equal(mod.version, '1.2.3');
  assert.equal(mod.corrupted, true);
  assert.deepEqual(mod.dependencies, []);
  assert.equal(assessPreset({ mods: [{ modId: mod.modId }] }, [mod])[0].status, 'corrupted');
});

test('filters built-in and self dependencies from Workshop metadata', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-launcher-builtin-deps-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const modDirectory = path.join(root, 'Example_646B350F36C6D3E4');
  await fs.mkdir(modDirectory);
  await fs.writeFile(path.join(modDirectory, 'ServerData.json'), JSON.stringify({
    id: '646B350F36C6D3E4', name: 'Example', revision: { dependencies: [
      { assetId: '58D0FB3206B6F859' }, { assetId: '5614BBCCBB55ED1C' },
      { assetId: '646B350F36C6D3E4' }, { assetId: '618C2492CC62D0D5', version: '2.0.0' }
    ] }
  }));
  const mods = await scanMods(root);
  assert.deepEqual(mods[0].dependencies.map((dependency) => dependency.modId), ['618C2492CC62D0D5']);
  const result = resolvePresetDependencies({ mods: [{ modId: '646B350F36C6D3E4' }] }, mods);
  assert.deepEqual(result.missingDependencies.map((dependency) => dependency.modId), ['618C2492CC62D0D5']);
});

async function createFallbackFixture(context, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-launcher-partial-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const modId = '68B60865B7332DD6';
  const directory = path.join(root, `Example_${modId}`);
  await fs.mkdir(directory);
  for (const [name, contents] of Object.entries(files)) await fs.writeFile(path.join(directory, name), contents);
  return { root, directory, modId };
}

const LOCAL_PROJECT = 'GameProject { GUID "68B60865B7332DD6" TITLE "Local Example" Dependencies { "58D0FB3206B6F859" } }';

test('marks the observed interrupted Workshop download corrupted for pinned and unpinned presets', async (context) => {
  const { root, modId } = await createFallbackFixture(context, {
    'addon.gproj': '',
    'resourceDatabase.rdb': '',
    'data.pak': 'partially transferred archive',
    'addon.gproj_1.3.27_manifest.json': '{}',
    'data.pak_1.3.27_manifest.json': '{}'
  });
  const mods = await scanMods(root);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].corrupted, true);
  for (const version of ['', '1.3.27']) {
    assert.equal(assessPreset({ mods: [{ modId, version }] }, mods)[0].status, 'corrupted');
  }
});

test('does not treat a completed project file as a completed Workshop download', async (context) => {
  const { root } = await createFallbackFixture(context, {
    'addon.gproj': LOCAL_PROJECT,
    'data.pak': 'still downloading',
    'data.pak_1.3.27_manifest.json': '{}'
  });
  const [mod] = await scanMods(root);
  assert.equal(mod.corrupted, true);
});

test('preserves valid manual projects without Workshop completion metadata or a known version', async (context) => {
  const { root, modId } = await createFallbackFixture(context, {
    'addon.gproj': LOCAL_PROJECT,
    'data.pak': 'local packaged addon',
    'unrelated_manifest.json': '{}'
  });
  const mods = await scanMods(root);
  assert.equal(mods[0].corrupted, false);
  assert.equal(mods[0].name, 'Local Example');
  assert.equal(assessPreset({ mods: [{ modId }] }, mods)[0].status, 'ready');
  assert.equal(assessPreset({ mods: [{ modId, version: '1.3.27' }] }, mods)[0].status, 'version-unknown');
});

test('does not infer a healthy addon from only its GUID directory and archive', async (context) => {
  const { root, modId } = await createFallbackFixture(context, { 'data.pak': 'partial archive' });
  const mods = await scanMods(root);
  assert.equal(mods[0].corrupted, true);
  assert.equal(assessPreset({ mods: [{ modId }] }, mods)[0].status, 'corrupted');
});

test('does not infer a healthy addon from an empty GUID directory', async (context) => {
  const { root } = await createFallbackFixture(context, {});
  const [mod] = await scanMods(root);
  assert.equal(mod.corrupted, true);
});

test('keeps completed Workshop downloads healthy when their transfer manifests remain', async (context) => {
  const { root } = await createFallbackFixture(context, {
    'addon.gproj': LOCAL_PROJECT,
    'data.pak_1.3.27_manifest.json': '{}',
    'ServerData.json': JSON.stringify({ id: '68B60865B7332DD6', name: 'Complete', revision: { version: '1.3.27', corrupted: false } })
  });
  const [mod] = await scanMods(root);
  assert.equal(mod.corrupted, false);
  assert.equal(mod.version, '1.3.27');
  assert.equal(mod.source, 'ServerData.json');
});

test('does not conceal truncated Workshop metadata behind a valid local project', async (context) => {
  const { root } = await createFallbackFixture(context, {
    'addon.gproj': LOCAL_PROJECT,
    'ServerData.json': '{"id":'
  });
  const [mod] = await scanMods(root);
  assert.equal(mod.corrupted, true);
});

test('clears incomplete state after the engine writes successful completion metadata', async (context) => {
  const { root, directory, modId } = await createFallbackFixture(context, {
    'addon.gproj': LOCAL_PROJECT,
    'data.pak_1.3.27_manifest.json': '{}'
  });
  assert.equal((await scanMods(root))[0].corrupted, true);
  await fs.writeFile(path.join(directory, 'ServerData.json'), JSON.stringify({
    id: modId, name: 'Complete', revision: { version: '1.3.27', corrupted: false }
  }));
  const mods = await scanMods(root);
  assert.equal(assessPreset({ mods: [{ modId, version: '1.3.27' }] }, mods)[0].status, 'ready');
});
