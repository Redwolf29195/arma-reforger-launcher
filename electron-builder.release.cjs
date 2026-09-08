const path = require('node:path');
const packageMetadata = require('./package.json');
const windowsPublisher = String(process.env.ALGZ_WINDOWS_PUBLISHER || '').trim();

module.exports = {
  ...packageMetadata.build,
  forceCodeSigning: true,
  win: {
    ...packageMetadata.build.win,
    publisherName: windowsPublisher ? [windowsPublisher] : undefined
  },
  directories: {
    ...packageMetadata.build.directories,
    output: path.join('dist-public', packageMetadata.version)
  }
};
