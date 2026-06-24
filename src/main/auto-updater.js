const { app, dialog } = require('electron');
const pkg = require('../../package.json');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 15 * 1000;

let initialized = false;
let updater;
let updateEvents = () => {};
let log = () => {};
let getMainWindow = () => null;
let checking = false;
let promptOpen = false;
let lastStatus = {
  type: 'idle',
  message: 'Updates are idle.',
  checking: false
};

function setupAutoUpdates(options = {}) {
  if (initialized) return lastStatus;
  initialized = true;

  log = typeof options.log === 'function' ? options.log : () => {};
  getMainWindow = typeof options.getMainWindow === 'function' ? options.getMainWindow : () => null;
  updateEvents = typeof options.emit === 'function' ? options.emit : () => {};

  if (!updatesEnabled()) {
    const reason = getUpdatesDisabledReason();
    setStatus(reason === 'not packaged' ? 'development' : 'disabled', getUpdatesDisabledMessage(reason), { checking: false, reason });
    log('info', 'updates:disabled', { reason, packaged: app.isPackaged });
    return lastStatus;
  }

  const autoUpdater = getAutoUpdater();
  autoUpdater.logger = createUpdaterLogger();
  const feedConfig = getGitHubFeedConfig();
  autoUpdater.setFeedURL(feedConfig);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = app.getVersion().includes('-');
  log('info', 'updates:feed-configured', { owner: feedConfig.owner, repo: feedConfig.repo, private: feedConfig.private });

  autoUpdater.on('checking-for-update', () => {
    checking = true;
    setStatus('checking', 'Checking for updates…', { checking: true });
  });

  autoUpdater.on('update-available', (info) => {
    checking = true;
    const version = info?.version ? ` ${info.version}` : '';
    setStatus('available', `Update${version} is available. Downloading…`, { checking: true, version: info?.version || '' });
  });

  autoUpdater.on('update-not-available', (info) => {
    checking = false;
    setStatus('not-available', 'You are running the latest version.', { checking: false, version: info?.version || app.getVersion() });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number.isFinite(progress?.percent) ? Math.round(progress.percent) : 0;
    checking = true;
    setStatus('downloading', `Downloading update… ${percent}%`, {
      checking: true,
      percent,
      transferred: progress?.transferred || 0,
      total: progress?.total || 0
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    checking = false;
    const version = info?.version ? ` ${info.version}` : '';
    setStatus('downloaded', `Update${version} is ready to install.`, { checking: false, version: info?.version || '' });
    promptToInstall(info).catch((error) => {
      log('warn', 'updates:install-prompt-failed', { error: error?.message || String(error) });
    });
  });

  autoUpdater.on('error', (error) => {
    checking = false;
    setStatus('error', `Update check failed: ${error?.message || String(error)}`, { checking: false });
    log('warn', 'updates:error', { error: error?.stack || error?.message || String(error) });
  });

  setTimeout(() => {
    checkForUpdates('startup').catch((error) => {
      log('warn', 'updates:startup-check-failed', { error: error?.message || String(error) });
    });
  }, STARTUP_CHECK_DELAY_MS).unref?.();

  setInterval(() => {
    checkForUpdates('scheduled').catch((error) => {
      log('warn', 'updates:scheduled-check-failed', { error: error?.message || String(error) });
    });
  }, CHECK_INTERVAL_MS).unref?.();

  setStatus('enabled', 'Automatic updates are enabled.', { checking: false });
  return lastStatus;
}

async function checkForUpdates(reason = 'manual') {
  if (!initialized) {
    return { ok: false, skipped: true, status: lastStatus, error: 'Auto-updater is not initialized yet.' };
  }

  if (!updatesEnabled()) {
    const disabledReason = getUpdatesDisabledReason();
    setStatus(disabledReason === 'not packaged' ? 'development' : 'disabled', getUpdatesDisabledMessage(disabledReason), {
      checking: false,
      reason: disabledReason || reason
    });
    return { ok: true, skipped: true, status: lastStatus };
  }

  if (checking) {
    return { ok: true, skipped: true, status: lastStatus, message: 'An update check is already running.' };
  }

  try {
    log('info', 'updates:check', { reason, version: app.getVersion() });
    const result = await getAutoUpdater().checkForUpdates();
    return { ok: true, status: lastStatus, updateInfo: sanitizeUpdateInfo(result?.updateInfo) };
  } catch (error) {
    checking = false;
    const message = error?.message || String(error);
    setStatus('error', `Update check failed: ${message}`, { checking: false, reason });
    log('warn', 'updates:check-failed', { reason, error: error?.stack || message });
    return { ok: false, status: lastStatus, error: message };
  }
}

function getUpdateStatus() {
  return lastStatus;
}

function updatesEnabled() {
  if (isAgentMode()) return false;
  if (isEnvEnabled('YOLO_AUTO_DISABLE_UPDATES')) return false;
  return app.isPackaged || isEnvEnabled('YOLO_AUTO_FORCE_UPDATES');
}

function isAgentMode() {
  return isEnvEnabled('YOLO_AUTO_AGENT') || isEnvEnabled('CUA');
}

function getUpdatesDisabledReason() {
  if (isAgentMode()) return 'agent mode';
  if (isEnvEnabled('YOLO_AUTO_DISABLE_UPDATES')) return 'disabled by environment';
  if (!app.isPackaged && !isEnvEnabled('YOLO_AUTO_FORCE_UPDATES')) return 'not packaged';
  return 'disabled';
}

function getUpdatesDisabledMessage(reason) {
  if (reason === 'agent mode') return 'Automatic updates are disabled in agent mode.';
  if (reason === 'not packaged') return 'Automatic updates run only in packaged builds.';
  return 'Automatic updates are disabled by environment.';
}

function getAutoUpdater() {
  if (!updater) {
    ({ autoUpdater: updater } = require('electron-updater'));
  }
  return updater;
}

function createUpdaterLogger() {
  return {
    info: (...args) => logUpdaterMessage('info', args),
    warn: (...args) => logUpdaterMessage('warn', args),
    error: (...args) => logUpdaterMessage('error', args),
    debug: (...args) => logUpdaterMessage('info', args)
  };
}

function logUpdaterMessage(level, args) {
  try {
    log(level, 'updates:updater-log', { message: args.map(formatUpdaterLogArg).join(' ') });
  } catch {
    // Updater logging should never affect the app lifecycle.
  }
}

function formatUpdaterLogArg(value) {
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function getGitHubFeedConfig() {
  const explicit = String(process.env.YOLO_AUTO_UPDATE_REPO || '').trim();
  const repository = explicit || process.env.GITHUB_REPOSITORY || pkg.repository?.url || pkg.homepage || 'yolo-auto-org/yolo-auto-desktop';
  const parsed = parseGitHubRepository(repository) || { owner: 'yolo-auto-org', repo: 'yolo-auto-desktop' };
  return { provider: 'github', owner: parsed.owner, repo: parsed.repo, private: false };
}

function parseGitHubRepository(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const shorthand = text.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:#.*)?$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/, '') };

  const urlMatch = text.match(/github\.com[:/]([^/\s]+)\/([^/#\s]+?)(?:\.git)?(?:[#/].*)?$/i);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, '') };

  return null;
}

async function promptToInstall(info) {
  if (promptOpen) return;
  promptOpen = true;

  try {
    const version = info?.version || 'the latest version';
    const options = {
      type: 'info',
      title: 'Update ready',
      message: `YOLO Auto Desktop ${version} is ready to install.`,
      detail: 'Restart now to finish the update, or choose Later to install it the next time you quit the app.',
      buttons: ['Restart and install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    };

    const window = getMainWindow();
    const result = window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);

    if (result.response === 0) {
      setStatus('installing', `Installing YOLO Auto Desktop ${version}…`, { checking: false, version });
      setImmediate(() => getAutoUpdater().quitAndInstall(false, true));
    }
  } finally {
    promptOpen = false;
  }
}

function setStatus(type, message, extra = {}) {
  lastStatus = {
    type,
    message,
    currentVersion: app.getVersion(),
    checking,
    updatedAt: new Date().toISOString(),
    ...extra
  };

  log(type === 'error' ? 'warn' : 'info', `updates:${type}`, compactStatusForLog(lastStatus));

  try {
    updateEvents(lastStatus);
  } catch (error) {
    log('warn', 'updates:event-failed', { error: error?.message || String(error) });
  }
}

function sanitizeUpdateInfo(info) {
  if (!info) return null;
  return {
    version: info.version || '',
    releaseName: info.releaseName || '',
    releaseDate: info.releaseDate || '',
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
  };
}

function compactStatusForLog(status) {
  return {
    type: status.type,
    message: status.message,
    currentVersion: status.currentVersion,
    updateVersion: status.updateVersion || status.version || '',
    percent: status.percent,
    reason: status.reason
  };
}

function isEnvEnabled(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

module.exports = {
  setupAutoUpdates,
  checkForUpdates,
  getUpdateStatus,
  parseGitHubRepository
};
