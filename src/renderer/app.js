const THINKING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'];
const RECENT_SESSION_LIMIT = 5;

const state = {
  settings: {},
  homeBaseRoot: '',
  workspaceRoot: '',
  sessions: [],
  activeSessionId: '',
  activeSession: null,
  busy: false,
  currentAssistant: null,
  queues: { steering: [], followUp: [] },
  skills: { skills: [], diagnostics: [], extraDirs: [], loading: false, error: '' },
  filePicker: { open: false, mode: 'file', query: '', results: [], selectedIndex: 0, anchor: null, requestId: 0 },
  sidebarCollapsed: localStorage.getItem('yolo-sidebar-collapsed') === 'true',
  theme: localStorage.getItem('yolo-theme') || document.documentElement.dataset.theme || 'dark'
};

const els = {
  appShell: document.querySelector('.app-shell'),
  workspacePath: document.getElementById('workspacePath'),
  chatWorkspaceName: document.getElementById('chatWorkspaceName'),
  chatWorkspacePath: document.getElementById('chatWorkspacePath'),
  modelName: document.getElementById('modelName'),
  statusText: document.getElementById('statusText'),
  thinkingLevelSelect: document.getElementById('thinkingLevelSelect'),
  connectionChip: document.getElementById('connectionChip'),
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  messages: document.getElementById('messages'),
  queuePanel: document.getElementById('queuePanel'),
  filePicker: document.getElementById('filePicker'),
  sessionsList: document.getElementById('sessionsList'),
  newSessionBtn: document.getElementById('newSessionBtn'),
  collapseSidebarBtn: document.getElementById('collapseSidebarBtn'),
  sessionsPaneBtn: document.getElementById('sessionsPaneBtn'),
  sessionsModal: document.getElementById('sessionsModal'),
  closeSessionsBtn: document.getElementById('closeSessionsBtn'),
  newSessionFromPaneBtn: document.getElementById('newSessionFromPaneBtn'),
  allSessionsList: document.getElementById('allSessionsList'),
  skillsPaneBtn: document.getElementById('skillsPaneBtn'),
  logsBtn: document.getElementById('logsBtn'),
  skillsModal: document.getElementById('skillsModal'),
  closeSkillsBtn: document.getElementById('closeSkillsBtn'),
  refreshSkillsBtn: document.getElementById('refreshSkillsBtn'),
  saveSkillDirsBtn: document.getElementById('saveSkillDirsBtn'),
  skillsList: document.getElementById('skillsList'),
  skillsStatus: document.getElementById('skillsStatus'),
  skillsExtraDirsInput: document.getElementById('skillsExtraDirsInput'),
  promptInput: document.getElementById('promptInput'),
  sendBtn: document.getElementById('sendBtn'),
  followUpBtn: document.getElementById('followUpBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  chooseWorkspaceBtn: document.getElementById('chooseWorkspaceBtn'),
  revealWorkspaceBtn: document.getElementById('revealWorkspaceBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  resetBtn: document.getElementById('resetBtn'),
  settingsModal: document.getElementById('settingsModal'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  cancelSettingsBtn: document.getElementById('cancelSettingsBtn'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  apiBaseUrlInput: document.getElementById('apiBaseUrlInput'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  modelInput: document.getElementById('modelInput'),
  settingsThinkingLevelInput: document.getElementById('settingsThinkingLevelInput'),
  compatibilityPresetInput: document.getElementById('compatibilityPresetInput')
};

init();

async function init() {
  applyTheme(state.theme);
  applySidebarState();
  bindEvents();
  setInterval(renderSessions, 60_000);
  window.yolo.onAgentEvent(handleAgentEvent);

  try {
    const bootstrap = await window.yolo.bootstrap();
    state.settings = bootstrap.settings || {};
    state.homeBaseRoot = bootstrap.homeBaseRoot || '';
    state.workspaceRoot = bootstrap.workspaceRoot || '';
    applySessionPayload(bootstrap);
    renderMessagesFromHistory(bootstrap.active?.messages || []);
    renderChrome();
  } catch (error) {
    setStatus(error.message || 'Failed to load app');
  }
}

function bindEvents() {
  els.promptInput.spellcheck = false;
  els.promptInput.setAttribute('spellcheck', 'false');

  els.sendBtn.addEventListener('click', primaryAction);
  els.followUpBtn.addEventListener('click', () => queuePrompt('followUp'));
  els.cancelBtn.addEventListener('click', cancelRun);
  els.promptInput.addEventListener('input', () => {
    autoGrowPrompt();
    updateFilePickerFromCaret();
  });
  els.promptInput.addEventListener('paste', pastePlainText);
  els.promptInput.addEventListener('keydown', (event) => {
    if (handleFilePickerKeydown(event)) return;

    if (event.key === 'Escape' && state.busy) {
      event.preventDefault();
      cancelRun();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (state.busy && event.altKey) queuePrompt('followUp');
      else primaryAction();
    }
  });

  document.addEventListener('selectionchange', () => {
    if (document.activeElement === els.promptInput) updateFilePickerFromCaret();
  });

  document.addEventListener('mousedown', (event) => {
    if (!els.filePicker.contains(event.target) && !els.promptInput.contains(event.target)) hideFilePicker();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.busy && !els.promptInput.contains(event.target)) {
      event.preventDefault();
      cancelRun();
    }
  });

  bindExamplePrompts(document);

  els.newSessionBtn.addEventListener('click', createNewSession);
  if (els.collapseSidebarBtn) els.collapseSidebarBtn.addEventListener('click', toggleSidebar);
  if (els.sessionsPaneBtn) els.sessionsPaneBtn.addEventListener('click', openSessionsPane);
  if (els.closeSessionsBtn) els.closeSessionsBtn.addEventListener('click', closeSessionsPane);
  if (els.newSessionFromPaneBtn) els.newSessionFromPaneBtn.addEventListener('click', async () => {
    await createNewSession();
    closeSessionsPane();
  });
  if (els.skillsPaneBtn) els.skillsPaneBtn.addEventListener('click', openSkillsPane);
  if (els.logsBtn) els.logsBtn.addEventListener('click', openLogs);
  if (els.closeSkillsBtn) els.closeSkillsBtn.addEventListener('click', closeSkillsPane);
  if (els.refreshSkillsBtn) els.refreshSkillsBtn.addEventListener('click', loadSkillsPane);
  if (els.saveSkillDirsBtn) els.saveSkillDirsBtn.addEventListener('click', saveSkillDirs);
  if (els.sessionsModal) els.sessionsModal.addEventListener('mousedown', (event) => {
    if (event.target === els.sessionsModal) closeSessionsPane();
  });
  if (els.skillsModal) els.skillsModal.addEventListener('mousedown', (event) => {
    if (event.target === els.skillsModal) closeSkillsPane();
  });
  if (els.settingsModal) els.settingsModal.addEventListener('mousedown', (event) => {
    if (event.target === els.settingsModal) closeSettings();
  });

  els.chooseWorkspaceBtn.addEventListener('click', async () => {
    try {
      const result = await window.yolo.selectWorkspace();
      state.workspaceRoot = result.workspaceRoot || '';
      if (result.session) {
        state.activeSession = result.session;
        state.activeSessionId = result.session.id || state.activeSessionId;
      }
      state.sessions = state.sessions.map((session) => session.id === state.activeSessionId ? { ...session, title: 'New chat', workspaceRoot: state.workspaceRoot } : session);
      clearMessages();
      renderChrome();
    } catch (error) {
      addAssistantError(error);
    }
  });

  els.revealWorkspaceBtn.addEventListener('click', () => window.yolo.revealWorkspace());
  els.thinkingLevelSelect.addEventListener('change', updateSessionThinkingLevel);
  els.settingsBtn.addEventListener('click', openSettings);
  els.themeToggleBtn.addEventListener('click', toggleTheme);
  els.closeSettingsBtn.addEventListener('click', closeSettings);
  els.cancelSettingsBtn.addEventListener('click', closeSettings);

  els.saveSettingsBtn.addEventListener('click', saveSettings);
  els.resetBtn.addEventListener('click', async () => {
    if (state.busy) {
      await cancelRun();
      setStatus('Cancelling. Reset after it stops.');
      return;
    }

    const payload = await window.yolo.resetChat(state.activeSessionId);
    applySessionPayload(payload);
    state.currentAssistant = null;
    state.queues = { steering: [], followUp: [] };
    state.activeSession = { ...(state.activeSession || {}), title: 'New chat', busy: false };
    state.sessions = state.sessions.map((session) => session.id === state.activeSessionId ? { ...session, title: 'New chat', busy: false } : session);
    renderQueue();
    clearMessages();
    renderSessions();
    setStatus('Session reset');
  });
}

function bindExamplePrompts(root) {
  root.querySelectorAll('.example-prompt').forEach((button) => {
    button.addEventListener('click', () => {
      setPromptText(button.textContent.trim());
      autoGrowPrompt();
      focusPromptEnd();
    });
  });
}

function getPromptText() {
  const clone = els.promptInput.cloneNode(true);
  clone.querySelectorAll('.file-pill').forEach((pill) => {
    pill.replaceWith(document.createTextNode(`@${pill.dataset.path || pill.textContent || ''}`));
  });
  return extractEditorText(clone, clone).replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function extractEditorText(node, root) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (node.tagName === 'BR') return '\n';

  let text = '';
  node.childNodes.forEach((child) => {
    text += extractEditorText(child, root);
  });

  if (node !== root && ['DIV', 'P'].includes(node.tagName) && text && !text.endsWith('\n')) {
    text += '\n';
  }
  return text;
}

function setPromptText(text) {
  hideFilePicker();
  els.promptInput.textContent = String(text || '');
}

function clearPrompt() {
  hideFilePicker();
  els.promptInput.innerHTML = '';
}

function focusPromptEnd() {
  els.promptInput.focus();
  const range = document.createRange();
  range.selectNodeContents(els.promptInput);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function pastePlainText(event) {
  event.preventDefault();
  const text = event.clipboardData?.getData('text/plain') || '';
  insertTextAtCaret(text);
  autoGrowPrompt();
  updateFilePickerFromCaret();
}

function insertTextAtCaret(text) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function handleFilePickerKeydown(event) {
  if (!state.filePicker.open) return false;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const count = Math.max(1, state.filePicker.results.length);
    state.filePicker.selectedIndex = (state.filePicker.selectedIndex + direction + count) % count;
    renderFilePicker();
    return true;
  }

  if (event.key === 'Tab' || event.key === 'Enter') {
    event.preventDefault();
    const selected = state.filePicker.results[state.filePicker.selectedIndex];
    if (selected) {
      if (state.filePicker.mode === 'skill') insertSkillCommand(selected.name);
      else insertFilePill(selected.path);
    }
    return true;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    hideFilePicker();
    return true;
  }

  return false;
}

async function updateFilePickerFromCaret() {
  const mention = getActiveMention();
  if (mention) {
    await openPickerFromCaret({
      mode: 'file',
      anchor: mention,
      loadingLabel: 'Searching files…',
      emptyLabel: 'No matching files',
      load: () => window.yolo.fileSuggestions(state.activeSessionId, mention.query)
    });
    return;
  }

  const skillCommand = getActiveSkillCommand();
  if (skillCommand) {
    await openPickerFromCaret({
      mode: 'skill',
      anchor: skillCommand,
      loadingLabel: 'Loading skills…',
      emptyLabel: 'No matching skills',
      load: () => window.yolo.skillSuggestions(state.activeSessionId, skillCommand.query)
    });
    return;
  }

  hideFilePicker();
}

async function openPickerFromCaret({ mode, anchor, loadingLabel, emptyLabel, load }) {
  const requestId = state.filePicker.requestId + 1;
  state.filePicker = {
    ...state.filePicker,
    open: true,
    mode,
    query: anchor.query,
    results: [],
    selectedIndex: 0,
    anchor,
    emptyLabel,
    requestId
  };
  renderFilePicker([{ name: loadingLabel, type: 'hint' }]);

  try {
    const results = await load();
    if (state.filePicker.requestId !== requestId) return;
    state.filePicker.results = Array.isArray(results) ? results : [];
    state.filePicker.selectedIndex = 0;
    renderFilePicker();
  } catch {
    if (state.filePicker.requestId !== requestId) return;
    state.filePicker.results = [];
    renderFilePicker();
  }
}

function getActiveMention() {
  const selection = window.getSelection();
  if (!selection.rangeCount || document.activeElement !== els.promptInput) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !els.promptInput.contains(range.startContainer)) return null;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;

  const node = range.startContainer;
  const offset = range.startOffset;
  const before = node.textContent.slice(0, offset);
  const match = before.match(/(^|[\s([{])@([^\s@]*)$/);
  if (!match) return null;

  return {
    node,
    startOffset: offset - match[2].length - 1,
    endOffset: offset,
    query: match[2]
  };
}

function getActiveSkillCommand() {
  const selection = window.getSelection();
  if (!selection.rangeCount || document.activeElement !== els.promptInput) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !els.promptInput.contains(range.startContainer)) return null;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;

  const node = range.startContainer;
  const offset = range.startOffset;
  const before = node.textContent.slice(0, offset);
  const match = before.match(/(^|[\n\r])([ \t]*)\/skill(?::([^\s]*))?$/);
  if (!match) return null;

  const commandStart = (match.index || 0) + match[1].length;
  if (getEditorTextBefore(node, commandStart).trim()) return null;

  return {
    node,
    startOffset: commandStart,
    endOffset: offset,
    query: match[3] || ''
  };
}

function getEditorTextBefore(node, offset) {
  const range = document.createRange();
  range.setStart(els.promptInput, 0);
  range.setEnd(node, offset);
  const holder = document.createElement('div');
  holder.appendChild(range.cloneContents());
  return extractEditorText(holder, holder);
}

function renderFilePicker(overrideResults) {
  const results = overrideResults || state.filePicker.results;
  if (!state.filePicker.open) {
    els.filePicker.classList.add('hidden');
    els.filePicker.innerHTML = '';
    return;
  }

  els.filePicker.classList.remove('hidden');
  els.filePicker.dataset.mode = state.filePicker.mode || 'file';
  if (!results.length) {
    const label = state.filePicker.emptyLabel || (state.filePicker.mode === 'skill' ? 'No matching skills' : 'No matching files');
    els.filePicker.innerHTML = `<div class="file-picker-empty">${escapeHtml(label)}</div>`;
    return;
  }

  els.filePicker.innerHTML = '';
  results.forEach((item, index) => {
    if (item.type === 'hint') {
      const empty = document.createElement('div');
      empty.className = 'file-picker-empty';
      empty.textContent = item.name;
      els.filePicker.appendChild(empty);
      return;
    }

    const isSkill = state.filePicker.mode === 'skill';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `file-picker-item${isSkill ? ' skill-picker-item' : ''}${index === state.filePicker.selectedIndex ? ' active' : ''}`;
    button.innerHTML = isSkill ? `
      <span class="file-picker-type">skill</span>
      <span class="file-picker-path skill-picker-copy">
        <strong></strong>
        <small></small>
      </span>
      <span class="file-picker-hint">Tab</span>
    ` : `
      <span class="file-picker-type">${item.type === 'folder' ? 'folder' : 'file'}</span>
      <span class="file-picker-path"></span>
      <span class="file-picker-hint">Tab</span>
    `;

    if (isSkill) {
      button.querySelector('strong').textContent = `/skill:${item.name}`;
      button.querySelector('small').textContent = item.description || item.location || '';
    } else {
      button.querySelector('.file-picker-path').textContent = item.path;
    }

    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (isSkill) insertSkillCommand(item.name);
      else insertFilePill(item.path);
    });
    els.filePicker.appendChild(button);
  });
}

function hideFilePicker() {
  state.filePicker.open = false;
  state.filePicker.results = [];
  state.filePicker.anchor = null;
  state.filePicker.emptyLabel = '';
  if (els.filePicker) {
    els.filePicker.classList.add('hidden');
    els.filePicker.innerHTML = '';
    delete els.filePicker.dataset.mode;
  }
}

function insertFilePill(filePath) {
  const anchor = state.filePicker.anchor;
  if (!anchor?.node?.isConnected) return;

  const range = document.createRange();
  range.setStart(anchor.node, anchor.startOffset);
  range.setEnd(anchor.node, anchor.endOffset);
  range.deleteContents();

  const pill = document.createElement('span');
  pill.className = 'file-pill';
  pill.contentEditable = 'false';
  pill.dataset.path = filePath;
  pill.title = filePath;
  pill.textContent = `@ ${displayMentionName(filePath)}`;

  const space = document.createTextNode(' ');
  range.insertNode(pill);
  range.setStartAfter(pill);
  range.collapse(true);
  range.insertNode(space);
  range.setStartAfter(space);
  range.collapse(true);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  hideFilePicker();
  els.promptInput.focus();
  autoGrowPrompt();
}

function insertSkillCommand(skillName) {
  const anchor = state.filePicker.anchor;
  if (!anchor?.node?.isConnected || !skillName) return;

  const range = document.createRange();
  range.setStart(anchor.node, anchor.startOffset);
  range.setEnd(anchor.node, anchor.endOffset);
  range.deleteContents();

  const node = document.createTextNode(`/skill:${skillName} `);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  hideFilePicker();
  els.promptInput.focus();
  autoGrowPrompt();
}

function displayMentionName(filePath) {
  const normalized = String(filePath || '').replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).pop() || normalized || 'file';
}

function applySessionPayload(payload = {}) {
  state.sessions = payload.sessions || state.sessions || [];
  state.activeSessionId = payload.activeSessionId || state.activeSessionId || '';
  if (payload.active?.session) state.activeSession = payload.active.session;
  state.busy = !!payload.active?.busy;
  state.queues = payload.active?.queues || { steering: [], followUp: [] };
}

async function createNewSession() {
  try {
    const payload = await window.yolo.createSession();
    applySessionPayload(payload);
    state.currentAssistant = null;
    renderMessagesFromHistory(payload.active?.messages || []);
    renderChrome();
    setStatus('New session');
  } catch (error) {
    addAssistantError(error);
  }
}

async function selectSession(sessionId) {
  if (!sessionId) return false;
  if (sessionId === state.activeSessionId) return true;

  try {
    const payload = await window.yolo.selectSession(sessionId);
    applySessionPayload(payload);
    state.currentAssistant = null;
    renderMessagesFromHistory(payload.active?.messages || []);
    renderChrome();
    setStatus(state.busy ? 'Working…' : 'Ready');
    return true;
  } catch (error) {
    addAssistantError(error);
    return false;
  }
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem('yolo-sidebar-collapsed', String(state.sidebarCollapsed));
  applySidebarState();
}

function applySidebarState() {
  if (!els.appShell) return;
  els.appShell.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  if (els.collapseSidebarBtn) {
    els.collapseSidebarBtn.textContent = state.sidebarCollapsed ? '›' : '‹';
    els.collapseSidebarBtn.title = state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
    els.collapseSidebarBtn.setAttribute('aria-label', state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
    els.collapseSidebarBtn.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
  }
}

async function openSessionsPane() {
  if (!els.sessionsModal) return;
  els.sessionsModal.classList.remove('hidden');
  renderAllSessions();

  try {
    const payload = await window.yolo.listSessions();
    state.sessions = payload.sessions || state.sessions;
    state.activeSessionId = payload.activeSessionId || state.activeSessionId;
    renderSessions();
  } catch (error) {
    setStatus(error.message || 'Failed to load sessions');
  }
}

function closeSessionsPane() {
  if (els.sessionsModal) els.sessionsModal.classList.add('hidden');
}

async function openSkillsPane() {
  if (!els.skillsModal) return;
  els.skillsModal.classList.remove('hidden');
  await loadSkillsPane();
}

function closeSkillsPane() {
  if (els.skillsModal) els.skillsModal.classList.add('hidden');
}

async function loadSkillsPane() {
  if (!els.skillsList) return;
  state.skills = { ...state.skills, loading: true, error: '' };
  renderSkillsPane();

  try {
    const payload = await window.yolo.listSkills(state.activeSessionId);
    state.skills = {
      skills: payload.skills || [],
      diagnostics: payload.diagnostics || [],
      extraDirs: payload.extraDirs || [],
      loading: false,
      error: ''
    };
  } catch (error) {
    state.skills = { ...state.skills, loading: false, error: error.message || 'Failed to load skills' };
  }

  renderSkillsPane();
}

function renderSkillsPane() {
  if (!els.skillsList) return;

  if (els.skillsExtraDirsInput && document.activeElement !== els.skillsExtraDirsInput) {
    els.skillsExtraDirsInput.value = (state.skills.extraDirs || []).join('\n');
  }

  const diagnostics = state.skills.diagnostics || [];
  if (els.skillsStatus) {
    if (state.skills.loading) els.skillsStatus.textContent = 'Loading skills…';
    else if (state.skills.error) els.skillsStatus.textContent = state.skills.error;
    else els.skillsStatus.textContent = `${state.skills.skills.length} skills available${diagnostics.length ? ` · ${diagnostics.length} notices` : ''}`;
    els.skillsStatus.classList.toggle('error-text', !!state.skills.error);
  }

  if (state.skills.loading) {
    els.skillsList.innerHTML = '<div class="sessions-empty">Loading skills…</div>';
    return;
  }

  if (state.skills.error) {
    els.skillsList.innerHTML = `<div class="sessions-empty">${escapeHtml(state.skills.error)}</div>`;
    return;
  }

  if (!state.skills.skills.length) {
    els.skillsList.innerHTML = '<div class="sessions-empty">No skills found</div>';
    return;
  }

  els.skillsList.innerHTML = '';
  for (const skill of state.skills.skills) {
    els.skillsList.appendChild(createSkillManageItem(skill));
  }
}

function createSkillManageItem(skill) {
  const item = document.createElement('div');
  item.className = `skill-manage-item${skill.enabled === false ? ' disabled' : ''}`;

  const copy = document.createElement('div');
  copy.className = 'skill-manage-copy';

  const title = document.createElement('div');
  title.className = 'skill-manage-title';
  title.textContent = skill.name || 'skill';

  const description = document.createElement('div');
  description.className = 'skill-manage-description';
  description.textContent = skill.description || 'No description';

  const meta = document.createElement('div');
  meta.className = 'skill-manage-meta';
  meta.textContent = [skill.source, skill.disableModelInvocation ? 'manual only' : '', skill.location].filter(Boolean).join(' · ');
  if (skill.location) meta.title = skill.location;

  copy.appendChild(title);
  copy.appendChild(description);
  copy.appendChild(meta);

  const toggle = document.createElement('label');
  toggle.className = 'toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = skill.enabled !== false;
  input.disabled = state.busy;
  input.addEventListener('change', () => setSkillEnabled(skill.name, input.checked));
  const slider = document.createElement('span');
  slider.className = 'toggle-slider';
  toggle.appendChild(input);
  toggle.appendChild(slider);

  item.appendChild(copy);
  item.appendChild(toggle);
  return item;
}

async function setSkillEnabled(skillName, enabled) {
  try {
    state.skills = { ...state.skills, loading: true, error: '' };
    renderSkillsPane();
    const payload = await window.yolo.setSkillEnabled(state.activeSessionId, skillName, enabled);
    state.skills = {
      skills: payload.skills || [],
      diagnostics: payload.diagnostics || [],
      extraDirs: payload.extraDirs || [],
      loading: false,
      error: ''
    };
    renderSkillsPane();
    setStatus(`${skillName} ${enabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    state.skills = { ...state.skills, loading: false, error: error.message || 'Failed to update skill' };
    renderSkillsPane();
  }
}

async function saveSkillDirs() {
  if (!els.skillsExtraDirsInput) return;
  const extraDirs = uniqueLines(els.skillsExtraDirsInput.value);

  try {
    state.skills = { ...state.skills, loading: true, error: '' };
    renderSkillsPane();
    const payload = await window.yolo.setExtraSkillDirs(state.activeSessionId, extraDirs);
    state.skills = {
      skills: payload.skills || [],
      diagnostics: payload.diagnostics || [],
      extraDirs: payload.extraDirs || [],
      loading: false,
      error: ''
    };
    renderSkillsPane();
    setStatus('Skill folders saved');
  } catch (error) {
    state.skills = { ...state.skills, loading: false, error: error.message || 'Failed to save skill folders' };
    renderSkillsPane();
  }
}

function uniqueLines(value) {
  const seen = new Set();
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || seen.has(line)) return false;
      seen.add(line);
      return true;
    });
}

function getActiveThinkingLevel() {
  return normalizeThinkingLevel(state.activeSession?.thinkingLevel || state.settings.thinkingLevel);
}

function normalizeThinkingLevel(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!raw || raw === 'none' || raw === 'off' || raw === 'no') return 'none';
  if (raw === 'xhigh' || raw === 'extrahigh' || raw === 'veryhigh') return 'xhigh';
  return THINKING_LEVELS.includes(raw) ? raw : 'none';
}

function displayThinkingLevel(value) {
  const level = normalizeThinkingLevel(value);
  return level === 'none' ? 'None' : level;
}

function normalizeCompatibilityPreset(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (raw === 'local' || raw === 'basic' || raw === 'localbasic') return 'local-basic';
  if (raw === 'open-ai' || raw === 'default') return 'openai';
  return raw === 'local-basic' ? 'local-basic' : 'openai';
}

function displayCompatibilityPreset(value) {
  return normalizeCompatibilityPreset(value) === 'local-basic' ? 'local basic' : 'openai';
}

function renderChrome() {
  applyTheme(state.theme);
  updateBusyUi();
  renderQueue();
  renderSessions();

  const activeWorkspace = state.activeSession?.workspaceRoot || state.workspaceRoot || state.homeBaseRoot;
  const workspaceTitle = displayWorkspaceName(activeWorkspace);
  if (activeWorkspace) {
    if (els.workspacePath) {
      els.workspacePath.textContent = activeWorkspace;
      els.workspacePath.title = activeWorkspace;
      els.workspacePath.classList.remove('empty');
    }
    if (els.chatWorkspaceName) els.chatWorkspaceName.textContent = workspaceTitle;
    if (els.chatWorkspacePath) els.chatWorkspacePath.textContent = activeWorkspace;
  } else {
    if (els.workspacePath) {
      els.workspacePath.textContent = 'workspace';
      els.workspacePath.classList.add('empty');
    }
    if (els.chatWorkspaceName) els.chatWorkspaceName.textContent = 'workspace';
    if (els.chatWorkspacePath) els.chatWorkspacePath.textContent = 'No folder selected';
  }

  const thinkingLevel = getActiveThinkingLevel();
  if (els.thinkingLevelSelect) els.thinkingLevelSelect.value = thinkingLevel;

  if (state.settings.model) {
    if (els.modelName) {
      els.modelName.textContent = state.settings.model;
      els.modelName.classList.remove('empty');
    }
    if (els.connectionChip) {
      els.connectionChip.textContent = `${state.settings.model} · think ${displayThinkingLevel(thinkingLevel)} · ${displayCompatibilityPreset(state.settings.compatibilityPreset)}`;
      els.connectionChip.classList.remove('muted');
    }
  } else {
    if (els.modelName) {
      els.modelName.textContent = 'Not configured';
      els.modelName.classList.add('empty');
    }
    if (els.connectionChip) {
      els.connectionChip.textContent = 'configure model';
      els.connectionChip.classList.add('muted');
    }
  }
}

function displayWorkspaceName(folderPath) {
  if (!folderPath) return 'workspace';
  const normalized = String(folderPath).replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized || 'Selected folder';
}

function samePath(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();
}

function getSessionsNewestFirst() {
  return [...state.sessions].sort((a, b) => {
    const bTime = new Date(b?.updatedAt || b?.createdAt || 0).getTime() || 0;
    const aTime = new Date(a?.updatedAt || a?.createdAt || 0).getTime() || 0;
    return bTime - aTime;
  });
}

function renderSessions() {
  if (!els.sessionsList) return;

  const recentSessions = getSessionsNewestFirst().slice(0, RECENT_SESSION_LIMIT);
  if (!recentSessions.length) {
    els.sessionsList.innerHTML = '<div class="sessions-empty">No sessions yet</div>';
    renderAllSessions();
    return;
  }

  els.sessionsList.innerHTML = '';
  for (const session of recentSessions) {
    els.sessionsList.appendChild(createSessionItem(session));
  }
  renderAllSessions();
}

function renderAllSessions() {
  if (!els.allSessionsList) return;

  if (!state.sessions.length) {
    els.allSessionsList.innerHTML = '<div class="sessions-empty">No sessions yet</div>';
    return;
  }

  els.allSessionsList.innerHTML = '';
  for (const session of getSessionsNewestFirst()) {
    els.allSessionsList.appendChild(createSessionItem(session, { showWorkspace: true, closeOnSelect: true }));
  }
}

function createSessionItem(session, { showWorkspace = false, closeOnSelect = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `session-item${session.id === state.activeSessionId ? ' active' : ''}`;
  button.dataset.sessionId = session.id;

  const title = document.createElement('div');
  title.className = 'session-item-title';
  title.textContent = session.title || 'New chat';

  const meta = document.createElement('div');
  meta.className = `session-item-meta${session.busy ? ' running' : ''}`;
  const metaParts = [session.busy ? 'running' : formatSessionTime(session.updatedAt)];
  if (showWorkspace && session.workspaceRoot) metaParts.push(displayWorkspaceName(session.workspaceRoot));
  meta.textContent = metaParts.filter(Boolean).join(' · ');

  button.appendChild(title);
  button.appendChild(meta);
  button.addEventListener('click', async () => {
    const selected = await selectSession(session.id);
    if (selected && closeOnSelect) closeSessionsPane();
  });
  return button;
}

function formatSessionTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return '';

  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w ago`;
  const years = Math.floor(weeks / 52);
  return `${years}y ago`;
}

function updateBusyUi() {
  const label = els.sendBtn.querySelector('span');
  if (label) label.textContent = state.busy ? 'Steer' : 'Send';
  els.followUpBtn.classList.toggle('hidden', !state.busy);
  els.cancelBtn.classList.toggle('hidden', !state.busy);
  if (!state.busy) els.cancelBtn.disabled = false;
  if (els.skillsModal && !els.skillsModal.classList.contains('hidden')) renderSkillsPane();
}

async function primaryAction() {
  const text = getPromptText().trim();
  if (isStopCommand(text)) {
    clearPrompt();
    autoGrowPrompt();
    if (state.busy) return cancelRun();
    setStatus('No active run to stop');
    return;
  }
  if (state.busy) return queuePrompt('steer');
  return sendPrompt(text);
}

async function sendPrompt(providedText) {
  const text = (providedText ?? getPromptText()).trim();
  if (!text || state.busy) return;

  const runSessionId = state.activeSessionId;
  state.busy = true;
  updateBusyUi();
  clearPrompt();
  autoGrowPrompt();
  setStatus('Thinking…');

  removeWelcome();
  addMessage('user', text);
  state.currentAssistant = addAssistantShell();

  try {
    updateLocalSessionAfterSend(text, runSessionId);
    const response = await window.yolo.sendMessage(runSessionId, text);
    if (state.activeSessionId === runSessionId && response?.content && state.currentAssistant && isAssistantShellEmpty(state.currentAssistant)) {
      state.currentAssistant.content.innerHTML = renderText(response.content || '(no response)');
    }
  } catch (error) {
    if (state.activeSessionId === runSessionId) {
      ensureAssistantShell().content.innerHTML = `<span class="error-text">${escapeHtml(displayError(error))}</span>`;
      setStatus('Error');
    }
  } finally {
    state.sessions = state.sessions.map((session) => session.id === runSessionId ? { ...session, busy: false } : session);
    if (state.activeSessionId === runSessionId) {
      state.busy = false;
      state.currentAssistant = null;
      updateBusyUi();
      if (!els.statusText.textContent || ['Thinking…', 'Working…', 'Cancelling…'].includes(els.statusText.textContent)) setStatus('Ready');
      scrollToBottom();
    }
    renderSessions();
  }
}

function updateLocalSessionAfterSend(text, sessionId = state.activeSessionId) {
  if (!sessionId) return;
  const title = makeSessionTitle(text);
  state.sessions = state.sessions.map((session) => {
    if (session.id !== sessionId) return session;
    const nextTitle = session.title === 'New chat' ? title : session.title;
    const next = { ...session, title: nextTitle, busy: true, updatedAt: new Date().toISOString() };
    if (sessionId === state.activeSessionId) state.activeSession = next;
    return next;
  });
  renderSessions();
}

function makeSessionTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 48 ? `${clean.slice(0, 45)}…` : clean;
}

function isStopCommand(text) {
  const normalized = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?！？…,，。;；:：'"’”)]*$/u, '')
    .replace(/\s+/g, ' ');
  return new Set(['/stop', 'stop', '/abort', 'abort', '/cancel', 'cancel', 'esc', 'escape']).has(normalized);
}

async function queuePrompt(mode) {
  const text = getPromptText().trim();
  if (!text || !state.busy) return;

  if (isStopCommand(text)) {
    clearPrompt();
    autoGrowPrompt();
    await cancelRun();
    return;
  }

  clearPrompt();
  autoGrowPrompt();
  setStatus(mode === 'followUp' ? 'Queueing follow-up…' : 'Queueing steering…');

  try {
    if (mode === 'followUp') await window.yolo.followUp(state.activeSessionId, text);
    else await window.yolo.steer(state.activeSessionId, text);
  } catch (error) {
    setPromptText(text);
    autoGrowPrompt();
    addAssistantError(error);
  }
}

async function updateSessionThinkingLevel() {
  const level = normalizeThinkingLevel(els.thinkingLevelSelect.value);
  if (!state.activeSessionId) return;

  try {
    const payload = await window.yolo.setSessionThinkingLevel(state.activeSessionId, level);
    applySessionPayload(payload);
    renderChrome();
    setStatus(`Thinking: ${displayThinkingLevel(level)}`);
  } catch (error) {
    els.thinkingLevelSelect.value = getActiveThinkingLevel();
    addAssistantError(error);
  }
}

async function cancelRun() {
  if (!state.busy) return;
  els.cancelBtn.disabled = true;
  setStatus('Cancelling…');

  try {
    const result = await window.yolo.cancelRun(state.activeSessionId);
    restoreQueuedToEditor(result?.queued);
  } catch (error) {
    els.cancelBtn.disabled = false;
    addAssistantError(error);
  }
}

function restoreQueuedToEditor(queued) {
  const messages = [
    ...(queued?.steering || []),
    ...(queued?.followUp || [])
  ];
  if (messages.length === 0) return;

  const restored = messages.join('\n\n');
  const current = getPromptText().trim();
  setPromptText(current ? `${current}\n\n${restored}` : restored);
  autoGrowPrompt();
  focusPromptEnd();
}

function addMessage(role, content) {
  const message = document.createElement('article');
  message.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'you' : 'ya';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const contentEl = document.createElement('div');
  contentEl.className = 'content';
  contentEl.innerHTML = renderText(content);

  bubble.appendChild(contentEl);
  message.appendChild(avatar);
  message.appendChild(bubble);
  els.messages.appendChild(message);
  scrollToBottom();
  return { message, bubble, content: contentEl };
}

function addSkillMessage(skillBlock) {
  const message = document.createElement('article');
  message.className = 'message skill';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = 'sk';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const contentEl = document.createElement('div');
  contentEl.className = 'content';

  const title = document.createElement('div');
  title.className = 'skill-title';
  title.textContent = `Skill used: ${skillBlock.name || 'skill'}`;
  contentEl.appendChild(title);

  if (skillBlock.location) {
    const meta = document.createElement('div');
    meta.className = 'skill-meta';
    meta.textContent = skillBlock.location;
    contentEl.appendChild(meta);
  }

  bubble.appendChild(contentEl);
  message.appendChild(avatar);
  message.appendChild(bubble);
  els.messages.appendChild(message);
  scrollToBottom();
  return { message, bubble, content: contentEl };
}

function addAssistantShell() {
  const message = document.createElement('article');
  message.className = 'message assistant';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = 'ya';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const activity = document.createElement('div');
  activity.className = 'activity';

  const content = document.createElement('div');
  content.className = 'content';

  bubble.appendChild(activity);
  bubble.appendChild(content);
  message.appendChild(avatar);
  message.appendChild(bubble);
  els.messages.appendChild(message);
  scrollToBottom();

  return { message, bubble, activity, content, tools: new Map() };
}

function ensureAssistantShell() {
  if (!state.currentAssistant) state.currentAssistant = addAssistantShell();
  return state.currentAssistant;
}

function isAssistantShellEmpty(shell) {
  return !shell.content.textContent.trim() && shell.activity.childElementCount === 0;
}

function addAssistantError(error) {
  removeWelcome();
  addMessage('assistant', `Error: ${displayError(error)}`);
}

function displayError(error) {
  const message = error?.message || String(error);
  return message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
    .replace(/^Error:\s*/, '');
}

function handleAgentEvent(event) {
  if (!event) return;

  if (event.type === 'sessions:update') {
    state.sessions = event.sessions || [];
    const active = state.sessions.find((session) => session.id === state.activeSessionId);
    if (active) {
      state.activeSession = active;
      state.busy = !!active.busy;
      updateBusyUi();
    }
    renderSessions();
    return;
  }

  if (event.sessionId && event.sessionId !== state.activeSessionId) {
    return;
  }

  if (event.type === 'status') {
    setStatus(event.message || 'Ready');
    return;
  }

  if (event.type === 'queue:update') {
    state.queues = {
      steering: event.steering || [],
      followUp: event.followUp || []
    };
    renderQueue();
    return;
  }

  if (event.type === 'assistant:content') {
    const shell = ensureAssistantShell();
    shell.content.innerHTML = renderText(event.content || '(no response)');
    scrollToBottom();
    return;
  }

  if (event.type === 'user:delivered') {
    if (state.currentAssistant && isAssistantShellEmpty(state.currentAssistant)) {
      state.currentAssistant.message.remove();
    }
    addMessage('user', event.text || '');
    state.currentAssistant = addAssistantShell();
    return;
  }

  if (event.type === 'skill:used') {
    const shell = ensureAssistantShell();
    shell.activity.appendChild(createSkillActivityItem(event));
    scrollToBottom();
    return;
  }

  if (event.type === 'tool:start') {
    const shell = ensureAssistantShell();
    const item = createToolItem(event);
    shell.tools.set(event.id, item);
    shell.activity.appendChild(item.root);
    scrollToBottom();
  }

  if (event.type === 'tool:result') {
    const shell = ensureAssistantShell();
    const item = shell.tools.get(event.id) || createToolItem(event);
    if (!shell.tools.has(event.id)) {
      shell.tools.set(event.id, item);
      shell.activity.appendChild(item.root);
    }
    const ok = event.result?.ok !== false;
    item.root.classList.remove('pending');
    item.root.classList.add(ok ? 'ok' : 'error');
    item.summary.textContent = compactToolLabel(event.name, event.args, event.result?.summary || (ok ? 'Completed' : 'Failed'));
    if (event.result?.preview) {
      item.root.classList.add('has-preview');
      item.root.title = 'Click to show or hide tool output';
      item.preview.textContent = event.result.preview;
    }
    scrollToBottom();
  }
}

function renderQueue() {
  const items = [
    ...state.queues.steering.map((text) => ({ label: 'steer queued', text })),
    ...state.queues.followUp.map((text) => ({ label: 'follow-up queued', text }))
  ];

  if (items.length === 0) {
    els.queuePanel.classList.add('hidden');
    els.queuePanel.innerHTML = '';
    return;
  }

  els.queuePanel.classList.remove('hidden');
  els.queuePanel.innerHTML = items.map((item) => `
    <div class="queue-chip"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.text)}</span></div>
  `).join('');
}

function createToolItem(event) {
  const root = document.createElement('div');
  root.className = 'tool-item pending';

  const head = document.createElement('div');
  head.className = 'tool-head';

  const pill = document.createElement('span');
  pill.className = 'tool-pill';

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = 'Tool Call:';

  const summary = document.createElement('span');
  summary.className = 'tool-summary';
  summary.textContent = compactToolLabel(event.name, event.args);

  head.appendChild(pill);
  head.appendChild(name);
  head.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'tool-body';
  const preview = document.createElement('pre');
  body.appendChild(preview);

  root.appendChild(head);
  root.appendChild(body);
  head.addEventListener('click', () => {
    if (root.classList.contains('has-preview')) root.classList.toggle('expanded');
  });

  return { root, summary, preview };
}

function createSkillActivityItem(event) {
  const root = document.createElement('div');
  root.className = 'tool-item skill ok';

  const head = document.createElement('div');
  head.className = 'tool-head';

  const pill = document.createElement('span');
  pill.className = 'tool-pill';

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = 'Skill:';

  const summary = document.createElement('span');
  summary.className = 'tool-summary';
  summary.textContent = [event.name || 'skill', event.source ? `(${event.source})` : ''].filter(Boolean).join(' ');

  head.appendChild(pill);
  head.appendChild(name);
  head.appendChild(summary);
  root.appendChild(head);

  if (event.location) {
    const body = document.createElement('div');
    body.className = 'tool-body';
    const preview = document.createElement('pre');
    preview.textContent = event.location;
    body.appendChild(preview);
    root.appendChild(body);
    root.classList.add('has-preview');
    root.title = 'Click to show skill location';
    head.addEventListener('click', () => root.classList.toggle('expanded'));
  }

  return root;
}

function compactToolLabel(name, args = {}, resultSummary = '') {
  const action = displayToolName(name);
  const detail = summarizeArgs(name, args);
  const left = [action, detail].filter(Boolean).join(': ');
  return resultSummary ? `${left || action} — ${resultSummary}` : left || action;
}

function displayToolName(name) {
  if (name === 'read') return 'inspect';
  if (name === 'write') return 'create';
  if (name === 'edit') return 'update';
  if (name === 'bash') return 'run';
  if (name === 'grep') return 'search files';
  if (name === 'find') return 'find files';
  if (name === 'ls') return 'list files';
  if (name === 'web_fetch') return 'web fetch';
  if (name === 'web_search') return 'web search';
  if (name === 'get_web') return 'get web';
  if (name === 'browser') return 'browser';
  if (name === 'exec') return 'run';
  return name || 'action';
}

function summarizeArgs(name, args = {}) {
  if (name === 'read') return args.path || '';
  if (name === 'write') return args.path || '';
  if (name === 'edit') return `${args.path || ''} (${Array.isArray(args.edits) ? args.edits.length : 0} changes)`;
  if (name === 'bash') return args.command || '';
  if (name === 'grep') return [args.pattern, args.path || args.glob || ''].filter(Boolean).join(' in ');
  if (name === 'find') return [args.pattern, args.path || ''].filter(Boolean).join(' in ');
  if (name === 'ls') return args.path || '.';
  if (name === 'web_fetch') return args.url || '';
  if (name === 'web_search') return args.query || '';
  if (name === 'get_web') return args.url || args.query || '';
  if (name === 'browser') return [args.action, args.label || args.targetId || args.url || args.ref || ''].filter(Boolean).join(' ');
  if (name === 'exec') return args.command || '';
  return '';
}

function openSettings() {
  els.apiBaseUrlInput.value = state.settings.apiBaseUrl || '';
  els.apiKeyInput.value = state.settings.apiKey || '';
  els.modelInput.value = state.settings.model || '';
  els.settingsThinkingLevelInput.value = normalizeThinkingLevel(state.settings.thinkingLevel);
  if (els.compatibilityPresetInput) els.compatibilityPresetInput.value = normalizeCompatibilityPreset(state.settings.compatibilityPreset);
  els.settingsModal.classList.remove('hidden');
  els.apiBaseUrlInput.focus();
}

async function openLogs() {
  try {
    const result = await window.yolo.openLogs();
    setStatus(result?.logPath ? `Opened logs: ${result.logPath}` : 'Opened logs');
  } catch (error) {
    addAssistantError(error);
  }
}

function closeSettings() {
  els.settingsModal.classList.add('hidden');
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
}

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem('yolo-theme', state.theme);

  if (els.themeToggleBtn) {
    const isLight = state.theme === 'light';
    els.themeToggleBtn.textContent = isLight ? '☀ Light' : '☾ Dark';
    els.themeToggleBtn.setAttribute('aria-pressed', String(isLight));
  }
}

async function saveSettings() {
  const next = {
    apiBaseUrl: els.apiBaseUrlInput.value.trim(),
    apiKey: els.apiKeyInput.value.trim(),
    model: els.modelInput.value.trim(),
    thinkingLevel: normalizeThinkingLevel(els.settingsThinkingLevelInput.value),
    compatibilityPreset: normalizeCompatibilityPreset(els.compatibilityPresetInput?.value)
  };

  try {
    state.settings = await window.yolo.saveSettings(next);
    renderChrome();
    closeSettings();
    setStatus('Settings saved');
  } catch (error) {
    setStatus(error.message || 'Failed to save settings');
  }
}

function autoGrowPrompt() {
  els.promptInput.style.height = 'auto';
  els.promptInput.style.height = `${Math.min(180, Math.max(42, els.promptInput.scrollHeight))}px`;
}

function setStatus(message) {
  els.statusText.textContent = message || 'Ready';
}

function parseSkillBlock(text) {
  const match = String(text || '').match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    userMessage: match[4]?.trim() || undefined
  };
}

function renderMessagesFromHistory(messages = []) {
  els.messages.innerHTML = '';
  state.currentAssistant = null;

  let displayed = 0;
  let lastDisplayRole = '';
  for (const message of messages) {
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      const skillBlock = parseSkillBlock(message.content);
      if (skillBlock) {
        addSkillMessage(skillBlock);
        displayed += 1;
        lastDisplayRole = 'skill';
        if (skillBlock.userMessage) {
          addMessage('user', skillBlock.userMessage);
          displayed += 1;
          lastDisplayRole = 'user';
        }
      } else {
        addMessage('user', message.content);
        displayed += 1;
        lastDisplayRole = 'user';
      }
    } else if (message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
      addMessage('assistant', message.content);
      displayed += 1;
      lastDisplayRole = 'assistant';
    }
  }

  if (displayed === 0) {
    clearMessages();
    return;
  }

  if (state.busy && lastDisplayRole !== 'assistant') {
    state.currentAssistant = addAssistantShell();
  }

  scrollToBottom();
}

function clearMessages() {
  els.messages.innerHTML = '';
  const welcome = document.createElement('div');
  welcome.className = 'welcome-card';
  welcome.innerHTML = `
    <div class="welcome-kicker">ready</div>
    <h2>New session.</h2>
    <p>Ask YOLO Auto anything, or choose a folder below when you want it to work on files somewhere on your computer.</p>
    <div class="example-grid">
      <button class="example-prompt">Clean up this folder and group files by type.</button>
      <button class="example-prompt">Summarize the documents here into a short notes file.</button>
      <button class="example-prompt">Rename these photos with dates and make a shareable zip.</button>
    </div>
  `;
  els.messages.appendChild(welcome);
  bindExamplePrompts(welcome);
}

function removeWelcome() {
  const welcome = els.messages.querySelector('.welcome-card');
  if (welcome) welcome.remove();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    els.messages.scrollTop = els.messages.scrollHeight;
  });
}

