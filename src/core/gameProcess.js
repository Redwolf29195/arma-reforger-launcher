const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const LINUX_CLIENT_IMAGES = ['armareforgersteam.exe', 'armareforger.exe', 'armareforgersteam', 'armareforger'];

function processImageName(value) {
  return String(value || '').replace(/ \(deleted\)$/, '').replace(/\\/g, '/').split('/').at(-1).toLowerCase();
}

function isArmaReforgerLinuxProcess(record = {}) {
  if (['Z', 'X', 'x'].includes(record.state)) return false;
  const argv = Array.isArray(record.argv) ? record.argv : [];
  // Wine rebuilds argv[0] and the kernel task name for its Windows child.
  // Looking for an .exe anywhere in a full command line also matches Steam,
  // Python Proton and pressure-vessel wrappers after the actual game exits.
  if (LINUX_CLIENT_IMAGES.includes(processImageName(argv[0]))
    || LINUX_CLIENT_IMAGES.includes(processImageName(record.executable))) return true;
  const comm = String(record.comm || '').trim().toLowerCase();
  return LINUX_CLIENT_IMAGES.some((image) => comm === image || comm === image.slice(0, 15));
}

function processCheckError(cause) {
  const error = new Error('Не удалось проверить, запущена ли Arma Reforger. Повторите попытку.', { cause });
  error.code = 'GAME_PROCESS_CHECK_FAILED';
  return error;
}

async function readLinuxProcessTable(options = {}) {
  const filesystem = options.fsImpl || fs;
  const procRoot = options.procRoot || '/proc';
  const userId = options.userId ?? process.getuid?.();
  const entries = await filesystem.readdir(procRoot, { withFileTypes: true });
  const pids = entries.filter((entry) => /^\d+$/.test(entry.name) && entry.isDirectory()).map((entry) => entry.name);
  const records = [];
  // Keep scans bounded in concurrency; /proc entries may vanish while reading.
  for (let offset = 0; offset < pids.length; offset += 32) {
    const batch = await Promise.all(pids.slice(offset, offset + 32).map(async (pid) => {
      const directory = path.join(procRoot, pid);
      try {
        if (Number.isInteger(userId) && (await filesystem.stat(directory)).uid !== userId) return null;
        const [statText, cmdline] = await Promise.all([
          filesystem.readFile(path.join(directory, 'stat'), 'utf8'),
          filesystem.readFile(path.join(directory, 'cmdline'))
        ]);
        const state = String(statText).match(/^\d+ \((.*)\) ([A-Za-z])(?:\s|$)/);
        if (!state) throw new Error(`Could not parse Linux process ${pid}.`);
        return { pid: Number(pid), comm: state[1], state: state[2], argv: String(cmdline).split('\0').filter(Boolean) };
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
        throw error;
      }
    }));
    records.push(...batch.filter(Boolean));
  }
  return records;
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    (options.execFileImpl || execFile)(command, args, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) {
        // pgrep exits with 1 when the query succeeded and found no processes.
        // A timeout or failed tasklist query must never mean the game is closed.
        const noMatches = command === 'pgrep' && error.code === 1 && !error.killed && !error.signal;
        if (options.strict && !noMatches) {
          const failure = new Error('Не удалось проверить, запущена ли Arma Reforger. Повторите попытку.', { cause: error });
          failure.code = 'GAME_PROCESS_CHECK_FAILED';
          reject(failure);
          return;
        }
        resolve('');
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function windowsTaskListContains(output, imageName) {
  const expected = String(imageName || '').trim().toLowerCase();
  if (!expected) return false;
  return String(output || '').split(/\r?\n/).some((line) => {
    const firstColumn = line.split(',', 1)[0].trim().replace(/^"|"$/g, '').toLowerCase();
    return firstColumn === expected;
  });
}

async function isArmaReforgerRunning(platform = process.platform, options = {}) {
  if (platform === 'win32') {
    const output = await execFileText('tasklist.exe', [
      '/FI',
      'IMAGENAME eq ArmaReforger*',
      '/FO',
      'CSV',
      '/NH'
    ], { ...options, strict: true });
    return windowsTaskListContains(output, 'ArmaReforgerSteam.exe')
      || windowsTaskListContains(output, 'ArmaReforger.exe');
  }

  if (platform === 'linux') {
    try {
      return (await readLinuxProcessTable(options)).some(isArmaReforgerLinuxProcess);
    } catch (error) {
      throw processCheckError(error);
    }
  }

  const output = await execFileText('pgrep', ['-f', '(^|/)ArmaReforger(Steam)?(\\.exe)?([[:space:]]|$)'], { ...options, strict: true });
  return /^\s*\d+/m.test(output);
}

async function isSteamRunning(platform = process.platform, options = {}) {
  if (platform === 'win32') {
    const output = await execFileText('tasklist.exe', [
      '/FI',
      'IMAGENAME eq steam.exe',
      '/FO',
      'CSV',
      '/NH'
    ], options);
    return windowsTaskListContains(output, 'steam.exe');
  }

  if (platform === 'linux') {
    try {
      return (await readLinuxProcessTable(options)).some((record) => (
        !['Z', 'X', 'x'].includes(record.state)
        && processImageName(record.argv[0]) === 'steam'
      ));
    } catch {
      return false;
    }
  }

  const output = await execFileText('pgrep', ['-f', '(^|/)(steam|steam_osx)([[:space:]]|$)']);
  return /^\s*\d+/m.test(output);
}

module.exports = { isArmaReforgerLinuxProcess, isArmaReforgerRunning, isSteamRunning, readLinuxProcessTable, windowsTaskListContains };
