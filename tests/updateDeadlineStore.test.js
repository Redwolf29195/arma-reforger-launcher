'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const UpdateDeadlineStore = require('../src/core/updateDeadlineStore');

const STARTED_AT = 1_800_000_000_000;

function updateInput(version = '0.3.33', digestByte = 0xab) {
  const artifactName = `Arma-Reforger-Launcher-${version}-x64-Setup.exe`;
  return {
    descriptor: {
      version,
      artifactName,
      sha512: Buffer.alloc(64, digestByte).toString('base64'),
      size: 85_000_000 + digestByte
    },
    policy: {
      version,
      artifactName,
      mode: 'semi-forced',
      gracePeriodSeconds: 300
    },
    noticeMilliseconds: 300_000
  };
}

async function temporaryUserData(context, name = 'case') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `algz-deadline-${name}-`));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function recordPaths(userDataDirectory) {
  const directory = path.join(userDataDirectory, 'update-deadlines');
  const names = await fs.readdir(directory);
  return names.filter((name) => name.endsWith('.json')).map((name) => path.join(directory, name));
}

test('preserves the original five-minute UTC deadline across launcher restarts', async (context) => {
  const userData = await temporaryUserData(context, 'restart');
  const input = updateInput();
  const first = await new UpdateDeadlineStore(userData, { now: () => STARTED_AT }).getOrCreate(input);
  const restartedAt = STARTED_AT + 120_000;
  const afterRestart = await new UpdateDeadlineStore(userData, { now: () => restartedAt }).getOrCreate(input);

  assert.deepEqual(first, {
    deadline: STARTED_AT + 300_000,
    startedAt: STARTED_AT,
    mode: 'semi-forced',
    version: '0.3.33',
    gracePeriodSeconds: 300
  });
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(afterRestart, first);
  assert.equal(afterRestart.deadline - restartedAt, 180_000);
});

test('never refreshes an expired or repeatedly verified deadline and a clock rollback cannot move it', async (context) => {
  const userData = await temporaryUserData(context, 'fixed');
  const input = updateInput();
  let now = STARTED_AT;
  const store = new UpdateDeadlineStore(userData, { now: () => now });
  const original = await store.getOrCreate(input);

  now = STARTED_AT + 600_000;
  const expired = await new UpdateDeadlineStore(userData, { now: () => now }).getOrCreate(input);
  assert.deepEqual(expired, original);
  assert.ok(expired.deadline < now);

  now = STARTED_AT - 86_400_000;
  const afterClockRollback = await new UpdateDeadlineStore(userData, { now: () => now }).getOrCreate(input);
  assert.deepEqual(afterClockRollback, original);

  now = STARTED_AT + 1_000;
  assert.deepEqual(await store.getOrCreate(input), original);
});

test('gives a different verified artifact its own deadline file and serializes same-file creation', async (context) => {
  const userData = await temporaryUserData(context, 'artifacts');
  let clockCalls = 0;
  const firstInput = updateInput();
  const stores = Array.from({ length: 12 }, () => new UpdateDeadlineStore(userData, {
    now: () => STARTED_AT + clockCalls++ * 1_000
  }));
  const sameArtifact = await Promise.all(stores.map((store) => store.getOrCreate(firstInput)));
  assert.equal(clockCalls, 1);
  assert.equal(new Set(sameArtifact.map((record) => record.deadline)).size, 1);

  const secondInput = updateInput('0.3.34', 0xcd);
  const second = await new UpdateDeadlineStore(userData, { now: () => STARTED_AT + 120_000 })
    .getOrCreate(secondInput);
  assert.equal(second.startedAt, STARTED_AT + 120_000);
  assert.equal((await recordPaths(userData)).length, 2);
});

