const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const profilePath = path.join(os.tmpdir(), `arma-launcher-next-features-${process.pid}`);
fsSync.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', path.join(profilePath, 'session'));

const outputPath = process.argv.find((argument) => /\.png$/i.test(argument))
  || path.join(app.getPath('temp'), 'arma-launcher-next-features.png');
const previewUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'assets', 'launcher-cover.png')).href;
const screenshotUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'assets', 'app-icon.png')).href;

app.whenReady().then(async () => {
  const modId = '5965550F24A0C152';
  let copiedMod = null;
  let settings = {
    gameExecutable: '',
    addonsDirectory: '',
    downloadRoot: '',
    profileDirectory: profilePath,
    noSplash: true,
    allowVersionMismatch: false,
    additionalArguments: '',
    defaultPresetId: '',
    autoUpdate: false,
    showModLogsFooter: true,
    autoAddDependencies: true,
    confirmModDeletion: true,
    advancedMode: false,
    favoriteMods: [],
    language: 'en'
  };
  ipcMain.handle('launcher:bootstrap', () => ({
    appVersion: '0.3.21',
    packaged: false,
    platform: process.platform,
    settings,
    presets: [],
    installedMods: [],
    workspace: { activePresetId: '', name: '', dirty: false, mods: [] },
    modLogCount: 0
  }));
  ipcMain.handle('game:download-status', () => ({ state: 'idle', completed: 0, total: 0, failed: 0, progress: 0 }));
  ipcMain.handle('workspace:save', (_event, value) => value);
  ipcMain.handle('settings:save', (_event, patch) => {
    settings = { ...settings, ...patch };
    return settings;
  });
  ipcMain.handle('mods:scan', () => []);
  ipcMain.handle('workshop:search', (_event, payload = {}) => ({
    query: payload.query || '',
    sort: payload.sort || 'subscribers',
    page: payload.page || 1,
    count: 1,
    pageSize: 16,
    items: [{
      modId,
      name: 'Where Am I',
      author: 'ValterB',
      summary: 'Shows where you are on the map',
      version: '1.2.0',
      gameVersion: '1.2.1.202',
      sizeBytes: 197 * 1024,
      ratingPercent: 97,
      ratingCount: 14701,
      subscriberCount: 2876219,
      previewUrl,
      tags: ['SYSTEMS']
    }]
  }));
  ipcMain.handle('mods:details', (_event, requestedModId) => ({
    modId: requestedModId,
    name: 'Where Am I',
    author: 'ValterB',
    summary: 'Shows where you are on the map',
    description: 'This mod marks your current location on the map.',
    version: '1.2.0',
    gameVersion: '1.2.1.202',
    sizeBytes: 197 * 1024,
    ratingPercent: 97,
    ratingCount: 14701,
    downloads: 2876219,
    updatedAt: '2026-08-11T00:00:00.000Z',
    createdAt: '2022-05-20T00:00:00.000Z',
    previewUrls: [previewUrl],
    screenshotUrls: [screenshotUrl],
    dependencies: [],
    versions: [],
    tags: ['SYSTEMS'],
    scenarios: []
  }));
  ipcMain.handle('mods:translate-description', () => ({
    text: 'Этот мод отмечает ваше текущее положение на карте.',
    alreadyRussian: false,
    cached: false
  }));
  ipcMain.handle('clipboard:copy-mod', (_event, mod) => {
    copiedMod = mod;
    return { modId: mod.modId };
  });
  ipcMain.handle('servers:list', (_event, payload = {}) => ({
    items: [],
    page: payload.page || 1,
    pageSize: 50,
    hasNext: false,
    provider: 'Arma Mods',
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
      sandbox: true
    }
  });
  await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  const result = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate, timeout = 5000) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error('UI wait timed out');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    await waitFor(() => document.querySelector('#titlebarStatus')?.textContent.trim() !== 'Loading launcher');
    document.querySelector('[data-view="workshop"]').click();
    await waitFor(() => document.querySelector('.workshop-card'));
    let card = document.querySelector('.workshop-card');
    const favoriteButton = card.querySelector('[data-workshop-favorite]');
    const previewBounds = card.querySelector('.workshop-preview-shell').getBoundingClientRect();
    const favoriteBounds = favoriteButton.getBoundingClientRect();
    const favoriteStyle = getComputedStyle(favoriteButton);
    const favoriteTransparent = favoriteStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
      && Number.parseFloat(favoriteStyle.borderTopWidth) === 0;
    favoriteButton.click();
    await waitFor(() => document.querySelector('[data-workshop-favorite]')?.getAttribute('aria-pressed') === 'true');
    const favorite = {
      topLeft: favoriteBounds.left < previewBounds.left + (previewBounds.width / 2)
        && favoriteBounds.top < previewBounds.top + (previewBounds.height / 2),
      transparent: favoriteTransparent,
      pressed: document.querySelector('[data-workshop-favorite]').getAttribute('aria-pressed'),
      detailsStayedClosed: !document.querySelector('#modDetailsDialog').open
    };
    const workshopSort = document.querySelector('#workshopSort');
    const favoriteSortOptions = [...workshopSort.options].map((option) => option.value);
    workshopSort.value = 'favorites';
    workshopSort.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelector('#workshopSummary')?.textContent.includes('1 favorite mod'));
    const favoriteSort = {
      options: favoriteSortOptions,
      cards: document.querySelectorAll('#workshopGrid .workshop-card').length,
      summary: document.querySelector('#workshopSummary').textContent.trim(),
      pressed: document.querySelector('[data-workshop-favorite]')?.getAttribute('aria-pressed')
    };
    workshopSort.value = 'subscribers';
    workshopSort.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelector('#workshopSummary')?.textContent.includes('official catalog'));
    card = document.querySelector('.workshop-card');
    const preview = card.querySelector('.workshop-preview-image');
    const initialCardImage = preview.src;
    card.querySelector('.workshop-preview-shell').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await waitFor(() => !card.querySelector('.workshop-gallery-arrow.next').hidden);
    card.querySelector('.workshop-gallery-arrow.next').click();
    const cardGallery = {
      bannerRemoved: !document.querySelector('.configurator-intro'),
      changed: preview.src !== initialCardImage,
      detailsStayedClosed: !document.querySelector('#modDetailsDialog').open
    };

    card.querySelector('.workshop-card-actions .workshop-details').click();
    await waitFor(() => document.querySelector('#modDetailsHero'));
    const hero = document.querySelector('#modDetailsHero');
    const initialHero = hero.src;
    document.querySelector('.mod-details-gallery-arrow.next').click();
    const detailsGallery = {
      arrows: document.querySelectorAll('.mod-details-gallery-arrow').length,
      changed: hero.src !== initialHero,
      viewerStayedClosed: document.querySelector('#imageViewerDialog').hidden
    };

    document.querySelector('#copyModDetailsJson').click();
    await waitFor(() => [...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes('Mod JSON copied')));
    const copy = {
      enabled: !document.querySelector('#copyModDetailsJson').disabled,
      label: document.querySelector('#copyModDetailsJson').textContent.trim()
    };

    document.querySelector('[data-description-mode="ru"]').click();
    await waitFor(() => document.querySelector('.mod-details-copy').textContent.includes('текущее положение'));
    const translated = document.querySelector('.mod-details-copy').textContent.trim();
    document.querySelector('[data-description-mode="original"]').click();
    const original = document.querySelector('.mod-details-copy').textContent.trim();
    document.querySelector('#closeModDetails').click();

    document.querySelector('[data-view="servers"]').click();
    document.querySelector('#serverDirectHost').value = '127.0.0.1';
    document.querySelector('#serverDirectPort').value = '2001';
    document.querySelector('#serverDirectForm').requestSubmit();
    const direct = {
      splitFields: Boolean(document.querySelector('#serverDirectHost') && document.querySelector('#serverDirectPort')),
      address: document.querySelector('#serverJoinAddress').textContent.trim()
    };
    document.querySelector('#serverJoinDialog').close();

    const transfer = new DataTransfer();
    transfer.items.add(new File([
      '{"game":{"mods":[{"modId":"5965550F24A0C152","name":"Where Am I","version":"1.2.0"}]}}'
    ], 'Where Am I.txt', { type: 'text/plain' }));
    document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const overlayVisible = !document.querySelector('#fileDropOverlay').hidden;
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    await waitFor(() => document.querySelector('#importDialog').open);
    const droppedFile = {
      overlayVisible,
      dialogOpen: document.querySelector('#importDialog').open,
      name: document.querySelector('#importPresetName').value,
      containsMod: document.querySelector('#presetJsonInput').value.includes('5965550F24A0C152')
    };
    return { favorite, favoriteSort, cardGallery, detailsGallery, copy, translated, original, direct, droppedFile };
  })()`);

  assert.deepEqual(result.favorite, { topLeft: true, transparent: true, pressed: 'true', detailsStayedClosed: true });
  assert.deepEqual(result.favoriteSort, {
    options: ['subscribers', 'newest', 'rating', 'favorites'],
    cards: 1,
    summary: '1 favorite mods',
    pressed: 'true'
  });
  assert.deepEqual(settings.favoriteMods, [modId]);
  assert.deepEqual(result.cardGallery, { bannerRemoved: true, changed: true, detailsStayedClosed: true });
  assert.deepEqual(result.detailsGallery, { arrows: 2, changed: true, viewerStayedClosed: true });
  assert.equal(result.copy.enabled, true);
  assert.equal(result.copy.label, 'Copy mod JSON');
  assert.equal(copiedMod?.modId, modId);
  assert.match(result.translated, /текущее положение/);
  assert.match(result.original, /marks your current location/);
  assert.deepEqual(result.direct, { splitFields: true, address: '127.0.0.1:2001' });
  assert.deepEqual(result.droppedFile, {
    overlayVisible: true,
    dialogOpen: true,
    name: 'Where Am I',
    containsMod: true
  });

  window.show();
  window.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.writeFile(outputPath, (await window.capturePage()).toPNG());
  process.stdout.write(`${JSON.stringify(result)}\n${outputPath}\n`);
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
  app.quit();
});