function renderText(text) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) return '';

  const codeBlocks = [];
  const withTokens = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, language, code) => {
    const token = `@@CODE_BLOCK_${codeBlocks.length}@@`;
    const className = language.trim() ? ` class="language-${escapeHtml(language.trim())}"` : '';
    codeBlocks.push(`<pre><code${className}>${escapeHtml(code.replace(/^\n/, '').replace(/\n$/, ''))}</code></pre>`);
    return `\n${token}\n`;
  });

  return renderMarkdownBlocks(withTokens)
    .replace(/@@CODE_BLOCK_(\d+)@@/g, (_match, index) => codeBlocks[Number(index)] || '');
}

function renderMarkdownBlocks(markdown) {
  const lines = markdown.split('\n');
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const codeToken = trimmed.match(/^@@CODE_BLOCK_\d+@@$/);
    if (codeToken) {
      html.push(trimmed);
      index += 1;
      continue;
    }

    const table = parseMarkdownTable(lines, index);
    if (table) {
      html.push(renderMarkdownTable(table));
      index = table.nextIndex;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdownBlocks(quote.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*+]\s+/, ''));
        index += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+[.)]\s+/, ''));
        index += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ol>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index].trim(), lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${renderInlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  return html.join('');
}

function parseMarkdownTable(lines, startIndex) {
  if (startIndex + 1 >= lines.length) return null;

  const headers = splitMarkdownTableRow(lines[startIndex]);
  if (!headers || headers.length === 0) return null;

  const aligns = parseMarkdownTableDivider(lines[startIndex + 1], headers.length);
  if (!aligns) return null;

  const columnCount = headers.length;
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].trim()) {
    const cells = splitMarkdownTableRow(lines[index]);
    if (!cells) break;
    rows.push(normalizeMarkdownTableCells(cells, columnCount));
    index += 1;
  }

  return {
    headers: normalizeMarkdownTableCells(headers, columnCount),
    aligns,
    rows,
    nextIndex: index
  };
}

