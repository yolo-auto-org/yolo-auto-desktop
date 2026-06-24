const THINKING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'];
const FALLBACK_TOOL_DEFINITIONS = [
  { name: 'read', label: 'Read files', group: 'Filesystem read', description: 'Read text files and supported images from the workspace.' },
  { name: 'grep', label: 'Search file text', group: 'Filesystem read', description: 'Search file contents for matching text.' },
  { name: 'find', label: 'Find files', group: 'Filesystem read', description: 'Find files and folders by path/name.' },
  { name: 'ls', label: 'List folders', group: 'Filesystem read', description: 'List directory contents.' },
  { name: 'write', label: 'Write files', group: 'Filesystem write', description: 'Create or overwrite files.' },
  { name: 'edit', label: 'Edit files', group: 'Filesystem write', description: 'Patch existing files with exact text replacements.' },
  { name: 'bash', label: 'Shell / exec', group: 'Shell', description: 'Run terminal commands through the AI bash tool.' },
  { name: 'web_search', label: 'Web search', group: 'Web', description: 'Search the web for titles, URLs, and snippets.' },
  { name: 'web_fetch', label: 'Web fetch', group: 'Web', description: 'Fetch one URL and return cleaned readable text/markdown.' },
  { name: 'get_web', label: 'Get web compatibility', group: 'Web', description: 'Compatibility wrapper for web_search/web_fetch. Disabled automatically unless both are enabled.' },
  { name: 'browser', label: 'Browser automation', group: 'Browser', description: 'Open live pages and interact with visible controls.' }
];
const RECENT_SESSION_LIMIT = 5;
const BOTTOM_SCROLL_THRESHOLD = 32;
const AUTO_SCROLL_SETTLE_FRAMES = 4;
const AUTO_SCROLL_INTERACTION_PAUSE_MS = 900;
const AUTO_SCROLL_PROGRAMMATIC_RESET_MS = 80;
const SESSION_REVIEW_STORAGE_KEY = 'yolo-session-reviews';
const SESSION_REVIEW_LIMIT = 500;
const DEFAULT_COMPACTION_SETTINGS = Object.freeze({ enabled: true, reserveTokens: 32_000, keepRecentTokens: 20_000 });
const CHAT_HISTORY_PAGE_SIZE = 80;
const MESSAGE_TEXT_COLLAPSE_CHARS = 24_000;
const THINKING_TEXT_COLLAPSE_CHARS = 12_000;
const MESSAGE_PREVIEW_HEAD_CHARS = 12_000;
const MESSAGE_PREVIEW_TAIL_CHARS = 6_000;

const state = {
  settings: {},
  homeBaseRoot: '',
  workspaceRoot: '',
  sessions: [],
  sessionReviews: loadSessionReviews(),
  reviewBaselineReady: false,
  activeSessionId: '',
  activeSession: null,
  busy: false,
  currentAssistant: null,
  stickToBottom: true,
  autoScroll: {
    frameId: 0,
    framesRemaining: 0,
    force: false,
    pendingSticky: false,
    programmatic: false,
    programmaticTimer: 0,
    userInteracting: false,
    interactionTimer: 0
  },
  chatRender: {
    items: [],
    renderedStart: 0,
    partialAssistantText: '',
    partialAssistantThinkingText: '',
    renderingHistory: false
  },
  queues: { steering: [], followUp: [] },
  concurrency: { maxConcurrency: 2, runningCount: 0, runningSessions: [], canStart: true, pendingText: '' },
  skills: { skills: [], diagnostics: [], extraDirs: [], skillDirs: [], loading: false, error: '' },
  filePicker: { open: false, mode: 'file', query: '', results: [], selectedIndex: 0, anchor: null, requestId: 0 },
  sessionBrowser: { query: '', sortKey: 'date', sortDir: 'desc', tab: 'all' },
  sidebarCollapsed: localStorage.getItem('yolo-sidebar-collapsed') === 'true',
  theme: localStorage.getItem('yolo-theme') || document.documentElement.dataset.theme || 'dark',
  updates: { type: 'idle', message: 'Updates are idle.', checking: false }
};

