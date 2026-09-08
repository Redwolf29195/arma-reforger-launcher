const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAddonDownloadArguments,
  buildLaunchArguments,
  buildServerConnectArguments,
  buildSteamClientArguments,
  buildSteamLaunchUrl,
  isDownloadDirectory,
  parseAdditionalArguments,
  toGamePath
} = require('../src/core/launchBuilder');

test('builds safe arguments for the in-game missing-mod downloader', () => {
  const args = buildAddonDownloadArguments({ platform: 'win32',
    settings: {
      profileDirectory: 'B:\\LauncherProfile',
      addonsDirectory: 'B:\\ReforgerMods\\addons',
      downloadRoot: 'B:\\ReforgerMods',
      noSplash: true,
      additionalArguments: '-client 127.0.0.1'
    },
    bridgeDirectory: 'B:\\Launcher\\launcher-addons',
    bridgeModId: 'A7909293ED71A512'
  });

  assert.deepEqual(args, [
    '-profile', 'B:\\LauncherProfile',
    '-addonsDir', 'B:\\Launcher\\launcher-addons',
    '-addonDownloadDir', 'B:\\ReforgerMods',
    '-addonTempDir', 'B:\\ReforgerMods\\temp',
    '-logsDir', 'B:\\LauncherProfile\\logs\\workshop-bridge',
    '-addons', 'A7909293ED71A512',
    '-world', 'worlds/MainMenuWorld/MainMenuWorld.ent',
    '-noSplash'
  ]);
});

test('builds an editable Workshop launch without an externally locked addon list', () => {
  const args = buildLaunchArguments({ platform: 'win32',
    mods: [
      { modId: '646B350F36C6D3E4' },
      { modId: '618C2492CC62D0D5' },
      { modId: '646B350F36C6D3E4' }
    ],
    settings: {
      profileDirectory: 'B:\\LauncherProfile',
      addonsDirectory: 'B:\\ReforgerMods\\addons',
      downloadRoot: 'B:\\ReforgerMods',
      noSplash: true,
      additionalArguments: '-window "-maxFPS 120"'
    }
  });

  assert.deepEqual(args, [
    '-profile', 'B:\\LauncherProfile',
    '-addonDownloadDir', 'B:\\ReforgerMods',
    '-world', 'worlds/MainMenuWorld/MainMenuWorld.ent',
    '-noSplash',
    '-window', '-maxFPS 120'
  ]);
});

test('keeps a separate addon search directory when it is not the Workshop download folder', () => {
  const args = buildLaunchArguments({ platform: 'win32',
    mods: [{ modId: '646B350F36C6D3E4' }],
    settings: {
      profileDirectory: 'B:\\LauncherProfile',
      addonsDirectory: 'D:\\LocalAddons',
      downloadRoot: 'B:\\ReforgerMods'
    }
  });

  assert.deepEqual(args.slice(0, 6), [
    '-profile', 'B:\\LauncherProfile',
    '-addonsDir', 'D:\\LocalAddons',
    '-addonDownloadDir', 'B:\\ReforgerMods'
  ]);
  assert.equal(args.includes('-addons'), false);
});

test('builds a direct server launch and permits a vanilla server collection', () => {
  const args = buildLaunchArguments({ platform: 'win32',
    mods: [],
    serverAddress: 'server.example.test:2001',
    settings: { profileDirectory: 'B:\\LauncherProfile', noSplash: true }
  });

  assert.deepEqual(args.slice(-3), ['-noSplash', '-client', 'server.example.test:2001']);
  assert.equal(args.includes('-world'), false);
});

test('opens the main menu with a one-shot native join bridge, never bare -client', () => {
  const args = buildServerConnectArguments({ platform: 'win32',
    serverAddress: 'server.example.test:2001',
    bridgeDirectory: 'B:\\LauncherProfile\\profile\\addons',
    bridgeModId: 'A7909293ED71A512',
    joinToken: '0123456789abcdef0123456789abcdef',
    settings: {
      profileDirectory: 'B:\\LauncherProfile',
      addonsDirectory: 'D:\\LocalAddons',
      downloadRoot: 'B:\\ReforgerMods',
      additionalArguments: '-addons BAD -world BAD',
      noSplash: true
    }
  });

  assert.deepEqual(args, [
    '-profile', 'B:\\LauncherProfile',
    '-addonsDir', 'B:\\LauncherProfile\\profile\\addons',
    '-addonDownloadDir', 'B:\\ReforgerMods',
    '-addonTempDir', 'B:\\ReforgerMods\\temp',
    '-logsDir', 'B:\\LauncherProfile\\logs\\server-join',
    '-addons', 'A7909293ED71A512',
    '-world', 'worlds/MainMenuWorld/MainMenuWorld.ent',
    '-noSplash', '-algzJoinRequest', '0123456789abcdef0123456789abcdef'
  ]);
  assert.equal(args.includes('-client'), false);
  assert.equal(args.includes('server.example.test:2001'), false);
  assert.equal(args.includes('BAD'), false);
});

test('refuses to start native joining without a matching one-shot token and explicit profile', () => {
  assert.throws(() => buildServerConnectArguments({ platform: 'win32', serverAddress: '127.0.0.1:2001' }), /идентификатор/);
  assert.throws(() => buildServerConnectArguments({ platform: 'win32',
    serverAddress: '127.0.0.1:2001', joinToken: 'a'.repeat(32)
  }), /профиль/);
  assert.throws(() => buildServerConnectArguments({ platform: 'win32',
    serverAddress: '127.0.0.1:2001 -client evil', joinToken: 'a'.repeat(32)
  }), /формате IP:порт/);
});

