// SPDX-License-Identifier: GPL-3.0-only
'use strict';

// Run with Xvfb as an ordinary user after installing the generated deb, or
// against an extracted AppImage fixture with a separately configured helper.
// This starts the real installed application; no app test hooks are introduced.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function processTree(parentPid) {
  const processes = [];
  for (const directory of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(directory)) continue;
    try {
      const [status, command] = await Promise.all([
        fs.readFile(`/proc/${directory}/status`, 'utf8'),
        fs.readFile(`/proc/${directory}/cmdline`, 'utf8')
      ]);
      processes.push({ pid: Number(directory), parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]), status, arguments: command.split('\0').filter(Boolean) });
    } catch (error) { if (!['ENOENT', 'EACCES', 'ESRCH'].includes(error.code)) throw error; }
  }
  const selected = new Set([parentPid]);
  let count;
  do {
    count = selected.size;
    for (const process of processes) if (selected.has(process.parent)) selected.add(process.pid);
  } while (selected.size !== count);
  return processes.filter(process => selected.has(process.pid));
}

async function main() {
  assert.equal(process.platform, 'linux', 'The installed package smoke runs on Linux.');
  assert.notEqual(process.getuid(), 0, 'Run this check as an ordinary user, not root.');
  const argumentsList = process.argv.slice(2);
  const extractedAppImage = argumentsList[0] === '--extracted-appimage';
  if (extractedAppImage) argumentsList.shift();
  const [requestedExecutable, requestedScreenshot = 'artifacts/linux-installed.png'] = argumentsList;
  assert(requestedExecutable && argumentsList.length <= 2,
    'Usage: node scripts/linux-package-smoke.js [--extracted-appimage] <executable-or-AppRun> [screenshot.png]');
  const executable = await fs.realpath(requestedExecutable);
  const installation = path.dirname(executable);
  if (extractedAppImage) {
    assert.equal(path.basename(executable), 'AppRun', 'Expected the extracted AppImage AppRun launcher.');
    assert((await fs.stat(path.join(installation, 'arma-reforger-launcher'))).isFile(),
      'The extracted AppImage must contain its real application executable.');
  } else {
    assert(executable.startsWith('/opt/'), 'Expected the executable installed by the deb under /opt.');
    assert.equal((await fs.stat(executable)).uid, 0, 'The installed executable must be root-owned.');
  }
  const sandboxHelper = await fs.stat(path.join(installation, 'chrome-sandbox'));
  assert.equal(sandboxHelper.uid, 0, 'The sandbox helper must be root-owned.');
  if (extractedAppImage) {
    assert.equal(sandboxHelper.mode & 0o7777, 0o4755, 'Configure the extracted fixture helper with mode 4755 before this check.');
  }
  await fs.access(path.join(installation, 'resources', 'app.asar'));
  await fs.access(path.join(installation, 'resources', 'launcher-addons', 'ALGZLauncherWorkshopBridge', 'Scripts', 'Game', 'ALGZLauncherWorkshopBridge.c'));
  const screenshot = path.resolve(requestedScreenshot);
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-linux-package-'));
  const environment = {
    ...process.env,
    HOME: temporaryHome,
    XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
    XDG_CACHE_HOME: path.join(temporaryHome, '.cache'),
    XDG_DATA_HOME: path.join(temporaryHome, '.local/share'),
    STEAM_PATH: path.join(temporaryHome, 'steam-not-installed')
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SANDBOX', 'NODE_OPTIONS', 'APPDIR', 'APPIMAGE', 'APPIMAGE_EXTRACT_AND_RUN']) delete environment[key];
  const child = spawn(executable, ['--disable-gpu', '--ozone-platform=x11'], {
    env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const capture = data => { output = `${output}${data}`.slice(-32 * 1024); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  try {
    const deadline = Date.now() + 45_000;
    let windowId;
    let renderers = [];
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `Installed app exited before showing its window: ${output}`);
      assert.equal(child.signalCode, null, `Installed app was terminated before showing its window: ${output}`);
      try {
        windowId = execFileSync('xdotool', ['search', '--onlyvisible', '--pid', String(child.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
      } catch { windowId = undefined; }
      const tree = await processTree(child.pid);
      assert(!tree.some(process => process.arguments.includes('--no-sandbox')), 'A packaged process disabled the sandbox.');
      renderers = tree.filter(process => process.arguments.includes('--type=renderer'));
      if (windowId && renderers.length) break;
      await delay(250);
    }
    assert(windowId, `No visible installed launcher window was found: ${output}`);
    assert(renderers.length, 'No renderer process was found.');
    for (const renderer of renderers) {
      assert.match(renderer.status, /^Seccomp:\s+2$/m, 'Renderer seccomp filtering is not enabled.');
      assert.match(renderer.status, /^NoNewPrivs:\s+1$/m, 'Renderer can still acquire new privileges.');
      assert.match(renderer.status, /^CapEff:\s+0+$/m, 'Renderer unexpectedly retains effective capabilities.');
    }
    const title = execFileSync('xdotool', ['getwindowname', windowId], { encoding: 'utf8' }).trim();
    assert.match(title, /Arma Reforger Launcher/i);
    await delay(750);
    assert.equal(child.exitCode, null, 'Installed app exited before its screenshot.');
    execFileSync('import', ['-window', windowId, screenshot]);
    assert((await fs.stat(screenshot)).size > 1000, 'The screenshot is unexpectedly small.');
    const report = {
      distribution: extractedAppImage ? 'extracted-appimage' : 'installed-deb',
      executable, title, screenshot, normalUser: true, isolatedHome: true,
      rendererCount: renderers.length, rendererSandbox: { seccomp: true, noNewPrivileges: true, effectiveCapabilities: '0' },
      sandboxHelper: { ownerUid: sandboxHelper.uid, mode: (sandboxHelper.mode & 0o7777).toString(8) },
      portableMountTested: false,
      extractedFixtureHelperConfigured: extractedAppImage,
      gameLaunchTested: false
    };
    await fs.writeFile(screenshot.replace(/\.png$/i, '') + '.json', `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await exited;
      }
    }
    assert(path.resolve(temporaryHome).startsWith(`${path.resolve(os.tmpdir())}${path.sep}launcher-linux-package-`));
    await fs.rm(temporaryHome, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
