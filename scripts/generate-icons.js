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

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="112" y1="80" x2="912" y2="944" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7C3AED"/>
      <stop offset="0.52" stop-color="#2563EB"/>
      <stop offset="1" stop-color="#06B6D4"/>
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(336 288) rotate(51) scale(720)">
      <stop stop-color="#FFFFFF" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="170" y="248" width="704" height="524" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="28" stdDeviation="32" flood-color="#020617" flood-opacity="0.36"/>
    </filter>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="220" fill="url(#bg)"/>
  <rect x="64" y="64" width="896" height="896" rx="220" fill="url(#glow)"/>
  <path d="M202 733C302 620 362 490 394 302H510C496 414 462 514 408 602C481 575 556 572 630 594C607 513 600 414 609 302H725C711 486 740 624 821 733H688C670 706 655 678 642 649C559 619 475 631 389 684C376 700 363 716 349 733H202Z" fill="white" fill-opacity="0.96" filter="url(#shadow)"/>
  <circle cx="709" cy="292" r="52" fill="white" fill-opacity="0.96"/>
</svg>`;

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

async function main() {
  await fs.mkdir(iconsDir, { recursive: true });
  await fs.writeFile(path.join(buildDir, 'icon.svg'), svg, 'utf8');

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

  console.log('Generated build icons.');
}

async function renderPng(size, filePath) {
  await sharp(Buffer.from(svg))
    .resize(size, size, { fit: 'contain' })
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
