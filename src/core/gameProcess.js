const { execFile } = require('node:child_process');

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

  const output = await execFileText('pgrep', ['-f', '(^|/)ArmaReforger(Steam)?(\\.exe)?([[:space:]]|$)'], { ...options, strict: true });
  return /^\s*\d+/m.test(output);
}

async function isSteamRunning(platform = process.platform) {
  if (platform === 'win32') {
    const output = await execFileText('tasklist.exe', [
      '/FI',
      'IMAGENAME eq steam.exe',
      '/FO',
      'CSV',
      '/NH'
    ]);
    return windowsTaskListContains(output, 'steam.exe');
  }

  const output = await execFileText('pgrep', ['-f', '(^|/)(steam|steam_osx)([[:space:]]|$)']);
  return /^\s*\d+/m.test(output);
}

module.exports = { isArmaReforgerRunning, isSteamRunning, windowsTaskListContains };
