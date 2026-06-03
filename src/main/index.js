const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { loadSettings, saveSettings, normalizeCompatibilityPreset, normalizeGuardrails, normalizeMaxConcurrency } = require('./settings');
const { createLogger } = require('./logger');
const { ensureHomeBase, getHomeWorkspacePath } = require('./home-base');
const { THINKING_LEVELS, normalizeThinkingLevel } = require('./thinking-levels');
const { PiSdkSessionManager } = require('./pi-sdk-session-manager');

let mainWindow;
let settings;
let homeBaseRoot = '';
let workspaceRoot = '';
let activeSessionId = '';
let sessionManager;
let logger = () => {};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#08080d',
    title: 'yolo-auto desktop',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  setupMainWindowSecurity(mainWindow);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function setupMainWindowSecurity(window) {
  const rendererUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).toString();

  window.webContents.on('will-navigate', (event, url) => {
    if (url === rendererUrl) return;
    event.preventDefault();
    openExternalUrl(url);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function openExternalUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      shell.openExternal(url.toString()).catch((error) => {
        logger('warn', 'shell:open-external-failed', { error: error?.message || String(error) });
      });
    }
  } catch {
    // Ignore invalid or unsupported external navigation attempts.
  }
}

function publicSettings() {
  return {
    apiBaseUrl: settings.apiBaseUrl || '',
    apiKeyConfigured: !!String(settings.apiKey || '').trim(),
    model: settings.model || '',
    thinkingLevel: normalizeThinkingLevel(settings.thinkingLevel),
    compatibilityPreset: normalizeCompatibilityPreset(settings.compatibilityPreset),
    maxConcurrency: normalizeMaxConcurrency(settings.maxConcurrency),
    guardrails: normalizeGuardrails(settings.guardrails),
    thinkingLevels: THINKING_LEVELS
  };
}

function saveAppSettings(patch = {}) {
  settings = saveSettings({
    workspaceRoot,
    activeSessionId,
    apiBaseUrl: settings.apiBaseUrl || '',
    apiKey: settings.apiKey || '',
    model: settings.model || '',
    thinkingLevel: normalizeThinkingLevel(settings.thinkingLevel),
    compatibilityPreset: normalizeCompatibilityPreset(settings.compatibilityPreset),
    maxConcurrency: normalizeMaxConcurrency(settings.maxConcurrency),
    guardrails: normalizeGuardrails(settings.guardrails),
    skills: settings.skills || {},
    agents: settings.agents || {},
    ...patch
  });
  workspaceRoot = settings.workspaceRoot || workspaceRoot || '';
  activeSessionId = settings.activeSessionId || activeSessionId || '';
  return settings;
}