const els = {
  appShell: document.querySelector('.app-shell'),
  workspaceWrap: document.querySelector('.workspace-wrap'),
  composerWrap: document.querySelector('.composer-wrap'),
  workspaceSelect: document.getElementById('workspaceSelect'),
  workspacePath: document.getElementById('workspacePath'),
  chatWorkspaceName: document.getElementById('chatWorkspaceName'),
  chatWorkspacePath: document.getElementById('chatWorkspacePath'),
  modelName: document.getElementById('modelName'),
  statusIndicator: document.getElementById('statusIndicator'),
  statusLight: document.getElementById('statusLight'),
  statusText: document.getElementById('statusText'),
  sessionMetrics: document.getElementById('sessionMetrics'),
  contextUsageText: document.getElementById('contextUsageText'),
  tokenUsageText: document.getElementById('tokenUsageText'),
  thinkingLevelSelect: document.getElementById('thinkingLevelSelect'),
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  messages: document.getElementById('messages'),
  returnToBottomBtn: document.getElementById('returnToBottomBtn'),
  queuePanel: document.getElementById('queuePanel'),
  filePicker: document.getElementById('filePicker'),
  sessionsList: document.getElementById('sessionsList'),
  newSessionBtn: document.getElementById('newSessionBtn'),
  collapseSidebarBtn: document.getElementById('collapseSidebarBtn'),
  sessionsPaneBtn: document.getElementById('sessionsPaneBtn'),
  sessionsModal: document.getElementById('sessionsModal'),
  closeSessionsBtn: document.getElementById('closeSessionsBtn'),
  newSessionFromPaneBtn: document.getElementById('newSessionFromPaneBtn'),
  sessionsSearchInput: document.getElementById('sessionsSearchInput'),
  sessionsTabs: [...document.querySelectorAll('.sessions-tab')],
  sessionsPanels: [...document.querySelectorAll('.sessions-tab-panel')],
  allSessionsList: document.getElementById('allSessionsList'),
  runningSessionsStatus: document.getElementById('runningSessionsStatus'),
  runningSessionsList: document.getElementById('runningSessionsList'),
  refreshRunningSessionsBtn: document.getElementById('refreshRunningSessionsBtn'),
  skillsPaneBtn: document.getElementById('skillsPaneBtn'),
  logsBtn: document.getElementById('logsBtn'),
  checkUpdatesBtn: document.getElementById('checkUpdatesBtn'),
  updatesStatus: document.getElementById('updatesStatus'),
  skillsModal: document.getElementById('skillsModal'),
  closeSkillsBtn: document.getElementById('closeSkillsBtn'),
  refreshSkillsBtn: document.getElementById('refreshSkillsBtn'),
  saveSkillDirsBtn: document.getElementById('saveSkillDirsBtn'),
  skillsList: document.getElementById('skillsList'),
  skillsStatus: document.getElementById('skillsStatus'),
  skillsDirsSummary: document.getElementById('skillsDirsSummary'),
  skillsExtraDirsInput: document.getElementById('skillsExtraDirsInput'),
  toolsList: document.getElementById('toolsList'),
  toolsStatus: document.getElementById('toolsStatus'),
  promptInput: document.getElementById('promptInput'),
  sendBtn: document.getElementById('sendBtn'),
  followUpBtn: document.getElementById('followUpBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  chooseWorkspaceBtn: document.getElementById('chooseWorkspaceBtn'),
  revealWorkspaceBtn: document.getElementById('revealWorkspaceBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  resetBtn: document.getElementById('resetBtn'),
  settingsModal: document.getElementById('settingsModal'),
  settingsTabs: [...document.querySelectorAll('.settings-tab')],
  settingsPanels: [...document.querySelectorAll('.settings-panel')],
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  cancelSettingsBtn: document.getElementById('cancelSettingsBtn'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  apiBaseUrlInput: document.getElementById('apiBaseUrlInput'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  apiKeyStatus: document.getElementById('apiKeyStatus'),
  clearApiKeyBtn: document.getElementById('clearApiKeyBtn'),
  modelInput: document.getElementById('modelInput'),
  settingsThinkingLevelInput: document.getElementById('settingsThinkingLevelInput'),
  compatibilityPresetInput: document.getElementById('compatibilityPresetInput'),
  maxConcurrencyInput: document.getElementById('maxConcurrencyInput'),
  compactionEnabledInput: document.getElementById('compactionEnabledInput'),
  compactionReserveTokensInput: document.getElementById('compactionReserveTokensInput'),
  compactionKeepRecentTokensInput: document.getElementById('compactionKeepRecentTokensInput'),
  guardrailsModeInput: document.getElementById('guardrailsModeInput'),
  concurrencyModal: document.getElementById('concurrencyModal'),
  concurrencyModalSummary: document.getElementById('concurrencyModalSummary'),
  concurrencyBlockersList: document.getElementById('concurrencyBlockersList'),
  closeConcurrencyBtn: document.getElementById('closeConcurrencyBtn'),
  cancelConcurrencyBtn: document.getElementById('cancelConcurrencyBtn'),
  openSessionManagementBtn: document.getElementById('openSessionManagementBtn')
};

init();

async function init() {
  applyTheme(state.theme);
  applySidebarState();
  bindEvents();
  setInterval(renderSessions, 60_000);
  window.yolo.onAgentEvent((event) => {
    try {
      handleAgentEvent(event);
    } catch (error) {
      console.error('Failed to render agent event', event, error);
      setStatus(`Event render error: ${error?.message || String(error)}`);
    }
  });

  if (typeof window.yolo.onUpdateEvent === 'function') {
    window.yolo.onUpdateEvent((event) => handleUpdateEvent(event));
  }

  if (typeof window.yolo.getUpdateStatus === 'function') {
    window.yolo.getUpdateStatus()
      .then((status) => handleUpdateEvent(status))
      .catch(() => {});
  }

  try {
    const bootstrap = await window.yolo.bootstrap();
    state.settings = bootstrap.settings || {};
    state.concurrency.maxConcurrency = normalizeMaxConcurrency(state.settings.maxConcurrency);
    state.homeBaseRoot = bootstrap.homeBaseRoot || '';
    state.workspaceRoot = bootstrap.workspaceRoot || '';
    applySessionPayload(bootstrap);
    renderMessagesFromHistory(bootstrap.active?.messages || [], {
      partialAssistantText: bootstrap.active?.partialAssistantText || '',
      partialAssistantThinkingText: bootstrap.active?.partialAssistantThinkingText || ''
    });
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
  els.messages.addEventListener('scroll', handleMessagesScroll, { passive: true });
  els.messages.addEventListener('wheel', markMessagesUserInteraction, { passive: true });
  els.messages.addEventListener('touchmove', markMessagesUserInteraction, { passive: true });
  els.messages.addEventListener('pointerdown', markMessagesUserInteraction, { passive: true });
  if (els.returnToBottomBtn) els.returnToBottomBtn.addEventListener('click', () => scrollToBottom({ force: true }));
  if (els.composerWrap && 'ResizeObserver' in window) {
    new ResizeObserver(() => {
      updateReturnToBottomButton();
      scrollToBottom();
    }).observe(els.composerWrap);
  }
  window.addEventListener('resize', () => {
    updateReturnToBottomButton();
    scrollToBottom();
    renderWorkspaceSelect();
  });
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
  if (els.workspaceSelect) els.workspaceSelect.addEventListener('change', handleWorkspaceSelectChange);
  if (els.sessionsPaneBtn) els.sessionsPaneBtn.addEventListener('click', () => openSessionsPane());
  if (els.closeSessionsBtn) els.closeSessionsBtn.addEventListener('click', closeSessionsPane);
  if (els.newSessionFromPaneBtn) els.newSessionFromPaneBtn.addEventListener('click', async () => {
    await createNewSession();
    closeSessionsPane();
  });
  if (els.sessionsSearchInput) els.sessionsSearchInput.addEventListener('input', () => {
    state.sessionBrowser.query = els.sessionsSearchInput.value;
    renderAllSessions();
  });
  els.sessionsTabs.forEach((button) => {
    button.addEventListener('click', () => setSessionsTab(button.dataset.sessionsTab || 'all'));
  });
  if (els.refreshRunningSessionsBtn) els.refreshRunningSessionsBtn.addEventListener('click', refreshConcurrencyState);
  if (els.skillsPaneBtn) els.skillsPaneBtn.addEventListener('click', openSkillsPane);
  if (els.logsBtn) els.logsBtn.addEventListener('click', openLogs);
  if (els.checkUpdatesBtn) els.checkUpdatesBtn.addEventListener('click', checkForUpdates);
  if (els.closeSkillsBtn) els.closeSkillsBtn.addEventListener('click', closeSkillsPane);
  if (els.refreshSkillsBtn) els.refreshSkillsBtn.addEventListener('click', loadSkillsPane);
  if (els.saveSkillDirsBtn) els.saveSkillDirsBtn.addEventListener('click', saveSkillDirs);
  els.settingsTabs.forEach((button) => {
    button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab || 'model'));
  });
  if (els.sessionsModal) els.sessionsModal.addEventListener('mousedown', (event) => {
    if (event.target === els.sessionsModal) closeSessionsPane();
  });
  if (els.skillsModal) els.skillsModal.addEventListener('mousedown', (event) => {
    if (event.target === els.skillsModal) closeSkillsPane();
  });
  if (els.settingsModal) els.settingsModal.addEventListener('mousedown', (event) => {
    if (event.target === els.settingsModal) closeSettings();
  });
  if (els.concurrencyModal) els.concurrencyModal.addEventListener('mousedown', (event) => {
    if (event.target === els.concurrencyModal) closeConcurrencyModal();
  });
  if (els.closeConcurrencyBtn) els.closeConcurrencyBtn.addEventListener('click', closeConcurrencyModal);
  if (els.cancelConcurrencyBtn) els.cancelConcurrencyBtn.addEventListener('click', closeConcurrencyModal);
  if (els.openSessionManagementBtn) els.openSessionManagementBtn.addEventListener('click', () => {
    closeConcurrencyModal();
    openSessionsPane('running');
  });

  els.chooseWorkspaceBtn.addEventListener('click', chooseWorkspace);
  els.revealWorkspaceBtn.addEventListener('click', () => window.yolo.revealWorkspace());
  els.thinkingLevelSelect.addEventListener('change', updateSessionThinkingLevel);
  els.settingsBtn.addEventListener('click', () => openSettings('model'));
  if (els.themeToggleBtn) els.themeToggleBtn.addEventListener('click', toggleTheme);
  els.closeSettingsBtn.addEventListener('click', closeSettings);
  els.cancelSettingsBtn.addEventListener('click', closeSettings);

  els.saveSettingsBtn.addEventListener('click', saveSettings);
  if (els.clearApiKeyBtn) els.clearApiKeyBtn.addEventListener('click', clearApiKey);
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
  state.concurrency.runningSessions = state.sessions.filter((session) => session.busy);
  state.concurrency.runningCount = state.concurrency.runningSessions.length;
  ensureSessionReviewBaseline();
}

async function createNewSession() {
  try {
    const payload = await window.yolo.createSession();
    applySessionPayload(payload);
    state.currentAssistant = null;
    renderMessagesFromHistory(payload.active?.messages || [], {
      partialAssistantText: payload.active?.partialAssistantText || '',
      partialAssistantThinkingText: payload.active?.partialAssistantThinkingText || ''
    });
    renderChrome();
    setStatus('New session');
  } catch (error) {
    addAssistantError(error);
  }
}

async function selectSession(sessionId) {
  if (!sessionId) return false;
  if (sessionId === state.activeSessionId) {
    markSessionReviewed(sessionId);
    renderSessions();
    return true;
  }

  try {
    const payload = await window.yolo.selectSession(sessionId);
    applySessionPayload(payload);
    if (payload.active?.session) markSessionReviewed(payload.active.session);
    state.currentAssistant = null;
    renderMessagesFromHistory(payload.active?.messages || [], {
      partialAssistantText: payload.active?.partialAssistantText || '',
      partialAssistantThinkingText: payload.active?.partialAssistantThinkingText || ''
    });
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
  setChromeToggle(
    els.collapseSidebarBtn,
    state.sidebarCollapsed ? 'right' : 'left',
    state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
    !state.sidebarCollapsed
  );
}

async function chooseWorkspace() {
  try {
    const result = await window.yolo.selectWorkspace();
    applyWorkspaceResult(result);
  } catch (error) {
    addAssistantError(error);
  }
}

async function handleWorkspaceSelectChange() {
  const value = els.workspaceSelect?.value || '';
  if (!value) return;

  if (value === '__choose__') {
    await chooseWorkspace();
    renderWorkspaceSelect();
    return;
  }

  const activeWorkspace = getActiveWorkspace();
  if (samePath(value, activeWorkspace)) {
    renderWorkspaceSelect();
    return;
  }

  try {
    const result = await window.yolo.setWorkspace(value);
    applyWorkspaceResult(result);
  } catch (error) {
    addAssistantError(error);
    renderWorkspaceSelect();
  }
}

function applyWorkspaceResult(result = {}) {
  const previousWorkspace = getActiveWorkspace();
  const previousSessionId = state.activeSessionId;
  const nextWorkspace = result.workspaceRoot || state.workspaceRoot || '';
  const nextSessionId = result.session?.id || state.activeSessionId;
  const changed = !samePath(previousWorkspace, nextWorkspace) || nextSessionId !== previousSessionId;

  state.workspaceRoot = nextWorkspace;
  if (result.session) {
    state.activeSession = result.session;
    state.activeSessionId = result.session.id || state.activeSessionId;
  }
  state.sessions = state.sessions.map((session) => session.id === state.activeSessionId ? { ...session, title: 'New chat', workspaceRoot: state.workspaceRoot } : session);
  if (changed) clearMessages();
  renderChrome();
}

function setChromeToggle(button, direction, label, expanded) {
  if (!button) return;
  const chevron = button.querySelector('.chevron');
  if (chevron) chevron.className = `chevron chevron-${direction}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String(expanded));
}

async function openSessionsPane(tab = state.sessionBrowser.tab || 'all') {
  if (!els.sessionsModal) return;
  els.sessionsModal.classList.remove('hidden');
  if (els.sessionsSearchInput) els.sessionsSearchInput.value = state.sessionBrowser.query || '';
  setSessionsTab(tab);
  renderAllSessions();
  renderRunningSessions();

  try {
    const payload = await window.yolo.listSessions();
    state.sessions = payload.sessions || state.sessions;
    state.activeSessionId = payload.activeSessionId || state.activeSessionId;
    await refreshConcurrencyState();
    renderSessions();
  } catch (error) {
    setStatus(error.message || 'Failed to load sessions');
  }
}

function closeSessionsPane() {
  if (els.sessionsModal) els.sessionsModal.classList.add('hidden');
}

async function openSkillsPane() {
  await openSettings('skills');
}

function closeSkillsPane() {
  setSettingsTab('model', { loadSkills: false });
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
      skillDirs: payload.skillDirs || [],
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

  renderSkillDirsSummary();

  const skills = state.skills.skills || [];
  const diagnostics = state.skills.diagnostics || [];
  const skillDirs = state.skills.skillDirs || [];
  if (els.skillsStatus) {
    if (state.skills.loading) {
      els.skillsStatus.textContent = 'Loading skills…';
      els.skillsStatus.title = '';
    } else if (state.skills.error) {
      els.skillsStatus.textContent = state.skills.error;
      els.skillsStatus.title = '';
    } else {
      els.skillsStatus.textContent = `${skills.length} skills available${diagnostics.length ? ` · ${diagnostics.length} notices` : ''}${skillDirs.length ? ` · ${skillDirs.length} locations` : ''}`;
      els.skillsStatus.title = skillDirs.map((entry) => `${entry.label || 'folder'}: ${entry.path}`).join('\n');
    }
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

  els.skillsList.innerHTML = '';
  for (const diagnostic of diagnostics) {
    els.skillsList.appendChild(createSkillDiagnosticItem(diagnostic));
  }

  if (!skills.length) {
    const empty = document.createElement('div');
    empty.className = 'sessions-empty';
    empty.textContent = diagnostics.length ? 'No loadable skills found' : 'No skills found';
    els.skillsList.appendChild(empty);
    return;
  }

  for (const skill of skills) {
    els.skillsList.appendChild(createSkillManageItem(skill));
  }
}

function renderSkillDirsSummary() {
  if (!els.skillsDirsSummary) return;
  const skillDirs = state.skills.skillDirs || [];
  els.skillsDirsSummary.innerHTML = '';
  els.skillsDirsSummary.classList.toggle('hidden', skillDirs.length === 0);
  if (!skillDirs.length) return;

  const title = document.createElement('div');
  title.className = 'skills-dirs-title';
  title.textContent = 'Skill search locations';

  const list = document.createElement('div');
  list.className = 'skills-dirs-list';
  for (const entry of skillDirs) {
    const row = document.createElement('div');
    row.className = 'skills-dirs-entry';

    const label = document.createElement('span');
    label.className = 'skills-dirs-label';
    label.textContent = entry.label || 'Folder';

    const pathText = document.createElement('code');
    pathText.textContent = entry.path || '';
    if (entry.path) row.title = entry.path;

    row.appendChild(label);
    row.appendChild(pathText);
    list.appendChild(row);
  }

  els.skillsDirsSummary.appendChild(title);
  els.skillsDirsSummary.appendChild(list);
}

function createSkillDiagnosticItem(diagnostic) {
  const item = document.createElement('div');
  item.className = `skill-diagnostic-item ${String(diagnostic?.type || 'warning').toLowerCase()}`;

  const title = document.createElement('div');
  title.className = 'skill-diagnostic-title';
  title.textContent = `${formatDiagnosticType(diagnostic?.type)}: ${diagnostic?.message || 'Skill notice'}`;

  const meta = document.createElement('div');
  meta.className = 'skill-diagnostic-meta';
  meta.textContent = diagnostic?.path || diagnostic?.location || '';
  if (meta.textContent) meta.title = meta.textContent;

  item.appendChild(title);
  if (meta.textContent) item.appendChild(meta);

  if (diagnostic?.code === 'skill-frontmatter-missing-opening-delimiter') {
    const fix = document.createElement('div');
    fix.className = 'skill-diagnostic-fix';
    fix.textContent = 'Fix: add a line containing --- before name: and keep the existing closing --- after the frontmatter block.';
    item.appendChild(fix);
  }

  return item;
}

function formatDiagnosticType(type) {
  const text = String(type || 'warning').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Warning';
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
      skillDirs: payload.skillDirs || [],
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
      skillDirs: payload.skillDirs || [],
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

function renderToolsPane() {
  if (!els.toolsList) return;

  const tools = getToolDefinitions();
  els.toolsList.innerHTML = '';

  if (!tools.length) {
    els.toolsList.innerHTML = '<div class="sessions-empty">No tools found</div>';
    if (els.toolsStatus) els.toolsStatus.textContent = 'No tools available';
    return;
  }

  let lastGroup = '';
  for (const tool of tools) {
    const group = tool.group || 'Tools';
    if (group !== lastGroup) {
      const heading = document.createElement('div');
      heading.className = 'tool-group-heading';
      heading.textContent = group;
      els.toolsList.appendChild(heading);
      lastGroup = group;
    }
    els.toolsList.appendChild(createToolManageItem(tool));
  }

  updateToolsStatus();
}

function createToolManageItem(tool) {
  const item = document.createElement('div');
  const enabled = isToolEnabled(tool.name);
  item.className = `skill-manage-item${enabled ? '' : ' disabled'}`;

  const copy = document.createElement('div');
  copy.className = 'skill-manage-copy';

  const title = document.createElement('div');
  title.className = 'skill-manage-title';
  title.textContent = tool.label ? `${tool.label} (${tool.name})` : tool.name;

  const description = document.createElement('div');
  description.className = 'skill-manage-description';
  description.textContent = tool.description || 'Model tool';

  const meta = document.createElement('div');
  meta.className = 'skill-manage-meta';
  meta.textContent = tool.name === 'get_web'
    ? 'compatibility wrapper · requires web_search and web_fetch'
    : tool.name;

  copy.appendChild(title);
  copy.appendChild(description);
  copy.appendChild(meta);

  const toggle = document.createElement('label');
  toggle.className = 'toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.toolName = tool.name;
  input.checked = enabled;
  input.addEventListener('change', () => {
    item.classList.toggle('disabled', !input.checked);
    updateToolsStatus();
  });
  const slider = document.createElement('span');
  slider.className = 'toggle-slider';
  toggle.appendChild(input);
  toggle.appendChild(slider);

  item.appendChild(copy);
  item.appendChild(toggle);
  return item;
}

function updateToolsStatus() {
  if (!els.toolsStatus) return;
  const tools = getToolDefinitions();
  const settings = collectToolSettingsFromUi();
  const enabledCount = tools.filter((tool) => settings.entries?.[tool.name]?.enabled !== false).length;
  const getWebConfigured = settings.entries?.get_web?.enabled !== false;
  const getWebExposed = getWebConfigured
    && settings.entries?.web_search?.enabled !== false
    && settings.entries?.web_fetch?.enabled !== false;
  const effectiveCount = enabledCount - (getWebConfigured && !getWebExposed ? 1 : 0);
  els.toolsStatus.textContent = `${enabledCount}/${tools.length} tools enabled${effectiveCount !== enabledCount ? ` · ${effectiveCount} exposed after dependencies` : ''}`;
}

function getToolDefinitions() {
  const fromSettings = Array.isArray(state.settings.toolDefinitions) ? state.settings.toolDefinitions : [];
  const normalized = fromSettings
    .map((tool) => ({
      name: String(tool?.name || '').trim(),
      label: String(tool?.label || '').trim(),
      group: String(tool?.group || '').trim(),
      description: String(tool?.description || '').trim()
    }))
    .filter((tool) => tool.name);
  return normalized.length ? normalized : FALLBACK_TOOL_DEFINITIONS;
}

function isToolEnabled(name, settings = state.settings) {
  return settings?.tools?.entries?.[name]?.enabled !== false;
}

function collectToolSettingsFromUi() {
  const tools = getToolDefinitions();
  const entries = {};
  const inputs = els.toolsList ? [...els.toolsList.querySelectorAll('input[data-tool-name]')] : [];
  const byName = new Map(inputs.map((input) => [input.dataset.toolName, input]));

  for (const tool of tools) {
    const input = byName.get(tool.name);
    entries[tool.name] = { enabled: input ? input.checked : isToolEnabled(tool.name) };
  }

  return { entries };
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

function normalizeMaxConcurrency(value, fallback = 2) {
  const number = Number.parseInt(String(value ?? ''), 10);
  const fallbackNumber = Number.isFinite(Number(fallback)) ? Number(fallback) : 2;
  const normalizedFallback = Math.min(8, Math.max(1, Math.round(fallbackNumber)));
  if (!Number.isFinite(number)) return normalizedFallback;
  return Math.min(8, Math.max(1, number));
}

function normalizeGuardrailsMode(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (raw === 'off' || raw === 'yolo' || raw === 'disabled' || raw === 'disable' || raw === 'none' || raw === 'false' || raw === '0') return 'off';
  return 'ask';
}

function getGuardrailsMode(settings = state.settings) {
  return normalizeGuardrailsMode(settings?.guardrails?.mode || settings?.guardrailsMode || 'ask');
}

function normalizeCompactionSettings(value = {}, fallback = DEFAULT_COMPACTION_SETTINGS) {
  const source = value && typeof value === 'object' ? value : {};
  const fallbackSource = fallback && typeof fallback === 'object' ? fallback : DEFAULT_COMPACTION_SETTINGS;
  return {
    enabled: normalizeBooleanSetting(source.enabled, normalizeBooleanSetting(fallbackSource.enabled, DEFAULT_COMPACTION_SETTINGS.enabled)),
    reserveTokens: normalizeTokenSetting(source.reserveTokens, normalizeTokenSetting(fallbackSource.reserveTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens)),
    keepRecentTokens: normalizeTokenSetting(source.keepRecentTokens, normalizeTokenSetting(fallbackSource.keepRecentTokens, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens))
  };
}

function normalizeBooleanSetting(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback !== false;
  if (['1', 'true', 'yes', 'on', 'enabled', 'enable'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'disabled', 'disable'].includes(raw)) return false;
  return fallback !== false;
}

function normalizeTokenSetting(value, fallback) {
  const number = Number.parseInt(String(value ?? ''), 10);
  const fallbackNumber = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const normalizedFallback = Math.min(1_000_000, Math.max(1_000, Math.round(fallbackNumber)));
  if (!Number.isFinite(number)) return normalizedFallback;
  return Math.min(1_000_000, Math.max(1_000, number));
}

function renderChrome() {
  applyTheme(state.theme);
  updateBusyUi();
  renderQueue();
  renderSessionMetrics();
  renderSessions();

  const activeWorkspace = getActiveWorkspace();
  const workspaceTitle = displayWorkspaceName(activeWorkspace);
  renderWorkspaceSelect(activeWorkspace);
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
  } else {
    if (els.modelName) {
      els.modelName.textContent = 'Not configured';
      els.modelName.classList.add('empty');
    }
  }
}

function renderSessionMetrics() {
  const metrics = state.activeSession?.metrics || null;
  if (!els.sessionMetrics || !els.contextUsageText || !els.tokenUsageText) return;

  if (!metrics) {
    els.contextUsageText.textContent = 'Context: ? / 128k';
    els.tokenUsageText.textContent = 'I/O: 0 in · 0 out';
    els.sessionMetrics.title = 'Session context and token usage are not available yet.';
    return;
  }

  els.contextUsageText.textContent = `Context: ${formatContextMetric(metrics.context)}`;
  els.tokenUsageText.textContent = `I/O: ${formatTokenMetric(metrics.usage?.input)} in · ${formatTokenMetric(metrics.usage?.output)} out`;
  els.sessionMetrics.title = buildSessionMetricsTitle(metrics);
}

function formatContextMetric(context = {}) {
  const windowTokens = normalizeMetricNumber(context.contextWindow, 128_000);
  const tokens = context.tokens === null || context.tokens === undefined ? null : normalizeMetricNumber(context.tokens, 0);
  const percent = context.percent === null || context.percent === undefined ? null : Number(context.percent);
  const percentText = Number.isFinite(percent) ? ` (${Math.round(percent)}%)` : '';
  return `${tokens === null ? '?' : formatTokenMetric(tokens)} / ${formatTokenMetric(windowTokens)}${percentText}`;
}

function formatCompactSessionMetrics(metrics = {}) {
  if (!metrics.context && !metrics.usage) return '';
  const context = metrics.context || {};
  const usage = metrics.usage || {};
  const parts = [];
  if (Number.isFinite(Number(context.percent))) parts.push(`${Math.round(Number(context.percent))}% ctx`);
  else if (context.contextWindow) parts.push('? ctx');
  if (Number(usage.input) || Number(usage.output)) parts.push(`${formatTokenMetric(usage.input)} in/${formatTokenMetric(usage.output)} out`);
  return parts.join(' · ');
}

function buildSessionMetricsTitle(metrics = {}) {
  const usage = metrics.usage || {};
  const compaction = metrics.compaction || {};
  return [
    `Context: ${formatContextMetric(metrics.context || {})}`,
    `Input tokens: ${formatTokenMetric(usage.input)}`,
    `Output tokens: ${formatTokenMetric(usage.output)}`,
    `Total tokens: ${formatTokenMetric(usage.total)}`,
    `Cost: $${Number(usage.cost || 0).toFixed(4)}`,
    `Auto compaction: ${compaction.enabled === false ? 'off' : 'on'}`,
    compaction.reserveTokens ? `Reserve tokens: ${formatTokenMetric(compaction.reserveTokens)}` : '',
    compaction.keepRecentTokens ? `Keep recent tokens: ${formatTokenMetric(compaction.keepRecentTokens)}` : '',
    compaction.lastCompactedAt ? `Last compaction: ${formatDateTime(compaction.lastCompactedAt)}` : ''
  ].filter(Boolean).join('\n');
}

function formatTokenMetric(value) {
  const number = normalizeMetricNumber(value, 0);
  if (number >= 1_000_000) return `${trimMetricNumber(number / 1_000_000)}M`;
  if (number >= 1_000) return `${trimMetricNumber(number / 1_000)}k`;
  return String(number);
}

function trimMetricNumber(value) {
  const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return fixed.replace(/\.0$/, '');
}

function normalizeMetricNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

function getActiveWorkspace() {
  return state.activeSession?.workspaceRoot || state.workspaceRoot || state.homeBaseRoot || '';
}

function renderWorkspaceSelect(activeWorkspace = getActiveWorkspace()) {
  if (!els.workspaceSelect) return;

  const selected = activeWorkspace || '';
  const choices = getWorkspaceChoices(selected);
  const labelBudget = getWorkspaceLabelBudget();
  els.workspaceSelect.innerHTML = '';

  if (!choices.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No folder selected';
    els.workspaceSelect.appendChild(option);
  }

  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.path;
    option.textContent = truncatePathFromLeft(choice.path, labelBudget);
    option.title = choice.path;
    els.workspaceSelect.appendChild(option);
  }

  const chooseOption = document.createElement('option');
  chooseOption.value = '__choose__';
  chooseOption.textContent = 'Choose another folder…';
  els.workspaceSelect.appendChild(chooseOption);

  els.workspaceSelect.value = selected;
  els.workspaceSelect.title = selected || 'No folder selected';
}

function getWorkspaceChoices(activeWorkspace) {
  const choices = [];
  const add = (folderPath) => {
    const pathValue = String(folderPath || '').trim();
    if (!pathValue || choices.some((choice) => samePath(choice.path, pathValue))) return;
    choices.push({ path: pathValue });
  };

  add(activeWorkspace);
  add(state.workspaceRoot);
  add(state.homeBaseRoot);
  for (const session of getSessionsNewestFirst()) add(session.workspaceRoot);
  return choices.slice(0, 24);
}

function getWorkspaceLabelBudget() {
  const width = els.workspaceSelect?.clientWidth || 420;
  return Math.max(28, Math.floor(width / 7.2));
}

function truncatePathFromLeft(folderPath, maxChars = 72) {
  const text = String(folderPath || '').trim();
  if (!text || text.length <= maxChars) return text || 'No folder selected';
  const tailLength = Math.max(10, maxChars - 4);
  let tail = text.slice(-tailLength);
  const separatorIndex = tail.search(/[\\/]/);
  if (separatorIndex > 0 && tail.length - separatorIndex >= Math.floor(tailLength * 0.65)) {
    tail = tail.slice(separatorIndex);
  }
  return `....${tail}`;
}

function displayWorkspaceName(folderPath) {
  if (!folderPath) return 'workspace';
  const normalized = String(folderPath).replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized || 'Selected folder';
}

function samePath(a, b) {
  if (!a || !b) return false;
  const normalize = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

function loadSessionReviews() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_REVIEW_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([id, token]) => [id, Number(token) || 0]));
  } catch {
    return {};
  }
}

function saveSessionReviews() {
  try {
    const entries = Object.entries(state.sessionReviews || {})
      .filter(([id, token]) => id && Number.isFinite(Number(token)))
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, SESSION_REVIEW_LIMIT);
    state.sessionReviews = Object.fromEntries(entries.map(([id, token]) => [id, Number(token) || 0]));
    localStorage.setItem(SESSION_REVIEW_STORAGE_KEY, JSON.stringify(state.sessionReviews));
  } catch {
    // Ignore storage failures; review dots will still work for this render pass.
  }
}

function ensureSessionReviewBaseline() {
  if (state.reviewBaselineReady || !state.sessions.length) return;
  state.reviewBaselineReady = true;
  markSessionsReviewed(state.sessions, { onlyMissing: true });
}

function markSessionsReviewed(sessions = [], options = {}) {
  let changed = false;
  for (const session of sessions || []) {
    if (!session?.id || session.busy || getSessionStatus(session) === 'running') continue;
    const token = getSessionReviewToken(session);
    if (token <= 0) continue;
    if (options.onlyMissing && Number(state.sessionReviews[session.id] || 0) > 0) continue;
    if (Number(state.sessionReviews[session.id] || 0) >= token) continue;
    state.sessionReviews[session.id] = token;
    changed = true;
  }
  if (changed) saveSessionReviews();
}

function markSessionReviewed(sessionOrId) {
  const session = typeof sessionOrId === 'string'
    ? state.sessions.find((candidate) => candidate.id === sessionOrId) || { id: sessionOrId }
    : sessionOrId;
  if (!session?.id) return;
  const token = getSessionReviewToken(session);
  if (token <= 0 || Number(state.sessionReviews[session.id] || 0) >= token) return;
  state.sessionReviews[session.id] = token;
  saveSessionReviews();
}

function getSessionReviewToken(session) {
  const count = Number(session?.messageCount);
  if (Number.isFinite(count)) return Math.max(0, count);
  return getSessionTimestamp(session);
}

function isSessionUnreviewed(session) {
  if (!session?.id || session.busy || getSessionStatus(session) !== 'idle') return false;
  const token = getSessionReviewToken(session);
  if (token <= 0) return false;
  return token > Number(state.sessionReviews[session.id] || 0);
}

function getSessionStatus(session) {
  if (session?.busy) return 'running';
  const raw = String(session?.status || '').trim().toLowerCase();
  if (raw === 'running') return 'running';
  if (raw === 'cancelled' || raw === 'canceled') return 'cancelled';
  return 'idle';
}

function getSessionIndicatorState(session) {
  const status = getSessionStatus(session);
  if (status === 'running') return 'running';
  if (status === 'cancelled') return 'cancelled';
  return isSessionUnreviewed(session) ? 'ready' : 'reviewed';
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
    renderRunningSessions();
    return;
  }

  els.sessionsList.innerHTML = '';
  for (const session of recentSessions) {
    els.sessionsList.appendChild(createSessionItem(session));
  }
  renderAllSessions();
  renderRunningSessions();
}

function renderAllSessions() {
  if (!els.allSessionsList) return;

  const sessions = getFilteredSortedSessions();
  if (!state.sessions.length) {
    els.allSessionsList.innerHTML = '<div class="sessions-empty table-empty">No sessions yet</div>';
    return;
  }
  if (!sessions.length) {
    els.allSessionsList.innerHTML = '<div class="sessions-empty table-empty">No matching sessions</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'sessions-table';
  table.appendChild(createSessionsTableHead());

  const body = document.createElement('tbody');
  for (const session of sessions) body.appendChild(createSessionTableRow(session));
  table.appendChild(body);

  els.allSessionsList.innerHTML = '';
  els.allSessionsList.appendChild(table);
}

function setSessionsTab(tab = 'all') {
  const nextTab = tab === 'running' ? 'running' : 'all';
  state.sessionBrowser.tab = nextTab;
  els.sessionsTabs.forEach((button) => {
    const active = button.dataset.sessionsTab === nextTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  els.sessionsPanels.forEach((panel) => {
    const active = panel.dataset.sessionsPanel === nextTab;
    panel.classList.toggle('active', active);
    panel.classList.toggle('hidden', !active);
  });
  if (nextTab === 'running') refreshConcurrencyState();
}

async function refreshConcurrencyState() {
  try {
    const concurrency = await window.yolo.getConcurrencyState();
    state.concurrency = {
      ...state.concurrency,
      ...normalizeConcurrencyState(concurrency)
    };
    renderRunningSessions();
    return state.concurrency;
  } catch (error) {
    if (els.runningSessionsStatus) els.runningSessionsStatus.textContent = error.message || 'Failed to load running sessions';
    return state.concurrency;
  }
}

async function waitForSendSlot(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const concurrency = await refreshConcurrencyState();
    if (concurrency.runningCount < concurrency.maxConcurrency) return true;
    await delay(180);
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeConcurrencyState(concurrency = {}) {
  const runningSessions = Array.isArray(concurrency.runningSessions) ? concurrency.runningSessions : [];
  const maxConcurrency = normalizeMaxConcurrency(concurrency.maxConcurrency, state.settings.maxConcurrency);
  return {
    maxConcurrency,
    runningCount: Number.isFinite(Number(concurrency.runningCount)) ? Number(concurrency.runningCount) : runningSessions.length,
    runningSessions,
    canStart: concurrency.canStart !== false && runningSessions.length < maxConcurrency
  };
}

function getRunningSessionsForDisplay() {
  const byId = new Map();
  for (const session of state.sessions || []) {
    if (session?.busy) byId.set(session.id, session);
  }
  for (const session of state.concurrency.runningSessions || []) {
    if (session?.id) byId.set(session.id, { ...(byId.get(session.id) || {}), ...session, busy: true });
  }
  return [...byId.values()];
}

function renderRunningSessions() {
  if (!els.runningSessionsList) return;
  const running = getRunningSessionsForDisplay();
  const max = normalizeMaxConcurrency(state.concurrency.maxConcurrency, state.settings.maxConcurrency);
  if (els.runningSessionsStatus) {
    els.runningSessionsStatus.textContent = `${running.length} / ${max} sessions running. Terminate one here if you need a send slot now.`;
  }

  if (!running.length) {
    els.runningSessionsList.innerHTML = '<div class="sessions-empty table-empty">No sessions are running.</div>';
    return;
  }

  els.runningSessionsList.innerHTML = '';
  for (const session of running) els.runningSessionsList.appendChild(createRunningSessionItem(session));
}

function createRunningSessionItem(session, options = {}) {
  const item = document.createElement('div');
  item.className = 'running-session-item';

  const copy = document.createElement('div');
  copy.className = 'running-session-copy';

  const title = document.createElement('div');
  title.className = 'running-session-title';
  title.textContent = session.title || 'Running session';

  const meta = document.createElement('div');
  meta.className = 'running-session-meta';
  meta.textContent = [displayWorkspaceName(session.workspaceRoot), session.sessionFile].filter(Boolean).join(' · ');
  if (meta.textContent) meta.title = meta.textContent;

  copy.appendChild(title);
  copy.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'running-session-actions';

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'button button-ghost';
  viewBtn.textContent = 'View';
  viewBtn.addEventListener('click', async () => {
    await selectSession(session.id);
    closeConcurrencyModal();
    closeSessionsPane();
  });
  actions.appendChild(viewBtn);

  const terminateBtn = document.createElement('button');
  terminateBtn.type = 'button';
  terminateBtn.className = 'button button-primary';
  terminateBtn.textContent = options.pendingText ? 'Terminate & send' : 'Terminate';
  terminateBtn.addEventListener('click', async () => {
    terminateBtn.disabled = true;
    await terminateSession(session.id, options.pendingText || '');
  });
  actions.appendChild(terminateBtn);

  item.appendChild(copy);
  item.appendChild(actions);
  return item;
}

async function terminateSession(sessionId, pendingText = '') {
  try {
    setStatus('Terminating session…');
    const result = await window.yolo.cancelRun(sessionId);
    state.sessions = state.sessions.map((session) => session.id === sessionId ? { ...session, busy: false, status: 'cancelled' } : session);
    if (state.activeSessionId === sessionId) {
      state.busy = false;
      restoreQueuedToEditor(result?.queued);
      updateBusyUi();
    }
    await refreshConcurrencyState();
    renderSessions();
    setStatus('Session terminated');
    if (pendingText) {
      closeConcurrencyModal();
      await waitForSendSlot();
      await sendPrompt(pendingText);
    }
  } catch (error) {
    addAssistantError(error);
  }
}

async function deleteSession(sessionOrId, triggerButton) {
  const session = typeof sessionOrId === 'string'
    ? state.sessions.find((candidate) => candidate.id === sessionOrId) || { id: sessionOrId }
    : sessionOrId;
  const sessionId = session?.id;
  if (!sessionId) return;

  if (getSessionStatus(session) === 'running') {
    setStatus('Cancel the running session before deleting it');
    return;
  }

  const title = session.title || 'New chat';
  const confirmed = window.confirm(`Delete session "${title}"?\n\nThis removes the saved chat and cannot be undone.`);
  if (!confirmed) return;

  const previousActiveId = state.activeSessionId;
  try {
    if (triggerButton) triggerButton.disabled = true;
    setStatus('Deleting session…');
    const payload = await window.yolo.deleteSession(sessionId);
    if (Object.prototype.hasOwnProperty.call(state.sessionReviews || {}, sessionId)) {
      delete state.sessionReviews[sessionId];
      saveSessionReviews();
    }
    applySessionPayload(payload);
    if (previousActiveId === sessionId || payload.activeSessionId !== previousActiveId) {
      state.currentAssistant = null;
      renderMessagesFromHistory(payload.active?.messages || [], {
        partialAssistantText: payload.active?.partialAssistantText || '',
        partialAssistantThinkingText: payload.active?.partialAssistantThinkingText || ''
      });
    }
    renderChrome();
    setStatus('Session deleted');
  } catch (error) {
    addAssistantError(error);
  } finally {
    if (triggerButton?.isConnected) triggerButton.disabled = false;
  }
}

function getFilteredSortedSessions() {
  const query = normalizeSessionSearch(state.sessionBrowser.query);
  const filtered = query
    ? state.sessions.filter((session) => sessionMatchesQuery(session, query))
    : [...state.sessions];

  const sortKey = state.sessionBrowser.sortKey || 'date';
  const direction = state.sessionBrowser.sortDir === 'asc' ? 1 : -1;
  return filtered.sort((a, b) => compareSessionsForTable(a, b, sortKey) * direction || compareSessionsForTable(a, b, 'date') * -1);
}

function createSessionsTableHead() {
  const head = document.createElement('thead');
  const row = document.createElement('tr');
  row.appendChild(createSessionSortHeader('Date', 'date'));
  row.appendChild(createSessionSortHeader('Time', 'time'));
  row.appendChild(createSessionSortHeader('Preview', 'preview'));
  row.appendChild(createSessionActionsHeader());
  head.appendChild(row);
  return head;
}

function createSessionSortHeader(label, key) {
  const th = document.createElement('th');
  th.scope = 'col';
  th.className = `sessions-col-${key}`;
  th.setAttribute('aria-sort', state.sessionBrowser.sortKey === key ? (state.sessionBrowser.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `sessions-sort-button${state.sessionBrowser.sortKey === key ? ' active' : ''}`;
  button.textContent = label;
  if (state.sessionBrowser.sortKey === key) {
    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    arrow.textContent = state.sessionBrowser.sortDir === 'asc' ? '↑' : '↓';
    button.appendChild(arrow);
  }
  button.addEventListener('click', () => toggleSessionSort(key));
  th.appendChild(button);
  return th;
}

function createSessionActionsHeader() {
  const th = document.createElement('th');
  th.scope = 'col';
  th.className = 'sessions-col-actions';
  th.setAttribute('aria-label', 'Session actions');
  return th;
}

function createSessionTableRow(session) {
  const row = document.createElement('tr');
  row.className = `session-table-row${session.id === state.activeSessionId ? ' active' : ''}${getSessionStatus(session) === 'running' ? ' running' : ''}`;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.sessionId = session.id;

  const date = document.createElement('td');
  date.className = 'sessions-date-cell';
  date.textContent = formatSessionDate(session.updatedAt || session.createdAt);

  const time = document.createElement('td');
  time.className = 'sessions-time-cell';
  time.textContent = getSessionStatus(session) === 'running'
    ? 'running'
    : getSessionStatus(session) === 'cancelled'
      ? 'cancelled'
      : formatSessionClock(session.updatedAt || session.createdAt);

  const preview = document.createElement('td');
  preview.className = 'sessions-preview-cell';
  const previewHoverText = [session.title || 'New chat', getSessionFullPathText(session)].filter(Boolean).join('\n');
  if (previewHoverText) preview.title = previewHoverText;
  const title = document.createElement('div');
  title.className = 'session-preview-title';
  title.textContent = session.title || 'New chat';
  if (previewHoverText) title.title = previewHoverText;
  const meta = document.createElement('div');
  meta.className = 'session-preview-meta';
  const metricsText = formatCompactSessionMetrics(session.metrics);
  meta.textContent = [session.workspaceRoot, metricsText, session.sessionFile].filter(Boolean).join(' · ');
  const metaTitle = [previewHoverText, metricsText ? buildSessionMetricsTitle(session.metrics) : ''].filter(Boolean).join('\n\n');
  if (metaTitle) meta.title = metaTitle;
  preview.appendChild(title);
  if (meta.textContent) preview.appendChild(meta);

  const actions = document.createElement('td');
  actions.className = 'sessions-actions-cell';
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'session-delete-button';
  deleteBtn.textContent = '🗑';
  deleteBtn.setAttribute('aria-label', `Delete session ${session.title || 'New chat'}`);
  if (getSessionStatus(session) === 'running') {
    deleteBtn.disabled = true;
    deleteBtn.title = 'Cancel the running session before deleting it';
  } else {
    deleteBtn.title = `Delete session: ${session.title || 'New chat'}`;
  }
  deleteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteSession(session, deleteBtn);
  });
  deleteBtn.addEventListener('keydown', (event) => event.stopPropagation());
  actions.appendChild(deleteBtn);

  row.appendChild(date);
  row.appendChild(time);
  row.appendChild(preview);
  row.appendChild(actions);

  const select = async () => {
    markSessionReviewed(session);
    renderSessions();
    const selected = await selectSession(session.id);
    if (selected) closeSessionsPane();
  };
  row.addEventListener('click', select);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select();
    }
  });
  return row;
}

function toggleSessionSort(key) {
  if (state.sessionBrowser.sortKey === key) {
    state.sessionBrowser.sortDir = state.sessionBrowser.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sessionBrowser.sortKey = key;
    state.sessionBrowser.sortDir = key === 'preview' ? 'asc' : 'desc';
  }
  renderAllSessions();
}

function compareSessionsForTable(a, b, key) {
  if (key === 'preview') return getSessionPreviewText(a).localeCompare(getSessionPreviewText(b), undefined, { sensitivity: 'base' });
  if (key === 'time') return getSessionTimeOfDay(a) - getSessionTimeOfDay(b);
  return getSessionTimestamp(a) - getSessionTimestamp(b);
}

function sessionMatchesQuery(session, query) {
  const haystack = normalizeSessionSearch([
    session.title,
    session.workspaceRoot,
    session.sessionFile,
    formatSessionDate(session.updatedAt || session.createdAt),
    formatSessionClock(session.updatedAt || session.createdAt)
  ].filter(Boolean).join(' '));
  return query.split(' ').filter(Boolean).every((part) => haystack.includes(part));
}

function normalizeSessionSearch(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getSessionPreviewText(session) {
  return String(session?.title || 'New chat');
}

function getSessionFullPathText(session) {
  return [
    session?.workspaceRoot ? `Workspace: ${session.workspaceRoot}` : '',
    session?.sessionFile ? `Session file: ${session.sessionFile}` : ''
  ].filter(Boolean).join('\n');
}

function getSessionTimestamp(session) {
  const time = new Date(session?.updatedAt || session?.createdAt || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getSessionTimeOfDay(session) {
  const date = new Date(session?.updatedAt || session?.createdAt || 0);
  const time = date.getTime();
  if (Number.isNaN(time)) return 0;
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

function formatSessionListStatus(session) {
  const status = getSessionStatus(session);
  if (status === 'running') return 'running';
  if (status === 'cancelled') return 'cancelled';
  return formatSessionTime(session.updatedAt);
}

function getSessionIndicatorTitle(indicatorState) {
  if (indicatorState === 'running') return 'Running';
  if (indicatorState === 'ready') return 'New result ready';
  if (indicatorState === 'cancelled') return 'Cancelled';
  return 'Reviewed';
}

function getSessionIndicatorLabel(indicatorState) {
  if (indicatorState === 'running') return 'Session running';
  if (indicatorState === 'ready') return 'Session has a new result';
  if (indicatorState === 'cancelled') return 'Session cancelled';
  return 'Session reviewed';
}

function createSessionItem(session, { showWorkspace = false, closeOnSelect = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `session-item${session.id === state.activeSessionId ? ' active' : ''}`;
  button.dataset.sessionId = session.id;

  const title = document.createElement('div');
  title.className = 'session-item-title';
  title.textContent = session.title || 'New chat';

  const indicatorState = getSessionIndicatorState(session);
  const meta = document.createElement('div');
  meta.className = `session-item-meta${indicatorState === 'running' ? ' running' : ''}${indicatorState === 'cancelled' ? ' cancelled' : ''}`;

  const time = document.createElement('span');
  time.className = 'session-item-time';
  time.textContent = formatSessionListStatus(session);
  meta.appendChild(time);

  const status = document.createElement('span');
  status.className = `session-status-dot ${indicatorState}`;
  status.title = getSessionIndicatorTitle(indicatorState);
  status.setAttribute('aria-label', getSessionIndicatorLabel(indicatorState));
  meta.appendChild(status);

  if (showWorkspace && session.workspaceRoot) {
    const separator = document.createElement('span');
    separator.className = 'session-item-separator';
    separator.textContent = '·';

    const workspace = document.createElement('span');
    workspace.className = 'session-item-workspace';
    workspace.textContent = displayWorkspaceName(session.workspaceRoot);

    meta.appendChild(separator);
    meta.appendChild(workspace);
  }

  const metricsText = formatCompactSessionMetrics(session.metrics);
  if (metricsText) {
    const separator = document.createElement('span');
    separator.className = 'session-item-separator';
    separator.textContent = '·';

    const usage = document.createElement('span');
    usage.className = 'session-item-usage';
    usage.textContent = metricsText;
    usage.title = buildSessionMetricsTitle(session.metrics);

    meta.appendChild(separator);
    meta.appendChild(usage);
  }

  button.appendChild(title);
  button.appendChild(meta);
  button.addEventListener('click', async () => {
    markSessionReviewed(session);
    renderSessions();
    const selected = await selectSession(session.id);
    if (selected && closeOnSelect) closeSessionsPane();
  });
  return button;
}

function formatSessionDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' }).format(date);
}

function formatSessionClock(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatDateTime(value) {
  const date = formatSessionDate(value);
  const time = formatSessionClock(value);
  return [date, time].filter(Boolean).join(' ');
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
  if (isSettingsTabActive('skills')) renderSkillsPane();
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

async function ensureCanSendNow(text) {
  try {
    const concurrency = await window.yolo.getConcurrencyState();
    state.concurrency = {
      ...state.concurrency,
      ...normalizeConcurrencyState(concurrency),
      pendingText: text
    };
    renderRunningSessions();
    if (state.concurrency.runningCount < state.concurrency.maxConcurrency) return true;
    openConcurrencyModal(text);
    return false;
  } catch (error) {
    setStatus(error.message || 'Failed to check session concurrency');
    return true;
  }
}

function openConcurrencyModal(pendingText) {
  if (!els.concurrencyModal) return;
  const running = getRunningSessionsForDisplay();
  const max = normalizeMaxConcurrency(state.concurrency.maxConcurrency, state.settings.maxConcurrency);
  state.concurrency.pendingText = pendingText;
  if (els.concurrencyModalSummary) {
    els.concurrencyModalSummary.textContent = `${running.length} / ${max} sessions are running. Terminate one blocking session to send this message now, or cancel and wait.`;
  }
  if (els.concurrencyBlockersList) {
    els.concurrencyBlockersList.innerHTML = '';
    if (!running.length) {
      els.concurrencyBlockersList.innerHTML = '<div class="sessions-empty table-empty">No blocking sessions found. Try Send again.</div>';
    } else {
      for (const session of running) els.concurrencyBlockersList.appendChild(createRunningSessionItem(session, { pendingText }));
    }
  }
  els.concurrencyModal.classList.remove('hidden');
}

function closeConcurrencyModal() {
  if (els.concurrencyModal) els.concurrencyModal.classList.add('hidden');
  state.concurrency.pendingText = '';
}

async function sendPrompt(providedText) {
  const text = (providedText ?? getPromptText()).trim();
  if (!text || state.busy) return;

  const canSend = await ensureCanSendNow(text);
  if (!canSend) return;

  const runSessionId = state.activeSessionId;
  state.stickToBottom = true;
  state.busy = true;
  updateBusyUi();
  clearPrompt();
  autoGrowPrompt();
  setStatus('Thinking…');

  removeWelcome();
  const optimisticUser = addMessage('user', text);
  state.currentAssistant = addAssistantShell();
  let runCancelled = false;

  try {
    updateLocalSessionAfterSend(text, runSessionId);
    const response = await window.yolo.sendMessage(runSessionId, text);
    if (state.activeSessionId === runSessionId && response?.content && state.currentAssistant && isAssistantShellEmpty(state.currentAssistant)) {
      setAssistantContent(state.currentAssistant, response.content || '(no response)');
    }
  } catch (error) {
    const errorText = displayError(error);
    if (/max concurrent sessions reached/i.test(errorText)) {
      if (state.activeSessionId === runSessionId) {
        setPromptText(text);
        autoGrowPrompt();
        if (state.currentAssistant && isAssistantShellEmpty(state.currentAssistant)) {
          state.currentAssistant.message.remove();
          removeHistoryItem(state.currentAssistant.historyItem);
        }
        optimisticUser?.message?.remove();
        removeHistoryItem(optimisticUser?.historyItem);
        state.currentAssistant = null;
        await refreshConcurrencyState();
        openConcurrencyModal(text);
      }
    } else if (isCancellationMessage(errorText) && state.activeSessionId === runSessionId) {
      runCancelled = true;
      markPendingToolsCancelled(state.currentAssistant);
      setStatus('Cancelled');
    } else if (state.activeSessionId === runSessionId) {
      renderAssistantError(errorText);
    }
  } finally {
    state.sessions = state.sessions.map((session) => {
      if (session.id !== runSessionId) return session;
      const cancelled = runCancelled || getSessionStatus(session) === 'cancelled';
      return { ...session, busy: false, status: cancelled ? 'cancelled' : 'idle' };
    });
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
    const next = { ...session, title: nextTitle, busy: true, status: 'running', updatedAt: new Date().toISOString() };
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
  const cancelSessionId = state.activeSessionId;
  els.cancelBtn.disabled = true;
  setStatus('Cancelling…');
  markPendingToolsCancelled(state.currentAssistant);

  try {
    const result = await window.yolo.cancelRun(cancelSessionId);
    restoreQueuedToEditor(result?.queued);
    state.sessions = state.sessions.map((session) => session.id === cancelSessionId ? { ...session, busy: false, status: 'cancelled' } : session);
    if (state.activeSessionId === cancelSessionId) {
      state.busy = false;
      updateBusyUi();
      setStatus('Cancelled');
    }
    renderSessions();
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

function recordHistoryItem(item) {
  if (state.chatRender.renderingHistory || !item) return null;
  state.chatRender.items.push(item);
  return item;
}

function removeHistoryItem(item) {
  if (!item) return;
  const index = state.chatRender.items.indexOf(item);
  if (index === -1) return;
  state.chatRender.items.splice(index, 1);
  state.chatRender.renderedStart = Math.min(state.chatRender.renderedStart, state.chatRender.items.length);
}

function assistantHistoryItemHasDisplay(item = {}) {
  return String(item.content || item.thinking || item.error || '').trim() || (item.tools || []).length > 0;
}

function addMessage(role, content, options = {}) {
  const message = document.createElement('article');
  message.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'you' : 'ya';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  let thinking;
  if (role === 'assistant' && String(options.thinking || '').trim()) {
    thinking = createThinkingBlock();
    setRenderedText(thinking.content, options.thinking, { limit: THINKING_TEXT_COLLAPSE_CHARS, label: 'thinking' });
    thinking.root.hidden = false;
    message.classList.add('has-thinking');
    bubble.appendChild(thinking.root);
  }

  const contentEl = document.createElement('div');
  contentEl.className = 'content';
  setRenderedText(contentEl, content);

  bubble.appendChild(contentEl);
  message.appendChild(avatar);
  message.appendChild(bubble);
  els.messages.appendChild(message);
  const historyItem = recordHistoryItem({ type: 'message', role, content });
  scrollToBottom();
  return { message, bubble, thinking: thinking?.root, thinkingContent: thinking?.content, content: contentEl, historyItem };
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
  const historyItem = recordHistoryItem({ type: 'skill', skillBlock });
  scrollToBottom();
  return { message, bubble, content: contentEl, historyItem };
}

function createThinkingBlock() {
  const root = document.createElement('div');
  root.className = 'thinking-block';
  root.hidden = true;

  const label = document.createElement('div');
  label.className = 'thinking-label';
  label.textContent = 'Thinking';

  const content = document.createElement('div');
  content.className = 'thinking-content';

  root.appendChild(label);
  root.appendChild(content);
  return { root, content };
}

function addAssistantShell() {
  const message = document.createElement('article');
  message.className = 'message assistant';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = 'ya';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const thinking = createThinkingBlock();

  const activity = document.createElement('div');
  activity.className = 'activity';

  const content = document.createElement('div');
  content.className = 'content';

  bubble.appendChild(thinking.root);
  bubble.appendChild(activity);
  bubble.appendChild(content);
  message.appendChild(avatar);
  message.appendChild(bubble);
  els.messages.appendChild(message);
  const historyItem = recordHistoryItem({ type: 'assistant', content: '', thinking: '', tools: [], error: '' });
  scrollToBottom();

  return { message, bubble, thinking: thinking.root, thinkingContent: thinking.content, activity, content, tools: new Map(), historyItem };
}

function ensureAssistantShell() {
  if (!state.currentAssistant) state.currentAssistant = addAssistantShell();
  return state.currentAssistant;
}

function setAssistantThinking(shell, thinkingText) {
  const text = String(thinkingText || '').trim();
  if (!shell?.thinking || !shell?.thinkingContent || !text) return;

  setRenderedText(shell.thinkingContent, text, { limit: THINKING_TEXT_COLLAPSE_CHARS, label: 'thinking' });
  if (shell.historyItem) shell.historyItem.thinking = text;
  shell.thinking.hidden = false;
  shell.message.classList.add('has-thinking');
}

function setAssistantContent(shell, contentText) {
  if (!shell?.content) return;
  const text = String(contentText || '');
  setRenderedText(shell.content, text || '(no response)');
  if (shell.historyItem) shell.historyItem.content = text;
}

function markAssistantHasActivity(shell) {
  if (shell?.message) shell.message.classList.add('has-activity');
}

function isAssistantShellEmpty(shell) {
  return !shell.content.textContent.trim()
    && !shell.thinkingContent?.textContent?.trim()
    && shell.activity.childElementCount === 0;
}

function addAssistantError(error) {
  renderAssistantError(error);
}

function renderAssistantError(error) {
  removeWelcome();
  const errorText = displayError(error);
  const shell = ensureAssistantShell();
  if (shell.errorText === errorText) return;
  markPendingToolsFailed(shell, errorText);
  shell.content.innerHTML = `<span class="error-text">Error: ${escapeHtml(errorText)}</span>`;
  if (shell.historyItem) shell.historyItem.error = errorText;
  shell.message.classList.add('has-error');
  shell.errorText = errorText;
  setStatus(`Error: ${errorText}`);
  scrollToBottom();
}

function displayError(error) {
  const message = error?.message || String(error);
  return message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
    .replace(/^Error:\s*/, '');
}

function isCancellationMessage(message) {
  return /\b(abort(?:ed)?|cancelled|canceled)\b/i.test(String(message || ''));
}

function handleAgentEvent(event) {
  if (!event) return;

  if (event.type === 'sessions:update') {
    state.sessions = event.sessions || [];
    ensureSessionReviewBaseline();
    state.concurrency.runningSessions = state.sessions.filter((session) => session.busy);
    state.concurrency.runningCount = state.concurrency.runningSessions.length;
    const active = state.sessions.find((session) => session.id === state.activeSessionId);
    if (active) {
      state.activeSession = active;
      state.busy = !!active.busy;
      renderSessionMetrics();
      updateBusyUi();
    }
    renderSessions();
    renderWorkspaceSelect();
    renderRunningSessions();
    return;
  }

  if (event.type === 'session:metrics') {
    applySessionMetricsEvent(event);
    return;
  }

  if (event.sessionId && event.sessionId !== state.activeSessionId) {
    return;
  }

  if (event.type === 'status') {
    setStatus(event.message || 'Ready');
    return;
  }

  if (event.type === 'run:error') {
    renderAssistantError(event.message || 'Run failed');
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

  if (event.type === 'assistant:thinking') {
    const shell = ensureAssistantShell();
    setAssistantThinking(shell, event.content || '');
    scrollToBottom();
    return;
  }

  if (event.type === 'assistant:content') {
    const shell = ensureAssistantShell();
    setAssistantContent(shell, event.content || '(no response)');
    scrollToBottom();
    return;
  }

  if (event.type === 'user:delivered') {
    if (state.currentAssistant && isAssistantShellEmpty(state.currentAssistant)) {
      state.currentAssistant.message.remove();
      removeHistoryItem(state.currentAssistant.historyItem);
    }
    addMessage('user', event.text || '');
    state.currentAssistant = addAssistantShell();
    return;
  }

  if (event.type === 'skill:used') {
    const shell = ensureAssistantShell();
    shell.activity.appendChild(createSkillActivityItem(event));
    markAssistantHasActivity(shell);
    scrollToBottom();
    return;
  }

  if (event.type === 'tool:start') {
    const shell = ensureAssistantShell();
    const item = createToolItem(event);
    shell.tools.set(event.id, item);
    shell.activity.appendChild(item.root);
    trackAssistantHistoryTool(shell, item, event, { status: 'pending' });
    markAssistantHasActivity(shell);
    scrollToBottom();
  }

  if (event.type === 'tool:result') {
    const shell = ensureAssistantShell();
    const item = shell.tools.get(event.id) || createToolItem(event);
    if (!shell.tools.has(event.id)) {
      shell.tools.set(event.id, item);
      shell.activity.appendChild(item.root);
    }
    markAssistantHasActivity(shell);
    const ok = event.result?.ok !== false;
    item.name = event.name || item.name;
    item.args = event.args || item.args || {};
    item.root.classList.remove('pending', 'cancelled');
    item.root.classList.add(ok ? 'ok' : 'error');
    item.summary.textContent = compactToolLabel(item.name, item.args, event.result?.summary || (ok ? 'Completed' : 'Failed'));
    if (event.result?.preview) {
      item.root.classList.add('has-preview');
      item.root.title = 'Click to show or hide tool output';
      item.preview.textContent = event.result.preview;
    }
    trackAssistantHistoryTool(shell, item, event, { status: ok ? 'ok' : 'error', result: event.result });
    scrollToBottom();
    return;
  }

  if (event.type === 'tool:cancelled') {
    const shell = ensureAssistantShell();
    const item = shell.tools.get(event.id) || createToolItem(event);
    if (!shell.tools.has(event.id)) {
      shell.tools.set(event.id, item);
      shell.activity.appendChild(item.root);
    }
    markAssistantHasActivity(shell);
    markToolCancelled(item, event);
    trackAssistantHistoryTool(shell, item, event, { status: 'cancelled', result: event.result || { ok: false, summary: 'Cancelled' } });
    scrollToBottom();
    return;
  }
}

function applySessionMetricsEvent(event) {
  const sessionId = event.sessionId;
  if (!sessionId) return;
  const incoming = event.session || { id: sessionId, metrics: event.metrics };
  state.sessions = state.sessions.map((session) => session.id === sessionId
    ? { ...session, ...incoming, metrics: event.metrics || incoming.metrics || session.metrics }
    : session);

  if (!state.sessions.some((session) => session.id === sessionId) && incoming.id) {
    state.sessions.unshift(incoming);
  }

  if (sessionId === state.activeSessionId) {
    state.activeSession = {
      ...(state.activeSession || {}),
      ...incoming,
      metrics: event.metrics || incoming.metrics || state.activeSession?.metrics
    };
    state.busy = !!state.activeSession.busy;
    renderSessionMetrics();
    updateBusyUi();
  }

  renderSessions();
  renderRunningSessions();
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

function markPendingToolsCancelled(shell = state.currentAssistant) {
  if (!shell?.tools) return;
  for (const item of shell.tools.values()) {
    if (!item?.root?.classList.contains('pending')) continue;
    markToolCancelled(item);
    trackAssistantHistoryTool(shell, item, {}, { status: 'cancelled', result: { ok: false, summary: 'Cancelled' } });
  }
}

function markPendingToolsFailed(shell = state.currentAssistant, message = 'Failed') {
  if (!shell?.tools) return;
  for (const item of shell.tools.values()) {
    if (!item?.root?.classList.contains('pending')) continue;
    item.root.classList.remove('pending', 'ok', 'cancelled');
    item.root.classList.add('error');
    item.summary.textContent = compactToolLabel(item.name, item.args, 'Failed');
    if (item.preview) {
      item.root.classList.add('has-preview');
      item.root.title = 'Click to show or hide tool output';
      item.preview.textContent = message;
    }
    trackAssistantHistoryTool(shell, item, {}, { status: 'error', result: { ok: false, summary: 'Failed', preview: message } });
  }
}

function trackAssistantHistoryTool(shell, item, event = {}, patch = {}) {
  if (!shell?.historyItem || !item) return;
  const tools = Array.isArray(shell.historyItem.tools) ? shell.historyItem.tools : [];
  shell.historyItem.tools = tools;

  const id = event.id || item.id || item.historyTool?.id || `tool-${tools.length}`;
  let record = item.historyTool || tools.find((tool) => tool.id === id);
  if (!record) {
    record = { id, name: event.name || item.name || '', args: event.args || item.args || {}, status: 'pending' };
    tools.push(record);
  }

  record.id = id;
  record.name = event.name || item.name || record.name || '';
  record.args = event.args || item.args || record.args || {};
  Object.assign(record, patch);
  item.historyTool = record;
}

function markToolCancelled(item, event = {}) {
  if (!item?.root) return;
  item.name = event.name || item.name;
  item.args = event.args || item.args || {};
  item.root.classList.remove('pending', 'ok', 'error');
  item.root.classList.add('cancelled');
  item.summary.textContent = compactToolLabel(item.name, item.args, event.result?.summary || 'Cancelled');
}

function addAssistantHistoryMessage(item = {}) {
  const { content = '', thinking = '', tools = [], error = '' } = item;
  const shell = addAssistantShell();
  shell.historyItem = item;
  if (thinking) setAssistantThinking(shell, thinking);
  for (const [index, tool] of tools.entries()) {
    const item = createToolItem({
      id: tool.id || `history-tool-${Date.now()}-${index}`,
      name: tool.name,
      args: tool.args || {}
    });
    item.historyTool = tool;
    shell.tools.set(tool.id || item.id || `history-tool-${index}`, item);
    shell.activity.appendChild(item.root);
    markAssistantHasActivity(shell);
    applyToolHistoryState(item, tool);
  }
  if (error) {
    shell.content.innerHTML = `<span class="error-text">Error: ${escapeHtml(displayError(error))}</span>`;
    shell.message.classList.add('has-error');
  } else if (content) {
    setRenderedText(shell.content, content);
  }
  state.currentAssistant = null;
  scrollToBottom();
  return shell;
}

function applyToolHistoryState(item, tool = {}) {
  if (!item?.root) return;
  const status = String(tool.status || '').toLowerCase();
  item.name = tool.name || item.name;
  item.args = tool.args || item.args || {};

  if (status === 'cancelled' || status === 'canceled') {
    markToolCancelled(item, { name: item.name, args: item.args, result: tool.result });
    return;
  }

  if (status === 'ok' || status === 'error' || tool.result) {
    const ok = status ? status === 'ok' : tool.result?.ok !== false;
    item.root.classList.remove('pending', 'cancelled');
    item.root.classList.add(ok ? 'ok' : 'error');
    item.summary.textContent = compactToolLabel(item.name, item.args, tool.result?.summary || (ok ? 'Completed' : 'Failed'));
    if (tool.result?.preview) {
      item.root.classList.add('has-preview');
      item.root.title = 'Click to show or hide tool output';
      item.preview.textContent = tool.result.preview;
    }
  }
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

  return { root, summary, preview, id: event.id || '', name: event.name, args: event.args || {} };
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

async function openSettings(tab = 'model') {
  els.apiBaseUrlInput.value = state.settings.apiBaseUrl || '';
  els.apiKeyInput.value = '';
  updateApiKeyUi();
  els.modelInput.value = state.settings.model || '';
  els.settingsThinkingLevelInput.value = normalizeThinkingLevel(state.settings.thinkingLevel);
  if (els.compatibilityPresetInput) els.compatibilityPresetInput.value = normalizeCompatibilityPreset(state.settings.compatibilityPreset);
  if (els.maxConcurrencyInput) els.maxConcurrencyInput.value = normalizeMaxConcurrency(state.settings.maxConcurrency);
  const compaction = normalizeCompactionSettings(state.settings.compaction);
  if (els.compactionEnabledInput) els.compactionEnabledInput.checked = compaction.enabled;
  if (els.compactionReserveTokensInput) els.compactionReserveTokensInput.value = compaction.reserveTokens;
  if (els.compactionKeepRecentTokensInput) els.compactionKeepRecentTokensInput.value = compaction.keepRecentTokens;
  if (els.guardrailsModeInput) els.guardrailsModeInput.value = getGuardrailsMode();
  renderToolsPane();
  els.settingsModal.classList.remove('hidden');
  await setSettingsTab(typeof tab === 'string' ? tab : 'model');
  if (tab === 'model') els.apiBaseUrlInput.focus();
}

function isSettingsTabActive(tab) {
  return !!els.settingsPanels.find((panel) => panel.dataset.settingsPanel === tab && !panel.classList.contains('hidden'));
}

async function setSettingsTab(tab = 'model', options = {}) {
  const nextTab = ['model', 'skills', 'tools', 'appearance', 'logs'].includes(tab) ? tab : 'model';
  els.settingsTabs.forEach((button) => {
    const active = button.dataset.settingsTab === nextTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  els.settingsPanels.forEach((panel) => {
    const active = panel.dataset.settingsPanel === nextTab;
    panel.classList.toggle('active', active);
    panel.classList.toggle('hidden', !active);
  });

  if (nextTab === 'skills' && options.loadSkills !== false) await loadSkillsPane();
  if (nextTab === 'tools') renderToolsPane();
  if (nextTab === 'logs') renderUpdateStatus();
}

async function openLogs() {
  try {
    const result = await window.yolo.openLogs();
    setStatus(result?.logPath ? `Opened logs: ${result.logPath}` : 'Opened logs');
  } catch (error) {
    addAssistantError(error);
  }
}

async function checkForUpdates() {
  if (!window.yolo.checkForUpdates) return;
  if (els.checkUpdatesBtn) els.checkUpdatesBtn.disabled = true;
  handleUpdateEvent({ type: 'checking', message: 'Checking for updates…', checking: true });

  try {
    const result = await window.yolo.checkForUpdates();
    if (result?.status) handleUpdateEvent(result.status);
    if (result?.error) setStatus(result.error);
    else if (result?.status?.message) setStatus(result.status.message);
  } catch (error) {
    handleUpdateEvent({ type: 'error', message: error.message || 'Failed to check for updates', checking: false });
    setStatus(error.message || 'Failed to check for updates');
  } finally {
    renderUpdateStatus();
  }
}

function handleUpdateEvent(event = {}) {
  state.updates = {
    ...state.updates,
    ...event,
    message: event.message || state.updates.message || 'Updates are idle.',
    checking: !!event.checking
  };
  renderUpdateStatus();
}

function renderUpdateStatus() {
  if (els.updatesStatus) {
    const pieces = [state.updates.message || 'Updates are idle.'];
    if (state.updates.updatedAt) pieces.push(`Last update check: ${formatDateTime(state.updates.updatedAt)}`);
    els.updatesStatus.textContent = pieces.join(' ');
  }

  if (els.checkUpdatesBtn) {
    els.checkUpdatesBtn.disabled = !!state.updates.checking;
    els.checkUpdatesBtn.textContent = state.updates.type === 'downloading'
      ? 'Downloading…'
      : state.updates.checking ? 'Checking…' : 'Check for updates';
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
    const label = isLight ? 'Switch to dark mode' : 'Switch to light mode';
    const status = els.themeToggleBtn.querySelector('span');
    if (status) status.textContent = isLight ? 'Light mode' : 'Dark mode';
    else els.themeToggleBtn.textContent = isLight ? 'Light mode' : 'Dark mode';
    els.themeToggleBtn.title = label;
    els.themeToggleBtn.setAttribute('aria-label', label);
    els.themeToggleBtn.setAttribute('aria-pressed', String(isLight));
  }
}

async function saveSettings() {
  const apiKey = els.apiKeyInput.value.trim();
  const next = {
    apiBaseUrl: els.apiBaseUrlInput.value.trim(),
    model: els.modelInput.value.trim(),
    thinkingLevel: normalizeThinkingLevel(els.settingsThinkingLevelInput.value),
    compatibilityPreset: normalizeCompatibilityPreset(els.compatibilityPresetInput?.value),
    maxConcurrency: normalizeMaxConcurrency(els.maxConcurrencyInput?.value, state.settings.maxConcurrency),
    guardrails: {
      mode: normalizeGuardrailsMode(els.guardrailsModeInput?.value)
    },
    tools: collectToolSettingsFromUi(),
    compaction: collectCompactionSettingsFromUi()
  };

  try {
    state.settings = await window.yolo.saveSettings(next);
    if (apiKey) state.settings = await window.yolo.saveApiKey(apiKey);
    if (els.apiKeyInput) els.apiKeyInput.value = '';
    state.concurrency.maxConcurrency = normalizeMaxConcurrency(state.settings.maxConcurrency);
    updateApiKeyUi();
    renderChrome();
    renderRunningSessions();
    closeSettings();
    setStatus(apiKey ? 'Settings and API key saved' : 'Settings saved');
  } catch (error) {
    setStatus(error.message || 'Failed to save settings');
  }
}

function collectCompactionSettingsFromUi() {
  const current = normalizeCompactionSettings(state.settings.compaction);
  return normalizeCompactionSettings({
    enabled: els.compactionEnabledInput ? els.compactionEnabledInput.checked : current.enabled,
    reserveTokens: els.compactionReserveTokensInput ? els.compactionReserveTokensInput.value : current.reserveTokens,
    keepRecentTokens: els.compactionKeepRecentTokensInput ? els.compactionKeepRecentTokensInput.value : current.keepRecentTokens
  }, current);
}

async function clearApiKey() {
  if (!state.settings.apiKeyConfigured) {
    if (els.apiKeyInput) els.apiKeyInput.value = '';
    updateApiKeyUi();
    setStatus('No saved API key to clear');
    return;
  }

  try {
    state.settings = await window.yolo.clearApiKey();
    if (els.apiKeyInput) els.apiKeyInput.value = '';
    updateApiKeyUi();
    renderChrome();
    setStatus('API key cleared');
  } catch (error) {
    setStatus(error.message || 'Failed to clear API key');
  }
}

function updateApiKeyUi() {
  const configured = !!state.settings.apiKeyConfigured;
  if (els.apiKeyInput) {
    els.apiKeyInput.placeholder = configured ? 'Configured — leave blank to keep current key' : 'yolo_…';
  }
  if (els.apiKeyStatus) {
    els.apiKeyStatus.textContent = configured
      ? 'API key is configured and is not shown here. Saved keys live in your YOLO Auto home folder.'
      : 'No API key saved. Enter one to store it in your YOLO Auto home folder.';
  }
  if (els.clearApiKeyBtn) {
    els.clearApiKeyBtn.disabled = !configured;
    els.clearApiKeyBtn.textContent = configured ? 'Clear API key' : 'No API key saved';
  }
}

function autoGrowPrompt() {
  els.promptInput.style.height = 'auto';
  els.promptInput.style.height = `${Math.min(180, Math.max(42, els.promptInput.scrollHeight))}px`;
  updateReturnToBottomButton();
}

function setStatus(message) {
  const text = message || 'Ready';
  els.statusText.textContent = text;
  updateStatusIndicator(text);
}

function updateStatusIndicator(message) {
  if (!els.statusIndicator) return;
  const level = getStatusLevel(message);
  els.statusIndicator.classList.toggle('status-ok', level === 'ok');
  els.statusIndicator.classList.toggle('status-warn', level === 'warn');
  els.statusIndicator.classList.toggle('status-error', level === 'error');
  els.statusIndicator.classList.toggle('status-working', level === 'warn' && isWorkingStatus(message));
}

function getStatusLevel(message) {
  const text = String(message || '').toLowerCase();
  if (/cancelled|canceled/.test(text)) return 'warn';
  if (/error|failed|failure|blocked|denied|not found/.test(text)) return 'error';
  if (/thinking|working|running|queue|cancell?ing|compact|retrying|waiting|preparing|loading|saving|refreshing|approv/.test(text)) return 'warn';
  return 'ok';
}

function isWorkingStatus(message) {
  const text = String(message || '').toLowerCase();
  return state.busy || /thinking|working|running|queue|cancell?ing|compact|retrying|waiting|preparing|loading|saving|refreshing/.test(text);
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

function renderMessagesFromHistory(messages = [], options = {}) {
  const items = normalizeHistoryMessages(messages);
  state.chatRender.items = items;
  state.chatRender.renderedStart = Math.max(0, items.length - CHAT_HISTORY_PAGE_SIZE);
  state.chatRender.partialAssistantText = String(options.partialAssistantText || '').trim();
  state.chatRender.partialAssistantThinkingText = String(options.partialAssistantThinkingText || '').trim();
  renderVisibleHistory({ forceBottom: true });
}

function normalizeHistoryMessages(messages = []) {
  const items = [];

  for (const message of messages) {
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      const skillBlock = parseSkillBlock(message.content);
      if (skillBlock) {
        items.push({ type: 'skill', skillBlock });
        if (skillBlock.userMessage) items.push({ type: 'message', role: 'user', content: skillBlock.userMessage });
      } else {
        items.push({ type: 'message', role: 'user', content: message.content });
      }
    } else if (message?.role === 'assistant') {
      const content = typeof message.content === 'string' ? message.content : '';
      const thinking = typeof message.thinking === 'string' ? message.thinking : '';
      const tools = Array.isArray(message.tools) ? message.tools : [];
      const error = typeof message.error === 'string' ? message.error : '';
      if (content.trim() || thinking.trim() || tools.length || error.trim()) {
        items.push({ type: 'assistant', content, thinking, tools, error });
      }
    }
  }

  return items;
}

function renderVisibleHistory(options = {}) {
  const items = state.chatRender.items || [];
  const start = Math.max(0, Math.min(state.chatRender.renderedStart || 0, items.length));
  const previousScrollHeight = els.messages.scrollHeight;
  const previousScrollTop = els.messages.scrollTop;

  els.messages.innerHTML = '';
  state.currentAssistant = null;

  if (items.length === 0) {
    clearMessages();
    return;
  }

  state.chatRender.renderingHistory = true;
  if (start > 0) els.messages.appendChild(createHistoryPager(start));

  let lastDisplayRole = '';
  let lastAssistantShell = null;
  for (const item of items.slice(start)) {
    if (item.type === 'skill') {
      addSkillMessage(item.skillBlock);
      lastDisplayRole = 'skill';
      lastAssistantShell = null;
    } else if (item.type === 'message') {
      addMessage(item.role, item.content);
      lastDisplayRole = item.role;
      lastAssistantShell = null;
    } else if (item.type === 'assistant' && (state.busy || assistantHistoryItemHasDisplay(item))) {
      lastAssistantShell = addAssistantHistoryMessage(item);
      lastDisplayRole = 'assistant';
    }
  }
  state.chatRender.renderingHistory = false;

  if (state.busy) {
    state.currentAssistant = lastDisplayRole === 'assistant' && lastAssistantShell
      ? lastAssistantShell
      : addAssistantShell();
    if (state.chatRender.partialAssistantThinkingText) {
      setAssistantThinking(state.currentAssistant, state.chatRender.partialAssistantThinkingText);
    }
    if (state.chatRender.partialAssistantText) {
      setAssistantContent(state.currentAssistant, state.chatRender.partialAssistantText);
    }
  }

  if (options.forceBottom) {
    scrollToBottom({ force: true });
  } else if (options.preserveScroll) {
    els.messages.scrollTop = previousScrollTop + (els.messages.scrollHeight - previousScrollHeight);
    updateReturnToBottomButton();
  } else {
    updateReturnToBottomButton();
  }
}

function createHistoryPager(hiddenCount) {
  const wrap = document.createElement('div');
  wrap.className = 'history-pager-wrap';

  const button = document.createElement('button');
  button.className = 'history-pager';
  button.type = 'button';
  button.textContent = `Load ${Math.min(CHAT_HISTORY_PAGE_SIZE, hiddenCount)} older messages (${hiddenCount} hidden)`;
  button.addEventListener('click', () => loadOlderMessages());

  wrap.appendChild(button);
  return wrap;
}

function loadOlderMessages() {
  const previousStart = state.chatRender.renderedStart || 0;
  if (previousStart <= 0) return;
  state.chatRender.renderedStart = Math.max(0, previousStart - CHAT_HISTORY_PAGE_SIZE);
  renderVisibleHistory({ preserveScroll: true });
}

function clearMessages() {
  state.stickToBottom = true;
  state.chatRender.items = [];
  state.chatRender.renderedStart = 0;
  state.chatRender.partialAssistantText = '';
  state.chatRender.partialAssistantThinkingText = '';
  state.chatRender.renderingHistory = false;
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
  scrollToBottom({ force: true });
}

function removeWelcome() {
  const welcome = els.messages.querySelector('.welcome-card');
  if (welcome) welcome.remove();
}

function handleMessagesScroll() {
  const nearBottom = isNearBottom();
  if (nearBottom || !state.autoScroll.programmatic) state.stickToBottom = nearBottom;
  updateReturnToBottomButton();
}

function markMessagesUserInteraction() {
  if (!state.autoScroll) return;
  state.autoScroll.userInteracting = true;
  state.autoScroll.pendingSticky = false;
  state.autoScroll.framesRemaining = 0;
  state.autoScroll.force = false;
  state.autoScroll.programmatic = false;
  if (!isNearBottom()) state.stickToBottom = false;
  if (state.autoScroll.frameId) cancelAnimationFrame(state.autoScroll.frameId);
  state.autoScroll.frameId = 0;
  if (state.autoScroll.programmaticTimer) window.clearTimeout(state.autoScroll.programmaticTimer);
  state.autoScroll.programmaticTimer = 0;
  if (state.autoScroll.interactionTimer) window.clearTimeout(state.autoScroll.interactionTimer);
  state.autoScroll.interactionTimer = window.setTimeout(() => {
    state.autoScroll.userInteracting = false;
    state.autoScroll.interactionTimer = 0;
  }, AUTO_SCROLL_INTERACTION_PAUSE_MS);
}

function clearMessagesUserInteraction() {
  if (!state.autoScroll) return;
  state.autoScroll.userInteracting = false;
  if (state.autoScroll.interactionTimer) window.clearTimeout(state.autoScroll.interactionTimer);
  state.autoScroll.interactionTimer = 0;
}

function isNearBottom() {
  if (!els.messages) return true;
  const distance = Math.max(0, els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight);
  return distance <= BOTTOM_SCROLL_THRESHOLD;
}

function updateReturnToBottomButton() {
  if (!els.returnToBottomBtn || !els.messages) return;
  const canScroll = els.messages.scrollHeight > els.messages.clientHeight + BOTTOM_SCROLL_THRESHOLD;
  const show = canScroll && !isNearBottom();
  els.returnToBottomBtn.classList.toggle('hidden', !show);
  if (els.composerWrap) {
    els.returnToBottomBtn.style.bottom = `${els.composerWrap.offsetHeight + 18}px`;
  }
}

function scrollToBottom(options = {}) {
  if (!els.messages) return;
  const force = options === true || options.force === true;
  if (state.chatRender.renderingHistory && !force) return;
  const shouldStick = force || state.stickToBottom || state.autoScroll.pendingSticky || isNearBottom();

  if (force) {
    state.stickToBottom = true;
    clearMessagesUserInteraction();
  }

  if (!shouldStick) {
    updateReturnToBottomButton();
    return;
  }

  state.autoScroll.pendingSticky = true;
  state.autoScroll.force = state.autoScroll.force || force;
  state.autoScroll.framesRemaining = Math.max(
    state.autoScroll.framesRemaining,
    force ? 1 : AUTO_SCROLL_SETTLE_FRAMES
  );
  scheduleAutoScrollFrame();
}

function scheduleAutoScrollFrame() {
  if (state.autoScroll.frameId) return;
  state.autoScroll.frameId = requestAnimationFrame(runAutoScrollFrame);
}

function runAutoScrollFrame() {
  state.autoScroll.frameId = 0;
  const force = state.autoScroll.force;
  state.autoScroll.force = false;

  const shouldScroll = state.autoScroll.pendingSticky && (force || !state.autoScroll.userInteracting);
  if (shouldScroll && els.messages) {
    state.autoScroll.programmatic = true;
    els.messages.scrollTop = els.messages.scrollHeight;
    state.stickToBottom = true;
    if (state.autoScroll.programmaticTimer) window.clearTimeout(state.autoScroll.programmaticTimer);
    state.autoScroll.programmaticTimer = window.setTimeout(() => {
      state.autoScroll.programmatic = false;
      state.autoScroll.programmaticTimer = 0;
    }, AUTO_SCROLL_PROGRAMMATIC_RESET_MS);
  }

  state.autoScroll.framesRemaining = Math.max(0, state.autoScroll.framesRemaining - 1);
  if (shouldScroll && state.autoScroll.framesRemaining > 0) {
    scheduleAutoScrollFrame();
  } else {
    state.autoScroll.pendingSticky = false;
    state.autoScroll.framesRemaining = 0;
  }

  updateReturnToBottomButton();
}

function setRenderedText(element, text, options = {}) {
  if (!element) return;
  const source = String(text || '');
  const limit = Math.max(1_000, Number(options.limit) || MESSAGE_TEXT_COLLAPSE_CHARS);
  const label = options.label || 'message';
  const isLong = source.length > limit;
  const expanded = isLong && element._yoloExpanded === true;
  const displayText = isLong && !expanded ? createTextPreview(source, limit) : source;

  element.innerHTML = renderText(displayText);
  element._yoloSourceText = source;

  if (!isLong) {
    element._yoloExpanded = false;
    return;
  }

  const notice = document.createElement('div');
  notice.className = 'message-truncation';

  const summary = document.createElement('span');
  summary.textContent = expanded
    ? `${capitalize(label)} expanded (${formatNumber(source.length)} chars).`
    : `${capitalize(label)} preview only; ${formatNumber(source.length - displayText.length)} chars hidden.`;

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = expanded ? 'Collapse' : 'Show full';
  button.addEventListener('click', () => {
    element._yoloExpanded = !expanded;
    setRenderedText(element, source, options);
    scrollToBottom();
  });

  notice.appendChild(summary);
  notice.appendChild(button);
  element.appendChild(notice);
}

function createTextPreview(text, limit) {
  const source = String(text || '');
  if (source.length <= limit) return source;
  const headLength = Math.min(MESSAGE_PREVIEW_HEAD_CHARS, Math.floor(limit * 0.68), source.length);
  const tailLength = Math.min(MESSAGE_PREVIEW_TAIL_CHARS, Math.max(1_000, limit - headLength), Math.max(0, source.length - headLength));
  const hidden = Math.max(0, source.length - headLength - tailLength);
  return [
    source.slice(0, headLength).trimEnd(),
    '',
    `… ${formatNumber(hidden)} chars hidden. Click “Show full” to render the entire message. …`,
    '',
    source.slice(source.length - tailLength).trimStart()
  ].join('\n');
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Math.max(0, Number(value) || 0));
}

function capitalize(value) {
  const text = String(value || '');
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '';
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
    const token = `<!--INLINECODE${inlineCode.length}-->`;
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

  return html.replace(/<!--INLINECODE(\d+)-->/g, (_match, index) => inlineCode[Number(index)] || '');
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
