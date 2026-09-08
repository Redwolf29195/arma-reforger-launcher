const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

// A focused layout fixture uses the actual HTML, CSS, translations and assets,
// with deterministic display values and no launcher IPC or game processes.
const rendererRoot = path.resolve(process.env.ALGZ_LAYOUT_SOURCE_ROOT || path.join(__dirname, '..', 'src', 'renderer'));
const assetRoot = path.resolve(process.env.ALGZ_LAYOUT_ASSET_ROOT || rendererRoot);
const outputRoot = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'arma-dashboard-layout'));
const profile = path.join(os.tmpdir(), `arma-dashboard-layout-profile-${process.pid}`);
fsSync.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  await fs.mkdir(outputRoot, { recursive: true });
  let html = await fs.readFile(path.join(rendererRoot, 'index.html'), 'utf8');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace('<head>', `<head><base href="${pathToFileURL(`${assetRoot}${path.sep}`).href}">`);
  html = html.replace('href="styles.css"', `href="${pathToFileURL(path.join(rendererRoot, 'styles.css')).href}"`);
  html = html.replace('</body>', `<script src="${pathToFileURL(path.join(assetRoot, 'i18n.js')).href}"></script></body>`);
  const fixturePath = path.join(profile, 'dashboard-layout.html');
  await fs.writeFile(fixturePath, html);
  const results = [];
  for (const language of ['en', 'ru']) {
    for (const [width, height] of [[1280, 720], [1380, 850], [1920, 1080], [2560, 1440], [3440, 1440]]) {
      // A fresh compositor avoids stale offscreen surfaces after window resizing.
      const window = new BrowserWindow({
        width, height, frame: false, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false }
      });
      window.setContentSize(width, height);
      await window.loadFile(fixturePath);
      await window.webContents.executeJavaScript('document.fonts.ready');
    await window.webContents.executeJavaScript(`(() => {
      window.launcherI18n.setLanguage(${JSON.stringify(language)});
      document.querySelectorAll('[data-home-i18n]').forEach((node) => {
        node.textContent = window.launcherI18n.t(node.dataset.homeI18n);
      });
      document.querySelector('#homePresetName').textContent = ${JSON.stringify(language === 'ru' ? 'Основной набор сервера ALGZ — 151 мод' : 'ALGZ main server collection — 151 mods')};
      document.querySelector('#homePresetMeta').textContent = ${JSON.stringify(language === 'ru' ? '151 мод выбран' : '151 selected mods')};
      document.querySelector('#homeReadinessText').textContent = ${JSON.stringify(language === 'ru' ? 'Готово к запуску' : 'Ready to launch')};
      document.querySelector('#homeGameState').textContent = ${JSON.stringify(language === 'ru' ? 'Игра найдена' : 'Game detected')};
      document.querySelector('#homeInstalledMods').textContent = '307';
      document.querySelector('#homeModsMetric').textContent = '307';
      document.querySelector('#homePresetsMetric').textContent = '12';
      document.querySelector('#appVersion').textContent = ${JSON.stringify(`v${require('../package.json').version}`)};
      document.querySelector('#gameDetection small').textContent = ${JSON.stringify(language === 'ru' ? 'Игра найдена' : 'Game detected')};
      document.querySelector('#footerPresetName').textContent = 'ALGZ main server';
      document.querySelector('#homeWebsiteLink').href = 'https://armalaucher.com/';
    })()`);
      await window.webContents.executeJavaScript(`(async () => {
        const started = Date.now();
        while (innerWidth !== ${width} || innerHeight !== ${height}) {
          if (Date.now() - started > 5000) throw new Error('Viewport timed out: ' + innerWidth + 'x' + innerHeight + ' expected ${width}x${height}');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      // Let the compositor finish the translated content, not just its initial load.
      await new Promise(resolve => setTimeout(resolve, 300));
      const metrics = await window.webContents.executeJavaScript(`(() => {
        const box = (node) => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
        const view = document.querySelector('#view-dashboard');
        const dashboard = document.querySelector('.home-dashboard');
        const hero = document.querySelector('.home-hero');
        const heading = document.querySelector('.home-hero-copy h2');
        const cards = [...document.querySelectorAll('.home-tool-card')];
        const footer = document.querySelector('.launch-footer');
        const bottom = document.querySelector('.home-bottom-grid');
        const copy = [...document.querySelectorAll('.home-tool-copy')];
        return {
          width:innerWidth, height:innerHeight, view:box(view), dashboard:box(dashboard), hero:box(hero), bottom:box(bottom), footer:box(footer),
          heading:heading.textContent, headingColor:getComputedStyle(heading.querySelector('.home-title-intro')).color,
          brandColor:getComputedStyle(heading.querySelector('.home-title-brand')).color,
          horizontalOverflow:view.scrollWidth > view.clientWidth + 1,
          verticalOverflow:view.scrollHeight > view.clientHeight + 1,
          cardBounds:cards.map(box), cardFont:parseFloat(getComputedStyle(cards[0].querySelector('strong')).fontSize),
          textOverflows:copy.map((node) => node.scrollWidth > node.clientWidth + 1),
          childrenOutside:cards.flatMap((card) => [...card.children].filter((node) => getComputedStyle(node).display !== 'none').map((node) => {
            const child=box(node), parent=box(card); return child.x < parent.x - 1 || child.right > parent.right + 1 || child.bottom > parent.bottom + 1;
          })),
          credit:document.querySelector('.home-community-credit').textContent,
          website:document.querySelector('#homeWebsiteLink').href,
          brokenImages:[...document.querySelectorAll('#view-dashboard img')].filter((img) => !img.complete || !img.naturalWidth).map((img) => img.src)
        };
      })()`);
      const label = `${language} ${width}x${height}`;
      await fs.writeFile(path.join(outputRoot, 'dashboard-layout-current.json'), JSON.stringify({ language, ...metrics }, null, 2));
      const screenshot = path.join(outputRoot, `dashboard-${language}-${width}x${height}.png`);
      const frame = await new Promise((resolve, reject) => {
        const painted = (_event, _dirty, image) => {
          const size = image.getSize();
          if (size.width !== width || size.height !== height) return;
          clearTimeout(timeout);
          window.webContents.removeListener('paint', painted);
          resolve(image);
        };
        const timeout = setTimeout(() => {
          window.webContents.removeListener('paint', painted);
          reject(new Error(`No rendered frame at ${width}x${height}`));
        }, 10_000);
        window.webContents.on('paint', painted);
        window.webContents.invalidate();
      });
      await fs.writeFile(screenshot, frame.toPNG());
      assert.equal(metrics.width, width, `${label}: viewport width`);
      assert.equal(metrics.height, height, `${label}: viewport height`);
      assert.equal(metrics.heading, language === 'ru' ? 'ДОБРО ПОЖАЛОВАТЬ В ARMA REFORGER LAUNCHER' : 'WELCOME TO ARMA REFORGER LAUNCHER', `${label}: welcome title`);
      assert.equal(metrics.headingColor, 'rgb(242, 242, 237)', `${label}: white welcome line`);
      assert.equal(metrics.brandColor, 'rgb(242, 191, 75)', `${label}: yellow launcher name`);
      assert.equal(metrics.horizontalOverflow, false, `${label}: horizontal overflow`);
      assert.equal(metrics.verticalOverflow, false, `${label}: vertical overflow`);
      assert(metrics.bottom.bottom <= metrics.footer.y + 1, `${label}: content overlaps footer`);
      assert(metrics.footer.y - metrics.bottom.bottom <= 32, `${label}: blank bottom space`);
      assert(metrics.dashboard.width >= metrics.view.width - 92, `${label}: content unnecessarily narrow`);
      assert(metrics.cardBounds.every((card) => card.height >= 74), `${label}: small cards`);
      assert(Math.max(...metrics.cardBounds.map(card => card.bottom)) <= metrics.bottom.y - 1, `${label}: sections overlap`);
      assert(metrics.cardFont <= 21, `${label}: oversized labels`);
      assert(metrics.textOverflows.every((overflow) => !overflow), `${label}: text overflow`);
      assert(metrics.childrenOutside.every((outside) => !outside), `${label}: card child overflow`);
      assert.equal(metrics.credit.includes('ExtaZzZ'), false, `${label}: community credit`);
      assert.equal(metrics.website, 'https://armalaucher.com/');
      assert.deepEqual(metrics.brokenImages, [], `${label}: missing images`);
      results.push({ language, ...metrics, screenshot });
      window.destroy();
    }
  }
  await fs.writeFile(path.join(outputRoot, 'dashboard-layout-results.json'), JSON.stringify(results, null, 2));
  process.stdout.write(`${JSON.stringify({ passed: results.length, outputRoot })}\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
