const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const UpdateDeadlineStore = require('../src/core/updateDeadlineStore');

// Exercise the real main-process handlers with a fake clock/updater. No Electron
// process, real installer, game, network, or user profile is touched.
const source = fsSync.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing main integration section: ${start}`);
  return source.slice(first, last);
}

const version = '0.9.1';
const descriptor = {
  version,
  artifactName: `Arma-Reforger-Launcher-${version}-x64-Setup.exe`,
  sha512: Buffer.alloc(64, 17).toString('base64'),
  size: 12345
};
const policy = { version, artifactName: descriptor.artifactName, mode: 'semi-forced', gracePeriodSeconds: 300 };
const updateInfo = { version, downloadedFile: 'verified-fixture.exe' };

function runtime(clock, store, overrides = {}) {
  const timers = new Map();
  const statuses = [];
  const installations = [];
  const events = {};
  let nextTimer = 0;
  const context = vm.createContext({
    Date: class extends Date { static now() { return clock.now; } },
    Object, Promise, Math, Error,
    mandatoryInstallTimer: null,
    updateVerificationGeneration: 0,
    updateInstallStarted: false,
    verifiedUpdateArtifact: null,
    availableUpdateInfo: updateInfo,
    availableUpdatePolicy: null,
    updaterState: 'idle',
    updateTrustPolicy: { enabled: true },
    settingsStore: { get: () => ({ autoUpdate: true }) },
    updateDeadlineStore: store,
    FORCED_UPDATE_NOTICE_MS: 5000,
    mainWindow: null,
    logger: { info() {}, error() {} },
    stopServerLaunchMonitor: null,
    workshopDownloads: { cancelPendingStart() {} },
    updatePushSubscriber: { stop() {} },
    app: { on: (name, callback) => { events[name] = callback; } },
    mainT: (key) => key,
    selectSignedInstallerUpdate: () => descriptor,
    isArmaReforgerRunning: async () => true,
    applyStableUpdateChannel() {},
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: clock.now + delay, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    autoUpdater: {
      autoInstallOnAppQuit: false,
      quitAndInstall: (...args) => installations.push(args)
    },
    publishUpdateStatus(status) {
      context.updaterState = status.state;
      statuses.push(status);
    }
  });
  vm.runInContext([
    section('function clearVerifiedUpdateArtifact()', 'async function loadUpdateEnvelope('),
    section('async function handleDownloadedUpdate(', 'async function handleAvailableUpdate('),
    section('function applyUpdaterPreferences(', 'function configureUpdaterEvents('),
    section("app.on('before-quit'", "app.on('activate'")
  ].join('\n'), context, { filename: 'main-mandatory-update-integration.js' });
  context.verifyDownloadedUpdate = overrides.verifyArtifact || (async () => ({ version, artifactName: descriptor.artifactName }));
  context.verifySignedUpdatePolicy = overrides.verifyPolicy || (async () => policy);
  return {
    context, timers, statuses, installations,
    download: () => context.handleDownloadedUpdate(updateInfo),
    close: () => events['before-quit'](),
    advance(milliseconds) {
      clock.now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at > clock.now) continue;
        timers.delete(id);
        timer.callback();
      }
    }
  };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'algz-update-deadline-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const clock = { now: 1_788_600_000_000 };
  const freshStore = () => new UpdateDeadlineStore(directory, { now: () => clock.now });
  return { clock, freshStore };
}

test('main restores the original deadline after closing and reopening, including time spent closed', async (t) => {
  const { clock, freshStore } = await fixture(t);
  const first = runtime(clock, freshStore());
  await first.download();
  const originalDeadline = first.statuses.at(-1).mandatory.deadline;
  assert.equal(originalDeadline, clock.now + 300_000);
  first.advance(60_000);
  first.close();
  assert.equal(first.timers.size, 0);
  assert.equal(first.installations.length, 0);
  assert.equal(first.context.autoUpdater.autoInstallOnAppQuit, false);
  clock.now += 60_000;

  const reopened = runtime(clock, freshStore());
  await reopened.download();
  assert.equal(reopened.statuses.at(-1).mandatory.deadline, originalDeadline);
  assert.equal([...reopened.timers.values()][0].delay, 180_000);
  reopened.advance(179_999);
  assert.equal(reopened.installations.length, 0);
  reopened.advance(1);
  assert.equal(reopened.installations.length, 1);
});

test('an expired deadline installs only after re-verification without granting a fresh five minutes', async (t) => {
  const { clock, freshStore } = await fixture(t);
  const first = runtime(clock, freshStore());
  await first.download();
  first.close();
  clock.now += 360_000;
  let releaseVerification;
  const verified = new Promise((resolve) => { releaseVerification = resolve; });
  const reopened = runtime(clock, freshStore(), { verifyArtifact: () => verified });
  const pending = reopened.download();
  assert.equal(reopened.timers.size, 0);
  assert.equal(reopened.installations.length, 0);
  releaseVerification({ version, artifactName: descriptor.artifactName });
  await pending;
  assert.equal([...reopened.timers.values()][0].delay, 0);
  reopened.advance(0);
  assert.equal(reopened.installations.length, 1);
});

test('repeat downloaded events retain the deadline and never create duplicate timers', async (t) => {
  const { clock, freshStore } = await fixture(t);
  const current = runtime(clock, freshStore());
  await current.download();
  const deadline = current.statuses.at(-1).mandatory.deadline;
  current.advance(120_000);
  await current.download();
  assert.equal(current.statuses.at(-1).mandatory.deadline, deadline);
  assert.equal(current.timers.size, 1);
  assert.equal([...current.timers.values()][0].delay, 180_000);
});

test('corrupt deadline storage cannot enable installation or silently reset the countdown', async () => {
  const current = runtime({ now: 1_788_600_000_000 }, {
    async getOrCreate() { throw new Error('invalid persisted deadline'); }
  });
  await current.download();
  assert.equal(current.statuses.at(-1).message, 'updateStorageFailed');
  assert.equal(current.context.verifiedUpdateArtifact, null);
  assert.equal(current.context.autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(current.timers.size, 0);
  assert.equal(current.installations.length, 0);
});

test('failed installer verification never reads a persisted deadline or enables installation', async () => {
  let reads = 0;
  const current = runtime({ now: 1_788_600_000_000 }, { async getOrCreate() { reads++; } }, {
    verifyArtifact: async () => { throw new Error('invalid signature'); }
  });
  await current.download();
  assert.equal(reads, 0);
  assert.equal(current.statuses.at(-1).message, 'updateVerificationFailed');
  assert.equal(current.timers.size, 0);
});

test('closing during asynchronous activation cannot resurrect its timer', async () => {
  const clock = { now: 1_788_600_000_000 };
  let save;
  let started;
  const saving = new Promise((resolve) => { started = resolve; });
  const record = new Promise((resolve) => { save = resolve; });
  const current = runtime(clock, { getOrCreate() { started(); return record; } });
  const pending = current.download();
  await saving;
  current.close();
  save({ deadline: clock.now + 300_000 });
  await pending;
  assert.equal(current.timers.size, 0);
  assert.equal(current.statuses.some((status) => status.state === 'downloaded'), false);
  assert.equal(current.installations.length, 0);
});

test('settings changes cannot enable quit-install for a pending mandatory update', async (t) => {
  const { clock, freshStore } = await fixture(t);
  const current = runtime(clock, freshStore());
  await current.download();
  current.context.applyUpdaterPreferences({ autoUpdate: true });
  assert.equal(current.context.autoUpdater.autoInstallOnAppQuit, false);
  current.context.verifiedUpdateArtifact = { updatePolicy: { mode: 'optional' } };
  current.context.applyUpdaterPreferences({ autoUpdate: true });
  assert.equal(current.context.autoUpdater.autoInstallOnAppQuit, true);
  current.context.applyUpdaterPreferences({ autoUpdate: false });
  assert.equal(current.context.autoUpdater.autoInstallOnAppQuit, false);
});
