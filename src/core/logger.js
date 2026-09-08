const fs = require('node:fs');
const path = require('node:path');

class Logger {
  constructor(userDataDirectory) {
    this.directory = path.join(userDataDirectory, 'logs');
    this.filePath = path.join(this.directory, 'launcher.log');
    fs.mkdirSync(this.directory, { recursive: true });
    this.rotate();
  }

  rotate() {
    try {
      const stats = fs.statSync(this.filePath);
      if (stats.size > 1024 * 1024) {
        fs.rmSync(`${this.filePath}.1`, { force: true });
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      }
    } catch {
      // The log does not exist yet.
    }
  }

  write(level, message) {
    const cleanMessage = String(message).replace(/[\r\n]+/g, ' ');
    fs.appendFileSync(this.filePath, `${new Date().toISOString()} [${level}] ${cleanMessage}\n`, 'utf8');
  }

  info(message) {
    this.write('INFO', message);
  }

  error(message) {
    this.write('ERROR', message);
  }
}

module.exports = Logger;
