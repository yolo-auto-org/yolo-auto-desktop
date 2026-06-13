#!/usr/bin/env node

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');

const pngToIco = pngToIcoModule.default || pngToIcoModule;
const rootDir = path.resolve(__dirname, '..');
const buildDir = path.join(rootDir, 'build');
const iconsDir = path.join(buildDir, 'icons');
const iconsetDir = path.join(buildDir, 'icon.iconset');
const sourceIconPath = path.resolve(process.env.YOLO_AUTO_ICON_SOURCE || path.join(rootDir, 'src', 'assets', 'app-icon.png'));

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

async function main() {
  await assertReadableSourceIcon();
  await fs.mkdir(iconsDir, { recursive: true });
  await fs.copyFile(sourceIconPath, path.join(buildDir, 'icon-source.png'));
  await fs.rm(path.join(buildDir, 'icon.svg'), { force: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const pngPaths = [];
  for (const size of sizes) {
    const filePath = path.join(iconsDir, `icon_${size}x${size}.png`);
    await renderPng(size, filePath);
    pngPaths.push(filePath);
  }

  await fs.copyFile(path.join(iconsDir, 'icon_512x512.png'), path.join(buildDir, 'icon.png'));
  await writeWindowsIco(pngPaths.filter((filePath) => /_(16|24|32|48|64|128|256)x\1\.png$/.test(filePath)));
  await writeMacIcns();

  console.log(`Generated build icons from ${path.relative(rootDir, sourceIconPath) || sourceIconPath}.`);
}

async function assertReadableSourceIcon() {
  try {
    const metadata = await sharp(sourceIconPath).metadata();
    if (!metadata.width || !metadata.height) throw new Error('image dimensions could not be detected');
  } catch (error) {
    throw new Error(`Could not read app icon source at ${sourceIconPath}: ${error?.message || String(error)}`);
  }
}

async function renderPng(size, filePath) {
  await sharp(sourceIconPath)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(filePath);
}

async function writeWindowsIco(pngPaths) {
  const icoBuffer = await pngToIco(pngPaths);
  await fs.writeFile(path.join(buildDir, 'icon.ico'), icoBuffer);
}

async function writeMacIcns() {
  if (process.platform !== 'darwin') {
    if (!fssync.existsSync(path.join(buildDir, 'icon.icns'))) {
      console.warn('Skipping icon.icns generation: macOS iconutil is only available on macOS.');
    }
    return;
  }

  await fs.rm(iconsetDir, { recursive: true, force: true });
  await fs.mkdir(iconsetDir, { recursive: true });

  const iconset = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ];

  for (const [name, size] of iconset) {
    await fs.copyFile(path.join(iconsDir, `icon_${size}x${size}.png`), path.join(iconsetDir, name));
  }

  const result = spawnSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(buildDir, 'icon.icns')], {
    stdio: 'inherit'
  });
  if (result.status !== 0) throw new Error('iconutil failed to create build/icon.icns');
}
