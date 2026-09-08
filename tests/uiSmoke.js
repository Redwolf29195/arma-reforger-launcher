const { app, BrowserWindow, ipcMain } = require('electron');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const profilePath = path.join(os.tmpdir(), `arma-launcher-ui-smoke-${process.pid}`);
fsSync.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', path.join(profilePath, 'session'));

const outputPath = process.argv.find((argument) => /\.png$/i.test(argument))
  || path.join(app.getPath('temp'), 'arma-launcher-ui-smoke.png');
const homeOutputPath = outputPath.replace(/\.png$/i, '.home.png');
const detailsOutputPath = outputPath.replace(/\.png$/i, '.details.png');
const viewerOutputPath = outputPath.replace(/\.png$/i, '.viewer.png');
const relationshipsOutputPath = outputPath.replace(/\.png$/i, '.relationships.png');
const modLogsOutputPath = outputPath.replace(/\.png$/i, '.mod-logs.png');
const mandatoryUpdateOutputPath = outputPath.replace(/\.png$/i, '.mandatory-update.png');
const previewImageUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'assets', 'launcher-cover.png')).href;
const screenshotImageUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'assets', 'app-icon.png')).href;

app.whenReady().then(async () => {
  let updateDownloadRequests = 0;
  let updateInstallRequests = 0;
  let backgroundScanRequests = 0;
  let settingsSaveRequests = 0;
  let officialReleaseOpenRequests = 0;
  let resumeDownloadRequests = 0;
  let failDownloadStatusOnce = false;
  const modActionRequests = [];
  let modActionScenario = {};
  let mockDownloadStatus = { state: 'idle', completed: 0, total: 0, failed: 0, progress: 0, message: '' };
  let licenseReadRequests = 0;
  let mockSettings = {
    gameExecutable: 'B:\\ArmaReforgerSteam.exe',
    addonsDirectory: 'B:\\ArmaReforger\\addons',
    downloadRoot: 'B:\\ArmaReforger',
    profileDirectory: 'B:\\ArmaLauncherProfile',
    noSplash: true,
    allowVersionMismatch: false,
    additionalArguments: '',
    defaultPresetId: '22222222-2222-4222-8222-222222222222',
    autoUpdate: true,
    showModLogsFooter: true,
    autoAddDependencies: true,
    confirmModDeletion: true,
    language: 'en'
  };
  const mockPresetId = '11111111-1111-4111-8111-111111111111';
  const workshopItems = [
    {
      modId: '7B4C0E19A6D34F82',
      name: 'ALGZ Admin API',
      author: 'ALGZ',
      summary: 'Server administration API and launcher integration.',
      version: '1.4.2',
      sizeBytes: 28190208,
      ratingPercent: 91,
      subscriberCount: 8421,
      previewUrl: ''
    },
    {
      modId: '595F2BF2F44836FB',
      name: 'RHS - Status Quo',
      author: 'Red Hammer Studios',
      summary: 'RHS content for Arma Reforger with vehicles and systems.',
      version: '0.16.5150',
      sizeBytes: 204219382,
      ratingPercent: 88,
      subscriberCount: 31995,
      previewUrl: ''
    }
  ];
  let mockPresets = [{
    id: mockPresetId,
    name: 'Field Ops',
    createdAt: '2026-08-14T12:00:00.000Z',
    updatedAt: '2026-08-14T12:00:00.000Z',
    mods: [
      { modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.10', required: true },
      { modId: '618C2492CC62D0D5', name: 'Gs BTR-90', version: '2.9.0', required: true },
      { modId: '5994AD5A9F33BE57', name: 'Game Master FX', version: '1.0.0', required: true }
    ]
  }];
  mockPresets.push({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Training',
    createdAt: '2026-08-14T11:00:00.000Z',
    updatedAt: '2026-08-14T11:00:00.000Z',
    mods: [{ modId: '59674C21AA886D57', name: 'Training Tools', version: '1.0.0', required: true }]
  });
  let mockLogSequence = 1;
  let mockModLogs = [{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    timestamp: '2026-08-16T12:30:00.000Z',
    action: 'preset-add',
    source: 'workshop',
    modId: '646B350F36C6D3E4',
    name: 'Breachable Doors',
    version: '1.1.10',
    presetId: mockPresetId,
    presetName: 'Field Ops',
    details: ''
  }];
  const appendMockLogs = (entries) => {
    const saved = entries.map((entry) => ({
      ...entry,
      id: `00000000-0000-4000-8000-${String(mockLogSequence++).padStart(12, '0')}`,
      timestamp: new Date(Date.now() + mockLogSequence).toISOString()
    }));
    mockModLogs = [...saved, ...mockModLogs].slice(0, 1000);
    return saved;
  };
  ipcMain.handle('launcher:bootstrap', () => ({
    appVersion: '0.2.9',
    packaged: false,
    platform: 'win32',
    buildIdentity: {
      status: 'development',
      releaseTier: 'development',
      version: '0.2.9',
      buildId: '',
      builtAt: '',
      authenticode: 'development',
      signer: '',
      officialReleasesUrl: 'https://github.com/Redwolf29195/arma-reforger-launcher-updates/releases/latest',
      license: 'GPL-3.0-only'
    },
    settings: mockSettings,
    modLogCount: mockModLogs.length,
    presets: mockPresets,
    workspace: {
      activePresetId: mockPresetId,
      name: 'Field Ops',
      dirty: false,
      mods: mockPresets[0].mods
    },
    installedMods: [
      {
        modId: '646B350F36C6D3E4',
        name: 'Breachable Doors',
        version: 'v1.1.10.0',
        corrupted: false,
        directoryPath: 'B:\\ArmaReforger\\addons\\Breachable Doors_646B350F36C6D3E4',
        dependencies: [{ modId: '5994AD5A9F33BE57', name: 'Game Master FX', version: '1.0.0' }]
      },
      {
        modId: '618C2492CC62D0D5',
        name: 'Gs BTR-90',
        version: '3.1.0',
        corrupted: false,
        directoryPath: 'B:\\ArmaReforger\\addons\\Gs BTR-90_618C2492CC62D0D5',
        dependencies: [{ modId: '646B350F36C6D3E4', name: 'Breachable Doors', version: '1.1.10' }]
      },
      {
        modId: '5994AD5A9F33BE57',
        name: 'Game Master FX',
        version: '1.0.0',
        corrupted: false,
        directoryPath: 'B:\\ArmaReforger\\addons\\Game Master FX_5994AD5A9F33BE57',
        dependencies: []
      }
    ]
  }));
  ipcMain.handle('mod-logs:list', () => mockModLogs);
  ipcMain.handle('mod-logs:add', (_event, entry) => appendMockLogs([entry])[0]);
  ipcMain.handle('mod-logs:add-many', (_event, entries) => appendMockLogs(entries));
  ipcMain.handle('mod-logs:clear', () => {
    mockModLogs = [];
    return true;
  });
  ipcMain.handle('workspace:save', (_event, workspace) => workspace);
  ipcMain.handle('game:download-status', () => {
    if (failDownloadStatusOnce) {
      failDownloadStatusOnce = false;
      throw new Error('Temporary status file lock');
    }
    return mockDownloadStatus;
  });
  ipcMain.handle('game:resume-download', () => {
    resumeDownloadRequests++;
    mockDownloadStatus = { state: 'queued', completed: 0, total: 2, failed: 0, progress: 0 };
    return { launched: true, queuedCount: 2 };
  });
  ipcMain.handle('mods:scan', () => {
    backgroundScanRequests += 1;
    return modActionScenario.installedMods || [];
  });
  ipcMain.handle('updates:download', () => {
    updateDownloadRequests += 1;
    return true;
  });
  ipcMain.handle('updates:install', () => {
    updateInstallRequests += 1;
    return true;
  });
  ipcMain.handle('updates:check', () => ({ state: 'current', version: '0.3.24' }));
  ipcMain.handle('system:open-official-releases', () => {
    officialReleaseOpenRequests += 1;
    return true;
  });
  ipcMain.handle('launcher:license', () => {
    licenseReadRequests += 1;
    return 'GNU GENERAL PUBLIC LICENSE\n\nVersion 3, 29 June 2007';
  });
  ipcMain.handle('mods:details', (_event, modId) => ({
    modId,
    name: 'Breachable Doors',
    author: 'Community Author',
    summary: 'Open locked doors with the correct tools.',
    description: 'Adds breaching interactions and configurable door behavior.',
    license: 'APL-SA',
    ratingPercent: 94,
    ratingCount: 118,
    version: '1.1.10',
    gameVersion: '1.7.0.54',
    sizeBytes: 18743296,
    downloads: 54021,
    createdAt: '2025-02-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:00:00.000Z',
    previewUrls: [previewImageUrl],
    screenshotUrls: [screenshotImageUrl],
    tags: ['GAMEPLAY', 'TOOLS'],
    dependencies: [{ modId: '5994AD5A9F33BE57', name: 'Game Master FX', version: '1.0.0', sizeBytes: 1024 }],
    versions: [{ version: '1.1.10', gameVersion: '1.7.0.54', sizeBytes: 18743296, createdAt: '2026-08-10T10:00:00.000Z' }],
    changelog: 'Compatibility update.',
    workshopUrl: `https://reforger.armaplatform.com/workshop/${modId}`
  }));
  ipcMain.handle('workshop:search', (_event, payload = {}) => {
    const items = payload.category === 'VEHICLES'
      ? workshopItems.slice(1)
      : payload.category
        ? workshopItems.slice(0, 1)
        : workshopItems;
    return {
      query: payload.query || '',
      category: payload.category || '',
      sort: payload.sort || 'subscribers',
      page: payload.page || 1,
      count: items.length,
      pageSize: 16,
      items
    };
  });
  ipcMain.handle('workshop:install', (_event, mod) => {
    modActionRequests.push({ type: 'install', modId: mod.modId });
    if (modActionScenario.installError) throw new Error('Simulated Workshop failure');
    return { modId: mod.modId, queuedCount: 1, dependencyCount: 0, ...modActionScenario.installResult };
  });
  ipcMain.handle('mods:update', (_event, payload) => {
    modActionRequests.push({ type: 'update', modIds: payload.modIds });
    return modActionScenario.updateResult || { alreadyUpToDate: true, checkedCount: payload.modIds.length, queuedCount: 0, skippedCount: 0 };
  });
  ipcMain.handle('presets:list', () => mockPresets);
  ipcMain.handle('presets:save', (_event, preset) => {
    const saved = { ...preset, id: preset.id || mockPresetId, updatedAt: new Date().toISOString() };
    mockPresets = [...mockPresets.filter((item) => item.id !== saved.id), saved];
    return saved;
  });
  ipcMain.handle('presets:add-mod', (_event, payload) => {
    const target = mockPresets.find((preset) => preset.id === payload.presetId);
    const created = !target;
    const base = target || {
      id: '33333333-3333-4333-8333-333333333333',
      name: payload.presetName || 'Workshop',
      createdAt: new Date().toISOString(),
      mods: []
    };
    const alreadyPresent = base.mods.some((mod) => mod.modId === payload.mod.modId);
    const saved = {
      ...base,
      updatedAt: new Date().toISOString(),
      mods: [...base.mods.filter((mod) => mod.modId !== payload.mod.modId), payload.mod]
    };
    mockPresets = [...mockPresets.filter((preset) => preset.id !== saved.id), saved];
    return { preset: saved, presets: mockPresets, created, alreadyPresent };
  });
  ipcMain.handle('presets:remove-mod', (_event, payload) => {
    const target = mockPresets.find((preset) => preset.id === payload.presetId);
    if (!target) throw new Error('The selected preset was not found.');
    const removedMod = target.mods.find((mod) => mod.modId === payload.modId);
    if (!removedMod) throw new Error('The mod was not found in the selected preset.');
    const mods = target.mods.filter((mod) => mod.modId !== payload.modId);
    const preset = mods.length > 0 ? { ...target, mods, updatedAt: new Date().toISOString() } : null;
    mockPresets = preset
      ? [...mockPresets.filter((item) => item.id !== target.id), preset]
      : mockPresets.filter((item) => item.id !== target.id);
    const nextPreset = preset || mockPresets[0] || null;
    return {
      preset,
      presets: mockPresets,
      removedMod,
      presetRemoved: !preset,
      workspace: {
        activePresetId: nextPreset?.id || '',
        name: nextPreset?.name || '',
        dirty: false,
        mods: nextPreset?.mods || []
      }
    };
  });
  ipcMain.handle('settings:save', (_event, patch) => {
    settingsSaveRequests += 1;
    mockSettings = { ...mockSettings, ...patch };
    return mockSettings;
  });
  ipcMain.handle('settings:reset', () => {
    mockSettings = { ...mockSettings, language: 'en' };
    return mockSettings;
  });
  ipcMain.handle('servers:list', () => ({
    items: [], page: 1, pageSize: 50, hasNext: false,
    providerUrl: 'https://reforgermods.com/servers'
  }));

  const window = new BrowserWindow({
    width: 1380,
    height: 850,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden Windows windows may retain an old compositor surface even after
      // DOM/RAF assertions pass. Offscreen painting keeps captures current.
      offscreen: true,
      backgroundThrottling: false
    }
  });

  await window.loadURL(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await window.webContents.executeJavaScript(
      `document.querySelector('#appVersion')?.textContent.trim() === 'v0.2.9'
        && document.querySelector('#titlebarStatus')?.textContent.trim() !== 'Loading launcher'`
    );
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  window.webContents.invalidate();
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const homeImage = await window.capturePage();
  await fs.writeFile(homeOutputPath, homeImage.toPNG());
  const result = await window.webContents.executeJavaScript(`(async () => {
    // Populate the hidden Mods view before checking its normalized status badges.
    renderMods();
    const englishInitial = {
      language: document.documentElement.lang,
      dashboard: document.querySelector('[data-view="dashboard"] span').textContent.trim(),
      mods: document.querySelector('[data-view="mods"] span').textContent.trim(),
      workshop: document.querySelector('[data-view="workshop"] span').textContent.trim(),
      servers: document.querySelector('[data-view="servers"] span').textContent.trim(),
      homeTools: document.querySelectorAll('.home-tool-card').length,
      homeWelcomeTitle: document.querySelector('.home-hero-copy h2')?.textContent.trim() || '',
      homeWelcomeKickerRemoved: !document.querySelector('.home-kicker'),
      normalizedVersionReady: document.querySelector('.mod-row[data-mod-id="646B350F36C6D3E4"] .status-badge')?.classList.contains('ready') === true,
      newerInstalledVersionReady: document.querySelector('.mod-row[data-mod-id="618C2492CC62D0D5"] .status-badge')?.classList.contains('ready') === true,
      homeDescriptionRemoved: !document.querySelector('.home-hero-description'),
      homeSessionLabelRemoved: !document.querySelector('[data-home-i18n="home.sessionLabel"]'),
      homePreset: document.querySelector('#homePresetName')?.textContent.trim() || '',
      homeSelected: document.querySelector('#homePresetMeta')?.textContent.trim() || '',
      homeModsMetric: document.querySelector('#homeModsMetric')?.textContent.trim() || '',
      homePresetsMetric: document.querySelector('#homePresetsMetric')?.textContent.trim() || '',
      homeGuideTitle: document.querySelector('.home-guide-card strong')?.textContent.trim() || '',
      homeDiscord: document.querySelector('#homeDiscordLink')?.href || '',
      homeWebsite: document.querySelector('#homeWebsiteLink')?.href || '',
      homeCredit: document.querySelector('.home-community-credit')?.textContent.trim() || '',
      homeLegacyContent: Boolean(document.querySelector('#dashboardPresetName, #metricSelected, #dashboardStatusList')),
      downloadMissing: document.querySelector('#downloadMissingMods').textContent.trim()
    };
    const noSplashToggle = document.querySelector('#settingNoSplash');
    const noSplashRow = noSplashToggle.closest('.setting-row');
    const noSplashControl = {
      present: Boolean(noSplashToggle),
      label: noSplashRow.querySelector('strong')?.textContent.trim() || '',
      initiallyChecked: noSplashToggle.checked,
      technicalSubtitlePresent: [...noSplashRow.querySelectorAll('small')]
        .some((element) => element.textContent.includes('-noSplash'))
    };
    noSplashToggle.click();
    noSplashControl.toggledOff = !noSplashToggle.checked;
    noSplashToggle.click();
    noSplashControl.restored = noSplashToggle.checked;
    document.querySelector('#openAboutSidebar').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const aboutDialog = document.querySelector('#aboutDialog');
    const aboutRect = aboutDialog.getBoundingClientRect();
    const authenticity = {
      sidebarButton: Boolean(document.querySelector('#openAboutSidebar')),
      sidebarStatus: document.querySelector('#sidebarBuildStatus').textContent.trim(),
      open: aboutDialog.open,
      modalFits: aboutRect.width <= innerWidth && aboutRect.height <= innerHeight,
      title: document.querySelector('#aboutDialogTitle').textContent.trim(),
      sidebarAria: document.querySelector('#openAboutSidebar').getAttribute('aria-label'),
      sidebarTitle: document.querySelector('#openAboutSidebar').title,
      product: document.querySelector('#aboutProductName').textContent.trim(),
      developer: document.querySelector('#aboutDeveloperValue').textContent.trim(),
      discord: document.querySelector('#aboutDiscordValue').textContent.trim(),
      version: document.querySelector('#aboutVersionValue').textContent.trim(),
      overallStatus: document.querySelector('#aboutOverallStatus').textContent.trim(),
      overallTone: document.querySelector('#aboutIdentityBanner').dataset.status,
      integrityStatus: document.querySelector('#aboutIntegrityStatus').textContent.trim(),
      windowsStatus: document.querySelector('#aboutWindowsStatus').textContent.trim(),
      source: document.querySelector('.about-official-source code').textContent.trim(),
      disclaimerMentionsBohemia: document.querySelector('#aboutTrademark').textContent.includes('Bohemia Interactive'),
      settingsEntry: Boolean(document.querySelector('#openAboutSettings'))
    };
    const originalBuildIdentity = state.buildIdentity;
    const originalPackaged = state.packaged;
    state.packaged = true;
    authenticity.states = {};
    for (const scenario of [
      { name: 'community', identity: { status: 'open-source', releaseTier: 'community', authenticode: 'unsigned', signer: '' } },
      { name: 'signed', identity: { status: 'open-source', releaseTier: 'public', authenticode: 'verified', signer: 'CN=ALGZ Publisher' } },
      { name: 'unsigned', identity: { status: 'open-source', releaseTier: 'public-unsigned', authenticode: 'unsigned', signer: '' } },
      { name: 'missing', identity: null }
    ]) {
      state.buildIdentity = scenario.identity;
      renderBuildIdentity();
      authenticity.states[scenario.name] = {
        tone: document.querySelector('#aboutIdentityBanner').dataset.status,
        overall: document.querySelector('#aboutOverallStatus').textContent.trim(),
        overallHidden: document.querySelector('#aboutOverallStatus').hidden,
        sidebar: document.querySelector('#sidebarBuildStatus').textContent.trim(),
        sidebarHidden: document.querySelector('#sidebarBuildStatus').hidden,
        settings: document.querySelector('#aboutSettingsStatus').textContent.trim(),
        settingsHidden: document.querySelector('#aboutSettingsStatus').hidden,
        integrity: document.querySelector('#aboutIntegrityStatus').textContent.trim(),
        windowsTone: document.querySelector('#aboutWindowsCard').dataset.status,
        windowsHidden: document.querySelector('#aboutWindowsCard').hidden,
        windows: document.querySelector('#aboutWindowsStatus').textContent.trim(),
        signer: document.querySelector('#aboutWindowsSigner').textContent.trim()
      };
    }
    state.buildIdentity = originalBuildIdentity;
    state.packaged = originalPackaged;
    renderBuildIdentity();
    document.querySelector('#openLicense').click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const licenseDialog = document.querySelector('#licenseDialog');
    authenticity.licenseOpen = licenseDialog.open;
    authenticity.aboutClosedForLicense = !aboutDialog.open;
    authenticity.licenseTitle = document.querySelector('#licenseDialogTitle').textContent.trim();
    authenticity.licenseLoaded = document.querySelector('#licenseDialogText').textContent.includes('GNU GENERAL PUBLIC LICENSE');
    document.querySelector('#licenseBackToAbout').click();
    authenticity.returnedToAbout = aboutDialog.open && !licenseDialog.open;
    document.querySelector('#openOfficialReleases').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    aboutDialog.querySelector('[data-dialog-close]').click();
    authenticity.closed = !aboutDialog.open;
    document.querySelector('#homeManualOpen').click();
    const homeManual = {
      open: document.querySelector('#homeManualDialog').open,
      title: document.querySelector('#homeManualDialog h2').textContent.trim(),
      steps: document.querySelectorAll('.home-manual-steps li').length
    };
    document.querySelector('#homeManualDialog [data-dialog-close]').click();
    homeManual.closed = !document.querySelector('#homeManualDialog').open;
    document.querySelector('.home-tool-card[data-home-view="mods"]').click();
    const homeNavigation = document.querySelector('.view.active')?.id || '';
    document.querySelector('.nav-item[data-view="dashboard"]').click();
    document.querySelector('#importPreset').click();
    const dialog = document.querySelector('#importDialog');
    const rect = dialog.getBoundingClientRect();
    const dialogResult = {
      dialogOpen: dialog.open,
      dialogWidth: Math.round(rect.width),
      dialogHeight: Math.round(rect.height),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      textareaVisible: document.querySelector('#presetJsonInput').offsetHeight > 0,
      shareButtonPresent: Boolean(document.querySelector('#sharePreset')),
      shareFileButtonPresent: Boolean(document.querySelector('#shareFilePreset')),
      updateButtonsPresent: Boolean(document.querySelector('#downloadUpdate') && document.querySelector('#installUpdate')),
      updateButtonsHidden: getComputedStyle(document.querySelector('#downloadUpdate')).display === 'none'
        && getComputedStyle(document.querySelector('#installUpdate')).display === 'none'
    };
    document.querySelector('#closeImportDialog').click();
    dialogResult.closedByX = !dialog.open;
    document.querySelector('#importPreset').click();
    document.querySelector('#cancelImportDialog').click();
    dialogResult.closedByCancel = !dialog.open;
    document.querySelector('[data-view="mods"]').click();
    document.querySelector('.mod-main').click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const detailsDialog = document.querySelector('#modDetailsDialog');
    const modDetails = {
      open: detailsDialog.open,
      title: document.querySelector('#modDetailsTitle').textContent.trim(),
      hasFacts: document.querySelectorAll('.mod-details-facts > div').length >= 8,
      hasDependency: Boolean(document.querySelector('.mod-details-dependency')),
      hasLocalDependent: Boolean(document.querySelector('.mod-details-dependent')),
      hasDescription: document.querySelector('.mod-details-copy')?.textContent.includes('breaching') === true,
      imageCount: document.querySelectorAll('.mod-details-thumbnail').length
    };
    const heroImage = document.querySelector('#modDetailsHero');
    const initialViewerSource = heroImage.src;
    heroImage.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const imageViewerDialog = document.querySelector('#imageViewerDialog');
    const imageViewer = {
      open: !imageViewerDialog.hidden,
      counter: document.querySelector('#imageViewerCounter').textContent.trim(),
      initialScale: document.querySelector('#imageViewerScale').textContent.trim(),
      controlsPresent: ['#imageViewerPrevious', '#imageViewerNext', '#imageViewerZoomOut', '#imageViewerZoomIn', '#imageViewerReset', '#closeImageViewer']
        .every((selector) => Boolean(document.querySelector(selector)))
    };
    document.querySelector('#imageViewerZoomIn').click();
    document.querySelector('#imageViewerZoomIn').click();
    imageViewer.buttonScale = document.querySelector('#imageViewerScale').textContent.trim();
    const viewerStage = document.querySelector('#imageViewerStage');
    const viewerRect = viewerStage.getBoundingClientRect();
    viewerStage.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120,
      clientX: viewerRect.left + (viewerRect.width / 2),
      clientY: viewerRect.top + (viewerRect.height / 2),
      bubbles: true,
      cancelable: true
    }));
    imageViewer.wheelScale = document.querySelector('#imageViewerScale').textContent.trim();
    await new Promise((resolve) => setTimeout(resolve, 160));
    const transformBeforeDrag = document.querySelector('#imageViewerImage').style.transform;
    viewerStage.setPointerCapture = () => {};
    viewerStage.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 7,
      button: 0,
      clientX: viewerRect.left + (viewerRect.width / 2),
      clientY: viewerRect.top + (viewerRect.height / 2),
      bubbles: true
    }));
    viewerStage.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 7,
      clientX: viewerRect.left + (viewerRect.width / 2) + 45,
      clientY: viewerRect.top + (viewerRect.height / 2) + 30,
      bubbles: true
    }));
    viewerStage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, button: 0, bubbles: true }));
    imageViewer.dragged = document.querySelector('#imageViewerImage').style.transform !== transformBeforeDrag;
    delete viewerStage.setPointerCapture;
    document.querySelector('#imageViewerNext').click();
    imageViewer.switchedImage = document.querySelector('#imageViewerImage').src !== initialViewerSource;
    document.querySelector('#imageViewerReset').click();
    imageViewer.resetScale = document.querySelector('#imageViewerScale').textContent.trim();
    document.querySelector('#closeImageViewer').click();
    imageViewer.closed = imageViewerDialog.hidden;
    document.querySelector('#closeModDetails').click();
    const relationship = document.querySelector('[data-mod-id="646B350F36C6D3E4"] .relationship-count');
    const dependencyCheckbox = document.querySelector('[data-mod-id="5994AD5A9F33BE57"] .mod-checkbox');
    dependencyCheckbox.checked = false;
    dependencyCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const dependencyCascade = {
      dependencies: relationship.dataset.dependencies,
      dependents: relationship.dataset.dependents,
      selectedAfterDisable: document.querySelectorAll('.mod-checkbox:checked').length,
      disableToast: [...document.querySelectorAll('.toast')].at(-1)?.textContent.trim() || ''
    };
    const mainModCheckbox = document.querySelector('[data-mod-id="618C2492CC62D0D5"] .mod-checkbox');
    mainModCheckbox.checked = true;
    mainModCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 140));
    dependencyCascade.selectedAfterEnable = document.querySelectorAll('.mod-checkbox:checked').length;
    dependencyCascade.enableToast = [...document.querySelectorAll('.toast')].at(-1)?.textContent.trim() || '';
    dependencyCascade.autosaved = !document.querySelector('#footerPresetName').textContent.includes('*');
    document.querySelector('[data-view="settings"]').click();
    dependencyCascade.settingDefaultOn = document.querySelector('#settingAutoAddDependencies').checked;
    dependencyCascade.manualButtonHiddenWithAutoOn = document.querySelector('#addDependencies').hidden;
    document.querySelector('#settingAutoAddDependencies').checked = false;
    document.querySelector('#saveSettings').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    dependencyCascade.settingDisabled = !document.querySelector('#settingAutoAddDependencies').checked;
    document.querySelector('[data-view="mods"]').click();
    dependencyCascade.manualButtonVisibleWithAutoOff = !document.querySelector('#addDependencies').hidden;
    document.querySelector('#clearSelection').click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const manualMainCheckbox = document.querySelector('[data-mod-id="618C2492CC62D0D5"] .mod-checkbox');
    manualMainCheckbox.checked = true;
    manualMainCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    dependencyCascade.selectedWithAutoOff = document.querySelectorAll('.mod-checkbox:checked').length;
    document.querySelector('#addDependencies').click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    dependencyCascade.selectedAfterManualAdd = document.querySelectorAll('.mod-checkbox:checked').length;
    document.querySelector('[data-view="settings"]').click();
    document.querySelector('#settingAutoAddDependencies').checked = true;
    document.querySelector('#saveSettings').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    dependencyCascade.settingRestored = document.querySelector('#settingAutoAddDependencies').checked;
    dependencyCascade.manualButtonHiddenAfterRestore = document.querySelector('#addDependencies').hidden;
    document.querySelector('[data-view="workshop"]').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const workshopAddButton = document.querySelector('.workshop-card[data-mod-id="7B4C0E19A6D34F82"] .workshop-add');
    const workshop = {
      activeView: document.querySelector('.view.active')?.id || '',
      cards: document.querySelectorAll('.workshop-card').length,
      firstTitle: document.querySelector('.workshop-card-title strong')?.textContent.trim() || '',
      page: document.querySelector('#workshopPageLabel')?.textContent.trim() || '',
      addEnabled: Boolean(workshopAddButton && !workshopAddButton.disabled)
    };
    workshopAddButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    workshop.defaultBypassDialog = !document.querySelector('#addToPresetDialog').open;
    workshop.defaultToast = [...document.querySelectorAll('.toast')].at(-1)?.textContent.trim() || '';

    document.querySelector('[data-view="settings"]').click();
    const footerLogs = {
      initiallyVisible: !document.querySelector('#footerModLogs').hidden,
      initialLabel: document.querySelector('#footerModLogsLabel').textContent.trim(),
      initialCount: document.querySelector('#footerModLogsCount').textContent.trim()
    };
    document.querySelector('#settingDefaultPreset').value = '';
    document.querySelector('#settingShowModLogsFooter').checked = false;
    document.querySelector('#saveSettings').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    footerLogs.hiddenAfterDisable = document.querySelector('#footerModLogs').hidden;
    footerLogs.settingDisabled = !document.querySelector('#settingShowModLogsFooter').checked;
    document.querySelector('#settingShowModLogsFooter').checked = true;
    document.querySelector('#saveSettings').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    footerLogs.visibleAfterEnable = !document.querySelector('#footerModLogs').hidden;
    footerLogs.settingEnabled = document.querySelector('#settingShowModLogsFooter').checked;
    workshop.defaultDisabled = document.querySelector('#settingDefaultPreset').value === '';
    workshop.askEveryTimeLabel = document.querySelector('#settingDefaultPreset').selectedOptions[0]?.textContent.trim() || '';

    document.querySelector('[data-view="workshop"]').click();
    const secondWorkshopAddButton = document.querySelector('.workshop-card[data-mod-id="595F2BF2F44836FB"] .workshop-add');
    secondWorkshopAddButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    workshop.addDialogOpen = document.querySelector('#addToPresetDialog').open;
    workshop.presetOptions = document.querySelector('#addToPresetSelect').options.length;
    workshop.selectedPreset = document.querySelector('#addToPresetSelect').value;
    workshop.newPresetFieldHidden = document.querySelector('#addToPresetNewField').hidden;
    workshop.defaultToggleLabel = document.querySelector('#rememberPresetRow strong').textContent.trim();
    document.querySelector('#confirmAddToPreset').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    workshop.afterAddDialogOpen = document.querySelector('#addToPresetDialog').open;
    workshop.afterAddButton = document.querySelector('.workshop-card[data-mod-id="595F2BF2F44836FB"] .workshop-add')?.textContent.trim() || '';
    workshop.toast = [...document.querySelectorAll('.toast')].at(-1)?.textContent.trim() || '';
    const configurator = {
      activeView: document.querySelector('.view.active')?.id || '',
      categories: document.querySelectorAll('.configurator-category').length,
      activeBefore: document.querySelector('.configurator-category.active strong')?.textContent.trim() || '',
      cardsBefore: document.querySelectorAll('#workshopGrid .workshop-card').length,
      firstBefore: document.querySelector('#workshopGrid .workshop-card-title strong')?.textContent.trim() || ''
    };
    document.querySelector('.configurator-category[data-category="VEHICLES"]').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    configurator.activeAfter = document.querySelector('.configurator-category.active strong')?.textContent.trim() || '';
    configurator.cardsAfter = document.querySelectorAll('#workshopGrid .workshop-card').length;
    configurator.firstAfter = document.querySelector('#workshopGrid .workshop-card-title strong')?.textContent.trim() || '';
    configurator.summary = document.querySelector('#workshopSummary')?.textContent.trim() || '';
    document.querySelector('#selectAllMods').click();
    document.querySelector('[data-language="ru"]').click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const russian = {
      language: document.documentElement.lang,
      dashboard: document.querySelector('[data-view="dashboard"] span').textContent.trim(),
      mods: document.querySelector('[data-view="mods"] span').textContent.trim(),
      workshop: document.querySelector('[data-view="workshop"] span').textContent.trim(),
      servers: document.querySelector('[data-view="servers"] span').textContent.trim(),
      configuratorCategory: document.querySelector('.configurator-category[data-category="VEHICLES"] strong').textContent.trim(),
      homeToolsTitle: document.querySelector('.home-section-heading h2').textContent.trim(),
      homeWelcomeTitle: document.querySelector('.home-hero-copy h2').textContent.trim(),
      homeGuideTitle: document.querySelector('.home-guide-card strong').textContent.trim(),
      homeManualTitle: document.querySelector('#homeManualDialog h2').textContent.trim(),
      homeCredit: document.querySelector('.home-community-credit').textContent.trim(),
      discordTitle: document.querySelector('#homeDiscordLink').title,
      websiteTitle: document.querySelector('#homeWebsiteLink').title,
      downloadMissing: document.querySelector('#downloadMissingMods').textContent.trim(),
      defaultToggle: document.querySelector('#rememberPresetRow strong').textContent.trim(),
      askEveryTime: document.querySelector('#settingDefaultPreset').options[0].textContent.trim(),
      relationships: document.querySelector('.table-head span:nth-child(4)').textContent.trim(),
      autoDependenciesSetting: document.querySelector('#autoDependenciesSettingTitle').textContent.trim(),
      modLogsSetting: document.querySelector('#modLogsSettingTitle').textContent.trim(),
      footerModLogs: document.querySelector('#footerModLogsLabel').textContent.trim(),
      footerModLogsSetting: document.querySelector('#modLogsFooterSettingTitle').textContent.trim(),
      aboutSettings: document.querySelector('#aboutSettingsHeading').textContent.trim(),
      aboutSidebarStatus: document.querySelector('#sidebarBuildStatus').textContent.trim(),
      aboutSidebarAria: document.querySelector('#openAboutSidebar').getAttribute('aria-label')
    };
    document.querySelector('#openAboutSettings').click();
    russian.aboutTitle = document.querySelector('#aboutDialogTitle').textContent.trim();
    russian.aboutOverallStatus = document.querySelector('#aboutOverallStatus').textContent.trim();
    russian.aboutWindowsStatus = document.querySelector('#aboutWindowsStatus').textContent.trim();
    state.buildIdentity = { status: 'open-source', releaseTier: 'public-unsigned', authenticode: 'unsigned', signer: '' };
    renderBuildIdentity();
    russian.aboutUnsignedOverallStatus = document.querySelector('#aboutOverallStatus').textContent.trim();
    russian.aboutUnsignedOverallStatusHidden = document.querySelector('#aboutOverallStatus').hidden;
    russian.aboutUnsignedSidebarStatus = document.querySelector('#sidebarBuildStatus').textContent.trim();
    russian.aboutUnsignedSidebarStatusHidden = document.querySelector('#sidebarBuildStatus').hidden;
    russian.aboutUnsignedSettingsStatus = document.querySelector('#aboutSettingsStatus').textContent.trim();
    russian.aboutUnsignedSettingsStatusHidden = document.querySelector('#aboutSettingsStatus').hidden;
    russian.aboutUnsignedIntegrityStatus = document.querySelector('#aboutIntegrityStatus').textContent.trim();
    russian.aboutUnsignedWindowsStatus = document.querySelector('#aboutWindowsStatus').textContent.trim();
    russian.aboutUnsignedWindowsHidden = document.querySelector('#aboutWindowsCard').hidden;
    russian.aboutDiscord = document.querySelector('#aboutDiscordValue').textContent.trim();
    state.buildIdentity = originalBuildIdentity;
    state.packaged = originalPackaged;
    renderBuildIdentity();
    document.querySelector('#aboutDialog [data-dialog-close]').click();
    document.querySelector('[data-view="settings"]').click();
    document.querySelector('#openModLogs').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    russian.modLogsTitle = document.querySelector('#modLogsTitle').textContent.trim();
    russian.deleteLogs = document.querySelector('#clearModLogs span').textContent.trim();
    document.querySelector('#closeModLogs').click();
    document.querySelector('[data-language="en"]').click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    document.querySelector('[data-view="settings"]').click();
    document.querySelector('#openModLogs').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const modLogDialog = document.querySelector('#modLogsDialog');
    const loggedRemoveButton = document.querySelector('[data-log-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] [data-log-remove]');
    const modLogs = {
      open: modLogDialog.open,
      modeless: !modLogDialog.matches(':modal'),
      title: document.querySelector('#modLogsTitle').textContent.trim(),
      moveHint: document.querySelector('#modLogsDragHandle').title,
      resizeHint: document.querySelector('#modLogsResizeHandle').title,
      rows: document.querySelectorAll('.mod-log-row').length,
      count: document.querySelector('#modLogCount').textContent.trim(),
      hasPresetAdd: [...document.querySelectorAll('.mod-log-action')]
        .some((entry) => entry.textContent.trim() === 'Added to preset'),
      hasAutoDisable: [...document.querySelectorAll('.mod-log-action')]
        .some((entry) => entry.textContent.trim() === 'Disabled by dependency'),
      hasTime: Boolean(document.querySelector('.mod-log-time')?.textContent.trim()),
      hasGuid: document.querySelector('#modLogsList').textContent.includes('646B350F36C6D3E4'),
      deleteEnabled: !document.querySelector('#clearModLogs').disabled,
      removeFromPresetEnabled: Boolean(loggedRemoveButton && !loggedRemoveButton.disabled)
    };
    const initialPanelRect = modLogDialog.getBoundingClientRect();
    const dragHandle = document.querySelector('#modLogsDragHandle');
    dragHandle.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 41,
      button: 0,
      clientX: initialPanelRect.left + 180,
      clientY: initialPanelRect.top + 24,
      bubbles: true,
      cancelable: true
    }));
    document.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 41,
      clientX: initialPanelRect.left + 140,
      clientY: initialPanelRect.top + 44,
      bubbles: true
    }));
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 41, button: 0, bubbles: true }));
    const movedPanelRect = modLogDialog.getBoundingClientRect();
    modLogs.moved = movedPanelRect.left !== initialPanelRect.left || movedPanelRect.top !== initialPanelRect.top;
    const resizeHandle = document.querySelector('#modLogsResizeHandle');
    resizeHandle.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 42,
      button: 0,
      clientX: movedPanelRect.right - 3,
      clientY: movedPanelRect.bottom - 3,
      bubbles: true,
      cancelable: true
    }));
    document.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 42,
      clientX: movedPanelRect.right + 50,
      clientY: movedPanelRect.bottom + 30,
      bubbles: true
    }));
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 42, button: 0, bubbles: true }));
    const resizedPanelRect = modLogDialog.getBoundingClientRect();
    modLogs.resized = resizedPanelRect.width > movedPanelRect.width && resizedPanelRect.height > movedPanelRect.height;
    modLogDialog.removeAttribute('style');
    document.querySelector('#modLogsFilter').value = 'disabled';
    document.querySelector('#modLogsFilter').dispatchEvent(new Event('change', { bubbles: true }));
    modLogs.disabledRows = document.querySelectorAll('.mod-log-row').length;
    document.querySelector('#modLogsFilter').value = 'all';
    document.querySelector('#modLogsFilter').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-log-id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] [data-log-remove]').click();
    if (!document.querySelector('#confirmationDialog')?.open) {
      throw new Error('Removing a mod from a preset did not open confirmation.');
    }
    document.querySelector('#confirmationDialogConfirm').click();
    await new Promise((resolve) => setTimeout(resolve, 160));
    modLogs.hasPresetRemove = [...document.querySelectorAll('.mod-log-action')]
      .some((entry) => entry.textContent.trim() === 'Removed from preset');
    modLogs.selectedAfterPresetRemove = document.querySelectorAll('.mod-checkbox:checked').length;
    modLogs.removedModStillInstalled = Boolean(document.querySelector('[data-mod-id="646B350F36C6D3E4"] .delete-mod-button'));
    modLogs.installedAfterPresetRemove = document.querySelectorAll('.delete-mod-button').length;
    document.querySelector('[data-view="workshop"]').click();
    modLogs.staysOpenAfterNavigation = modLogDialog.open
      && document.querySelector('.view.active')?.id === 'view-workshop';
    document.querySelector('#closeModLogs').click();
    modLogs.footerLabel = document.querySelector('#footerModLogsLabel').textContent.trim();
    modLogs.footerCountMatches = document.querySelector('#footerModLogsCount').textContent.trim()
      === document.querySelector('#modLogCount').textContent.trim();
    document.querySelector('#footerModLogs').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    modLogs.opensFromFooter = modLogDialog.open;
    document.querySelector('#closeModLogs').click();
    document.querySelector('[data-view="presets"]').click();
    const presetDeleteButtons = document.querySelectorAll('[data-delete-installed-mod]').length;
    document.querySelector('[data-delete-installed-mod]').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const deletionWarning = {
      open: document.querySelector('#deleteModDialog').open,
      title: document.querySelector('#deleteModDialogTitle').textContent.trim(),
      irreversible: document.querySelector('#deleteModMessage').textContent.includes('cannot be undone'),
      dontAsk: document.querySelector('#deleteModDontAskLabel').textContent.trim(),
      confirmLabel: document.querySelector('#confirmDeleteMod').textContent.trim(),
      presetButtons: presetDeleteButtons
    };
    document.querySelector('#cancelDeleteMod').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    deletionWarning.closed = !document.querySelector('#deleteModDialog').open;
    const editPresetButton = document.querySelector('#editPreset');
    const editPresetEnabled = !editPresetButton.disabled;
    editPresetButton.click();
    deletionWarning.modsLabel = document.querySelector('.delete-mod-button span')?.textContent.trim();
    return {
      ...dialogResult,
      modDetails,
      imageViewer,
      dependencyCascade,
      authenticity,
      noSplashControl,
      englishInitial,
      russian,
      englishRestored: {
        language: document.documentElement.lang,
        dashboard: document.querySelector('[data-view="dashboard"] span').textContent.trim(),
        mods: document.querySelector('[data-view="mods"] span').textContent.trim()
      },
      workshop,
      configurator,
      footerLogs,
      modLogs,
      deletionWarning,
      homeManual,
      homeNavigation,
      presetActionOrder: [...document.querySelectorAll('.details-actions > button')]
        .slice(0, 3)
        .map((button) => ({ id: button.id, label: button.textContent.trim() })),
      automaticUpdates: {
        present: Boolean(document.querySelector('#settingAutoUpdate')),
        checked: document.querySelector('#settingAutoUpdate').checked,
        label: document.querySelector('#settingAutoUpdate').closest('label').querySelector('strong').textContent.trim(),
        updateAddressPresent: Boolean(document.querySelector('#settingUpdateUrl'))
      },
      defaultPreset: {
        value: document.querySelector('#settingDefaultPreset').value,
        options: document.querySelector('#settingDefaultPreset').options.length
      },
      languageSwitchPresent: document.querySelectorAll('[data-language]').length === 2,
      missingDownloadButton: {
        present: Boolean(document.querySelector('#downloadMissingMods')),
        enabled: !document.querySelector('#downloadMissingMods').disabled,
        actionsFit: document.querySelector('#downloadMissingMods').getBoundingClientRect().right
          <= document.querySelector('#launchGame').getBoundingClientRect().left
          && document.querySelector('#launchGame').getBoundingClientRect().right <= innerWidth + 1,
        downloadRect: document.querySelector('#downloadMissingMods').getBoundingClientRect().toJSON(),
        launchRect: document.querySelector('#launchGame').getBoundingClientRect().toJSON(),
        viewportWidth: innerWidth
      },
      selectAllPresent: Boolean(document.querySelector('#selectAllMods')),
      selectAllVisible: document.querySelector('#selectAllMods').offsetHeight > 0,
      selectedAfterSelectAll: document.querySelectorAll('.mod-checkbox:checked').length,
      deleteSelected: {
        present: Boolean(document.querySelector('#deleteSelectedMods')),
        enabled: !document.querySelector('#deleteSelectedMods').disabled,
        label: document.querySelector('#deleteSelectedMods').textContent.trim()
      },
      deleteButtonsPresent: document.querySelectorAll('.delete-mod-button').length,
      editPresetEnabled,
      activeView: document.querySelector('.view.active')?.id || ''
    };
  })()`);

  result.authenticity.officialReleaseOpenRequests = officialReleaseOpenRequests;
  result.authenticity.licenseReadRequests = licenseReadRequests;

  window.webContents.send('updates:status', { state: 'available', info: { version: '0.3.6' } });
  const titlebarAvailable = await window.webContents.executeJavaScript(`(async () => {
    const button = document.querySelector('#titlebarUpdate');
    const started = Date.now();
    while (button.hidden) {
      if (Date.now() - started > 3000) throw new Error('Titlebar update did not appear');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const value = { label: button.textContent.trim(), enabled: !button.disabled, visible: button.offsetHeight > 0 };
    button.click();
    return value;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  window.webContents.send('updates:status', { state: 'downloaded', info: { version: '0.3.6' } });
  const titlebarReady = await window.webContents.executeJavaScript(`(async () => {
    const button = document.querySelector('#titlebarUpdate');
    const started = Date.now();
    while (!button.classList.contains('ready')) {
      if (Date.now() - started > 3000) throw new Error('Titlebar install action did not appear');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const value = { label: button.textContent.trim(), enabled: !button.disabled, visible: button.offsetHeight > 0 };
    button.click();
    return value;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  result.titlebarUpdate = {
    available: titlebarAvailable,
    ready: titlebarReady,
    downloadRequests: updateDownloadRequests,
    installRequests: updateInstallRequests
  };
  window.webContents.send('updates:status', {
    state: 'downloaded',
    info: { version: '0.3.31' },
    mandatory: {
      deadline: Date.now() + 300_000,
      gameRunning: true,
      gracePeriodSeconds: 300,
      mode: 'semi-forced',
      version: '0.3.31'
    }
  });
  result.mandatoryUpdate = await window.webContents.executeJavaScript(`(async () => {
    const dialog = document.querySelector('#mandatoryUpdateDialog');
    const started = Date.now();
    while (!dialog.open) {
      if (Date.now() - started > 3000) throw new Error('Mandatory update dialog did not appear');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const cancelEvent = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    const countdown = document.querySelector('#mandatoryUpdateCountdown').textContent.trim();
    return {
      open: dialog.open,
      modalFits: dialog.getBoundingClientRect().height <= window.innerHeight,
      cancelBlocked: cancelEvent.defaultPrevented && dialog.open,
      title: document.querySelector('#mandatoryUpdateTitle').textContent.trim(),
      message: document.querySelector('#mandatoryUpdateMessage').textContent.trim(),
      game: document.querySelector('#mandatoryUpdateGameText').textContent.trim(),
      countdown,
      countdownLabel: document.querySelector('#mandatoryUpdateCountdownLabel').textContent.trim(),
      note: document.querySelector('#mandatoryUpdateNote').textContent.trim(),
      acknowledge: document.querySelector('#mandatoryUpdateAcknowledge').textContent.trim(),
      acknowledgeVisible: !document.querySelector('#mandatoryUpdateAcknowledge').hidden,
      install: document.querySelector('#mandatoryUpdateInstall').textContent.trim()
    };
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  window.webContents.invalidate();
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const mandatoryUpdateImage = await window.capturePage();
  await fs.writeFile(mandatoryUpdateOutputPath, mandatoryUpdateImage.toPNG());
  result.mandatoryUpdate.russian = await window.webContents.executeJavaScript(`(async () => {
    await changeLanguage('ru');
    return {
      message: document.querySelector('#mandatoryUpdateMessage').textContent.trim(),
      game: document.querySelector('#mandatoryUpdateGameText').textContent.trim(),
      countdownLabel: document.querySelector('#mandatoryUpdateCountdownLabel').textContent.trim(),
      note: document.querySelector('#mandatoryUpdateNote').textContent.trim(),
      acknowledge: document.querySelector('#mandatoryUpdateAcknowledge').textContent.trim()
    };
  })()`);
  await window.webContents.executeJavaScript("changeLanguage('en')");
  result.mandatoryUpdate.acknowledged = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#mandatoryUpdateAcknowledge').click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      closed: !document.querySelector('#mandatoryUpdateDialog').open,
      updateStillPending: state.updateStatus.state === 'downloaded'
        && state.updateStatus.mandatory?.mode === 'semi-forced'
    };
  })()`);
  window.webContents.send('updates:status', { state: 'current', info: { version: '0.3.30' } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  window.webContents.send('updates:status', {
    state: 'downloaded',
    info: { version: '0.3.31' },
    mandatory: {
      deadline: Date.now() + 5_000,
      gameRunning: false,
      gracePeriodSeconds: 5,
      mode: 'forced',
      version: '0.3.31'
    }
  });
  result.forcedUpdate = await window.webContents.executeJavaScript(`(async () => {
    const dialog = document.querySelector('#mandatoryUpdateDialog');
    const started = Date.now();
    while (!dialog.open || !document.querySelector('#mandatoryUpdateTitle').textContent.includes('Required')) {
      if (Date.now() - started > 3000) throw new Error('Forced update dialog did not appear');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      open: dialog.open,
      title: document.querySelector('#mandatoryUpdateTitle').textContent.trim(),
      countdown: document.querySelector('#mandatoryUpdateCountdown').textContent.trim(),
      countdownLabel: document.querySelector('#mandatoryUpdateCountdownLabel').textContent.trim(),
      game: document.querySelector('#mandatoryUpdateGameText').textContent.trim(),
      acknowledgeHidden: document.querySelector('#mandatoryUpdateAcknowledge').hidden
    };
  })()`);
  window.webContents.send('updates:status', { state: 'current', info: { version: '0.3.30' } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const settingsSavesBeforeSilentUpdate = settingsSaveRequests;
  await window.webContents.executeJavaScript('checkUpdates(true)');
  result.silentUpdateSettingsWrites = settingsSaveRequests - settingsSavesBeforeSilentUpdate;
  window.webContents.send('updates:status', {
    state: 'error',
    message: 'Error invoking remote method updates:check: Cannot find channel "preview.yml" update info: HttpError: 404\n    at updater.js:123:45'
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  result.updateError = await window.webContents.executeJavaScript(`({
    text: document.querySelector('#updateStatus').textContent.trim(),
    hasTechnicalDetails: /preview\\.yml|HttpError|invoking remote method|updater\\.js/i.test(document.querySelector('#updateStatus').textContent)
  })`);
  result.backgroundScanRequests = backgroundScanRequests;

  const expectedPresetActions = [
    { id: 'editPreset', label: 'Edit' },
    { id: 'sharePreset', label: 'Share' },
    { id: 'shareFilePreset', label: 'Export' }
  ];
  if (JSON.stringify(result.presetActionOrder) !== JSON.stringify(expectedPresetActions)) {
    throw new Error(`Unexpected preset action order: ${JSON.stringify(result.presetActionOrder)}`);
  }
  if (!result.dialogOpen || !result.closedByX || !result.closedByCancel) {
    throw new Error(`Import dialog close actions failed: ${JSON.stringify(result)}`);
  }
  if (!result.deletionWarning.open || !result.deletionWarning.closed || !result.deletionWarning.irreversible
    || result.deletionWarning.title !== 'Permanently delete mod?'
    || result.deletionWarning.dontAsk !== 'Do not show this warning again'
    || result.deletionWarning.confirmLabel !== 'Delete mod' || result.deletionWarning.modsLabel !== 'Delete mod'
    || result.deletionWarning.presetButtons !== 3) {
    throw new Error(`Mod deletion warning is invalid: ${JSON.stringify(result.deletionWarning)}`);
  }
  if (!result.editPresetEnabled || result.activeView !== 'view-mods') {
    throw new Error(`Existing preset edit action failed: ${JSON.stringify({ enabled: result.editPresetEnabled, view: result.activeView })}`);
  }
  if (!result.automaticUpdates.present || !result.automaticUpdates.checked
    || result.automaticUpdates.label !== 'Automatic updates' || result.automaticUpdates.updateAddressPresent) {
    throw new Error(`Automatic update control is invalid: ${JSON.stringify(result.automaticUpdates)}`);
  }
  if (!result.titlebarUpdate.available.visible || !result.titlebarUpdate.available.enabled
    || result.titlebarUpdate.available.label !== 'Update 0.3.6'
    || !result.titlebarUpdate.ready.visible || !result.titlebarUpdate.ready.enabled
    || result.titlebarUpdate.ready.label !== 'Install update'
    || result.titlebarUpdate.downloadRequests !== 1 || result.titlebarUpdate.installRequests !== 1) {
    throw new Error(`Titlebar update action is invalid: ${JSON.stringify(result.titlebarUpdate)}`);
  }
  if (!result.mandatoryUpdate.open || !result.mandatoryUpdate.modalFits
    || !result.mandatoryUpdate.cancelBlocked
    || result.mandatoryUpdate.title !== 'Update 0.3.31 will be installed soon'
    || !result.mandatoryUpdate.message.includes('time to save your progress')
    || !result.mandatoryUpdate.game.includes('Arma Reforger is running')
    || result.mandatoryUpdate.countdownLabel !== 'Time left to save your progress'
    || result.mandatoryUpdate.note !== 'Closing the launcher does not reset the timer. The countdown continues after you reopen it.'
    || /exit the game|quit the game/i.test(`${result.mandatoryUpdate.message} ${result.mandatoryUpdate.game} ${result.mandatoryUpdate.countdownLabel}`)
    || !/^0[45]:[0-5]\d$/.test(result.mandatoryUpdate.countdown)
    || !result.mandatoryUpdate.acknowledgeVisible
    || result.mandatoryUpdate.acknowledge !== 'OK, continue'
    || !result.mandatoryUpdate.acknowledged.closed
    || !result.mandatoryUpdate.acknowledged.updateStillPending
    || result.mandatoryUpdate.install !== 'Install now'
    || !result.mandatoryUpdate.russian.message.includes('время сохранить прогресс')
    || !result.mandatoryUpdate.russian.game.includes('Сохраните прогресс')
    || result.mandatoryUpdate.russian.countdownLabel !== 'Осталось времени на сохранение прогресса'
    || result.mandatoryUpdate.russian.note !== 'Закрытие лаунчера не сбрасывает таймер. После повторного запуска отсчёт продолжится.'
    || result.mandatoryUpdate.russian.acknowledge !== 'Окей, продолжить'
    || /вый(?:ти|дите) из игры|выход(?:а|у)? из игры|закройте игру/i.test(
      `${result.mandatoryUpdate.russian.message} ${result.mandatoryUpdate.russian.game} ${result.mandatoryUpdate.russian.countdownLabel}`
    )) {
    throw new Error(`Mandatory update dialog is invalid: ${JSON.stringify(result.mandatoryUpdate)}`);
  }
  if (!result.forcedUpdate.open
    || result.forcedUpdate.title !== 'Required update 0.3.31'
    || !/^00:0[45]$/.test(result.forcedUpdate.countdown)
    || result.forcedUpdate.countdownLabel !== 'Time before automatic installation'
    || !result.forcedUpdate.game.includes('is not running')
    || !result.forcedUpdate.acknowledgeHidden) {
    throw new Error(`Forced update dialog is invalid: ${JSON.stringify(result.forcedUpdate)}`);
  }
  if (result.updateError.hasTechnicalDetails
    || result.updateError.text !== 'Error: Could not check for updates. Please try again later.') {
    throw new Error(`Update error presentation is invalid: ${JSON.stringify(result.updateError)}`);
  }
  if (result.backgroundScanRequests !== 0) {
    throw new Error(`Fresh launcher state triggered redundant mod scans: ${result.backgroundScanRequests}`);
  }
  if (result.silentUpdateSettingsWrites !== 0) {
    throw new Error(`Silent update check rewrote settings: ${result.silentUpdateSettingsWrites}`);
  }
  if (!result.authenticity.sidebarButton || !result.authenticity.open || !result.authenticity.modalFits
    || result.authenticity.title !== 'About'
    || result.authenticity.sidebarAria !== 'About' || result.authenticity.sidebarTitle !== 'About'
    || result.authenticity.product !== 'ALGZ Launcher for Arma Reforger'
    || result.authenticity.developer !== 'ALGZ / ExtaZzZ'
    || result.authenticity.discord !== 'Discord: legoshi223'
    || result.authenticity.version !== 'v0.2.9'
    || result.authenticity.sidebarStatus !== 'Development build'
    || result.authenticity.overallStatus !== 'Development build'
    || result.authenticity.overallTone !== 'development'
    || result.authenticity.integrityStatus !== 'GNU GPL v3'
    || result.authenticity.windowsStatus !== 'Not checked in development'
    || result.authenticity.source !== 'github.com/Redwolf29195/arma-reforger-launcher-updates/releases'
    || !result.authenticity.disclaimerMentionsBohemia || !result.authenticity.settingsEntry
    || Object.values(result.authenticity.states).some((scenario) => (
      scenario.tone !== 'open-source' || scenario.overall !== 'Open-source build'
      || scenario.overallHidden || scenario.sidebarHidden || scenario.settingsHidden
      || scenario.sidebar !== 'Open-source build' || scenario.settings !== 'Open-source build'
      || scenario.integrity !== 'GNU GPL v3' || scenario.windowsHidden
    ))
    || result.authenticity.states.signed.windowsTone !== 'verified'
    || result.authenticity.states.signed.windows !== 'Windows digital signature valid'
    || !result.authenticity.states.signed.signer.includes('CN=ALGZ Publisher')
    || result.authenticity.states.unsigned.windowsTone !== 'unsigned'
    || result.authenticity.states.unsigned.windows !== 'No Windows publisher signature'
    || result.authenticity.states.community.windowsTone !== 'unsigned'
    || result.authenticity.states.missing.windowsTone !== 'unavailable'
    || !result.authenticity.licenseOpen || !result.authenticity.aboutClosedForLicense
    || result.authenticity.licenseTitle !== 'GNU General Public License v3' || !result.authenticity.licenseLoaded
    || !result.authenticity.returnedToAbout || !result.authenticity.closed
    || result.authenticity.officialReleaseOpenRequests !== 1 || result.authenticity.licenseReadRequests !== 1
    || result.russian.aboutSettings !== 'О программе'
    || result.russian.aboutSidebarStatus !== 'Сборка для разработки'
    || result.russian.aboutTitle !== 'О программе'
    || result.russian.aboutSidebarAria !== 'О программе'
    || result.russian.aboutOverallStatus !== 'Сборка для разработки'
    || result.russian.aboutWindowsStatus !== 'В режиме разработки не проверяется'
    || result.russian.aboutUnsignedOverallStatus !== 'Сборка с открытым кодом'
    || result.russian.aboutUnsignedOverallStatusHidden
    || result.russian.aboutUnsignedSidebarStatus !== 'Сборка с открытым кодом'
    || result.russian.aboutUnsignedSidebarStatusHidden
    || result.russian.aboutUnsignedSettingsStatus !== 'Сборка с открытым кодом'
    || result.russian.aboutUnsignedSettingsStatusHidden
    || result.russian.aboutUnsignedIntegrityStatus !== 'GNU GPL v3'
    || result.russian.aboutUnsignedWindowsHidden
    || result.russian.aboutDiscord !== 'Discord: legoshi223') {
    throw new Error(`About UI is invalid: ${JSON.stringify({ authenticity: result.authenticity, russian: result.russian })}`);
  }
  if (!result.noSplashControl.present || result.noSplashControl.label !== 'Skip intro screens'
    || !result.noSplashControl.initiallyChecked || result.noSplashControl.technicalSubtitlePresent
    || !result.noSplashControl.toggledOff || !result.noSplashControl.restored) {
    throw new Error(`Skip intro toggle is invalid: ${JSON.stringify(result.noSplashControl)}`);
  }
  if (result.defaultPreset.value !== '' || result.defaultPreset.options !== 3) {
    throw new Error(`Default preset control is invalid: ${JSON.stringify(result.defaultPreset)}`);
  }
  if (!result.footerLogs.initiallyVisible || result.footerLogs.initialLabel !== 'MOD LOGS'
    || !result.footerLogs.initialCount || !result.footerLogs.hiddenAfterDisable
    || !result.footerLogs.settingDisabled || !result.footerLogs.visibleAfterEnable
    || !result.footerLogs.settingEnabled) {
    throw new Error(`Footer mod log setting is invalid: ${JSON.stringify(result.footerLogs)}`);
  }
  if (!result.missingDownloadButton.present || !result.missingDownloadButton.enabled || !result.missingDownloadButton.actionsFit) {
    throw new Error(`Missing-mod download control is invalid: ${JSON.stringify(result.missingDownloadButton)}`);
  }
  if (!result.deleteSelected.present || !result.deleteSelected.enabled || result.deleteSelected.label !== 'Delete') {
    throw new Error(`Bulk mod deletion control is invalid: ${JSON.stringify(result.deleteSelected)}`);
  }
  if (!result.modDetails.open || result.modDetails.title !== 'Breachable Doors' || !result.modDetails.hasFacts
    || !result.modDetails.hasDependency || !result.modDetails.hasLocalDependent
    || !result.modDetails.hasDescription || result.modDetails.imageCount !== 2) {
    throw new Error(`Mod details dialog is invalid: ${JSON.stringify(result.modDetails)}`);
  }
  if (!result.imageViewer.open || result.imageViewer.counter !== '1 / 2' || result.imageViewer.initialScale !== '100%'
    || !result.imageViewer.controlsPresent || result.imageViewer.buttonScale !== '150%'
    || result.imageViewer.wheelScale !== '175%' || !result.imageViewer.dragged || !result.imageViewer.switchedImage
    || result.imageViewer.resetScale !== '100%' || !result.imageViewer.closed) {
    throw new Error(`Image viewer is invalid: ${JSON.stringify(result.imageViewer)}`);
  }
  if (result.dependencyCascade.dependencies !== '1' || result.dependencyCascade.dependents !== '1'
    || result.dependencyCascade.selectedAfterDisable !== 0 || !result.dependencyCascade.disableToast.includes('2')
    || result.dependencyCascade.selectedAfterEnable !== 3 || !result.dependencyCascade.enableToast.includes('2')
    || !result.dependencyCascade.autosaved || !result.dependencyCascade.settingDefaultOn
    || !result.dependencyCascade.manualButtonHiddenWithAutoOn
    || !result.dependencyCascade.settingDisabled || !result.dependencyCascade.manualButtonVisibleWithAutoOff
    || result.dependencyCascade.selectedWithAutoOff !== 1
    || result.dependencyCascade.selectedAfterManualAdd !== 3 || !result.dependencyCascade.settingRestored
    || !result.dependencyCascade.manualButtonHiddenAfterRestore) {
    throw new Error(`Dependency cascade is invalid: ${JSON.stringify(result.dependencyCascade)}`);
  }
  if (result.englishInitial.workshop !== 'Workshop' || result.russian.workshop !== 'Мастерская') {
    throw new Error(`Workshop navigation translations are invalid: ${JSON.stringify({ en: result.englishInitial.workshop, ru: result.russian.workshop })}`);
  }
  if (result.russian.configuratorCategory !== 'Транспорт') {
    throw new Error(`Workshop category translations are invalid: ${JSON.stringify({ category: result.russian.configuratorCategory })}`);
  }
  if (result.englishInitial.servers !== 'Servers' || result.russian.servers !== 'Сервера') {
    throw new Error(`Server navigation translations are invalid: ${JSON.stringify({ en: result.englishInitial.servers, ru: result.russian.servers })}`);
  }
  if (result.englishInitial.homeTools !== 6 || result.englishInitial.homeLegacyContent
    || result.englishInitial.homeWelcomeTitle !== 'WELCOME TO ARMA REFORGER LAUNCHER' || !result.englishInitial.homeWelcomeKickerRemoved
    || !result.englishInitial.normalizedVersionReady || !result.englishInitial.newerInstalledVersionReady
    || !result.englishInitial.homeDescriptionRemoved || !result.englishInitial.homeSessionLabelRemoved
    || result.englishInitial.homePreset !== 'Field Ops' || result.englishInitial.homeSelected !== '3 selected mods'
    || result.englishInitial.homeModsMetric !== '3' || result.englishInitial.homePresetsMetric !== '2'
    || result.englishInitial.homeGuideTitle !== 'Not sure where to begin?'
    || result.englishInitial.homeDiscord !== 'https://discord.gg/P54RqqWDE'
    || result.englishInitial.homeWebsite !== 'https://armalaucher.com/'
    || result.englishInitial.homeCredit !== 'Official ALGZ distribution'
    || result.homeNavigation !== 'view-mods'
    || !result.homeManual.open || !result.homeManual.closed || result.homeManual.steps !== 4
    || result.homeManual.title !== 'How to get started'
    || result.russian.homeToolsTitle !== 'Возможности лаунчера'
    || result.russian.homeWelcomeTitle !== 'ДОБРО ПОЖАЛОВАТЬ В ARMA REFORGER LAUNCHER'
    || result.russian.homeGuideTitle !== 'Не знаете, с чего начать?'
    || result.russian.homeManualTitle !== 'Как начать работу'
    || result.russian.homeCredit !== 'Официальная сборка ALGZ'
    || result.russian.discordTitle !== 'Открыть Discord ALGZ'
    || result.russian.websiteTitle !== 'Открыть сайт ALGZ') {
    throw new Error(`Home dashboard is invalid: ${JSON.stringify({ en: result.englishInitial, manual: result.homeManual, navigation: result.homeNavigation, ru: result.russian })}`);
  }
  if (result.workshop.activeView !== 'view-workshop' || result.workshop.cards < 2
    || result.workshop.firstTitle !== 'ALGZ Admin API' || !result.workshop.addEnabled
    || !result.workshop.defaultBypassDialog || !result.workshop.defaultToast.includes('Training')
    || !result.workshop.defaultDisabled || result.workshop.askEveryTimeLabel !== 'Ask every time'
    || !result.workshop.addDialogOpen || result.workshop.presetOptions !== 2
    || result.workshop.selectedPreset !== '11111111-1111-4111-8111-111111111111'
    || result.workshop.defaultToggleLabel !== 'Set as default'
    || !result.workshop.newPresetFieldHidden || result.workshop.afterAddDialogOpen
    || result.workshop.afterAddButton !== 'Add to preset' || !result.workshop.toast.includes('Field Ops')) {
    throw new Error(`Workshop view is invalid: ${JSON.stringify(result.workshop)}`);
  }
  if (result.configurator.activeView !== 'view-workshop' || result.configurator.categories !== 11
    || result.configurator.activeBefore !== 'All mods' || result.configurator.cardsBefore < 2
    || result.configurator.firstBefore !== 'ALGZ Admin API' || result.configurator.activeAfter !== 'Vehicles'
    || result.configurator.cardsAfter !== 1 || result.configurator.firstAfter !== 'RHS - Status Quo'
    || !result.configurator.summary.includes('Vehicles')) {
    throw new Error(`Configurator view is invalid: ${JSON.stringify(result.configurator)}`);
  }
  if (result.englishInitial.downloadMissing !== 'DOWNLOAD MODS' || result.russian.downloadMissing !== 'СКАЧАТЬ МОДЫ') {
    throw new Error(`Missing-mod download translations are invalid: ${JSON.stringify({ en: result.englishInitial.downloadMissing, ru: result.russian.downloadMissing })}`);
  }
  if (result.russian.defaultToggle !== 'По умолчанию' || result.russian.askEveryTime !== 'Спрашивать каждый раз'
    || result.russian.relationships !== 'Связи' || result.russian.modLogsSetting !== 'Логи модов'
    || result.russian.modLogsTitle !== 'Логи модов' || result.russian.deleteLogs !== 'Удалить логи'
    || result.russian.footerModLogs !== 'ЛОГИ МОДОВ'
    || result.russian.footerModLogsSetting !== 'Показывать на нижней панели'
    || result.russian.autoDependenciesSetting !== 'Автоматически добавлять зависимости') {
    throw new Error(`Default preset translations are invalid: ${JSON.stringify(result.russian)}`);
  }
  if (!result.modLogs.open || !result.modLogs.modeless || result.modLogs.title !== 'Mod logs' || result.modLogs.rows < 5
    || result.modLogs.moveHint !== 'Drag to move the mod log panel'
    || result.modLogs.resizeHint !== 'Drag to resize the mod log panel' || !result.modLogs.moved || !result.modLogs.resized
    || !result.modLogs.hasPresetAdd || !result.modLogs.hasAutoDisable || !result.modLogs.hasTime
    || !result.modLogs.hasGuid || !result.modLogs.deleteEnabled || result.modLogs.disabledRows < 1
    || !result.modLogs.removeFromPresetEnabled || !result.modLogs.hasPresetRemove
    || result.modLogs.selectedAfterPresetRemove !== 3 || !result.modLogs.removedModStillInstalled
    || result.modLogs.installedAfterPresetRemove !== 3
    || !result.modLogs.staysOpenAfterNavigation || result.modLogs.footerLabel !== 'MOD LOGS'
    || !result.modLogs.footerCountMatches || !result.modLogs.opensFromFooter) {
    throw new Error(`Mod log dialog is invalid: ${JSON.stringify(result.modLogs)}`);
  }

  window.webContents.invalidate();
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const relationshipsImage = await window.capturePage();
  await fs.writeFile(relationshipsOutputPath, relationshipsImage.toPNG());

  window.setSize(1040, 680);
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const minimumLayout = await window.webContents.executeJavaScript(`(() => {
    const download = document.querySelector('#downloadMissingMods').getBoundingClientRect();
    const play = document.querySelector('#launchGame').getBoundingClientRect();
    const preset = document.querySelector('.footer-preset').getBoundingClientRect();
    const logs = document.querySelector('#footerModLogs').getBoundingClientRect();
    const status = document.querySelector('#footerStatus').getBoundingClientRect();
    return {
      downloadBeforePlay: download.right <= play.left,
      actionsInsideViewport: play.right <= innerWidth + 1,
      presetBeforeLogs: preset.right <= logs.left,
      logsBeforeStatus: logs.right <= status.left,
      statusBeforeActions: status.right <= download.left
    };
  })()`);
  if (!minimumLayout.downloadBeforePlay || !minimumLayout.actionsInsideViewport
    || !minimumLayout.presetBeforeLogs || !minimumLayout.logsBeforeStatus || !minimumLayout.statusBeforeActions) {
    throw new Error(`Minimum window layout is invalid: ${JSON.stringify(minimumLayout)}`);
  }
  window.setSize(1380, 850);
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav-item[data-view="mods"]').click();
    document.querySelector('.mod-main').click();
    await new Promise((resolve) => setTimeout(resolve, 60));
  })()`);
  window.webContents.invalidate();
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const detailsImage = await window.capturePage();
  await fs.writeFile(detailsOutputPath, detailsImage.toPNG());
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#modDetailsHero').click();
    document.querySelector('#imageViewerZoomIn').click();
    document.querySelector('#imageViewerZoomIn').click();
  })()`);
  await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const image = document.querySelector('#imageViewerImage');
    if (image.complete) return resolve();
    image.addEventListener('load', resolve, { once: true });
    image.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, 1000);
  })`);
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const viewerImage = await window.capturePage();
  await fs.writeFile(viewerOutputPath, viewerImage.toPNG());
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#closeImageViewer').click();
    document.querySelector('#closeModDetails').click();
  })()`);

  const clearedModLogs = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav-item[data-view="settings"]').click();
    document.querySelector('#openModLogs').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return true;
  })()`);
  if (!clearedModLogs) throw new Error('Unable to open mod logs for screenshot');
  window.webContents.invalidate();
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const modLogsImage = await window.capturePage();
  await fs.writeFile(modLogsOutputPath, modLogsImage.toPNG());
  const clearedModLogState = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#clearModLogs').click();
    if (!document.querySelector('#confirmationDialog')?.open) {
      throw new Error('Clearing mod logs did not open confirmation.');
    }
    document.querySelector('#confirmationDialogConfirm').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = {
      rows: document.querySelectorAll('.mod-log-row').length,
      count: document.querySelector('#modLogCount').textContent.trim(),
      empty: document.querySelector('#modLogsList').textContent.includes('No mod actions'),
      clearDisabled: document.querySelector('#clearModLogs').disabled
    };
    document.querySelector('#closeModLogs').click();
    return result;
  })()`);
  if (clearedModLogState.rows !== 0 || clearedModLogState.count !== '0'
    || !clearedModLogState.empty || !clearedModLogState.clearDisabled) {
    throw new Error(`Mod log clearing is invalid: ${JSON.stringify(clearedModLogState)}`);
  }

  result.searchInputRegression = [];
  window.webContents.focus();
  for (const field of [
    { view: 'mods', id: 'modSearch', text: 'Моды Arma ' },
    { view: 'servers', id: 'serverSearch', text: 'ALGZ Сервер ' },
    { view: 'workshop', id: 'workshopSearch', text: 'RHS Моды ' }
  ]) {
    for (const dismissal of ['cancel', 'confirm', 'escape']) {
      const opened = await window.webContents.executeJavaScript(`(async () => {
        setView(${JSON.stringify(field.view)});
        await new Promise((resolve) => setTimeout(resolve, 40));
        const input = document.getElementById(${JSON.stringify(field.id)});
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        window.searchInputConfirmationResult = null;
        confirmAction('Search input regression').then((confirmed) => {
          window.searchInputConfirmationResult = confirmed;
        });
        return document.querySelector('#confirmationDialog')?.open === true
          && document.activeElement.id === 'confirmationDialogCancel';
      })()`);
      if (!opened) throw new Error(`Search confirmation did not open: ${field.id}/${dismissal}`);
      if (dismissal === 'escape') {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      } else {
        const button = dismissal === 'confirm' ? 'confirmationDialogConfirm' : 'confirmationDialogCancel';
        await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(button)}).click()`);
      }
      const dismissed = await window.webContents.executeJavaScript(`(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          open: document.querySelector('#confirmationDialog').open,
          confirmed: window.searchInputConfirmationResult,
          focused: document.activeElement.id
        };
      })()`);
      if (dismissed.open || dismissed.confirmed !== (dismissal === 'confirm') || dismissed.focused !== field.id) {
        throw new Error(`Confirmation failed to restore search focus: ${JSON.stringify({ field, dismissal, dismissed })}`);
      }
      // Characters go through Electron/Chromium input dispatch. Do not assign
      // value or call focus after closing: that would mask the reported bug.
      for (const character of field.text) {
        window.webContents.sendInputEvent({ type: 'char', keyCode: character });
      }
      const typed = await window.webContents.executeJavaScript(`(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const input = document.getElementById(${JSON.stringify(field.id)});
        return { value: input.value, focused: document.activeElement.id };
      })()`);
      if (typed.value !== field.text || typed.focused !== field.id) {
        throw new Error(`Character input failed after confirmation: ${JSON.stringify({ field, dismissal, typed })}`);
      }
      const refreshed = await window.webContents.executeJavaScript(`(async () => {
        const input = document.getElementById(${JSON.stringify(field.id)});
        input.setSelectionRange(1, 4, 'backward');
        if (${JSON.stringify(field.view)} === 'servers') {
          await loadServers({ refresh: true });
          // Let the actual 400 ms typing debounce finish as well.
          await new Promise((resolve) => setTimeout(resolve, 450));
        } else if (${JSON.stringify(field.view)} === 'workshop') {
          await loadWorkshop({ refresh: true });
        } else {
          renderMods();
        }
        return {
          value: input.value, focused: document.activeElement.id,
          selection: [input.selectionStart, input.selectionEnd, input.selectionDirection]
        };
      })()`);
      if (refreshed.value !== field.text || refreshed.focused !== field.id
          || JSON.stringify(refreshed.selection) !== JSON.stringify([1, 4, 'backward'])) {
        throw new Error(`Refresh changed search draft or selection: ${JSON.stringify({ field, dismissal, refreshed })}`);
      }
      result.searchInputRegression.push({ field: field.id, dismissal, ...refreshed });
    }
  }
  await window.webContents.executeJavaScript(`(() => {
    for (const id of ['modSearch', 'serverSearch', 'workshopSearch']) {
      const input = document.getElementById(id);
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (serverSearchTimer) clearTimeout(serverSearchTimer);
    serverSearchTimer = 0;
    state.workshopQuery = '';
    cancelServerAutoRefresh();
    delete window.searchInputConfirmationResult;
  })()`);

  result.modAcquisition = await require('./modAcquisitionUiSmoke')({
    window, outputPath, requests: modActionRequests,
    configure: (scenario, status) => { modActionScenario = scenario; if (status) mockDownloadStatus = status; }
  });
  modActionScenario = {};
  const screenshotView = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('.nav-item[data-view="settings"]').click();
    document.querySelector('#modLogsSettingHeading').scrollIntoView({ block: 'center' });
    document.querySelectorAll('.toast').forEach((toast) => toast.remove());
    return document.querySelector('.view.active')?.id || '';
  })()`);
  if (screenshotView !== 'view-settings') {
    throw new Error(`Unable to open settings for screenshot: ${screenshotView}`);
  }

  window.webContents.invalidate();
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const image = await window.capturePage();
  await fs.writeFile(outputPath, image.toPNG());
  mockDownloadStatus = { state: 'paused', completed: 1, total: 2, failed: 0, progress: 35, resumeAvailable: true };
  result.downloadResume = await window.webContents.executeJavaScript(`(async () => {
    if (modDownloadTimer) clearTimeout(modDownloadTimer);
    state.modDownloadStatus = { state: 'downloading', total: 2, completed: 1, failed: 0, progress: 35 };
    await pollModDownloadStatus();
    state.selectedIds.clear();
    state.requirements.clear();
    setLanguage('en');
    renderLaunchState();
    const button = document.querySelector('#downloadMissingMods');
    const english = { label: button.textContent.trim(), enabled: !button.disabled,
      paused: state.modDownloadStatus.state, selected: state.selectedIds.size };
    setLanguage('ru');
    renderLaunchState();
    const russian = { label: button.textContent.trim(), enabled: !button.disabled,
      help: button.title, status: document.querySelector('#footerStatus').textContent.trim() };
    await downloadMissingMods();
    const resumed = state.modDownloadStatus.state;
    if (modDownloadTimer) clearTimeout(modDownloadTimer);
    modDownloadTimer = 0;
    return { english, russian, resumed };
  })()`);
  if (result.downloadResume.english.label !== 'RESUME DOWNLOAD'
      || !result.downloadResume.english.enabled || result.downloadResume.english.selected !== 0
      || result.downloadResume.english.paused !== 'paused'
      || result.downloadResume.russian.label !== 'ПРОДОЛЖИТЬ ЗАГРУЗКУ'
      || !result.downloadResume.russian.enabled || result.downloadResume.resumed !== 'queued'
      || resumeDownloadRequests !== 1) throw new Error(`Resume UI failed: ${JSON.stringify(result.downloadResume)}`);
  mockDownloadStatus = { state: 'failed', completed: 0, total: 2, failed: 1, progress: 0 };
  const continuesAfterItemFailure = await window.webContents.executeJavaScript(`(async () => {
    await pollModDownloadStatus();
    const keepsPolling = modDownloadTimer !== 0 && state.modDownloadStatus.state === 'failed';
    clearTimeout(modDownloadTimer); modDownloadTimer = 0;
    return keepsPolling;
  })()`);
  if (!continuesAfterItemFailure) throw new Error('An individual Workshop failure stopped progress polling.');
  failDownloadStatusOnce = true;
  const retriesStatusError = await window.webContents.executeJavaScript(`(async () => {
    await pollModDownloadStatus();
    const retries = modDownloadTimer !== 0;
    clearTimeout(modDownloadTimer); modDownloadTimer = 0;
    return retries;
  })()`);
  if (!retriesStatusError) throw new Error('A transient status error stopped progress polling.');
  mockDownloadStatus = { state: 'paused', completed: 1, total: 2, failed: 0, progress: 35, resumeAvailable: true };
  await window.webContents.executeJavaScript(`(async () => {
    await pollModDownloadStatus();
    state.language = setLanguage('ru');
    state.settings.language = 'ru';
    applyStaticTranslations();
    renderAll();
    if (state.modDownloadStatus.state !== 'paused'
        || document.querySelector('#downloadMissingMods').textContent.trim() !== 'ПРОДОЛЖИТЬ ЗАГРУЗКУ') {
      throw new Error('Final paused queue state was lost.');
    }
    document.querySelectorAll('.toast').forEach(toast => toast.remove());
  })()`);
  await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  // Drain already queued compositor frames before requesting the final paint.
  // RAF completion alone does not mean its frame has reached the main process.
  await new Promise(resolve => setTimeout(resolve, 250));
  const pausedImage = await new Promise((resolve, reject) => {
    const painted = (_event, _dirty, frame) => {
      clearTimeout(timeout);
      resolve(frame);
    };
    const timeout = setTimeout(() => {
      window.webContents.removeListener('paint', painted);
      reject(new Error('Paused Workshop UI did not produce a new frame.'));
    }, 10_000);
    window.webContents.once('paint', painted);
    window.webContents.invalidate();
  });
  await fs.writeFile(outputPath.replace(/\.png$/i, '.paused.png'), pausedImage.toPNG());
  process.stdout.write(`${JSON.stringify(result)}\n${outputPath}\n${homeOutputPath}\n${detailsOutputPath}\n${viewerOutputPath}\n${relationshipsOutputPath}\n${modLogsOutputPath}\n${mandatoryUpdateOutputPath}\n`);
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