function parseMarkdownTableDivider(line, expectedColumns) {
  const cells = splitMarkdownTableRow(line);
  if (!cells || cells.length !== expectedColumns) return null;

  const aligns = [];
  for (const cell of cells) {
    const marker = cell.replace(/\s+/g, '');
    if (!/^:?-{3,}:?$/.test(marker)) return null;

    if (marker.startsWith(':') && marker.endsWith(':')) aligns.push('center');
    else if (marker.endsWith(':')) aligns.push('right');
    else if (marker.startsWith(':')) aligns.push('left');
    else aligns.push('');
  }
  return aligns;
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.includes('|')) return null;

  let value = trimmed;
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);

  const cells = [];
  let cell = '';
  let inCode = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === '\\' && value[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }

    if (char === '`') {
      inCode = !inCode;
      cell += char;
      continue;
    }

    if (char === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }

    cell += char;
  }

  cells.push(cell.trim());
  return cells;
}

function normalizeMarkdownTableCells(cells, columnCount) {
  const normalized = cells.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push('');
  return normalized;
}

function renderMarkdownTable(table) {
  const head = table.headers
    .map((cell, index) => renderMarkdownTableCell('th', cell, table.aligns[index]))
    .join('');
  const body = table.rows
    .map((row) => `<tr>${row.map((cell, index) => renderMarkdownTableCell('td', cell, table.aligns[index])).join('')}</tr>`)
    .join('');

  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>`;
}

function renderMarkdownTableCell(tag, cell, align) {
  const className = align ? ` class="align-${align}"` : '';
  return `<${tag}${className}>${renderInlineMarkdown(cell)}</${tag}>`;
}

function isMarkdownBlockStart(trimmed, lines, index) {
  return /^@@CODE_BLOCK_\d+@@$/.test(trimmed)
    || parseMarkdownTable(lines || [], index || 0)
    || /^(#{1,6})\s+/.test(trimmed)
    || /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || /^[-*+]\s+/.test(trimmed)
    || /^\d+[.)]\s+/.test(trimmed);
}

function renderInlineMarkdown(value) {
  const inlineCode = [];
  let html = escapeHtml(value);

  html = html.replace(/`([^`]+)`/g, (_match, code) => {
    const token = `@@INLINE_CODE_${inlineCode.length}@@`;
    inlineCode.push(`<code>${code}</code>`);
    return token;
  });

  html = html.replace(/\[([^\]]+)]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, label, rawUrl) => {
    const href = sanitizeMarkdownUrl(rawUrl);
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>`;
  });

  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');

  return html.replace(/@@INLINE_CODE_(\d+)@@/g, (_match, index) => inlineCode[Number(index)] || '');
}

function sanitizeMarkdownUrl(value) {
  const url = String(value || '').replaceAll('&amp;', '&').replaceAll('&quot;', '').trim();
  if (/^(https?:|mailto:|#)/i.test(url)) return url;
  return '#';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