async function requestCommandApproval({ command, reason, rule, source, cwd, sessionId } = {}) {
  const detail = [
    source ? `Source: ${source}` : '',
    cwd ? `Folder: ${cwd}` : '',
    reason ? `Reason: ${reason}` : '',
    rule ? `Rule: ${rule}` : '',
    '',
    String(command || '')
  ].filter((line, index) => line || index === 4).join('\n');

  logger('warn', 'guardrails:approval-requested', { source, rule, sessionId, command: String(command || '') });

  const options = {
    type: 'warning',
    title: 'AI Guardrails',
    message: 'Approve this dangerous command?',
    detail,
    buttons: ['Cancel', 'Run anyway'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  const approved = result.response === 1;
  logger(approved ? 'warn' : 'info', approved ? 'guardrails:approved' : 'guardrails:denied', { source, rule, sessionId });
  return approved;
}

async function activeSessionPayload() {
  const session = await sessionManager.ensureSession(activeSessionId);
  if (session?.id && session.id !== activeSessionId) {
    activeSessionId = session.id;
    saveAppSettings({ activeSessionId });
  }

  return {
    activeSessionId,
    sessions: await sessionManager.listSessions(),
    active: await sessionManager.getPayload(activeSessionId)
  };
}

async function setWorkspaceRoot(nextRoot) {
  const root = String(nextRoot || '').trim();
  if (!root) throw new Error('Workspace folder is empty.');

  workspaceRoot = root;
  const session = await sessionManager.updateSessionWorkspace(activeSessionId, workspaceRoot);
  activeSessionId = session.id;
  saveAppSettings({ workspaceRoot, activeSessionId });
  return { workspaceRoot, session };
}

function setupIpc() {
  ipcMain.handle('app:bootstrap', async () => ({
    settings: publicSettings(),
    homeBaseRoot,
    workspaceRoot,
    appVersion: app.getVersion(),
    ...(await activeSessionPayload())
  }));

  ipcMain.handle('settings:save', async (_event, nextSettings) => {
    const patch = {
      apiBaseUrl: String(nextSettings.apiBaseUrl || '').trim(),
      model: String(nextSettings.model || '').trim(),
      thinkingLevel: normalizeThinkingLevel(nextSettings.thinkingLevel, settings.thinkingLevel),
      compatibilityPreset: normalizeCompatibilityPreset(nextSettings.compatibilityPreset, settings.compatibilityPreset),
      maxConcurrency: normalizeMaxConcurrency(nextSettings.maxConcurrency, settings.maxConcurrency),
      guardrails: normalizeGuardrails(nextSettings.guardrails, settings.guardrails)
    };

    const needsReload = patch.apiBaseUrl !== String(settings.apiBaseUrl || '').trim()
      || patch.model !== String(settings.model || '').trim()
      || patch.compatibilityPreset !== normalizeCompatibilityPreset(settings.compatibilityPreset);

    if (needsReload && sessionManager.hasBusySessions()) {
      throw new Error('Cancel running sessions before changing model provider settings. Max concurrency can be changed by itself while sessions run.');
    }

    saveAppSettings(patch);

    if (needsReload) await sessionManager.reloadActive();
    return publicSettings();
  });

  ipcMain.handle('settings:save-api-key', async (_event, apiKey) => {
    const nextApiKey = String(apiKey || '').trim();
    const needsReload = nextApiKey !== String(settings.apiKey || '').trim();

    if (needsReload && sessionManager.hasBusySessions()) {
      throw new Error('Cancel running sessions before changing the API key.');
    }

    saveAppSettings({ apiKey: nextApiKey });
    if (needsReload) await sessionManager.reloadActive();
    return publicSettings();
  });

  ipcMain.handle('settings:clear-api-key', async () => {
    const hadApiKey = !!String(settings.apiKey || '').trim();

    if (hadApiKey && sessionManager.hasBusySessions()) {
      throw new Error('Cancel running sessions before clearing the API key.');
    }

    saveAppSettings({ apiKey: '' });
    if (hadApiKey) await sessionManager.reloadActive();
    return publicSettings();
  });

  ipcMain.handle('sessions:list', async () => ({
    activeSessionId,
    sessions: await sessionManager.listSessions()
  }));

  ipcMain.handle('sessions:concurrency', async () => sessionManager.getConcurrencyState());

  ipcMain.handle('sessions:create', async () => {
    const session = await sessionManager.createSession({ workspaceRoot });
    activeSessionId = session.id;
    saveAppSettings({ activeSessionId });
    return activeSessionPayload();
  });

  ipcMain.handle('sessions:select', async (_event, sessionId) => {
    const session = await sessionManager.ensureSession(String(sessionId || ''));
    if (!session) throw new Error('Session not found.');

    activeSessionId = session.id;
    workspaceRoot = session.workspaceRoot || workspaceRoot;
    saveAppSettings({ activeSessionId, workspaceRoot });
    return activeSessionPayload();
  });

  ipcMain.handle('sessions:set-thinking-level', async (_event, sessionId, thinkingLevel) => {
    const id = await resolveSessionId(sessionId);
    await sessionManager.updateSessionThinkingLevel(id, thinkingLevel);
    return activeSessionPayload();
  });

  ipcMain.handle('sessions:delete', async (_event, sessionId) => {
    const id = String(sessionId || '');
    if (!id) throw new Error('Session not found.');

    await sessionManager.deleteSession(id);
    if (activeSessionId === id) activeSessionId = '';
    const payload = await activeSessionPayload();
    saveAppSettings({ activeSessionId: payload.activeSessionId });
    return payload;
  });

  ipcMain.handle('workspace:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || !result.filePaths[0]) {
      return { workspaceRoot, session: await sessionManager.getSession(activeSessionId) };
    }

    return setWorkspaceRoot(result.filePaths[0]);
  });

  ipcMain.handle('workspace:set', async (_event, nextRoot) => setWorkspaceRoot(nextRoot));

  ipcMain.handle('workspace:reveal', async () => {
    const session = await sessionManager.getSession(activeSessionId);
    const root = session?.workspaceRoot || workspaceRoot;
    if (root) await shell.openPath(root);
    return { workspaceRoot: root };
  });

  ipcMain.handle('logs:open', async () => {
    const logPath = path.join(app.getPath('userData'), 'app.log');
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, '', 'utf8');
    shell.showItemInFolder(logPath);
    return { logPath };
  });

  ipcMain.handle('workspace:file-suggestions', async (_event, sessionId, query) => {
    const id = await resolveSessionId(sessionId);
    const root = await sessionManager.getSessionWorkspace(id);
    return listWorkspaceFileSuggestions(root, query);
  });

  ipcMain.handle('skills:suggestions', async (_event, sessionId, query) => {
    const id = await resolveSessionId(sessionId);
    return sessionManager.listSkillSuggestions(id, query);
  });

  ipcMain.handle('skills:list', async (_event, sessionId) => {
    const id = await resolveSessionId(sessionId);
    return sessionManager.listSkills(id);
  });

  ipcMain.handle('skills:set-enabled', async (_event, sessionId, skillName, enabled) => {
    const id = await resolveSessionId(sessionId);
    await assertAllSessionsIdle();
    saveAppSettings({ skills: setSkillEntryEnabled(settings.skills, skillName, enabled) });
    await sessionManager.reloadActive();
    return sessionManager.listSkills(id);
  });

  ipcMain.handle('skills:set-extra-dirs', async (_event, sessionId, extraDirs) => {
    const id = await resolveSessionId(sessionId);
    await assertAllSessionsIdle();
    saveAppSettings({ skills: setExtraSkillDirs(settings.skills, extraDirs) });
    await sessionManager.reloadActive();
    return sessionManager.listSkills(id);
  });

  ipcMain.handle('chat:send', async (_event, maybeSessionId, maybeUserText) => {
    const { sessionId, text } = await parseChatArgs(maybeSessionId, maybeUserText);
    if (!text) throw new Error('Message is empty.');

    logger('info', 'chat:send', { sessionId, chars: text.length });
    try {
      return await sessionManager.run(sessionId, text);
    } catch (error) {
      logger('error', 'chat:send:error', {
        sessionId,
        name: error?.name || 'Error',
        message: error?.message || String(error)
      });
      throw error;
    }
  });

  ipcMain.handle('chat:steer', async (_event, maybeSessionId, maybeUserText) => {
    const { sessionId, text } = await parseChatArgs(maybeSessionId, maybeUserText);
    if (!text) throw new Error('Message is empty.');

    return sessionManager.queueSteer(sessionId, text);
  });

  ipcMain.handle('chat:follow-up', async (_event, maybeSessionId, maybeUserText) => {
    const { sessionId, text } = await parseChatArgs(maybeSessionId, maybeUserText);
    if (!text) throw new Error('Message is empty.');

    return sessionManager.queueFollowUp(sessionId, text);
  });

  ipcMain.handle('chat:cancel', async (_event, sessionId) => sessionManager.cancel(await resolveSessionId(sessionId, { select: false })));

  ipcMain.handle('chat:reset', async (_event, sessionId) => {
    const session = await sessionManager.reset(await resolveSessionId(sessionId));
    activeSessionId = session.id;
    saveAppSettings({ activeSessionId });
    return activeSessionPayload();
  });
}

