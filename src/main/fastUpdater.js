const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { NsisUpdater } = require('electron-updater');
const { computeOperations } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder');
const { CancellationError } = createRequire(require.resolve('electron-updater'))('builder-util-runtime');
const { downloadWithPlan, fetchUpdateRange } = require('../core/updateDownload');

function readBlockMap(buffer) {
  if (!buffer?.length || buffer.length > 8 * 1024 * 1024) throw new Error('Invalid update blockmap size.');
  const value = JSON.parse(zlib.gunzipSync(buffer, { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'));
  const file = value?.files?.[0];
  if (value?.files?.length !== 1 || !value.version || !file?.name || file.offset !== 0 ||
      !Array.isArray(file.sizes) || !Array.isArray(file.checksums) || !file.sizes.length ||
      file.sizes.length > 200_000 || file.sizes.length !== file.checksums.length ||
      file.sizes.some((size) => !Number.isSafeInteger(size) || size <= 0) ||
      file.checksums.some((checksum) => typeof checksum !== 'string' || checksum.length > 128)) {
    throw new Error('Invalid update blockmap.');
  }
  return value;
}

// Only replaces the transfer stage of the pinned electron-updater NSIS flow.
// Its cache management, installer signature verification and installation stay intact.
class FastNsisUpdater extends NsisUpdater {
  async differentialDownloadInstaller(fileInfo, options, installerPath, provider, oldInstallerFileName) {
    const token = options.cancellationToken;
    const controller = new AbortController();
    const cancel = () => controller.abort(new CancellationError());
    if (token.cancelled) throw new CancellationError();
    token.once('cancel', cancel);
    try {
      const urls = await provider.getBlockMapFiles(fileInfo.url, this.app.version, options.updateInfoAndProvider.info.version, this.previousBlockmapBaseUrlOverride);
      const fetchMap = async (url) => readBlockMap(await this.httpExecutor.downloadToBuffer(url, {
        headers: options.requestHeaders,
        cancellationToken: token
      }));
      const newMap = await fetchMap(urls[1]);
      controller.signal.throwIfAborted();
      const cache = this.downloadedUpdateHelper;
      const oldFile = path.join(cache.cacheDir, oldInstallerFileName);
      let operations;
      let cachedFile;
      try {
        const stat = await fs.stat(oldFile);
        if (!stat.isFile()) throw new Error('Cached installer is unavailable.');
        let oldMap;
        try {
          oldMap = readBlockMap(await fs.readFile(path.join(cache.cacheDir, 'current.blockmap')));
        } catch {
          oldMap = await fetchMap(urls[0]);
        }
        if (oldMap.version !== newMap.version) throw new Error('Blockmap versions differ.');
        operations = computeOperations(oldMap, newMap, this._logger);
        cachedFile = oldFile;
      } catch (error) {
        if (token.cancelled) throw new CancellationError();
        this._logger.info(`Update cache unavailable; using parallel full download: ${error.message}`);
      }
      this._logger.info(`Starting ${operations ? 'differential' : 'full'} update download with up to 4 connections`);
      const result = await downloadWithPlan({
        newFile: installerPath,
        oldFile: cachedFile,
        size: fileInfo.info.size,
        sha512: fileInfo.info.sha512,
        operations,
        signal: controller.signal,
        fetchRange: (range, request) => fetchUpdateRange(this.httpExecutor, fileInfo.url, range, {
          ...request,
          headers: options.requestHeaders
        }),
        onProgress: (progress) => this.emit('download-progress', progress),
        onRetry: ({ range, attempt, error }) => this._logger.info(`Retry update range ${range.start}-${range.end - 1} (${attempt}/2): ${error.message}`)
      });
      controller.signal.throwIfAborted();
      // Save only the blockmap corresponding to a fully verified installer.
      await fs.writeFile(path.join(cache.cacheDirForPendingUpdate, 'current.blockmap'), zlib.gzipSync(JSON.stringify(newMap)));
      controller.signal.throwIfAborted();
      this._logger.info(`Verified parallel update: ${result.downloadBytes} of ${result.fullBytes} bytes, ${result.rangeCount} ranges`);
      return false;
    } catch (error) {
      if (token.cancelled) throw new CancellationError();
      if (['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      this._logger.warn(`Parallel update unavailable; using standard verified download: ${error.message}`);
      return true;
    } finally {
      controller.abort();
      token.removeListener('cancel', cancel);
    }
  }
}

function createLauncherUpdater() {
  return process.platform === 'win32' ? new FastNsisUpdater() : require('electron-updater').autoUpdater;
}

function applyStableUpdateChannel(updater) {
  updater.channel = 'latest';
  updater.allowPrerelease = false;
  // Setting channel enables downgrades in electron-updater. A local preview must
  // never replace itself with an older public build just because it uses latest.yml.
  updater.allowDowngrade = false;
  return updater;
}

module.exports = { applyStableUpdateChannel, createLauncherUpdater, FastNsisUpdater, readBlockMap };
