const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { computeOperations } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder');
const { downloadWithPlan, fetchUpdateRange } = require('../src/core/updateDownload');

const releases = process.argv[2];
const from = process.argv[3] || '0.3.17';
const to = process.argv[4] || '0.3.18';
const updateBaseUrl = process.argv[5] || process.env.UPDATE_BASE_URL || 'https://armaveblaucher.playit.plus/updates/';
if (!releases) throw new Error('Provide the update directory.');

const name = (version, suffix = '.exe') => `Arma-Reforger-Launcher-${version}-x64-Setup${suffix}`;
const readMap = (version) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(releases, name(version, '.exe.blockmap')))));
const latest = fs.readFileSync(path.join(releases, 'latest.yml'), 'utf8');
const sha512 = /^sha512:\s*(\S+)/m.exec(latest)?.[1];
const target = path.join(os.tmpdir(), `arma-launcher-fast-update-${process.pid}.exe`);
const publicIp = process.env.PLAYIT_PUBLIC_IP || '209.25.141.28';
const executor = {
  createRequest(options, callback) {
    return https.request({
      ...options,
      servername: options.hostname,
      lookup: (_hostname, lookupOptions, done) => (
        lookupOptions?.all ? done(null, [{ address: publicIp, family: 4 }]) : done(null, publicIp, 4)
      )
    }, callback);
  }
};

(async () => {
  const operations = computeOperations(readMap(from), readMap(to), { info() {}, warn() {} });
  let lastBucket = -1;
  const started = Date.now();
  const result = await downloadWithPlan({
    newFile: target,
    oldFile: path.join(releases, name(from)),
    size: fs.statSync(path.join(releases, name(to))).size,
    sha512,
    operations,
    fetchRange: (range, options) => fetchUpdateRange(executor, new URL(name(to), updateBaseUrl), range, options),
    onProgress: ({ percent, bytesPerSecond }) => {
      const bucket = Math.floor(percent / 25);
      if (bucket > lastBucket) {
        lastBucket = bucket;
        process.stdout.write(`${percent.toFixed(1)}% ${Math.round(bytesPerSecond / 1024)} KB/s\n`);
      }
    }
  });
  result.seconds = (Date.now() - started) / 1000;
  result.bytesPerSecond = Math.round(result.wireBytes / result.seconds);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  await fsp.rm(target, { force: true });
})().catch(async (error) => {
  await fsp.rm(target, { force: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
