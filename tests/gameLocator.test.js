const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeConfiguredPath,
  findAddonsDirectory,
  findGameExecutable,
  resolveGameExecutable,
  steamRootFromGamePath
} = require('../src/core/gameLocator');

test('resolves a selected Arma Reforger directory to the Steam executable', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-launcher-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const gameDirectory = path.join(root, 'steamapps', 'common', 'Arma Reforger');
  const executable = path.join(gameDirectory, process.platform === 'darwin' ? 'ArmaReforgerSteam' : 'ArmaReforgerSteam.exe');
  await fs.mkdir(gameDirectory, { recursive: true });
  await fs.writeFile(executable, 'test');

  assert.equal(await resolveGameExecutable(gameDirectory), executable);
  assert.equal(await resolveGameExecutable(`"${gameDirectory}"`), executable);
});

test('does not accept an arbitrary existing file as the game', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-launcher-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const toolsExecutable = path.join(root, 'ArmaReforgerWorkbench.exe');
  await fs.writeFile(toolsExecutable, 'test');

  assert.equal(await resolveGameExecutable(toolsExecutable), '');
});

test('derives the Steam root from a library game path', () => {
  const gamePath = path.join('C:\\', 'Programs', 'Steam', 'steamapps', 'common', 'Arma Reforger');
  const expected = path.join('C:\\', 'Programs', 'Steam');
  assert.equal(steamRootFromGamePath(gamePath), expected);
  assert.equal(normalizeConfiguredPath(`"${gamePath}"`), gamePath);
});

test('Linux resolves the Windows Steam executable for Proton and preserves explicit Windows resolution', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-proton-game-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'steamapps', 'common', 'Arma Reforger');
  await fs.mkdir(directory, { recursive: true });
  const executable = path.join(directory, 'ArmaReforgerSteam.exe');
  await fs.writeFile(executable, 'fixture');
  assert.equal(await resolveGameExecutable(directory, { platform: 'linux' }), executable);
  assert.equal(await resolveGameExecutable(root, { platform: 'linux' }), executable);
  assert.equal(await resolveGameExecutable(executable, { platform: 'win32' }), executable);
  const nativeName = path.join(directory, 'ArmaReforgerSteam');
  await fs.writeFile(nativeName, 'not the Windows game');
  assert.equal(await resolveGameExecutable(nativeName, { platform: 'linux' }), '');
});

test('Linux automatic detection uses manifests in secondary libraries and avoids unrelated executables', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-proton-library-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const steam = path.join(root, 'Steam');
  const library = path.join(root, 'Another library');
  const directory = path.join(library, 'steamapps', 'common', 'Custom Reforger');
  await fs.mkdir(path.join(steam, 'steamapps'), { recursive: true });
  await fs.mkdir(directory, { recursive: true });
  const executable = path.join(directory, 'ArmaReforgerSteam.exe');
  await fs.writeFile(executable, 'fixture');
  await fs.writeFile(path.join(library, 'steamapps', 'appmanifest_1874880.acf'), '"AppState" { "appid" "1874880" "installdir" "Custom Reforger" }');
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "1" { "path" "${library.replaceAll('\\', '\\\\')}" } }`);
  const options = { platform: 'linux', homeDirectory: root, env: {}, steamRoots: [steam] };
  assert.equal(await findGameExecutable('', options), executable);
  assert.equal(await findGameExecutable(path.join(root, 'missing.exe'), options), executable);
  assert.equal(await findGameExecutable('', { ...options, steamRoots: [] }), '');
});

test('Linux addons discovery follows the selected Proton profile, including before its first download', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-proton-addons-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = path.join(root, 'Steam');
  const executable = path.join(library, 'steamapps', 'common', 'Arma Reforger', 'ArmaReforgerSteam.exe');
  const profile = path.join(library, 'steamapps', 'compatdata', '1874880', 'pfx', 'drive_c', 'users', 'steamuser', 'Documents', 'My Games', 'ArmaReforger');
  await fs.mkdir(profile, { recursive: true });
  const options = { platform: 'linux', homeDirectory: root, env: {}, steamRoots: [library] };
  assert.equal(await findAddonsDirectory(executable, options), path.join(profile, 'addons'));
  await fs.mkdir(path.join(profile, 'addons'));
  assert.equal(await findAddonsDirectory(executable, options), path.join(profile, 'addons'));
  assert.equal(await findAddonsDirectory({ ...options, steamRoots: [] }), path.join(root, '.local', 'share', 'ArmaReforger', 'addons'));
});
