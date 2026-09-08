const path = require('node:path');
const { app } = require('electron');

const { readBuildIdentity } = require('../src/core/buildIdentity');

async function main() {
  const [appPath, resourcesPath, executablePath, expectedVersion, expectedTier] = process.argv.slice(2);
  if (!appPath || !resourcesPath || !executablePath || !expectedVersion) {
    throw new Error('Usage: electron tests/packageIdentitySmoke.js <app.asar> <resources> <executable> <version> [community|public-unsigned|public]');
  }
  if (expectedTier !== undefined && !['community', 'public-unsigned', 'public'].includes(expectedTier)) {
    throw new Error(`Unsupported expected release tier: ${expectedTier}`);
  }
  await app.whenReady();
  const identity = await readBuildIdentity({
    appPath: path.resolve(appPath),
    resourcesPath: path.resolve(resourcesPath),
    executablePath: path.resolve(executablePath),
    version: expectedVersion,
    packaged: true,
    platform: process.platform
  });
  process.stdout.write(`${JSON.stringify(identity)}\n`);
  if (identity.status !== 'open-source' || identity.license !== 'GPL-3.0-only') {
    app.exit(1);
    return;
  }
  if (expectedTier !== undefined && identity.releaseTier !== expectedTier) {
    throw new Error(`Packaged release tier mismatch: expected ${expectedTier}, received ${identity.releaseTier}`);
  }
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.exit(1);
});
