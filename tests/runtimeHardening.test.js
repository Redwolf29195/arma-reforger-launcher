const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const packageMetadata = require('../package.json');

function read(...parts) {
  return fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');
}

test('guards every launcher IPC registration through the trusted registrar', () => {
  const main = read('src', 'main', 'main.js');
  const trust = read('src', 'main', 'ipcTrust.js');
  assert.match(main, /ipcMain:\s*electronIpcMain/);
  assert.match(main, /createTrustedIpcRegistrar\(\{/);
  assert.doesNotMatch(main, /electronIpcMain\.(?:handle|on)\(/);
  assert.match(trust, /senderFrame/);
  assert.match(trust, /frame === webContents\.mainFrame/);
});

test('allows developer tools while blocking unsafe renderer navigation and permissions', () => {
  const main = read('src', 'main', 'main.js');
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /devTools:\s*true/);
  assert.match(main, /webviewTag:\s*false/);
  assert.match(main, /will-navigate/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /ALLOWED_EXTERNAL_HOSTS\.has/);
});

test('reads informational build metadata without blocking source or bridge modifications', () => {
  const main = read('src', 'main', 'main.js');
  assert.match(main, /readBuildIdentity\(\{/);
  assert.doesNotMatch(main, /buildIdentity\.status === 'tampered'/);
  assert.doesNotMatch(main, /computeDirectoryDigest|workshopBridgeSha256|buildTampered/);
  assert.match(main, /await fs\.access\(projectPath\)/);
  assert.match(main, /unsupportedRuntimeTitle/);
});

test('pins updater configuration and verifies every downloaded installer before enabling install', () => {
  const main = read('src', 'main', 'main.js');
  assert.match(main, /autoUpdater\.updateConfigPath = updateTrustPolicy\.updateConfigPath/);
  assert.match(main, /fetchUpdateArtifactEnvelope\(\{/);
  assert.match(main, /verifyUpdateArtifactFile\(\{/);
  assert.match(main, /autoUpdater\.verifyUpdateCodeSignature = async/);
  assert.match(main, /handleDownloadedUpdate\(info\)/);
  assert.match(main, /updaterState !== 'downloaded' \|\| !verifiedUpdateArtifact/);
  assert.match(main, /autoUpdater\.autoDownload = false/);
  assert.match(main, /verifySignedUpdatePolicy\(signedUpdateInfo\)/);
  assert.match(main, /policy\.mode !== 'optional'/);
  assert.match(main, /isArmaReforgerRunning\(\)/);
  assert.match(main, /beginVerifiedUpdateInstall\(`\$\{policy\.mode\}-deadline`\)/);
  assert.match(main, /updateDeadlineStore\.getOrCreate\(/);
  assert.match(main, /deadline: savedDeadline\.deadline/);
  assert.match(main, /Math\.max\(0, mandatory\.deadline - Date\.now\(\)\)/);
  assert.match(main, /autoUpdate && !mandatory/);
  assert.doesNotMatch(main, /beginVerifiedUpdateInstall\('window-close'\)/);
});

test('stages readable Bridge code and contains no legacy Electron-as-Node worker', () => {
  const extraResource = packageMetadata.build.extraResources.find((entry) => (
    entry.to === 'launcher-addons/ALGZLauncherWorkshopBridge'
  ));
  const preparation = read('scripts', 'prepare-build.js');
  const sourceFiles = [];
  const pending = [path.join(projectRoot, 'src')];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile()) sourceFiles.push(filePath);
    }
  }

  assert.equal(extraResource.from, '.build/app/launcher-addons/ALGZLauncherWorkshopBridge');
  assert.doesNotMatch(preparation, /protectWorkshopBridge|protectedIdentifierPattern|javascript-obfuscator|selfDefending/);
  assert.equal(fs.existsSync(path.join(projectRoot, 'src', 'main', 'factoryResetWorker.js')), false);
  for (const filePath of sourceFiles) {
    assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /ELECTRON_RUN_AS_NODE/);
  }
});
