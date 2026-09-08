const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { disableWorkshopMod, syncWorkshopSelection } = require('../src/core/workshopProfile');

const ACCOUNT_NAME = 'app1874880_user123456789';

async function writeState(root, modId, value) {
  const directoryPath = path.join(root, 'profile', '.save', ACCOUNT_NAME, 'workshop');
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(path.join(directoryPath, `I${modId}.json`), JSON.stringify(value), 'utf8');
}

async function readState(root, modId) {
  const filePath = path.join(root, 'profile', '.save', ACCOUNT_NAME, 'workshop', `I${modId}.json`);
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

test('syncs the exact enabled set and preserves Workshop preferences', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-workshop-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const targetRoot = path.join(temporaryRoot, 'launcher');
  const fallbackRoot = path.join(temporaryRoot, 'standard');
  const firstId = '646B350F36C6D3E4';
  const secondId = '618C2492CC62D0D5';
  const thirdId = '59674C21AA886D57';

  await fs.mkdir(path.join(targetRoot, 'profile', '.save', ACCOUNT_NAME), { recursive: true });
  await writeState(fallbackRoot, firstId, {
    m_bIsEnabled: false,
    m_bIsFavorite: true,
    m_bIsBlocked: false,
    m_fMyRating: 0.75
  });

  const result = await syncWorkshopSelection({
    profileDirectory: targetRoot,
    fallbackProfileDirectories: [fallbackRoot],
    installedMods: [{ modId: firstId }, { modId: secondId }, { modId: thirdId }],
    enabledMods: [{ modId: firstId }, { modId: thirdId }]
  });

  assert.equal(result.enabled, 2);
  assert.equal(result.disabled, 1);
  assert.equal(result.updated, 3);
  assert.deepEqual(await readState(targetRoot, firstId), {
    m_bIsEnabled: true,
    m_bIsFavorite: true,
    m_bIsBlocked: false,
    m_fMyRating: 0.75
  });
  assert.equal((await readState(targetRoot, secondId)).m_bIsEnabled, false);
  assert.equal((await readState(targetRoot, thirdId)).m_bIsEnabled, true);

  const repeated = await syncWorkshopSelection({
    profileDirectory: targetRoot,
    fallbackProfileDirectories: [fallbackRoot],
    installedMods: [{ modId: firstId }, { modId: secondId }, { modId: thirdId }],
    enabledMods: [{ modId: firstId }, { modId: thirdId }]
  });
  assert.equal(repeated.updated, 0);
});

test('reuses the standard Steam account directory for a new launcher profile', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-account-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const targetRoot = path.join(temporaryRoot, 'launcher');
  const fallbackRoot = path.join(temporaryRoot, 'standard');
  const modId = '646B350F36C6D3E4';
  await writeState(fallbackRoot, modId, { m_bIsEnabled: false });

  const result = await syncWorkshopSelection({
    profileDirectory: targetRoot,
    fallbackProfileDirectories: [fallbackRoot],
    installedMods: [{ modId }],
    enabledMods: [{ modId }]
  });

  assert.equal(result.skipped, false);
  assert.equal((await readState(targetRoot, modId)).m_bIsEnabled, true);
});

test('disables a deleted mod in launcher and standard Workshop profiles', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-disable-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const launcherRoot = path.join(temporaryRoot, 'launcher');
  const standardRoot = path.join(temporaryRoot, 'standard');
  const modId = '646B350F36C6D3E4';
  await writeState(launcherRoot, modId, { m_bIsEnabled: true, m_bIsFavorite: true });
  await writeState(standardRoot, modId, { m_bIsEnabled: true, m_bIsFavorite: false });

  const result = await disableWorkshopMod({
    modId,
    profileDirectories: [launcherRoot, standardRoot]
  });

  assert.equal(result.updated, 2);
  assert.equal((await readState(launcherRoot, modId)).m_bIsEnabled, false);
  assert.equal((await readState(launcherRoot, modId)).m_bIsFavorite, true);
  assert.equal((await readState(standardRoot, modId)).m_bIsEnabled, false);
});

test('serializes 30 concurrent selections and keeps the final enabled set', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-workshop-stress-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const mods = [{ modId: '646B350F36C6D3E4' }, { modId: '618C2492CC62D0D5' }];
  for (const mod of mods) await writeState(root, mod.modId, { m_bIsEnabled: false, m_bIsFavorite: true });
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, index) => syncWorkshopSelection({
    profileDirectory: root, installedMods: mods, enabledMods: [mods[index % 2]]
  })));
  assert.equal(results.filter((result) => result.status === 'rejected').length, 0);
  assert.equal((await readState(root, mods[0].modId)).m_bIsEnabled, false);
  assert.equal((await readState(root, mods[1].modId)).m_bIsEnabled, true);
  assert.equal((await readState(root, mods[0].modId)).m_bIsFavorite, true);
});

test('does not lose Workshop preferences on replacement failure', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-launcher-workshop-failure-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const modId = '646B350F36C6D3E4';
  const original = { m_bIsEnabled: true, m_bIsFavorite: true, m_fMyRating: 0.75 };
  await writeState(root, modId, original);
  const rename = fs.rename;
  context.mock.method(fs, 'rename', async (source, destination) => {
    if (destination.endsWith(`I${modId}.json`)) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return rename(source, destination);
  });
  await assert.rejects(disableWorkshopMod({ modId, profileDirectories: [root] }), { code: 'EACCES' });
  assert.deepEqual(await readState(root, modId), original);
});
