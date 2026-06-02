#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { downloadArtifact } = require('@electron/get');

const rootDir = path.resolve(__dirname, '..');
const electronDir = path.join(rootDir, 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const pathFile = path.join(electronDir, 'path.txt');

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});

async function main() {
  if (!fs.existsSync(electronDir)) {
    throw new Error('Electron is not installed. Run `npm install` first.');
  }

  const electronPackage = require(path.join(electronDir, 'package.json'));
  const version = electronPackage.version;
  const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;
  const arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch;
  const platformPath = getPlatformPath(platform);

  if (isInstalled(version, platformPath)) return;

  console.log(`Preparing Electron ${version} for ${platform}-${arch}...`);

  const checksumsPath = path.join(electronDir, 'checksums.json');
  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    force: process.env.force_no_cache === 'true',
    cacheRoot: process.env.electron_config_cache,
    checksums: process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums
      ? undefined
      : require(checksumsPath),
    platform,
    arch
  });

  await fsp.rm(distDir, { recursive: true, force: true });
  await fsp.mkdir(distDir, { recursive: true });
  extractZip(zipPath, distDir, platform);

  const typeDefInDist = path.join(distDir, 'electron.d.ts');
  if (fs.existsSync(typeDefInDist)) {
    await fsp.rename(typeDefInDist, path.join(electronDir, 'electron.d.ts'));
  }

  await fsp.writeFile(pathFile, platformPath, 'utf8');

  if (!isInstalled(version, platformPath)) {
    throw new Error(`Electron binary was extracted, but ${path.join(distDir, platformPath)} was not found.`);
  }
}

function isInstalled(version, platformPath) {
  try {
    const installedVersion = fs.readFileSync(path.join(distDir, 'version'), 'utf8').replace(/^v/, '');
    const installedPath = fs.readFileSync(pathFile, 'utf8');
    const executablePath = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(distDir, platformPath);
    return installedVersion === version && installedPath === platformPath && fs.existsSync(executablePath);
  } catch {
    return false;
  }
}

function extractZip(zipPath, destination, platform) {
  if (platform === 'win32') {
    const command = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destination)} -Force`;
    if (run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command])) return;
    if (run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command])) return;
    if (run('tar.exe', ['-xf', zipPath, '-C', destination])) return;
  } else {
    if (run('unzip', ['-q', zipPath, '-d', destination])) return;
    if (run('tar', ['-xf', zipPath, '-C', destination])) return;
  }

  throw new Error(`Could not extract Electron zip: ${zipPath}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return result.status === 0;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getPlatformPath(platform = os.platform()) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}
