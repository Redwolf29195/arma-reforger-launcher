const path = require('node:path');

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
};
