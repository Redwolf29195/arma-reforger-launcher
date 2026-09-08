const path = require('node:path');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const {
  getQueuePaths, normalizeQueueItems, readWorkshopQueue, readWorkshopStatus,
  isWorkshopDownloadActive, writeWorkshopQueue
} = require('./workshopDownloadQueue');

const SESSION_FILE = 'ALGZLauncherWorkshopSession.json';
const MAX_SESSION_BYTES = 256 * 1024;
const RETRYABLE_SESSION_IO_CODES = new Set(['EBUSY', 'EACCES', 'EPERM', 'EAGAIN', 'EMFILE', 'ENFILE', 'EINTR', 'ETIMEDOUT', 'ESTALE']);
const START_TIMEOUT_MS = 90_000;
const idle = () => ({ state: 'idle', completed: 0, total: 0, failed: 0, modId: '', progress: 0, message: '' });
const sessionPath = profile => path.join(path.dirname(getQueuePaths(profile).queuePath), SESSION_FILE);

function normalizeSession(record) {
  if (![1, 2].includes(record?.schema) || !Number.isSafeInteger(record.startedAt) || record.startedAt < 0
      || typeof record.paused !== 'boolean') throw new Error('Invalid saved Workshop queue.');
  return { schema: 1, startedAt: record.startedAt, paused: record.paused, items: normalizeQueueItems(record.items) };
}

function sessionPayload(record, revision) {
  return { schema: 2, revision, startedAt: record.startedAt, paused: record.paused, items: record.items };
}

function sessionChecksum(payload) {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

async function readSessionCopy(filePath) {
  let handle;
  try {
    const link = await fs.lstat(filePath);
    if (link.isSymbolicLink() || !link.isFile() || link.size < 2 || link.size > MAX_SESSION_BYTES) {
      throw new Error('Invalid saved Workshop queue file.');
    }
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== link.dev || before.ino !== link.ino
        || before.size < 2 || before.size > MAX_SESSION_BYTES) throw new Error('Workshop queue file changed.');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Workshop queue file changed.');
    }
    const parsed = JSON.parse(bytes.subarray(0, offset).toString('utf8').replace(/^\uFEFF/, ''));
    const record = normalizeSession(parsed);
    const revision = parsed.schema === 2 ? parsed.revision : 0;
    if (parsed.schema === 2 && (!Number.isSafeInteger(revision) || revision < 1
        || parsed.checksum !== sessionChecksum(sessionPayload(record, revision)))) {
      throw new Error('Workshop queue checksum mismatch.');
    }
    return { filePath, record, revision };
  } catch (error) {
    return { filePath, error, missing: error.code === 'ENOENT' };
  } finally {
    await handle?.close();
  }
}

async function committedCopies(profile) {
  const primary = sessionPath(profile);
  const copies = await Promise.all([readSessionCopy(primary), readSessionCopy(`${primary}.bak`)]);
  // A temporary lock or resource shortage says nothing about file integrity.
  // Let the caller retry instead of publishing recovery/paused and ending its
  // progress polling, or replacing a newer copy whose revision is unreadable.
  const retryable = copies.find(copy => RETRYABLE_SESSION_IO_CODES.has(copy.error?.code));
  if (retryable) throw retryable.error;
  return copies;
}

