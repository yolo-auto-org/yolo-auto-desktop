const fs = require('node:fs');
const path = require('node:path');

const APP_ID = 'com.yoloauto.desktop';

function getAppRootDir() {
  return path.resolve(__dirname, '..', '..');
}

function getAppIconPath() {
  const rootDir = getAppRootDir();
  const platformIcon = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const candidates = [
    path.join(rootDir, 'build', platformIcon),
    path.join(rootDir, 'build', 'icon.png'),
    path.join(__dirname, '..', 'assets', 'app-icon.png')
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function getAppIcon() {
  const iconPath = getAppIconPath();
  if (!iconPath) return undefined;

  try {
    const { nativeImage } = require('electron');
    if (!nativeImage?.createFromPath) return iconPath;

    const image = nativeImage.createFromPath(iconPath);
    return image && !image.isEmpty() ? image : iconPath;
  } catch {
    return iconPath;
  }
}

module.exports = {
  APP_ID,
  getAppIcon,
  getAppIconPath
};