async function listWorkspaceFileSuggestions(root, query) {
  if (!root) return [];

  const workspaceRoot = path.resolve(root);
  const needle = normalizeFileQuery(query);
  const results = [];
  const maxResults = 60;
  const maxVisited = 2500;
  let visited = 0;

  async function walk(relativeDir = '', depth = 0) {
    if (results.length >= maxResults || visited >= maxVisited || depth > 5) return;

    const dir = path.join(workspaceRoot, relativeDir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= maxResults || visited >= maxVisited) return;
      if (shouldSkipFilePickerEntry(entry.name)) continue;
      visited += 1;

      const relativePath = path.join(relativeDir, entry.name);
      const displayPath = relativePath.split(path.sep).join('/');
      const isDirectory = entry.isDirectory();

      if (matchesFileQuery(displayPath, needle)) {
        results.push({
          path: displayPath,
          name: entry.name,
          type: isDirectory ? 'folder' : 'file'
        });
      }

      if (isDirectory && needle) await walk(relativePath, depth + 1);
    }
  }

  await walk();
  return results;
}

function normalizeFileQuery(query) {
  return String(query || '').trim().replace(/\\/g, '/').toLowerCase();
}

function matchesFileQuery(filePath, query) {
  if (!query) return true;
  const haystack = String(filePath || '').toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((part) => haystack.includes(part));
}

