const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  GAME_EXECUTABLE, STEAM_APP_ID, discoverLinuxSteam, findLinuxGameProfileDirectories,
  linuxSteamRootCandidates, parseValveKeyValues, protonPrefixCandidates, readSteamLibraries
} = require('../src/core/steamLinux');

const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-linux-discovery-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function install(library, name = 'Arma Reforger', appId = STEAM_APP_ID) {
  const gameDirectory = path.join(library, 'steamapps', 'common', name);
  await fs.mkdir(gameDirectory, { recursive: true });
  await fs.writeFile(path.join(library, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`),
    `"AppState" { "appid" "${appId}" "installdir" ${quote(name)} }`);
  const executable = path.join(gameDirectory, GAME_EXECUTABLE);
  await fs.writeFile(executable, 'fixture, never executed');
  return executable;
}

test('Linux Steam candidates include native aliases, absolute XDG paths and Flatpak discovery', () => {
  const homeDirectory = path.join(os.tmpdir(), 'linux-home');
  const data = path.join(homeDirectory, 'custom-data');
  const explicit = path.join(homeDirectory, 'custom-steam');
  const roots = linuxSteamRootCandidates({ homeDirectory, env: { XDG_DATA_HOME: data, STEAM_PATH: explicit } });
  for (const expected of [explicit, path.join(data, 'Steam'), path.join(homeDirectory, '.local', 'share', 'Steam'),
    path.join(homeDirectory, '.steam', 'steam'), path.join(homeDirectory, '.steam', 'root'),
    path.join(homeDirectory, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')]) {
    assert.ok(roots.includes(expected), expected);
  }
  assert.equal(roots[0], explicit);
  assert.equal(new Set(roots).size, roots.length);
  assert.equal(linuxSteamRootCandidates({ homeDirectory, env: { XDG_DATA_HOME: 'relative' } })[0],
    path.join(homeDirectory, '.local', 'share', 'Steam'));
});

test('Valve parser preserves escapes and ignores comments without treating quoted braces as structure', () => {
  const data = parseValveKeyValues(`\ufeff// Header\n"root" { "label" ${quote('A "quoted" {name}')} "path" ${quote('D:\\Games')} // line\n bare value }`);
  assert.equal(data.root.label, 'A "quoted" {name}');
  assert.equal(data.root.path, 'D:\\Games');
  assert.equal(data.root.bare, 'value');
  assert.equal(Object.getPrototypeOf(data), null);
  assert.throws(() => parseValveKeyValues('"x" { "y" "missing end"'), /Unterminated/);
  assert.throws(() => parseValveKeyValues('"x" "unterminated'), /Unterminated/);
  assert.throws(() => parseValveKeyValues('}'), /Unexpected/);
  assert.throws(() => parseValveKeyValues('a'.repeat(1024 * 1024 + 1)), /too large/);
});

test('modern and legacy library VDFs locate multiple libraries and ignore unrelated metadata paths', async context => {
  const root = await fixture(context);
  const first = path.join(root, 'Steam');
  const second = path.join(root, 'External library');
  const third = path.join(root, 'Игры');
  await fs.mkdir(path.join(first, 'steamapps'), { recursive: true });
  const vdfPath = path.join(first, 'steamapps', 'libraryfolders.vdf');
  await fs.writeFile(vdfPath, `"libraryfolders" { "0" { "path" ${quote(first)} "apps" { "${STEAM_APP_ID}" "123" } }
    "1" { "path" ${quote(second)} } "2" ${quote(third)} "TimeNextStatsReport" "123" "other" { "path" "/ignored" } }`);
  assert.deepEqual(await readSteamLibraries(first), [first, second, third]);
  await fs.writeFile(vdfPath, `"LibraryFolders" { "TimeNextStatsReport" "123" "1" ${quote(second)} "2" "relative-library" }`);
  assert.deepEqual(await readSteamLibraries(first), [first, second]);
  await fs.writeFile(vdfPath, '"libraryfolders" { "0" { "path" "unterminated');
  assert.deepEqual(await readSteamLibraries(first), [first]);
});

test('discovers the installed Windows game from a secondary library manifest with a custom directory', async context => {
  const homeDirectory = await fixture(context);
  const steam = path.join(homeDirectory, '.local', 'share', 'Steam');
  const library = path.join(homeDirectory, 'Игры на втором диске');
  await fs.mkdir(path.join(steam, 'steamapps'), { recursive: true });
  const executable = await install(library, 'Reforger custom');
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" ${quote(steam)} } "1" { "path" ${quote(library)} } }`);
  const found = await discoverLinuxSteam({ homeDirectory, env: {} });
  assert.deepEqual(found.libraries, [await fs.realpath(steam), await fs.realpath(library)]);
  assert.equal(found.installations.length, 1);
  assert.equal(found.installations[0].gameExecutable, executable);
  assert.equal(found.installations[0].protonPrefix, path.join(library, 'steamapps', 'compatdata', STEAM_APP_ID, 'pfx'));
});

test('automatic discovery rejects wrong app manifests, incomplete installs and escaping installdir values', async context => {
  const root = await fixture(context);
  const library = path.join(root, 'Steam');
  const executable = await install(library, 'Arma Reforger', '999');
  const options = { steamRoots: [library], homeDirectory: root, env: {} };
  assert.deepEqual((await discoverLinuxSteam(options)).installations, []);
  const manifestPath = path.join(library, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`);
  await fs.writeFile(manifestPath, `"AppState" { "appid" "${STEAM_APP_ID}" "installdir" "../common/Arma Reforger" }`);
  assert.deepEqual((await discoverLinuxSteam(options)).installations, []);
  await fs.writeFile(manifestPath, `"AppState" { "appid" "${STEAM_APP_ID}" "installdir" "Arma Reforger" }`);
  await fs.unlink(executable);
  await fs.writeFile(path.join(path.dirname(executable), 'ArmaReforgerSteam'), 'not the Proton game');
  assert.deepEqual((await discoverLinuxSteam(options)).installations, []);
});

test('deduplicates Steam root symlinks and library aliases by their actual directories', async context => {
  const root = await fixture(context);
  const steam = path.join(root, 'Steam');
  await install(steam);
  const alias = path.join(root, 'alias');
  await fs.symlink(steam, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const found = await discoverLinuxSteam({ steamRoots: [alias, steam], homeDirectory: root, env: {} });
  assert.deepEqual(found.roots, [await fs.realpath(steam)]);
  assert.equal(found.installations.length, 1);
});

test('finds only existing Proton profiles, prioritizes the selected game and resolves Documents aliases', async context => {
  const root = await fixture(context);
  const first = path.join(root, 'First library');
  const selected = path.join(root, 'Selected library');
  await install(first);
  const executable = await install(selected);
  const firstPrefix = protonPrefixCandidates('', [first])[0];
  const selectedPrefix = protonPrefixCandidates(executable)[0];
  const firstProfile = path.join(firstPrefix, 'drive_c', 'users', 'steamuser', 'Documents', 'My Games', 'ArmaReforger');
  const selectedDocuments = path.join(selectedPrefix, 'drive_c', 'users', 'steamuser', 'Documents');
  const selectedProfile = path.join(selectedDocuments, 'My Games', 'ArmaReforger');
  const legacyProfile = path.join(selectedPrefix, 'drive_c', 'users', 'oldplayer', 'My Documents', 'My Games', 'ArmaReforger');
  await Promise.all([firstProfile, selectedProfile, legacyProfile].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.symlink(selectedDocuments, path.join(path.dirname(selectedDocuments), 'My Documents'), process.platform === 'win32' ? 'junction' : 'dir');
  const profiles = await findLinuxGameProfileDirectories(executable, { steamRoots: [first, selected], homeDirectory: root, env: {} });
  assert.deepEqual(profiles, [await fs.realpath(selectedProfile), await fs.realpath(legacyProfile), await fs.realpath(firstProfile)]);
  assert.deepEqual(await findLinuxGameProfileDirectories('', { steamRoots: [], homeDirectory: root, env: {} }), []);
});