test('rejects malformed, oversized and internally inconsistent persisted records without resetting them', async (context) => {
  const userData = await temporaryUserData(context, 'corrupt');
  const input = updateInput();
  await new UpdateDeadlineStore(userData, { now: () => STARTED_AT }).getOrCreate(input);
  const [recordPath] = await recordPaths(userData);

  await fs.writeFile(recordPath, '{broken-json\n', 'utf8');
  await assert.rejects(
    new UpdateDeadlineStore(userData, { now: () => STARTED_AT + 10_000 }).getOrCreate(input),
    /update-deadline-json/
  );
  assert.equal(await fs.readFile(recordPath, 'utf8'), '{broken-json\n');

  await fs.writeFile(recordPath, 'x'.repeat(4 * 1024 + 1), 'utf8');
  await assert.rejects(
    new UpdateDeadlineStore(userData, { now: () => STARTED_AT + 20_000 }).getOrCreate(input),
    /update-deadline-file-size/
  );

  const inconsistent = {
    formatVersion: 1,
    bindingHash: path.basename(recordPath, '.json'),
    version: '0.3.33',
    mode: 'semi-forced',
    gracePeriodSeconds: 300,
    durationMilliseconds: 300_000,
    startedAt: STARTED_AT,
    deadline: STARTED_AT + 300_001
  };
  await fs.writeFile(recordPath, `${JSON.stringify(inconsistent)}\n`, 'utf8');
  await assert.rejects(
    new UpdateDeadlineStore(userData, { now: () => STARTED_AT + 30_000 }).getOrCreate(input),
    /update-deadline-record-time/
  );
});

test('fails closed on unsafe input and deterministic filesystem read/write errors', async (context) => {
  const unsafeRoot = await temporaryUserData(context, 'unsafe');
  const unsafe = updateInput();
  unsafe.descriptor.artifactName = '../Launcher-0.3.33-Setup.exe';
  unsafe.policy.artifactName = unsafe.descriptor.artifactName;
  await assert.rejects(
    new UpdateDeadlineStore(unsafeRoot).getOrCreate(unsafe),
    /update-deadline-artifact/
  );

  const readRoot = await temporaryUserData(context, 'read-error');
  const input = updateInput();
  await new UpdateDeadlineStore(readRoot, { now: () => STARTED_AT }).getOrCreate(input);
  const [recordPath] = await recordPaths(readRoot);
  await fs.rm(recordPath);
  await fs.mkdir(recordPath);
  await assert.rejects(
    new UpdateDeadlineStore(readRoot, { now: () => STARTED_AT + 1 }).getOrCreate(input),
    /update-deadline-file-type/
  );

  const writeRoot = await temporaryUserData(context, 'write-error');
  await fs.writeFile(path.join(writeRoot, 'update-deadlines'), 'not-a-directory', 'utf8');
  await assert.rejects(
    new UpdateDeadlineStore(writeRoot, { now: () => STARTED_AT }).getOrCreate(input),
    /EEXIST|not a directory|ENOTDIR/i
  );
});

test('an atomic creation failure leaves an older artifact deadline untouched', async (context) => {
  const userData = await temporaryUserData(context, 'atomic');
  const firstInput = updateInput();
  await new UpdateDeadlineStore(userData, { now: () => STARTED_AT }).getOrCreate(firstInput);
  const [oldPath] = await recordPaths(userData);
  const oldContents = await fs.readFile(oldPath);

  const promises = require('node:fs/promises');
  const originalLink = promises.link;
  promises.link = async () => {
    const error = new Error('injected atomic link failure');
    error.code = 'EIO';
    throw error;
  };
  try {
    await assert.rejects(
      new UpdateDeadlineStore(userData, { now: () => STARTED_AT + 120_000 })
        .getOrCreate(updateInput('0.3.34', 0xcd)),
      /injected atomic link failure/
    );
  } finally {
    promises.link = originalLink;
  }

  assert.deepEqual(await fs.readFile(oldPath), oldContents);
  assert.equal((await recordPaths(userData)).length, 1);
});