function shouldSkipFilePickerEntry(name) {
  return name === '.git' || name === 'node_modules' || name === '.DS_Store' || name === '.pi';
}

async function parseChatArgs(maybeSessionId, maybeUserText) {
  if (maybeUserText === undefined) {
    return {
      sessionId: await resolveSessionId(),
      text: String(maybeSessionId || '').trim()
    };
  }

  return {
    sessionId: await resolveSessionId(maybeSessionId),
    text: String(maybeUserText || '').trim()
  };
}

async function resolveSessionId(sessionId, options = {}) {
  const requestedId = String(sessionId || '').trim();
  const select = options.select !== false;
  const session = await sessionManager.ensureSession(requestedId || activeSessionId || '', { select });

  if (select && (!requestedId || requestedId === activeSessionId || activeSessionId !== session.id)) {
    activeSessionId = session.id;
    workspaceRoot = session.workspaceRoot || workspaceRoot;
    saveAppSettings({ activeSessionId, workspaceRoot });
  }

  return session.id;
}

async function assertAllSessionsIdle() {
  if (sessionManager.hasBusySessions()) throw new Error('Cancel running sessions before changing skills.');
}

function setSkillEntryEnabled(currentSkills = {}, skillName, enabled) {
  const name = String(skillName || '').trim();
  if (!name) throw new Error('Skill not found.');

  const skills = normalizeSkillSettings(currentSkills);
  const entries = { ...skills.entries };
  const existing = { ...(entries[name] || {}) };

  if (enabled) {
    delete existing.enabled;
    if (Object.keys(existing).length) entries[name] = existing;
    else delete entries[name];
  } else {
    entries[name] = { ...existing, enabled: false };
  }

  return { ...skills, entries };
}

function setExtraSkillDirs(currentSkills = {}, extraDirs = []) {
  const skills = normalizeSkillSettings(currentSkills);
  const unique = [];
  for (const entry of Array.isArray(extraDirs) ? extraDirs : []) {
    const value = String(entry || '').trim();
    if (value && !unique.includes(value)) unique.push(value);
  }

  return {
    ...skills,
    load: {
      ...skills.load,
      extraDirs: unique
    }
  };
}

function normalizeSkillSettings(currentSkills = {}) {
  const source = currentSkills && typeof currentSkills === 'object' ? currentSkills : {};
  return {
    ...source,
    entries: { ...(source.entries || {}) },
    load: {
      ...(source.load || {}),
      extraDirs: Array.isArray(source.load?.extraDirs) ? source.load.extraDirs : []
    }
  };
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(String(b)).replace(/[\\/]+$/, '').toLowerCase();
}

app.whenReady().then(async () => {
  logger = createLogger(app.getPath('userData'));
  logger('info', 'app:ready', { version: app.getVersion() });

  const homeBase = ensureHomeBase(logger);
  homeBaseRoot = homeBase.homeBaseRoot;
  const defaultWorkspaceRoot = homeBase.workspaceRoot || getHomeWorkspacePath();

  settings = loadSettings();
  workspaceRoot = (!settings.workspaceRoot || samePath(settings.workspaceRoot, homeBaseRoot)) ? defaultWorkspaceRoot : settings.workspaceRoot;
  activeSessionId = settings.activeSessionId || '';
  if (workspaceRoot !== settings.workspaceRoot) saveAppSettings({ workspaceRoot });

  sessionManager = new PiSdkSessionManager({
    userDataDir: app.getPath('userData'),
    agentDir: homeBaseRoot,
    getSettings: () => settings,
    getDefaultWorkspaceRoot: () => workspaceRoot || homeBaseRoot,
    emit: (payload) => mainWindow?.webContents.send('agent:event', payload),
    requestCommandApproval,
    log: logger
  });

  setupIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  logger('error', 'app:ready:error', { message: error?.message || String(error) });
  throw error;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
