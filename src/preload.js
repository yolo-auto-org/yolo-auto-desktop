const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yolo', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  saveApiKey: (apiKey) => ipcRenderer.invoke('settings:save-api-key', apiKey),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-api-key'),
  selectWorkspace: () => ipcRenderer.invoke('workspace:select'),
  setWorkspace: (workspaceRoot) => ipcRenderer.invoke('workspace:set', workspaceRoot),
  revealWorkspace: () => ipcRenderer.invoke('workspace:reveal'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  fileSuggestions: (sessionId, query) => ipcRenderer.invoke('workspace:file-suggestions', sessionId, query),
  skillSuggestions: (sessionId, query) => ipcRenderer.invoke('skills:suggestions', sessionId, query),
  listSkills: (sessionId) => ipcRenderer.invoke('skills:list', sessionId),
  setSkillEnabled: (sessionId, skillName, enabled) => ipcRenderer.invoke('skills:set-enabled', sessionId, skillName, enabled),
  setExtraSkillDirs: (sessionId, extraDirs) => ipcRenderer.invoke('skills:set-extra-dirs', sessionId, extraDirs),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getConcurrencyState: () => ipcRenderer.invoke('sessions:concurrency'),
  createSession: () => ipcRenderer.invoke('sessions:create'),
  selectSession: (sessionId) => ipcRenderer.invoke('sessions:select', sessionId),
  setSessionThinkingLevel: (sessionId, thinkingLevel) => ipcRenderer.invoke('sessions:set-thinking-level', sessionId, thinkingLevel),
  deleteSession: (sessionId) => ipcRenderer.invoke('sessions:delete', sessionId),
  sendMessage: (sessionId, message) => ipcRenderer.invoke('chat:send', sessionId, message),
  steer: (sessionId, message) => ipcRenderer.invoke('chat:steer', sessionId, message),
  followUp: (sessionId, message) => ipcRenderer.invoke('chat:follow-up', sessionId, message),
  cancelRun: (sessionId) => ipcRenderer.invoke('chat:cancel', sessionId),
  resetChat: (sessionId) => ipcRenderer.invoke('chat:reset', sessionId),
  onAgentEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  }
});
