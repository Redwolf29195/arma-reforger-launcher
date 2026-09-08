const path = require('node:path');
const fs = require('node:fs/promises');

exports.default = async function hardenPackagedElectron(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const { appOutDir, electronPlatformName } = context;
  const executableName = electronPlatformName === 'linux'
    ? context.packager.executableName
    : context.packager.appInfo.productFilename;
  const executablePath = ['darwin', 'mas'].includes(electronPlatformName)
    ? path.join(appOutDir, `${executableName}.app`, 'Contents', 'MacOS', executableName)
    : electronPlatformName === 'win32'
      ? path.join(appOutDir, `${executableName}.exe`)
      : electronPlatformName === 'linux'
        ? path.join(appOutDir, executableName)
        : '';
  if (!executablePath) throw new Error(`Unsupported Electron platform: ${electronPlatformName}`);

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    [FuseV1Options.WasmTrapHandlers]: true
  });

  if (electronPlatformName === 'linux') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(executableName)) {
      throw new Error('Linux executableName must be a plain filename.');
    }
    // electron-builder copies appOutDir over its generated AppImage AppRun.
    // Keep Chromium's sandbox enabled even when user namespaces are unavailable:
    // the user can install the deb, which provides the distro sandbox integration.
    const appRun = `#!/bin/sh
set -eu
if [ -z "\${APPDIR:-}" ]; then
  APPDIR=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)
fi
export APPDIR
export PATH="$APPDIR:$APPDIR/usr/sbin\${PATH:+:$PATH}"
export XDG_DATA_DIRS="$APPDIR/usr/share\${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}:/usr/local/share:/usr/share"
export LD_LIBRARY_PATH="$APPDIR/usr/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$APPDIR/${executableName}" "$@"
`;
    await fs.writeFile(path.join(appOutDir, 'AppRun'), appRun, { mode: 0o755 });
    await fs.chmod(path.join(appOutDir, 'AppRun'), 0o755);
  }
};