test('rejects an unsafe direct server address', () => {
  assert.throws(() => buildLaunchArguments({ platform: 'win32',
    mods: [],
    serverAddress: '127.0.0.1:2001 -addons BAD',
    settings: {}
  }), /формате IP:порт/);
});

test('recognizes the addon subfolder of the Workshop download directory', () => {
  assert.equal(isDownloadDirectory('B:\\Mods\\addons', 'B:\\Mods', 'win32'), true);
  assert.equal(isDownloadDirectory('D:\\Mods', 'B:\\Mods', 'win32'), false);
});

test('rejects an unclosed quote in additional arguments', () => {
  assert.throws(() => parseAdditionalArguments('-window "broken'), /не закрыта кавычка/);
});

test('builds Steam client launch arguments for Arma Reforger', () => {
  assert.deepEqual(buildSteamClientArguments(['-profile', 'B:\\Launcher Profile', '-noSplash']), [
    '-applaunch',
    '1874880',
    '-profile',
    'B:\\Launcher Profile',
    '-noSplash'
  ]);
});

test('builds a Steam protocol fallback with quoted paths', () => {
  const prefix = 'steam://run/1874880//';
  const url = buildSteamLaunchUrl(['-profile', 'B:\\Launcher Profile', '-noSplash']);
  assert.ok(url.startsWith(prefix));
  assert.equal(decodeURIComponent(url.slice(prefix.length, -1)), '-profile "B:\\Launcher Profile" -noSplash');
});

test('Linux launch maps native profile and addon directories to Proton without changing settings', () => {
  const settings = {
    profileDirectory: '/home/user/Launcher Profile',
    addonsDirectory: '/mnt/Games/Custom Addons',
    downloadRoot: '/mnt/Games/Workshop',
    additionalArguments: '-window "-maxFPS 120"'
  };
  const original = { ...settings };
  const args = buildLaunchArguments({ platform: 'linux', mods: [{ modId: 'A'.repeat(16) }], settings });
  assert.deepEqual(args.slice(0, 6), [
    '-profile', 'Z:\\home\\user\\Launcher Profile',
    '-addonsDir', 'Z:\\mnt\\Games\\Custom Addons',
    '-addonDownloadDir', 'Z:\\mnt\\Games\\Workshop'
  ]);
  assert.deepEqual(args.slice(-2), ['-window', '-maxFPS 120']);
  assert.deepEqual(settings, original);
  assert.deepEqual(buildSteamClientArguments(args).slice(0, 4), ['-applaunch', '1874880', '-profile', 'Z:\\home\\user\\Launcher Profile']);
});

test('Linux bridge and server join paths are converted once while tokens and resource names stay intact', () => {
  const options = {
    platform: 'linux',
    settings: { profileDirectory: '/home/user/My Profile', downloadRoot: '/mnt/Mods', additionalArguments: '-client evil' },
    bridgeDirectory: '/home/user/My Profile/profile/addons', bridgeModId: 'A7909293ED71A512',
    serverAddress: '127.0.0.1:2001', joinToken: 'a'.repeat(32)
  };
  const download = buildAddonDownloadArguments(options);
  const join = buildServerConnectArguments(options);
  assert.deepEqual(download.slice(0, 10), [
    '-profile', 'Z:\\home\\user\\My Profile',
    '-addonsDir', 'Z:\\home\\user\\My Profile\\profile\\addons',
    '-addonDownloadDir', 'Z:\\mnt\\Mods',
    '-addonTempDir', 'Z:\\mnt\\Mods\\temp',
    '-logsDir', 'Z:\\home\\user\\My Profile\\logs\\workshop-bridge'
  ]);
  assert.equal(join[join.indexOf('-logsDir') + 1], 'Z:\\home\\user\\My Profile\\logs\\server-join');
  assert.equal(join[join.indexOf('-world') + 1], 'worlds/MainMenuWorld/MainMenuWorld.ent');
  assert.deepEqual(join.slice(-2), ['-algzJoinRequest', 'a'.repeat(32)]);
  assert.equal(join.includes('-client'), false);
  assert.equal(join.some((value) => value.includes('Z:Z:')), false);
});

test('Linux directory equivalence preserves case and suppresses only the managed download addons folder', () => {
  assert.equal(isDownloadDirectory('/mnt/Mods/addons', '/mnt/Mods', 'linux'), true);
  assert.equal(isDownloadDirectory('/mnt/mods/addons', '/mnt/Mods', 'linux'), false);
  const args = buildLaunchArguments({ platform: 'linux', mods: [{ modId: 'A'.repeat(16) }],
    settings: { addonsDirectory: '/mnt/Mods/addons', downloadRoot: '/mnt/Mods' } });
  assert.equal(args.includes('-addonsDir'), false);
});

test('Proton path conversion preserves Unicode and rejects ambiguous managed paths', () => {
  assert.equal(toGamePath('/home/user/игрок/Mods/../Профиль', 'linux'), 'Z:\\home\\user\\игрок\\Профиль');
  assert.equal(toGamePath('/', 'linux'), 'Z:\\');
  assert.equal(toGamePath('B:\\Profile', 'win32'), 'B:\\Profile');
  for (const value of ['relative/profile', 'C:\\Profile', '/home/user\\profile', '/home/user\0/profile']) {
    assert.throws(() => toGamePath(value, 'linux'), /absolute native paths/);
  }
});
