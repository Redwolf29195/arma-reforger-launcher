const { app, BrowserWindow, ipcMain } = require('electron');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const profilePath = path.join(os.tmpdir(), `arma-launcher-server-ui-${process.pid}`);
fsSync.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', path.join(profilePath, 'session'));

const outputPath = process.argv.find((argument) => /\.png$/i.test(argument))
  || path.join(app.getPath('temp'), 'arma-launcher-server-ui.png');
const joinOutputPath = outputPath.replace(/\.png$/i, '.join.png');
const failureOutputPath = outputPath.replace(/\.png$/i, '.failure.png');
const logsOutputPath = outputPath.replace(/\.png$/i, '.logs-small.png');
const serverId = '11e9dc0c-1304-4f20-8247-8fa9043f7a49';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCondition(check, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await wait(20);
  }
  return false;
}

app.whenReady().then(async () => {
  let lastConnectPayload = null;
  let downloadedServerMod = null;
  let serverDetailsRefreshRequested = false;
  let serverDetailsRefreshCount = 0;
  let serverConnectCount = 0;
  let serverConnectAvailability = '';
  let serverConnectDelayMs = 0;
  let serverConnectCancelCount = 0;
  let copiedServerMods = null;
  let settings = {
    gameExecutable: 'B:\\ArmaReforgerSteam.exe',
    addonsDirectory: 'B:\\ArmaReforger\\addons',
    downloadRoot: 'B:\\ArmaReforger',
    profileDirectory: 'B:\\ArmaLauncherProfile',
    noSplash: true,
    allowVersionMismatch: false,
    additionalArguments: '',
    defaultPresetId: '',
    autoUpdate: true,
    showModLogsFooter: true,
    autoAddDependencies: true,
    favoriteMods: [],
    favoriteServers: [],
    language: 'en'
  };
  const server = {
    id: serverId,
    name: '[EU] LuckyGames | Hardcore | Bakhmut | NATO vs RU | Drones | 1PP',
    address: '155.103.80.243:2004',
    playerCount: 74,
    playerLimit: 128,
    queueCount: 5,
    scenarioName: 'Bakhmut Front',
    gameVersion: '1.8.0.10',
    official: false,
    passwordProtected: false,
    totalModSize: 6983517798,
    tags: [],
    lastUpdated: '2026-08-24T18:00:00.000Z'
  };
  const serverMods = [
    { modId: '1337C0DE5DABBEEF', name: 'RHS - Content Pack 01', version: '0.16.5150', sizeBytes: 6343204665, required: true, status: 'ready', installedVersion: '0.16.5150' },
    { modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.10', sizeBytes: 18743296, required: true, status: 'version-mismatch', installedVersion: '1.1.9' },
    { modId: '595F2BF2F44836FB', name: 'RHS - Status Quo', version: '0.16.5150', sizeBytes: 621570834, required: true, status: 'missing', installedVersion: '' }
  ];
  let presets = [{
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Field Ops',
    sourceName: '',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    mods: [{ modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.9', required: true }]
  }];
  let modLogs = serverMods.map((mod, index) => ({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`,
    timestamp: `2026-08-24T18:0${index}:00.000Z`,
    action: index === 0 ? 'preset-add' : 'install',
    source: 'server',
    modId: mod.modId,
    name: mod.name,
    version: mod.version,
    presetId: presets[0].id,
    presetName: presets[0].name,
    details: server.name
  }));

  ipcMain.handle('launcher:bootstrap', () => ({
    appVersion: '0.3.0',
    packaged: false,
    platform: 'win32',
    settings,
    presets,
    installedMods: [
      { modId: '1337C0DE5DABBEEF', name: 'RHS - Content Pack 01', version: '0.16.5150', corrupted: false, dependencies: [] },
      { modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.9', corrupted: false, dependencies: [] }
    ],
    workspace: { activePresetId: presets[0].id, name: presets[0].name, dirty: false, mods: presets[0].mods },
    modLogCount: modLogs.length
  }));
  ipcMain.handle('workspace:save', (_event, value) => value);
  ipcMain.handle('mods:scan', () => [
    { modId: '1337C0DE5DABBEEF', name: 'RHS - Content Pack 01', version: '0.16.5150', corrupted: false, dependencies: [] },
    { modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.9', corrupted: false, dependencies: [] }
  ]);
  ipcMain.handle('settings:save', (_event, patch) => {
    settings = { ...settings, ...patch };
    return settings;
  });
  ipcMain.handle('game:download-status', () => ({ state: 'idle', completed: 0, total: 0, failed: 0, progress: 0 }));
  ipcMain.handle('servers:list', (_event, payload) => ({
    items: [server, { ...server, id: '22e9dc0c-1304-4f20-8247-8fa9043f7a40', name: 'Training Ground', address: 'play.example.test:2001', playerCount: 21, queueCount: 0 }],
    page: payload.page || 1,
    pageSize: 50,
    hasNext: true,
    provider: 'Arma Mods',
    providerUrl: 'https://reforgermods.com/servers'
  }));
  ipcMain.handle('servers:details', (_event, _serverId, options = {}) => {
    if (options.refresh === true) {
      serverDetailsRefreshRequested = true;
      serverDetailsRefreshCount += 1;
    }
    return { server, mods: serverMods };
  });
  ipcMain.handle('servers:copy-mods', (_event, mods) => {
    copiedServerMods = mods;
    return { count: mods.length };
  });
  ipcMain.handle('servers:download', () => ({ queuedCount: 2, pendingCount: 2, server }));
  ipcMain.handle('servers:download-mod', (_event, requestedServerId, modId) => {
    downloadedServerMod = { serverId: requestedServerId, modId };
    return { queuedCount: 1, pendingCount: 1, server, mod: serverMods.find((mod) => mod.modId === modId) };
  });
  ipcMain.handle('servers:connect', async (_event, payload) => {
    serverConnectCount += 1;
    lastConnectPayload = payload;
    if (serverConnectDelayMs > 0) await wait(serverConnectDelayMs);
    if (serverConnectAvailability && payload.allowUnverified !== true) {
      return {
        launched: false,
        reason: 'server-unavailable',
        availability: serverConnectAvailability,
        retryAfterMs: 5_000,
        server,
        selectedCount: serverMods.length
      };
    }
    if (payload.allowUnverified !== true && server.playerLimit > 0 && server.playerCount >= server.playerLimit) {
      return {
        launched: false,
        reason: 'server-full',
        retryAfterMs: 3_000,
        server,
        selectedCount: serverMods.length
      };
    }
    const preset = payload.savePreset ? {
      id: '33333333-3333-4333-8333-333333333333',
      name: payload.presetName,
      sourceName: `server:${serverId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mods: serverMods.map(({ status: _status, installedVersion: _installedVersion, sizeBytes: _sizeBytes, ...mod }) => mod)
    } : null;
    if (preset) presets = [preset, ...presets];
    return {
      launched: true,
      connectionMode: 'native-menu',
      connectionAttempted: false,
      server,
      mods: serverMods,
      selectedCount: serverMods.length,
      missingCount: 1,
      mismatchCount: 1,
      preset,
      presets: preset ? presets : null,
      presetCreated: Boolean(preset)
    };
  });
  ipcMain.handle('servers:cancel-connect', () => {
    serverConnectCancelCount += 1;
    return { cancelled: true };
  });
  ipcMain.handle('mod-logs:list', () => modLogs);
  ipcMain.handle('mod-logs:add-many', (_event, entries) => {
    const saved = entries.map((entry, index) => ({
      ...entry,
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 1).padStart(12, '0')}`,
      timestamp: new Date().toISOString()
    }));
    modLogs = [...saved, ...modLogs];
    return saved;
  });
  ipcMain.handle('mod-logs:clear', () => true);

  const window = new BrowserWindow({
    width: 1380,
    height: 850,
    minWidth: 1040,
    minHeight: 680,
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  await window.loadURL(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await window.webContents.executeJavaScript("document.querySelector('#appVersion')?.textContent === 'v0.3.0'");
    if (ready) break;
    await wait(100);
  }

  const serverState = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-view="servers"]').click();
    for (let attempt = 0; attempt < 50 && !document.querySelector('[data-server-connect]'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const result = {
      activeView: document.querySelector('.view.active')?.id,
      navigationLabel: document.querySelector('[data-view="servers"] span').textContent.trim(),
      rows: document.querySelectorAll('.server-row').length,
      selectedName: document.querySelector('.server-row.active strong')?.textContent.trim(),
      modRows: document.querySelectorAll('.server-mod-row').length,
      hasReady: Boolean(document.querySelector('.server-mod-row .status-badge.ready')),
      hasMissing: Boolean(document.querySelector('.server-mod-row .status-badge.missing')),
      hasMismatch: Boolean(document.querySelector('.server-mod-row .status-badge.version-mismatch')),
      singleDownloadButtons: document.querySelectorAll('[data-server-mod-download]').length,
      downloadEnabled: !document.querySelector('[data-server-download]').disabled,
      copyEnabled: !document.querySelector('[data-server-copy-json]').disabled,
      copyLabel: document.querySelector('[data-server-copy-json]').textContent.trim(),
      connectEnabled: !document.querySelector('[data-server-connect]').disabled
    };
    const headerRect = document.querySelector('.server-details-header').getBoundingClientRect();
    const actionsRect = document.querySelector('.server-details-actions').getBoundingClientRect();
    const identityRect = document.querySelector('.server-details-identity').getBoundingClientRect();
    result.headerLayout = {
      identityBelowActions: identityRect.top >= actionsRect.bottom,
      actionsInsideHeader: actionsRect.left >= headerRect.left && actionsRect.right <= headerRect.right,
      identityInsideHeader: identityRect.left >= headerRect.left && identityRect.right <= headerRect.right,
      fullName: document.querySelector('.server-details-identity h2').textContent.trim()
    };
    document.querySelector('[data-server-copy-json]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    result.copyToast = document.querySelector('#toastRegion .toast')?.textContent.trim();
    document.querySelector('[data-server-mod-download="595F2BF2F44836FB"]').click();
    for (let attempt = 0; attempt < 50 && ![...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes('Download started for')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    result.singleDownloadToast = [...document.querySelectorAll('.toast')]
      .find((toast) => toast.textContent.includes('Download started for'))?.textContent.trim() || '';
    result.sortOptions = [...document.querySelector('#serverSort').options].map((option) => option.textContent.trim());
    document.querySelector('.server-row [data-server-favorite]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sort = document.querySelector('#serverSort');
    sort.value = 'favorites';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    result.favorite = {
      rows: document.querySelectorAll('.server-row').length,
      pressed: document.querySelector('.server-row [data-server-favorite]')?.getAttribute('aria-pressed')
    };
    sort.value = 'players_desc';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    document.querySelector('[data-language="ru"]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    result.russian = {
      navigation: document.querySelector('[data-view="servers"] span').textContent.trim(),
      connect: document.querySelector('[data-server-connect]').textContent.trim(),
      mods: document.querySelector('.server-mod-heading h3').textContent.trim()
    };
    document.querySelector('[data-language="en"]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.querySelector('[data-server-connect]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const dialog = document.querySelector('#serverJoinDialog');
    result.joinOpen = dialog.open;
    result.savePresetChecked = document.querySelector('#serverSavePreset').checked;
    result.presetName = document.querySelector('#serverPresetName').value;
    result.joinFacts = document.querySelector('#serverJoinFacts').textContent.trim();
    result.joinHelp = document.querySelector('#serverJoinHelp').textContent.trim();
    return result;
  })()`);

  if (serverState.activeView !== 'view-servers' || serverState.navigationLabel !== 'Servers'
    || serverState.rows !== 2 || serverState.modRows !== 3 || !serverState.hasReady
    || !serverState.hasMissing || !serverState.hasMismatch || !serverState.downloadEnabled || !serverState.copyEnabled
    || serverState.singleDownloadButtons !== 2 || !serverState.singleDownloadToast.includes('RHS - Status Quo')
    || serverState.copyLabel !== 'Copy JSON' || serverState.copyToast !== 'Server mod JSON copied: 3 mods'
    || !serverState.headerLayout.identityBelowActions || !serverState.headerLayout.actionsInsideHeader
    || !serverState.headerLayout.identityInsideHeader || serverState.headerLayout.fullName !== server.name
    || !serverState.connectEnabled || !serverState.joinOpen || !serverState.savePresetChecked
    || serverState.sortOptions.join('|') !== 'Most players|Popular|Favorites'
    || serverState.favorite.rows !== 1 || serverState.favorite.pressed !== 'true' || settings.favoriteServers.length !== 1
    || !serverState.presetName.includes(server.name) || !serverState.joinFacts.includes('3 server mods')
    || !serverState.joinHelp.includes('main menu first') || !serverState.joinHelp.includes('Confirm')
    || serverState.russian.navigation !== 'Сервера' || serverState.russian.connect !== 'Подключиться'
    || serverState.russian.mods !== 'Моды сервера' || !serverDetailsRefreshRequested
    || copiedServerMods?.length !== 3 || copiedServerMods[0]?.modId !== '1337C0DE5DABBEEF'
    || downloadedServerMod?.serverId !== serverId || downloadedServerMod?.modId !== '595F2BF2F44836FB') {
    throw new Error(`Server UI is invalid: ${JSON.stringify(serverState)}`);
  }

  window.webContents.invalidate();
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile(joinOutputPath, (await window.capturePage()).toPNG());

  const joinState = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#confirmServerJoin').click();
    for (let attempt = 0; attempt < 50 && document.querySelector('#serverJoinDialog').open; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      closed: !document.querySelector('#serverJoinDialog').open,
      activePreset: document.querySelector('#footerPresetName').textContent.trim(),
      presetCount: document.querySelector('#navPresetsCount').textContent.trim()
    };
  })()`);
  if (!joinState.closed || joinState.activePreset !== serverState.presetName || joinState.presetCount !== '2'
    || lastConnectPayload?.serverId !== serverId || lastConnectPayload?.savePreset !== true
    || lastConnectPayload?.presetName !== serverState.presetName
    || lastConnectPayload?.mods?.length !== serverMods.length) {
    throw new Error(`Server connection prompt is invalid: ${JSON.stringify({ joinState, lastConnectPayload })}`);
  }

  const refreshCountBeforeFullWait = serverDetailsRefreshCount;
  server.playerCount = server.playerLimit;
  server.queueCount = 5;
  const fullServerState = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-server-connect]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.querySelector('#confirmServerJoin').click();
    for (let attempt = 0; attempt < 100
      && document.querySelector('#confirmServerJoin').textContent.trim() !== 'Waiting for a slot…'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      open: document.querySelector('#serverJoinDialog').open,
      disabled: document.querySelector('#confirmServerJoin').disabled,
      button: document.querySelector('#confirmServerJoin').textContent.trim(),
      facts: document.querySelector('#serverJoinFacts').textContent.trim(),
      help: document.querySelector('#serverJoinHelp').textContent.trim()
    };
  })()`);
  if (!fullServerState.open || !fullServerState.disabled
    || fullServerState.button !== 'Waiting for a slot…'
    || !fullServerState.facts.includes('128/128 players')
    || !fullServerState.facts.includes('Queue: 5')
    || !fullServerState.help.includes('every 5 seconds')) {
    throw new Error(`Full server wait state is invalid: ${JSON.stringify(fullServerState)}`);
  }

  server.playerCount = server.playerLimit - 1;
  server.queueCount = 0;
  const slotState = await window.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 180 && document.querySelector('#serverJoinDialog').open; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      closed: !document.querySelector('#serverJoinDialog').open,
      button: document.querySelector('#confirmServerJoin').textContent.trim(),
      facts: document.querySelector('#serverJoinFacts').textContent.trim(),
      help: document.querySelector('#serverJoinHelp').textContent.trim()
    };
  })()`);
  if (!slotState.closed) throw new Error(`Launcher did not connect after a slot appeared: ${JSON.stringify({ slotState, refreshCountBeforeFullWait, serverDetailsRefreshCount, serverConnectCount })}`);

  serverConnectAvailability = 'stale';
  const unavailableState = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-server-connect]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const presetName = document.querySelector('#serverPresetName');
    presetName.value = 'Keep this exact preset name';
    const savePreset = document.querySelector('#serverSavePreset');
    savePreset.checked = false;
    savePreset.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#confirmServerJoin').click();
    for (let attempt = 0; attempt < 100
      && document.querySelector('#forceServerJoin').hidden; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      open: document.querySelector('#serverJoinDialog').open,
      disabled: document.querySelector('#confirmServerJoin').disabled,
      confirmText: document.querySelector('#confirmServerJoin').textContent.trim(),
      forceVisible: !document.querySelector('#forceServerJoin').hidden,
      help: document.querySelector('#serverJoinHelp').textContent.trim(),
      helpState: document.querySelector('#serverJoinHelp').dataset.state,
      savePreset: document.querySelector('#serverSavePreset').checked,
      presetName: document.querySelector('#serverPresetName').value,
      errorToast: [...document.querySelectorAll('#toastRegion .toast')]
        .some((toast) => toast.textContent.includes('address or status may be outdated'))
    };
  })()`);
  if (!unavailableState.open || unavailableState.disabled || unavailableState.helpState !== 'warning'
    || unavailableState.confirmText !== 'Check again' || !unavailableState.forceVisible
    || !unavailableState.help.includes('address or status may be outdated') || !unavailableState.errorToast
    || unavailableState.savePreset || unavailableState.presetName !== 'Keep this exact preset name') {
    throw new Error(`Unavailable server guard is invalid: ${JSON.stringify(unavailableState)}`);
  }

  const overrideState = await window.webContents.executeJavaScript(`(async () => {
    const savePreset = document.querySelector('#serverSavePreset');
    savePreset.checked = true;
    savePreset.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#forceServerJoin').click();
    for (let attempt = 0; attempt < 100 && document.querySelector('#serverJoinDialog').open; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      closed: !document.querySelector('#serverJoinDialog').open,
      launchToast: [...document.querySelectorAll('#toastRegion .toast')]
        .some((toast) => toast.textContent.includes('Starting Arma for'))
    };
  })()`);
  if (!overrideState.closed || !overrideState.launchToast || lastConnectPayload?.allowUnverified !== true
    || lastConnectPayload?.savePreset !== true || lastConnectPayload?.presetName !== 'Keep this exact preset name') {
    throw new Error(`Server warning override is invalid: ${JSON.stringify({ overrideState, lastConnectPayload })}`);
  }

  serverConnectDelayMs = 250;
  const cancelCountBefore = serverConnectCancelCount;
  const connectCountBeforeCancel = serverConnectCount;
  const cancelledState = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-server-connect]').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const opened = document.querySelector('#serverJoinDialog').open;
    const disabledBefore = document.querySelector('#confirmServerJoin').disabled;
    document.querySelector('#confirmServerJoin').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const checkingText = document.querySelector('#confirmServerJoin').textContent.trim();
    document.querySelector('#serverJoinDialog [data-dialog-close]').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      opened,
      disabledBefore,
      checkingText,
      cancelApi: typeof window.reforgerLauncher.cancelServerConnect,
      closed: !document.querySelector('#serverJoinDialog').open,
      failureDialogClosed: !document.querySelector('#serverConnectionFailureDialog').open
    };
  })()`);
  serverConnectDelayMs = 0;
  if (!cancelledState.closed || !cancelledState.failureDialogClosed
    || serverConnectCancelCount !== cancelCountBefore + 1) {
    throw new Error(`Cancelled server response changed the UI: ${JSON.stringify({ cancelledState, serverConnectCancelCount, cancelCountBefore, serverConnectCount, connectCountBeforeCancel })}`);
  }

  await window.webContents.executeJavaScript("document.querySelector('#mandatoryUpdateDialog').showModal()");
  window.webContents.send('servers:connection-failure', {
    server,
    reason: 'handshake-timeout',
    logPath: 'C:\\Users\\User\\Documents\\My Games\\ArmaReforger\\logs\\console.log'
  });
  const failureReceived = await waitForCondition(() => window.webContents.executeJavaScript(
    "document.querySelector('#serverConnectionFailureMessage').textContent.includes('did not receive a response')"
  ));
  if (!failureReceived) throw new Error('Timed out waiting for the connection failure event.');
  const failureBehindMandatory = await window.webContents.executeJavaScript(`({
    mandatoryOpen: document.querySelector('#mandatoryUpdateDialog').open,
    failureOpen: document.querySelector('#serverConnectionFailureDialog').open
  })`);
  if (!failureBehindMandatory.mandatoryOpen || failureBehindMandatory.failureOpen) {
    throw new Error(`Connection failure displaced the mandatory update: ${JSON.stringify(failureBehindMandatory)}`);
  }
  await window.webContents.executeJavaScript("document.querySelector('#mandatoryUpdateDialog').close('test')");
  const failureOpened = await waitForCondition(() => window.webContents.executeJavaScript(
    "document.querySelector('#serverConnectionFailureDialog').open"
  ));
  if (!failureOpened) throw new Error('Timed out waiting for the deferred connection failure dialog.');
  const failureState = await window.webContents.executeJavaScript(`({
      open: document.querySelector('#serverConnectionFailureDialog').open,
      title: document.querySelector('#serverConnectionFailureTitle').textContent.trim(),
      server: document.querySelector('#serverConnectionFailureServer').textContent.trim(),
      message: document.querySelector('#serverConnectionFailureMessage').textContent.trim(),
      logPath: document.querySelector('#serverConnectionFailureLogPath').textContent.trim(),
      okay: document.querySelector('#serverConnectionFailureOk').textContent.trim()
  })`);
  window.webContents.invalidate();
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile(failureOutputPath, (await window.capturePage()).toPNG());
  failureState.closed = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#serverConnectionFailureOk').click();
    return !document.querySelector('#serverConnectionFailureDialog').open;
  })()`);
  if (!failureState.open || failureState.title !== 'Could not connect to the server'
    || failureState.server !== server.name || !failureState.message.includes('did not receive a response')
    || !failureState.logPath.endsWith('console.log') || failureState.okay !== 'OK' || !failureState.closed) {
    throw new Error(`Connection failure dialog is invalid: ${JSON.stringify(failureState)}`);
  }

  for (const reason of ['native-join-unavailable', 'native-join-timeout']) {
    window.webContents.send('servers:connection-failure', { server, reason, logPath: 'B:\\Profile\\profile\\ALGZLauncherServerJoinStatus.txt' });
    if (!await waitForCondition(() => window.webContents.executeJavaScript(
      "document.querySelector('#serverConnectionFailureDialog').open"
    ))) throw new Error(`Native join diagnostics did not open: ${reason}`);
    const nativeMessage = await window.webContents.executeJavaScript(
      "document.querySelector('#serverConnectionFailureMessage').textContent"
    );
    if (!nativeMessage.includes(server.address) || !nativeMessage.includes('server browser')
      || nativeMessage.includes('did not receive a response')) {
      throw new Error(`Native join diagnostics blamed a server/network failure: ${nativeMessage}`);
    }
    await window.webContents.executeJavaScript("document.querySelector('#serverConnectionFailureOk').click()");
  }

  window.webContents.invalidate();
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile(outputPath, (await window.capturePage()).toPNG());

  window.setSize(1040, 680);
  const logState = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#footerModLogs').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dialog = document.querySelector('#modLogsDialog');
    const before = dialog.getBoundingClientRect();
    const handle = document.querySelector('#modLogsResizeHandle');
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 71,
      button: 0,
      clientX: before.right - 3,
      clientY: before.bottom - 3,
      bubbles: true,
      cancelable: true
    }));
    document.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 71,
      clientX: before.right - 420,
      clientY: before.bottom - 260,
      bubbles: true
    }));
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 71, button: 0, bubbles: true }));
    const after = dialog.getBoundingClientRect();
    const table = document.querySelector('.mod-logs-table-scroll');
    const close = document.querySelector('#closeModLogs').getBoundingClientRect();
    const grip = handle.getBoundingClientRect();
    return {
      open: dialog.open,
      modeless: !dialog.matches(':modal'),
      width: Math.round(after.width),
      height: Math.round(after.height),
      insideViewport: after.left >= 0 && after.top >= 0 && after.right <= innerWidth && after.bottom <= innerHeight,
      resizedSmaller: after.width < before.width && after.height < before.height,
      horizontalScroll: table.scrollWidth > table.clientWidth,
      closeVisible: close.left >= after.left && close.right <= after.right && close.bottom <= after.bottom,
      gripVisible: grip.width >= 24 && grip.height >= 24
    };
  })()`);
  if (!logState.open || !logState.modeless || !logState.insideViewport || !logState.resizedSmaller
    || !logState.horizontalScroll || !logState.closeVisible || !logState.gripVisible) {
    throw new Error(`Resizable mod log panel is invalid: ${JSON.stringify(logState)}`);
  }

  window.webContents.invalidate();
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile(logsOutputPath, (await window.capturePage()).toPNG());
  process.stdout.write(`${JSON.stringify({ serverState, joinState, logState })}\n${outputPath}\n${joinOutputPath}\n${failureOutputPath}\n${logsOutputPath}\n`);
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
