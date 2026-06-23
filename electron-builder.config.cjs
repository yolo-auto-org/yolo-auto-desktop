const path = require('node:path');

const productName = 'YOLO Auto Desktop';
const owner = process.env.GITHUB_REPOSITORY_OWNER || 'yolo-auto-org';
const repo = (process.env.GITHUB_REPOSITORY || 'yolo-auto-org/yolo-auto-desktop').split('/').pop();

function env(name) {
  return String(process.env[name] || '').trim();
}

function firstEnv(...names) {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return undefined;
}

// GitHub Actions exposes missing secrets as empty environment variables. electron-builder
// treats an empty CSC_LINK as a path and then fails with "not a file" before it can
// fall back to ad-hoc macOS signing, so remove empty signing vars up front.
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_INSTALLER_LINK', 'CSC_INSTALLER_KEY_PASSWORD']) {
  if (!env(name)) delete process.env[name];
}

function enabled(name) {
  return ['1', 'true', 'yes', 'on'].includes(env(name).toLowerCase());
}

function hasWindowsSigning() {
  return enabled('WINDOWS_AZURE_SIGNING')
    || Boolean(env('CSC_LINK') && env('CSC_KEY_PASSWORD'))
    || Boolean(env('WINDOWS_CSC_LINK') && env('WINDOWS_CSC_KEY_PASSWORD'))
    || Boolean(env('WIN_CSC_LINK') && env('WIN_CSC_KEY_PASSWORD'));
}

function hasMacSigning() {
  return Boolean(env('CSC_LINK') || env('MACOS_CSC_LINK')) && Boolean(env('CSC_KEY_PASSWORD') || env('MACOS_CSC_KEY_PASSWORD'));
}

function hasMacNotarization() {
  return enabled('MAC_NOTARIZE') || Boolean(
    (env('APPLE_API_KEY') && env('APPLE_API_KEY_ID') && env('APPLE_API_ISSUER'))
      || (env('APPLE_API_KEY_BASE64') && env('APPLE_API_KEY_ID') && env('APPLE_API_ISSUER'))
      || (env('APPLE_ID') && env('APPLE_APP_SPECIFIC_PASSWORD') && env('APPLE_TEAM_ID'))
      || (env('APPLE_KEYCHAIN') && env('APPLE_KEYCHAIN_PROFILE'))
  );
}

function windowsAzureSignOptions() {
  if (!enabled('WINDOWS_AZURE_SIGNING')) return undefined;

  return {
    endpoint: env('AZURE_TRUSTED_SIGNING_ENDPOINT'),
    codeSigningAccountName: env('AZURE_TRUSTED_SIGNING_ACCOUNT_NAME'),
    certificateProfileName: env('AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME'),
    publisherName: env('AZURE_TRUSTED_SIGNING_PUBLISHER_NAME'),
    timestampRfc3161: env('AZURE_TRUSTED_SIGNING_TIMESTAMP_URL') || 'http://timestamp.acs.microsoft.com',
    fileDigest: 'SHA256',
    timestampDigest: 'SHA256'
  };
}

module.exports = {
  appId: 'com.yoloauto.desktop',
  productName,
  copyright: 'Copyright © 2026 YOLO Auto',
  directories: {
    output: 'release',
    buildResources: 'build'
  },
  files: [
    'src/**/*',
    'package.json',
    'README.md',
    'LICENSE',
    '!**/*.map',
    '!**/.DS_Store'
  ],
  extraMetadata: {
    main: 'src/main/index.js'
  },
  asar: true,
  compression: 'maximum',
  removePackageScripts: true,
  npmRebuild: false,
  toolsets: {
    winCodeSign: '1.1.0'
  },
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // This app currently loads renderer assets with BrowserWindow.loadFile().
    // Keep file protocol privileges enabled until the renderer is moved to a custom app:// protocol.
    grantFileProtocolExtraPrivileges: true
  },
  publish: [
    {
      provider: 'github',
      owner,
      repo,
      private: false,
      releaseType: enabled('GITHUB_RELEASE_DRAFT') ? 'draft' : 'release'
    }
  ],
  artifactName: 'YOLO-Auto-Desktop-${version}-${os}-${arch}.${ext}',
  mac: {
    category: 'public.app-category.productivity',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] }
    ],
    icon: 'build/icon.icns',
    cscLink: firstEnv('CSC_LINK', 'MACOS_CSC_LINK'),
    cscKeyPassword: firstEnv('CSC_KEY_PASSWORD', 'MACOS_CSC_KEY_PASSWORD'),
    // If you do not have a paid Apple Developer ID cert, still ad-hoc sign (`-`)
    // instead of skipping signing entirely. Electron fuses modify executable pages;
    // without re-signing, newer macOS releases can kill the app with
    // CODESIGNING Code 2 / Invalid Page. Ad-hoc builds are still not notarized,
    // so Gatekeeper bypass steps remain necessary for downloaded tester builds.
    identity: hasMacSigning() ? undefined : '-',
    hardenedRuntime: hasMacSigning(),
    gatekeeperAssess: false,
    entitlements: 'config/entitlements.mac.plist',
    entitlementsInherit: 'config/entitlements.mac.plist',
    notarize: hasMacSigning() && hasMacNotarization()
  },
  dmg: {
    sign: false,
    artifactName: 'YOLO-Auto-Desktop-${version}-${arch}.${ext}'
  },
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] }
    ],
    icon: 'build/icon.ico',
    requestedExecutionLevel: 'asInvoker',
    signAndEditExecutable: hasWindowsSigning(),
    azureSignOptions: windowsAzureSignOptions()
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: productName,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    artifactName: 'YOLO-Auto-Desktop-Setup-${version}-${arch}.${ext}'
  },
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
      { target: 'rpm', arch: ['x64'] }
    ],
    icon: 'build/icon.png',
    category: 'Utility',
    maintainer: 'YOLO Auto',
    synopsis: 'Local desktop AI assistant',
    description: 'A local desktop AI assistant for everyday computer tasks and coding work.'
  }
};