async function readSession(profile) {
  const copies = await committedCopies(profile);
  const valid = copies.filter(copy => copy.record).sort((a, b) => b.revision - a.revision);
  if (valid.length) {
    const selected = valid[0];
    // Recovery is deliberately paused. A surviving old/torn "complete" status
    // cannot discard a recovered queue, even when its item count happens to fit.
    return selected.filePath === sessionPath(profile)
      ? selected.record : { ...selected.record, paused: true, recovered: true };
  }

  // A fully written, checksummed temporary file can survive a cut before its
  // first rename. Never prefer an uncommitted temporary over a committed copy.
  let entries = [];
  try { entries = await fs.readdir(path.dirname(sessionPath(profile))); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const names = entries.filter(name => /^ALGZLauncherWorkshopSession\.json(?:\.bak)?\.\d+\.[0-9a-f-]{36}\.tmp$/i.test(name));
  if (names.length > 32) throw new Error('Too many incomplete Workshop queue records.');
  const temporary = [];
  for (const name of names) temporary.push(await readSessionCopy(path.join(path.dirname(sessionPath(profile)), name)));
  const recoverable = temporary.filter(copy => copy.record && copy.revision > 0).sort((a, b) => b.revision - a.revision);
  if (recoverable.length) return { ...recoverable[0].record, paused: true, recovered: true };

  const interrupted = copies.some(copy => !copy.missing) || names.length > 0;
  const items = await readWorkshopQueue(profile);
  if (items.length) return { schema: 1, startedAt: 0, paused: interrupted, items, ...(interrupted ? { recovered: true } : {}) };
  if (interrupted) throw Object.assign(new Error('Saved Workshop queue could not be recovered.'), { code: 'WORKSHOP_SESSION_RECOVERY' });
  return null;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory fsync through Node on all filesystems.
    // Both record files themselves are still flushed before either rename.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

async function writeDurableCopy(filePath, bytes) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function persistSession(profile, value) {
  const record = normalizeSession(value);
  const copies = await committedCopies(profile);
  const revision = Math.max(0, ...copies.filter(copy => copy.record).map(copy => copy.revision)) + 1;
  if (!Number.isSafeInteger(revision)) throw new Error('Workshop queue revision overflow.');
  const payload = sessionPayload(record, revision);
  const bytes = Buffer.from(`${JSON.stringify({ ...payload, checksum: sessionChecksum(payload) })}\n`, 'utf8');
  if (bytes.length > MAX_SESSION_BYTES) throw new Error('Saved Workshop queue is too large.');
  const primary = sessionPath(profile);
  await fs.mkdir(path.dirname(primary), { recursive: true });
  // Commit the new recovery copy first. Its revision lets restart recover the
  // newer queue if power disappears before the primary replacement completes.
  await writeDurableCopy(`${primary}.bak`, bytes);
  await writeDurableCopy(primary, bytes);
}

async function flushBridgeQueue(profile) {
  const paths = getQueuePaths(profile);
  for (const filePath of [paths.queuePath, paths.statusPath]) {
    const handle = await fs.open(filePath, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncDirectory(path.dirname(paths.queuePath));
}

function completed(status, record) {
  return status.state === 'complete' && status.total > 0 && status.failed === 0
    && status.completed === status.total
    && (!record || status.total === record.items.length);
}

function currentAttemptStatus(status, record) {
  return record && status.updatedAt && Date.parse(status.updatedAt) < record.startedAt ? idle() : status;
}

function createWorkshopDownloadController({ isGameRunning, now = Date.now, errorMessage = key => key }) {
  let startingProfile = '';
  let startingCount = 0;
  let generation = 0;

  async function inspectStatus(profile) {
    if (!profile) return idle();
    if (startingProfile === path.resolve(profile)) {
      return { ...idle(), state: 'queued', total: startingCount, resumeAvailable: false };
    }
    const record = await readSession(profile);
    let current = await readWorkshopStatus(profile, { includeFileMetadata: true, now: now() });
    // A previous attempt's terminal status cannot finish a newly saved queue.
    current = currentAttemptStatus(current, record);
    if (completed(current, record) && !record?.paused) return { ...current, resumeAvailable: false };
    const resumable = Boolean(record?.items.length);
    if (!resumable && !isWorkshopDownloadActive(current)) return { ...current, resumeAvailable: false };
    const paused = reason => ({
      ...current, state: 'paused', total: record?.items.length || current.total,
      resumeAvailable: resumable, recoverable: resumable, reason
    });
    if (record?.paused) return paused(record.recovered ? 'session-recovered' : 'launch-failed');
    if (current.state === 'partial' || current.state === 'error') {
      return { ...current, resumeAvailable: resumable, recoverable: resumable };
    }
    const age = current.updatedAt ? current.ageMs : Math.max(0, now() - (record?.startedAt || 0));
    if (current.state === 'queued' && age < START_TIMEOUT_MS) return { ...current, resumeAvailable: false };
    const running = await isGameRunning();
    if (!running) return paused('game-closed');
    if (age >= START_TIMEOUT_MS) return paused('bridge-unresponsive');
    if (!isWorkshopDownloadActive(current)) {
      // The game truncates its status file before rewriting it. A short/empty
      // read is transient, never completion or a reason to stop polling.
      return { ...current, state: 'waiting', total: record?.items.length || current.total, resumeAvailable: false };
    }
    return { ...current, resumeAvailable: false };
  }

  async function status(profile) {
    for (;;) {
      const observedGeneration = generation;
      const result = await inspectStatus(profile);
      // A poll begun before a new launch must not return the previous queue's
      // terminal state after the new preparation has already started.
      if (observedGeneration === generation) return result;
    }
  }

  async function start(profile, prepare, launch, { resume = false, requireEmptyQueue = false } = {}) {
    if (startingProfile) throw new Error(errorMessage('workshopDownloadBusy'));
    if (!profile) throw new Error(errorMessage('workshopPathsMissing'));
    const operation = ++generation;
    const isCancelled = () => generation !== operation;
    startingProfile = path.resolve(profile);
    startingCount = 0;
    let record;
    try {
      if (await isGameRunning()) throw new Error(errorMessage('gameAlreadyRunning'));
      const previous = await readSession(profile);
      const previousStatus = currentAttemptStatus(await readWorkshopStatus(profile, { includeFileMetadata: true, now: now() }), previous);
      const pending = previous && (previous.paused || !completed(previousStatus, previous)) ? previous.items : [];
      if (requireEmptyQueue && pending.length) throw new Error(errorMessage('workshopUpdateQueuePending'));
      if (resume && !pending.length) throw new Error(errorMessage('workshopResumeMissing'));
      const prepared = await prepare(resume ? pending : null);
      if (isCancelled()) return { cancelled: true };
      const items = normalizeQueueItems(resume ? pending : [...pending, ...prepared.items]);
      startingCount = items.length;
      if (await isGameRunning()) throw new Error(errorMessage('gameAlreadyRunning'));
      if (isCancelled()) return { cancelled: true };
      record = { schema: 1, startedAt: now(), paused: true, items };
      // Keep a durable copy: the game deletes the text queue even when it ends
      // with failed/cancelled items. Replays retain exact GUIDs and versions.
      await persistSession(profile, record);
      await writeWorkshopQueue(profile, items);
      await flushBridgeQueue(profile);
      if (isCancelled()) return { cancelled: true };
      record.paused = false;
      await persistSession(profile, record);
      if (isCancelled()) {
        record.paused = true;
        await persistSession(profile, record);
        return { cancelled: true };
      }
      const result = await launch(prepared, items, isCancelled);
      if (result?.cancelled || isCancelled()) {
        record.paused = true;
        await persistSession(profile, record);
        return { ...result, cancelled: true };
      }
      return { ...result, queuedCount: items.length };
    } catch (error) {
      if (record) {
        record.paused = true;
        await persistSession(profile, record).catch(() => {});
      }
      throw error;
    } finally {
      startingProfile = '';
      startingCount = 0;
    }
  }

  return { status, start, cancelPendingStart() { generation++; } };
}

module.exports = { SESSION_FILE, START_TIMEOUT_MS, createWorkshopDownloadController, readSession };
