const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeConfiguredPath,
  resolveGameExecutable,
  steamRootFromGamePath
} = require('../src/core/gameLocator');

test('resolves a selected Arma Reforger directory to the Steam executable', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reforger-launcher-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const gameDirectory = path.join(root, 'steamapps', 'common', 'Arma Reforger');
  const executable = path.join(gameDirectory, process.platform === 'win32' ? 'ArmaReforgerSteam.exe' : 'ArmaReforgerSteam');
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
