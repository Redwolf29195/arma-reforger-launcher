// SPDX-License-Identifier: GPL-3.0-only
const path = require('node:path');

const { UPDATE_CHANNEL_URL } = require('../core/buildIdentity');
const {
  MAX_UPDATE_ARTIFACT_BYTES,
  isSafeInstallerName,
  normalizeExpectedSha512
} = require('../core/updateArtifactSignature');

const PROTECTED_UPDATE_CONFIG_RELATIVE_PATH = path.join('src', 'security', 'app-update.yml');
const UPDATE_CACHE_DIRECTORY_NAME = 'arma-reforger-launcher-updater';

function resolveProtectedUpdateConfigPath(appPath) {
  const source = String(appPath || '').trim();
  if (!source) throw new Error('Packaged application path is required for trusted updates.');
  return path.join(path.resolve(source), PROTECTED_UPDATE_CONFIG_RELATIVE_PATH);
}

function createUpdateTrustPolicy({ appPath, packaged, buildIdentity, portableExecutableFile } = {}) {
  const resolvedAppPath = path.resolve(String(appPath || '').trim() || '.');
  const portable = Boolean(String(portableExecutableFile || '').trim());
  // An explicit distribution setting opts into official updates; it is not
  // source authentication. Downloaded installers still require verification.
  const publicBuild = packaged === true
    && buildIdentity?.releaseTier === 'public'
    && Boolean(String(buildIdentity?.windowsPublisher || '').trim())
    && /^[0-9A-F]{40,128}$/i.test(String(buildIdentity?.windowsCertificateThumbprint || ''));
  const unsignedPublicBuild = packaged === true
    && buildIdentity?.releaseTier === 'public-unsigned';
  const packagedAsarLayout = path.basename(resolvedAppPath).toLowerCase() === 'app.asar';
  const officialUpdateChannel = publicBuild || unsignedPublicBuild;
  const enabled = officialUpdateChannel && packagedAsarLayout && !portable;

  return Object.freeze({
    enabled,
    portable,
    verificationMode: !enabled
      ? 'disabled'
      : publicBuild
        ? 'authenticode'
        : 'algz-ed25519',
    updateConfigPath: resolveProtectedUpdateConfigPath(resolvedAppPath)
  });
}

function createProtectedUpdateConfig(windowsPublisher) {
  const publisher = String(windowsPublisher || '').trim();
  return {
    provider: 'generic',
    url: UPDATE_CHANNEL_URL,
    updaterCacheDirName: UPDATE_CACHE_DIRECTORY_NAME,
    // An empty array deliberately makes accidental local-build update attempts
    // fail signature verification instead of silently skipping it.
    publisherName: publisher ? [publisher] : []
  };
}

function serializeProtectedUpdateConfig(windowsPublisher) {
  // JSON is valid YAML and avoids introducing a second serializer into the
  // trusted build preparation path.
  return `${JSON.stringify(createProtectedUpdateConfig(windowsPublisher), null, 2)}\n`;
}

function selectSignedInstallerUpdate(updateInfo) {
  const version = String(updateInfo?.version || '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('update-artifact-metadata-version');
  }
  if (!Array.isArray(updateInfo?.files) || updateInfo.files.length < 1 || updateInfo.files.length > 32) {
    throw new Error('update-artifact-metadata-files');
  }
  const installers = updateInfo.files.filter((file) => isSafeInstallerName(file?.url));
  if (installers.length !== 1) throw new Error('update-artifact-metadata-installer');
  const file = installers[0];
  const artifactName = String(file.url);
  if (!artifactName.includes(`-${version}-`)) throw new Error('update-artifact-metadata-version');
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPDATE_ARTIFACT_BYTES) {
    throw new Error('update-artifact-metadata-size');
  }
  normalizeExpectedSha512(file.sha512);
  return Object.freeze({
    artifactName,
    sha512: String(file.sha512),
    size,
    version
  });
}

module.exports = {
  PROTECTED_UPDATE_CONFIG_RELATIVE_PATH,
  UPDATE_CACHE_DIRECTORY_NAME,
  createProtectedUpdateConfig,
  createUpdateTrustPolicy,
  resolveProtectedUpdateConfigPath,
  selectSignedInstallerUpdate,
  serializeProtectedUpdateConfig
};
