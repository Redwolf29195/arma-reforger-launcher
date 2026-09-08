const { app, BrowserWindow } = require('electron');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const profilePath = path.join(os.tmpdir(), `arma-launcher-site-smoke-${process.pid}`);
fsSync.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', path.join(profilePath, 'session'));

const baseUrl = process.argv.find((argument) => /^https?:\/\//i.test(argument)) || 'http://127.0.0.1:4174';
const desktopPath = path.resolve(process.argv.find((argument) => /site-desktop\.png$/i.test(argument)) || 'site-desktop.png');
const mobilePath = path.resolve(process.argv.find((argument) => /site-mobile\.png$/i.test(argument)) || 'site-mobile.png');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 1000, show: false });
  await window.loadURL(baseUrl);
  await new Promise((resolve) => setTimeout(resolve, 700));

  const result = await window.webContents.executeJavaScript(`(async () => {
    const snapshot = () => ({
      language: document.documentElement.lang,
      interfaceLabel: document.querySelector('#mainNav a')?.textContent.trim(),
      downloadLabel: document.querySelector('.header-download')?.textContent.trim(),
      heroLead: document.querySelector('.hero-lead')?.textContent.trim().replace(/\\s+/g, ' '),
      interfaceHeading: document.querySelector('#product h2')?.textContent.trim().replace(/\\s+/g, ' '),
      workflowHeading: document.querySelector('#workflow h2')?.textContent.trim().replace(/\\s+/g, ' '),
      featureHeading: document.querySelector('#features h2')?.textContent.trim().replace(/\\s+/g, ' '),
      downloadHeading: document.querySelector('#download h2')?.textContent.trim().replace(/\\s+/g, ' '),
      activeLanguage: document.querySelector('[data-language].active')?.dataset.language,
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth
    });
    const english = snapshot();
    document.querySelector('[data-language="ru"]').click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const russian = snapshot();
    document.querySelector('[data-language="en"]').click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { english, russian, englishRestored: snapshot() };
  })()`);

  const desktop = await window.capturePage();
  await fs.writeFile(desktopPath, desktop.toPNG());

  window.setSize(390, 844);
  await new Promise((resolve) => setTimeout(resolve, 250));
  result.mobile = await window.webContents.executeJavaScript(`({
    language: document.documentElement.lang,
    noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
    languageSwitchVisible: document.querySelector('.language-switch').offsetWidth > 0,
    menuButtonVisible: document.querySelector('#menuButton').offsetWidth > 0
  })`);
  const mobile = await window.capturePage();
  await fs.writeFile(mobilePath, mobile.toPNG());

  process.stdout.write(`${JSON.stringify(result)}\n${desktopPath}\n${mobilePath}\n`);
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.exit(1);
});
