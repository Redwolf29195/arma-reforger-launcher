// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 ALGZ / ExtaZzZ and contributors.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const BUILD_INFO_SCHEMA = 1;
const BUILD_INFO_RELATIVE_PATH = path.join('security', 'build-info.json');
const OFFICIAL_RELEASES_URL = 'https://github.com/Redwolf29195/arma-reforger-launcher-updates/releases/latest';
const UPDATE_CHANNEL_URL = 'https://github.com/Redwolf29195/arma-reforger-launcher-updates/releases/latest/download/';

// Metadata selects distribution/update behavior. It is unsigned and does not
// authenticate authorship or restrict changes to source code or the bridge.
function readBuildMetadata(appPath, version) {
  const fallback = { releaseTier: 'community', windowsPublisher: '', windowsCertificateThumbprint: '' };
  try {
    const contents = fs.readFileSync(path.join(appPath, 'src', BUILD_INFO_RELATIVE_PATH), 'utf8');
    if (Buffer.byteLength(contents) > 64 * 1024) return fallback;
    const info = JSON.parse(contents);
    if (!info || Array.isArray(info) || info.schema !== BUILD_INFO_SCHEMA
      || info.version !== version || !['community', 'public', 'public-unsigned'].includes(info.releaseTier)) {
      return fallback;
    }
    const windowsPublisher = String(info.windowsPublisher || '').trim();
    const windowsCertificateThumbprint = String(info.windowsCertificateThumbprint || '').replace(/\s/g, '').toUpperCase();
    if (windowsPublisher.length > 300 || !/^[0-9A-F]{0,128}$/.test(windowsCertificateThumbprint)) return fallback;
    if (info.releaseTier === 'public'
      && (!windowsPublisher || !/^[0-9A-F]{40,128}$/.test(windowsCertificateThumbprint))) return fallback;
    if (info.releaseTier === 'public-unsigned' && (windowsPublisher || windowsCertificateThumbprint)) return fallback;
    return {
      releaseTier: info.releaseTier,
      windowsPublisher,
      windowsCertificateThumbprint,
      buildId: String(info.buildId || '').slice(0, 96),
      builtAt: String(info.builtAt || '').slice(0, 80)
    };
  } catch {
    return fallback;
  }
}

function inspectWindowsSignature(executablePath) {
  if (process.platform !== 'win32') return Promise.resolve({ status: 'not-applicable', subject: '', thumbprint: '' });
  const windowsRoot = path.resolve(String(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'));
  if (path.basename(windowsRoot).toLowerCase() !== 'windows'
    || path.dirname(windowsRoot).toLowerCase() !== path.parse(windowsRoot).root.toLowerCase()) {
    return Promise.resolve({ status: 'unavailable', subject: '', thumbprint: '' });
  }
  const powershellPath = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const escapedPath = String(executablePath || '').replace(/'/g, "''");
  const command = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`,
    '$certificate = $signature.SignerCertificate',
    '[pscustomobject]@{Status=$signature.Status.ToString();Subject=if($certificate){$certificate.Subject}else{""};Thumbprint=if($certificate){$certificate.Thumbprint}else{""}} | ConvertTo-Json -Compress'
  ].join('; ');
  return new Promise((resolve) => {
    execFile(powershellPath, ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', command], {
      timeout: 20_000,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, PSModulePath: '' }
    }, (error, stdout) => {
      if (error) {
        resolve({ status: 'unavailable', subject: '', thumbprint: '' });
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolve({
          status: String(result.Status || '').toLowerCase(),
          subject: String(result.Subject || ''),
          thumbprint: String(result.Thumbprint || '').replace(/\s/g, '').toUpperCase()
        });
      } catch {
        resolve({ status: 'unavailable', subject: '', thumbprint: '' });
      }
    });
  });
}

async function readBuildIdentity({
  appPath,
  version,
  packaged,
  platform = process.platform,
  executablePath = process.execPath,
  inspectSignature = inspectWindowsSignature
}) {
  const metadata = packaged ? readBuildMetadata(appPath, version) : { releaseTier: 'development' };
  let signature = { status: packaged ? 'not-applicable' : 'development', subject: '', thumbprint: '' };
  if (packaged && platform === 'win32') {
    try {
      signature = await inspectSignature(executablePath) || { status: 'unavailable' };
    } catch {
      signature = { status: 'unavailable' };
    }
  }
  const signatureStatus = String(signature.status || 'unavailable').toLowerCase();
  const signer = String(signature.subject || '');
  const authenticode = signatureStatus === 'valid' ? 'verified'
    : signatureStatus === 'notsigned' ? 'unsigned'
      : ['development', 'not-applicable', 'unavailable'].includes(signatureStatus) ? signatureStatus : 'untrusted';
  return {
    status: packaged ? 'open-source' : 'development',
    releaseTier: metadata.releaseTier,
    version,
    buildId: metadata.buildId || '',
    builtAt: metadata.builtAt || '',
    license: 'GPL-3.0-only',
    authenticode,
    signer: authenticode === 'verified' ? signer : '',
    windowsPublisher: metadata.windowsPublisher || '',
    windowsCertificateThumbprint: metadata.windowsCertificateThumbprint || '',
    officialReleasesUrl: OFFICIAL_RELEASES_URL,
    versionReleaseUrl: `${OFFICIAL_RELEASES_URL.replace(/\/latest$/, '')}/tag/v${version}`
  };
}

module.exports = {
  BUILD_INFO_SCHEMA,
  BUILD_INFO_RELATIVE_PATH,
  OFFICIAL_RELEASES_URL,
  UPDATE_CHANNEL_URL,
  inspectWindowsSignature,
  readBuildIdentity
};
