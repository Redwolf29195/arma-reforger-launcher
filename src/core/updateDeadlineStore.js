/*! Copyright (c) 2026 ALGZ / ExtaZzZ. SPDX-License-Identifier: GPL-3.0-only */
'use strict';

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const { MAX_UPDATE_ARTIFACT_BYTES, isSafeInstallerName } = require('./updateArtifactSignature');

const FORMAT_VERSION = 1;
const DIRECTORY_NAME = 'update-deadlines';
const MAX_RECORD_BYTES = 4 * 1024;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const RECORD_KEYS = Object.freeze([
  'bindingHash',
  'deadline',
  'durationMilliseconds',
  'formatVersion',
  'gracePeriodSeconds',
  'mode',
  'startedAt',
  'version'
]);
const fileQueues = new Map();

function fail(reason) {
  throw new Error(`update-deadline-${reason}`);
}

function normalizeInput({ descriptor, policy, noticeMilliseconds } = {}) {
  if (!descriptor || Array.isArray(descriptor) || typeof descriptor !== 'object') fail('descriptor');
  if (!policy || Array.isArray(policy) || typeof policy !== 'object') fail('policy');

  const version = descriptor.version;
  const artifactName = descriptor.artifactName;
  const sha512 = descriptor.sha512;
  const size = descriptor.size;
  if (typeof version !== 'string' || version.length > 64 || !VERSION_PATTERN.test(version)) fail('version');
  if (!isSafeInstallerName(artifactName) || !artifactName.includes(`-${version}-`)) fail('artifact');
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPDATE_ARTIFACT_BYTES) fail('artifact-size');
  if (typeof sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sha512)) fail('artifact-digest');
  const digestBytes = Buffer.from(sha512, 'base64');
  if (digestBytes.length !== 64 || digestBytes.toString('base64') !== sha512) fail('artifact-digest');

  const mode = policy.mode;
  const gracePeriodSeconds = policy.gracePeriodSeconds;
  if (policy.version !== version || policy.artifactName !== artifactName) fail('policy-binding');
  if (mode !== 'forced' && mode !== 'semi-forced') fail('policy-mode');
  if (!Number.isSafeInteger(gracePeriodSeconds)) fail('policy-duration');
  if (!Number.isSafeInteger(noticeMilliseconds) || noticeMilliseconds < 1) fail('notice-duration');
  if (mode === 'semi-forced') {
    if (gracePeriodSeconds < 60 || gracePeriodSeconds > 3600
      || noticeMilliseconds !== gracePeriodSeconds * 1000) {
      fail('policy-duration');
    }
  } else if (gracePeriodSeconds !== 0 || noticeMilliseconds > 60_000) {
    fail('policy-duration');
  }

  const binding = Object.freeze({
    artifactName,
    artifactSha512: sha512,
    artifactSize: size,
    gracePeriodSeconds,
    mode,
    noticeMilliseconds,
    version
  });
  const bindingHash = crypto.createHash('sha256')
    .update(JSON.stringify(binding), 'utf8')
    .digest('hex');
  return Object.freeze({ binding, bindingHash, gracePeriodSeconds, mode, noticeMilliseconds, version });
}

function enqueueFile(filePath, operation) {
  const previous = fileQueues.get(filePath) || Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  fileQueues.set(filePath, settled);
  return result.finally(() => {
    if (fileQueues.get(filePath) === settled) fileQueues.delete(filePath);
  });
}

async function ensureStorageDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const status = await fs.lstat(directoryPath);
  if (status.isSymbolicLink() || !status.isDirectory()) fail('directory');
}

async function readRecord(filePath, expected) {
  let linkStatus;
  try {
    linkStatus = await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (linkStatus.isSymbolicLink() || !linkStatus.isFile()) fail('file-type');
  if (linkStatus.size < 2 || linkStatus.size > MAX_RECORD_BYTES) fail('file-size');

  const noFollow = fsSync.constants.O_NOFOLLOW || 0;
  const handle = await fs.open(filePath, fsSync.constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_RECORD_BYTES) fail('file-size');
    if (before.dev !== linkStatus.dev || before.ino !== linkStatus.ino) fail('file-changed');
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail('file-changed');
    }
    const contents = bytes.subarray(0, bytesRead).toString('utf8');
    if (!Buffer.from(contents, 'utf8').equals(bytes.subarray(0, bytesRead))) fail('encoding');
    let record;
    try {
      record = JSON.parse(contents);
    } catch {
      fail('json');
    }
    validateRecord(record, expected);
    return record;
  } finally {
    await handle.close();
  }
}

function validateRecord(record, expected) {
  if (!record || Array.isArray(record) || typeof record !== 'object') fail('record');
  const keys = Object.keys(record).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== RECORD_KEYS[index])) {
    fail('record-fields');
  }
  if (record.formatVersion !== FORMAT_VERSION) fail('record-version');
  if (record.bindingHash !== expected.bindingHash) fail('record-binding');
  if (record.mode !== expected.mode
    || record.version !== expected.version
    || record.gracePeriodSeconds !== expected.gracePeriodSeconds
    || record.durationMilliseconds !== expected.noticeMilliseconds) {
    fail('record-policy');
  }
  if (!Number.isSafeInteger(record.startedAt)
    || record.startedAt < 0
    || record.startedAt > MAX_DATE_MILLISECONDS
    || !Number.isSafeInteger(record.deadline)
    || record.deadline < record.startedAt
    || record.deadline > MAX_DATE_MILLISECONDS
    || record.deadline - record.startedAt !== record.durationMilliseconds) {
    fail('record-time');
  }
}

async function createRecordAtomically(filePath, record) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(temporaryPath, filePath);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function publicRecord(record, expected) {
  return Object.freeze({
    deadline: record.deadline,
    startedAt: record.startedAt,
    mode: expected.mode,
    version: expected.version,
    gracePeriodSeconds: expected.gracePeriodSeconds
  });
}

class UpdateDeadlineStore {
  constructor(userDataDirectory, { now = Date.now } = {}) {
    if (typeof userDataDirectory !== 'string' || !userDataDirectory.trim()) fail('directory');
    if (typeof now !== 'function') fail('clock');
    this.directoryPath = path.join(path.resolve(userDataDirectory), DIRECTORY_NAME);
    this.now = now;
  }

  async getOrCreate(input) {
    const expected = normalizeInput(input);
    const filePath = path.join(this.directoryPath, `${expected.bindingHash}.json`);
    return enqueueFile(filePath, async () => {
      await ensureStorageDirectory(this.directoryPath);
      const existing = await readRecord(filePath, expected);
      if (existing) return publicRecord(existing, expected);

      const startedAt = Number(this.now());
      if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > MAX_DATE_MILLISECONDS) fail('clock');
      const deadline = startedAt + expected.noticeMilliseconds;
      if (!Number.isSafeInteger(deadline) || deadline > MAX_DATE_MILLISECONDS) fail('clock');
      const record = {
        formatVersion: FORMAT_VERSION,
        bindingHash: expected.bindingHash,
        version: expected.version,
        mode: expected.mode,
        gracePeriodSeconds: expected.gracePeriodSeconds,
        durationMilliseconds: expected.noticeMilliseconds,
        startedAt,
        deadline
      };
      validateRecord(record, expected);
      const created = await createRecordAtomically(filePath, record);
      const persisted = await readRecord(filePath, expected);
      if (!persisted) fail(created ? 'write-missing' : 'concurrent-write-missing');
      return publicRecord(persisted, expected);
    });
  }
}

module.exports = UpdateDeadlineStore;
