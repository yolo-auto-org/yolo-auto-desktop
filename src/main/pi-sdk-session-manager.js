const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { shouldAskCommandApproval } = require('./command-guardrails');
const { normalizeMaxConcurrency } = require('./settings');

const PI_PROVIDER = 'yolo-openai-compatible';
const DEFAULT_MODEL = 'gpt-4.1-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const TOOL_TEXT_LIMIT = 50_000;
const WEB_MAX_RESPONSE_BYTES = 8_000_000;
const EMPTY_RESPONSE_RETRY_PROMPT = 'The previous turn produced no user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.';
const MODEL_COMPATIBILITY_PRESETS = new Set(['openai', 'local-basic']);

class PiSdkSessionManager {
  constructor({ userDataDir, agentDir, getSettings, getDefaultWorkspaceRoot, emit, requestCommandApproval, log }) {
    this.userDataDir = userDataDir;
    this.agentDir = agentDir;
    this.sessionDir = path.join(userDataDir, 'pi-sessions');
    this.getSettings = getSettings;
    this.getDefaultWorkspaceRoot = getDefaultWorkspaceRoot;
    this.emit = emit || (() => {});
    this.requestCommandApproval = typeof requestCommandApproval === 'function' ? requestCommandApproval : async () => false;
    this.log = typeof log === 'function' ? log : () => {};
    this.sdkPromise = null;
    this.typeboxPromise = null;
    this.customToolsPromise = null;
    this.active = null;
    this.runtimes = new Map();
    this.sessionIndex = new Map();
    this.browserTabs = new Map();
    this.browserNextTabId = 1;
  }

  async sdk() {
    if (!this.sdkPromise) this.sdkPromise = import('@earendil-works/pi-coding-agent');
    return this.sdkPromise;
  }

  async typebox() {
    if (!this.typeboxPromise) this.typeboxPromise = import('typebox');
    return this.typeboxPromise;
  }

  async ensureSession(preferredIdOrPath, options = {}) {
    const runtime = await this.ensureRuntime(preferredIdOrPath, options);
    return this.runtimeSummary(runtime);
  }

  async ensureRuntime(preferredIdOrPath, options = {}) {
    const select = options.select !== false;
    const preferred = String(preferredIdOrPath || '').trim();
    const existing = preferred ? this.findRuntime(preferred) : this.active;
    if (existing) {
      if (select) this.setSelectedRuntime(existing);
      return existing;
    }

    const sdk = await this.sdk();
    await fs.mkdir(this.sessionDir, { recursive: true });

    let piSessionManager;
    const target = await this.resolveSessionTarget(preferred);
    if (target?.path) {
      const loaded = this.findRuntime(target.id || target.path);
      if (loaded) {
        if (select) this.setSelectedRuntime(loaded);
        return loaded;
      }
      piSessionManager = sdk.SessionManager.open(target.path, this.sessionDir);
    } else {
      piSessionManager = sdk.SessionManager.continueRecent(this.getDefaultWorkspaceRoot() || process.cwd(), this.sessionDir);
    }

    const managerId = typeof piSessionManager.getSessionId === 'function' ? piSessionManager.getSessionId() : '';
    const loaded = managerId ? this.findRuntime(managerId) : null;
    if (loaded) {
      if (select) this.setSelectedRuntime(loaded);
      return loaded;
    }

    const summary = await this.activatePiSessionManager(piSessionManager, {
      reason: options.reason || 'startup',
      thinkingLevel: options.thinkingLevel,
      select
    });
    return this.findRuntime(summary?.id) || this.active;
  }

  async createSession({ workspaceRoot, thinkingLevel } = {}) {
    const sdk = await this.sdk();
    const cwd = workspaceRoot || this.getDefaultWorkspaceRoot() || process.cwd();
    await fs.mkdir(cwd, { recursive: true }).catch(() => {});
    const piSessionManager = sdk.SessionManager.create(cwd, this.sessionDir);
    const summary = await this.activatePiSessionManager(piSessionManager, {
      reason: 'new',
      thinkingLevel: toPiThinkingLevel(thinkingLevel, this.getSettings()?.thinkingLevel),
      select: true
    });
    this.emitSessionsChanged();
    return summary;
  }

  async listSessions() {
    const sdk = await this.sdk();
    await fs.mkdir(this.sessionDir, { recursive: true });
    let sessions = [];
    try {
      sessions = await sdk.SessionManager.listAll(this.sessionDir);
    } catch (error) {
      this.log('warn', 'pi:sessions:list-failed', { error: error?.message || String(error) });
      sessions = [];
    }

    sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    this.sessionIndex = new Map(sessions.map((info) => [info.id, info]));

    const summaries = sessions.map((info) => this.sessionInfoToSummary(info));
    for (const runtime of this.runtimes.values()) {
      if (!summaries.some((session) => session.id === runtime.id)) summaries.unshift(this.runtimeSummary(runtime));
    }
    return summaries;
  }

  async getSession(id) {
    const runtime = this.findRuntime(id);
    if (runtime) return this.runtimeSummary(runtime);
    const info = await this.getSessionInfo(id);
    return info ? this.sessionInfoToSummary(info) : null;
  }

  async listSkillSuggestions(id, query = '') {
    const active = await this.requireActive(id);
    const needle = normalizeSkillQuery(query);
    const skillsResult = active.session.resourceLoader?.getSkills?.();
    const skills = Array.isArray(skillsResult?.skills) ? skillsResult.skills : [];
    return skills
      .map((skill) => this.skillToSummary(skill))
      .filter((skill) => matchesSkillQuery(skill, needle))
      .sort((a, b) => skillSortScore(a, needle) - skillSortScore(b, needle) || a.name.localeCompare(b.name))
      .slice(0, 50);
  }

  async listSkills(id) {
    const active = await this.requireActive(id);
    const settings = this.getSettings() || {};
    const loader = active.session.resourceLoader;
    const loadedResult = loader?.getSkills?.() || { skills: [], diagnostics: [] };
    let result = loadedResult;

    try {
      const sdk = await this.sdk();
      const skillPaths = Array.isArray(loader?.lastSkillPaths) ? loader.lastSkillPaths : [];
      if (typeof sdk.loadSkills === 'function' && skillPaths.length > 0) {
        result = sdk.loadSkills({
          cwd: active.cwd,
          agentDir: this.agentDir,
          skillPaths,
          includeDefaults: false
        });
      }
    } catch (error) {
      this.log('warn', 'skills:list-failed', { error: error?.message || String(error) });
    }

    const loadedByPath = new Map((loadedResult.skills || []).map((skill) => [skill.filePath, skill]));
    const loadedByName = new Map((loadedResult.skills || []).map((skill) => [skill.name, skill]));
    const skills = (result.skills || [])
      .map((skill) => this.skillToSummary(loadedByPath.get(skill.filePath) || loadedByName.get(skill.name) || skill, settings))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      skills,
      diagnostics: result.diagnostics || loadedResult.diagnostics || [],
      extraDirs: getExtraSkillDirs(settings)
    };
  }

  skillToSummary(skill, settings = this.getSettings() || {}) {
    const sourceInfo = skill.sourceInfo || {};
    return {
      name: skill.name || 'skill',
      description: skill.description || '',
      location: skill.filePath || skill.location || '',
      source: sourceInfo.scope || sourceInfo.origin || sourceInfo.source || sourceInfo.type || 'skill',
      enabled: isSkillEnabled(skill, settings),
      disableModelInvocation: !!skill.disableModelInvocation
    };
  }

  async getPayload(id) {
    const active = await this.ensureRuntime(id, { select: true });

    return {
      session: this.runtimeSummary(active),
      messages: this.getRendererMessages(active),
      queues: this.queueSnapshot(active),
      busy: !!(active?.session?.isStreaming || active?.runInProgress),
      partialAssistantText: active?.currentAssistantText || ''
    };
  }

  async updateSessionWorkspace(id, workspaceRoot) {
    const runtime = this.findRuntime(id || this.active?.id);
    if (runtime?.session?.isStreaming || runtime?.runInProgress) {
      throw new Error('Cancel the running session before changing folders.');
    }

    return this.createSession({ workspaceRoot, thinkingLevel: this.getSettings()?.thinkingLevel });
  }

  async run(id, text) {
    const active = await this.requireActive(id);
    if (active.session.isStreaming || active.runInProgress) {
      if (isStopCommandText(text)) {
        await this.cancel(id);
        return { content: 'Cancelled.', cancelled: true };
      }
      throw new Error('Agent is already running. Use steer or follow-up while it works.');
    }

    if (!this.canStartRun(active.id)) {
      const concurrency = this.getConcurrencyState();
      throw new Error(`Max concurrent sessions reached (${concurrency.runningCount}/${concurrency.maxConcurrency}). Terminate a running session from Session Management, or wait for one to finish.`);
    }

    active.runInProgress = true;
    active.initialPromptText = '';
    active.initialUserSeen = false;
    this.emitSessionsChanged();

    try {
      const localCommand = await this.tryRunLocalCommand(active, text);
      if (localCommand) return localCommand;

      active.initialPromptText = String(text || '').trim();
      active.initialUserSeen = false;
      active.currentAssistantText = '';
      active.lastAssistantText = '';
      active.seenSkillKeys = new Set();
      active.suppressedUserTexts = new Set();
      active.cancelRequested = false;
      active.emptyResponseRetried = false;
      active.toolCalls.clear();
      active.cancelledToolCallIds.clear();

      this.emit({ type: 'status', message: `Thinking (${displayPiThinkingLevel(active.session.thinkingLevel)})…`, sessionId: active.id });

      await active.session.prompt(active.initialPromptText, { source: 'interactive' });
      let content = getActiveLastAssistantText(active);

      if (shouldRetryEmptyResponse(active, content)) {
        active.emptyResponseRetried = true;
        active.suppressedUserTexts.add(EMPTY_RESPONSE_RETRY_PROMPT);
        this.log('warn', 'pi:empty-response-retry', { sessionId: active.id, model: this.getSettings()?.model || '' });
        this.emit({ type: 'status', message: 'No visible answer — asking once more…', sessionId: active.id });
        await active.session.prompt(EMPTY_RESPONSE_RETRY_PROMPT, {
          expandPromptTemplates: false,
          source: 'extension'
        });
        content = getActiveLastAssistantText(active);
      }

      return { content };
    } finally {
      active.runInProgress = false;
      active.initialPromptText = '';
      active.initialUserSeen = false;
      this.emitSessionsChanged();
    }
  }

  async tryRunLocalCommand(active, text) {
    const input = String(text || '').trim();
    let content = '';

    if (input.startsWith('!')) {
      const excludeFromContext = input.startsWith('!!');
      const command = input.slice(excludeFromContext ? 2 : 1).trim();
      if (!command) return null;

      const approval = await this.ensureCommandApproved(active, command, 'local ! command');
      if (!approval.approved) {
        content = formatGuardrailBlockedMessage(command, approval.decision);
        active.lastAssistantText = content;
        this.emit({ type: 'assistant:content', content, sessionId: active.id });
        this.emit({ type: 'status', message: 'Command blocked by AI Guardrails', sessionId: active.id });
        return { content, blocked: true };
      }

      let streamed = '';
      this.emit({ type: 'status', message: 'Running command…', sessionId: active.id });
      const result = await active.session.executeBash(command, (chunk) => {
        streamed += chunk;
        this.emit({ type: 'assistant:content', content: streamed, sessionId: active.id });
      }, { excludeFromContext });
      content = [
        `Command: ${command}`,
        `Exit code: ${result.exitCode ?? 'cancelled'}`,
        result.truncated && result.fullOutputPath ? `Full output: ${result.fullOutputPath}` : '',
        '',
        result.output || '(no output)'
      ].filter(Boolean).join('\n');
      active.lastAssistantText = content;
      this.emit({ type: 'assistant:content', content, sessionId: active.id });
      this.emit({ type: 'status', message: 'Done', sessionId: active.id });
      return { content };
    }

    if (!input.startsWith('/')) return null;

    const [command, ...rest] = input.slice(1).split(/\s+/);
    const args = rest.join(' ').trim();

    if (command === 'compact') {
      this.emit({ type: 'status', message: 'Compacting context…', sessionId: active.id });
      await active.session.compact(args || undefined);
      content = 'Context compacted.';
    } else if (command === 'session') {
      const stats = active.session.getSessionStats();
      content = [
        `Session: ${stats.sessionId}`,
        stats.sessionFile ? `File: ${stats.sessionFile}` : '',
        `Messages: ${stats.totalMessages} (${stats.userMessages} user, ${stats.assistantMessages} assistant, ${stats.toolCalls} tool calls)`,
        `Tokens: ${stats.tokens.total}`,
        `Cost: $${Number(stats.cost || 0).toFixed(4)}`
      ].filter(Boolean).join('\n');
    } else if (command === 'tools') {
      content = active.session.getActiveToolNames().join(', ');
    } else {
      return null;
    }

    active.lastAssistantText = content;
    this.emit({ type: 'assistant:content', content, sessionId: active.id });
    this.emit({ type: 'status', message: 'Done', sessionId: active.id });
    return { content };
  }

  async ensureCommandApproved(active, command, source) {
    const decision = shouldAskCommandApproval(command, this.getSettings() || {}, {
      cwd: active?.cwd || this.getDefaultWorkspaceRoot() || process.cwd()
    });

    if (!decision.requiresApproval) return { approved: true, decision };

    const sessionId = active?.id || this.active?.id || '';
    this.log('warn', 'guardrails:command-needs-approval', {
      sessionId,
      source,
      rule: decision.rule,
      reason: decision.reason,
      command
    });
    this.emit({ type: 'status', message: 'Waiting for AI Guardrails approval…', sessionId });

    let approved = false;
    try {
      approved = await this.requestCommandApproval({
        command,
        reason: decision.reason,
        rule: decision.rule,
        source,
        cwd: active?.cwd || this.getDefaultWorkspaceRoot() || process.cwd(),
        sessionId
      });
    } catch (error) {
      this.log('error', 'guardrails:approval-failed', { error: error?.message || String(error), sessionId, source });
      approved = false;
    }

    this.emit({
      type: 'status',
      message: approved ? 'Command approved' : 'Command blocked by AI Guardrails',
      sessionId
    });
    return { approved, decision };
  }

  async queueSteer(id, text) {
    const active = await this.requireActive(id);
    await active.session.steer(String(text || '').trim());
    return this.queueSnapshot(active);
  }

  async queueFollowUp(id, text) {
    const active = await this.requireActive(id);
    await active.session.followUp(String(text || '').trim());
    return this.queueSnapshot(active);
  }

  async updateSessionThinkingLevel(id, thinkingLevel) {
    const active = await this.requireActive(id);
    const compatibilityPreset = normalizeCompatibilityPreset(this.getSettings()?.compatibilityPreset);
    active.session.setThinkingLevel(
      compatibilityPreset === 'local-basic'
        ? 'off'
        : toPiThinkingLevel(thinkingLevel, this.getSettings()?.thinkingLevel)
    );
    this.emitSessionsChanged();
    return this.runtimeSummary(active);
  }

  async cancel(id) {
    const active = await this.requireActive(id, { select: false });
    active.cancelRequested = true;
    const queued = active.session.clearQueue();
    this.emitPendingToolCancellations(active);
    this.emit({ type: 'status', message: 'Cancelled', sessionId: active.id });
    await active.session.abort();
    this.emitPendingToolCancellations(active);
    active.runInProgress = false;
    this.emitSessionsChanged();
    return { ok: true, status: 'cancelled', busy: !!(active.session.isStreaming || active.runInProgress), queued };
  }

  emitPendingToolCancellations(active) {
    if (!active?.toolCalls?.size) return;
    if (!active.cancelledToolCallIds) active.cancelledToolCallIds = new Set();

    for (const [toolCallId, toolCall] of active.toolCalls.entries()) {
      active.cancelledToolCallIds.add(toolCallId);
      active.toolCalls.delete(toolCallId);
      this.emit({
        type: 'tool:cancelled',
        id: toolCallId,
        name: toolCall.name,
        args: toolCall.args || {},
        result: { ok: false, status: 'cancelled', summary: 'Cancelled' },
        sessionId: active.id
      });
    }
  }

  async reset(id) {
    const active = await this.requireActive(id);
    if (active.session.isStreaming || active.runInProgress) await active.session.abort();
    return this.createSession({ workspaceRoot: active.cwd, thinkingLevel: active.session.thinkingLevel });
  }

  async reloadActive() {
    if (!this.active?.sessionFile) return this.activeSummary();
    if (this.hasBusySessions()) throw new Error('Cancel running sessions before changing model settings.');

    const sdk = await this.sdk();
    const previousId = this.active.id;
    const previousSessionFile = this.active.sessionFile;
    for (const runtime of [...this.runtimes.values()]) this.disposeRuntime(runtime);
    this.closeBrowserTabs();
    const piSessionManager = sdk.SessionManager.open(previousSessionFile, this.sessionDir);
    const summary = await this.activatePiSessionManager(piSessionManager, { reason: 'resume', select: true });
    if (summary?.id !== previousId) this.log('warn', 'pi:session:reload-id-changed', { previousId, nextId: summary?.id });
    return summary;
  }

  async deleteSession(id) {
    const info = await this.getSessionInfo(id);
    if (!info) return { ok: false };

    const runtime = this.findRuntime(info.id);
    if (runtime) {
      if (runtime.session.isStreaming || runtime.runInProgress) throw new Error('Cancel the running session before deleting it.');
      this.disposeRuntime(runtime);
    }

    await fs.unlink(info.path).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    this.sessionIndex.delete(info.id);
    this.emitSessionsChanged();
    return { ok: true };
  }

  async getSessionWorkspace(id) {
    const runtime = this.findRuntime(id || this.active?.id);
    if (runtime) return runtime.cwd;
    const info = await this.getSessionInfo(id);
    return info?.cwd || this.getDefaultWorkspaceRoot() || '';
  }

  async activatePiSessionManager(piSessionManager, { reason = 'startup', thinkingLevel, select = true } = {}) {
    const existing = this.findRuntime(typeof piSessionManager.getSessionId === 'function' ? piSessionManager.getSessionId() : '');
    if (existing) {
      if (select) this.setSelectedRuntime(existing);
      return this.runtimeSummary(existing);
    }

    const previousSessionFile = this.active?.sessionFile;
    const runtimeRef = { current: null };

    const cwd = piSessionManager.getCwd() || this.getDefaultWorkspaceRoot() || process.cwd();
    const { session } = await this.createAgentSessionForManager(piSessionManager, {
      cwd,
      reason,
      previousSessionFile,
      thinkingLevel,
      runtimeRef
    });

    const active = {
      session,
      id: session.sessionId,
      cwd,
      sessionFile: session.sessionFile,
      unsubscribe: null,
      currentAssistantText: '',
      lastAssistantText: session.getLastAssistantText?.() || '',
      initialPromptText: '',
      initialUserSeen: false,
      toolCalls: new Map(),
      cancelledToolCallIds: new Set(),
      seenSkillKeys: new Set(),
      suppressedUserTexts: new Set(),
      cancelRequested: false,
      emptyResponseRetried: false,
      runInProgress: false
    };

    runtimeRef.current = active;
    active.unsubscribe = session.subscribe((event) => this.handlePiEvent(event, active));
    this.runtimes.set(active.id, active);
    if (select) this.setSelectedRuntime(active);

    await session.bindExtensions({
      onError: (error) => {
        this.log('error', 'pi:extension:error', error);
        this.emit({ type: 'status', message: `Extension error: ${error?.error || 'unknown'}`, sessionId: active.id });
      }
    });

    if (thinkingLevel) {
      const compatibilityPreset = normalizeCompatibilityPreset(this.getSettings()?.compatibilityPreset);
      session.setThinkingLevel(compatibilityPreset === 'local-basic' ? 'off' : toPiThinkingLevel(thinkingLevel));
    }

    this.log('info', select ? 'pi:session:selected' : 'pi:session:loaded', { sessionId: active.id, sessionFile: active.sessionFile, cwd });
    this.emitSessionsChanged();
    return this.runtimeSummary(active);
  }

  async createAgentSessionForManager(piSessionManager, { cwd, reason, previousSessionFile, thinkingLevel, runtimeRef }) {
    const sdk = await this.sdk();
    const settings = this.getSettings() || {};
    const apiBaseUrl = String(settings.apiBaseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
    const apiKey = String(settings.apiKey || '').trim();
    const modelId = String(settings.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const compatibilityPreset = normalizeCompatibilityPreset(settings.compatibilityPreset);
    const piThinkingLevel = compatibilityPreset === 'local-basic'
      ? 'off'
      : toPiThinkingLevel(thinkingLevel, settings.thinkingLevel);

    const authStorage = sdk.AuthStorage.inMemory();
    if (apiKey) authStorage.setRuntimeApiKey(PI_PROVIDER, apiKey);

    const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider(PI_PROVIDER, {
      name: 'YOLO OpenAI Compatible',
      baseUrl: apiBaseUrl,
      apiKey: apiKey || '$OPENAI_API_KEY',
      authHeader: true,
      api: 'openai-completions',
      models: [makeProviderModel(modelId, compatibilityPreset)]
    });

    const model = modelRegistry.find(PI_PROVIDER, modelId);
    if (!model) throw new Error(`Model not available: ${modelId}`);

    const settingsManager = sdk.SettingsManager.create(cwd, this.agentDir);
    settingsManager.applyOverrides({
      defaultProvider: PI_PROVIDER,
      defaultModel: modelId,
      defaultThinkingLevel: piThinkingLevel,
      sessionDir: this.sessionDir,
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      compaction: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000
      },
      retry: {
        enabled: true,
        maxRetries: 4,
        baseDelayMs: 750,
        provider: {
          maxRetries: 0,
          maxRetryDelayMs: 10_000
        }
      },
      enableSkillCommands: true
    });

    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      additionalSkillPaths: getExtraSkillDirs(settings),
      skillsOverride: (result) => filterSkillsForSettings(result, settings),
      agentsFilesOverride: (base) => this.appendSoulContext(base, cwd),
      appendSystemPromptOverride: (base) => [
        ...base,
        'You are running inside YOLO Auto Desktop. Use the full Pi coding-agent toolset for software work. Be production-minded: inspect before editing, prefer exact patches, run relevant checks, explain changes concisely, and ask before destructive actions. The app may require approval before extremely dangerous shell commands unless AI Guardrails are set to YOLO mode.'
      ]
    });
    await resourceLoader.reload();

    const customTools = await this.createCustomTools(cwd, settingsManager, runtimeRef);
    return sdk.createAgentSession({
      cwd,
      agentDir: this.agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: piThinkingLevel,
      settingsManager,
      resourceLoader,
      sessionManager: piSessionManager,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_fetch', 'web_search', 'get_web', 'browser'],
      customTools,
      sessionStartEvent: {
        type: 'session_start',
        reason: reason === 'new' ? 'new' : reason === 'resume' ? 'resume' : 'startup',
        previousSessionFile
      }
    });
  }

  appendSoulContext(base, cwd) {
    const agentsFiles = [...(base?.agentsFiles || [])];
    const candidates = [
      path.join(this.agentDir, 'SOUL.md'),
      cwd ? path.join(cwd, 'SOUL.md') : ''
    ].filter(Boolean);

    for (const filePath of candidates) {
      try {
        if (!fssync.existsSync(filePath)) continue;
        const content = fssync.readFileSync(filePath, 'utf8');
        if (!content.trim()) continue;
        agentsFiles.push({ path: filePath, content: `# SOUL.md\n\n${content}` });
      } catch (error) {
        this.log('warn', 'pi:soul:read-failed', { path: filePath, error: error?.message || String(error) });
      }
    }

    return { agentsFiles };
  }

  async createCustomTools(cwd, settingsManager, runtimeRef) {
    return this.buildCustomTools(cwd, settingsManager, runtimeRef);
  }

  async createGuardedBashTool(cwd, settingsManager, runtimeRef) {
    const sdk = await this.sdk();
    const base = sdk.createBashToolDefinition(cwd, {
      commandPrefix: settingsManager?.getShellCommandPrefix?.(),
      shellPath: settingsManager?.getShellPath?.()
    });
    const execute = base.execute.bind(base);

    return {
      ...base,
      description: `${base.description} YOLO Auto may ask for user approval before extremely dangerous commands unless AI Guardrails are in YOLO mode.`,
      promptGuidelines: [
        ...(Array.isArray(base.promptGuidelines) ? base.promptGuidelines : []),
        'Extremely dangerous shell commands may require user approval from YOLO Auto before execution.'
      ],
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const command = String(params?.command || '').trim();
        const active = runtimeRef?.current || this.active;
        const approval = await this.ensureCommandApproved(active, command, 'AI bash tool');
        if (!approval.approved) {
          throw new Error(formatGuardrailBlockedMessage(command, approval.decision));
        }
        return execute(toolCallId, params, signal, onUpdate, ctx);
      }
    };
  }

  async buildCustomTools(cwd, settingsManager, runtimeRef) {
    const { Type } = await this.typebox();
    return [
      await this.createGuardedBashTool(cwd, settingsManager, runtimeRef),
      {
        name: 'web_fetch',
        label: 'Web Fetch',
        description: 'Fetch one HTTP(S) URL and return readable markdown or text. Lightweight page access; does not run a browser.',
        promptSnippet: 'Fetch an HTTP(S) URL and extract readable page text/markdown.',
        parameters: Type.Object({
          url: Type.String({ description: 'HTTP or HTTPS URL to fetch.' }),
          extractMode: Type.Optional(Type.String({ description: 'markdown or text. Defaults to markdown.' })),
          maxChars: Type.Optional(Type.Number({ description: 'Maximum extracted characters to return.' })),
          timeoutSeconds: Type.Optional(Type.Number({ description: 'Timeout in seconds.' }))
        }, { additionalProperties: false }),
        execute: async (_toolCallId, params, signal) => {
          const result = await toolWebFetch(params, signal);
          return {
            content: [{ type: 'text', text: formatWebToolContent(result) }],
            details: result
          };
        }
      },
      {
        name: 'web_search',
        label: 'Web Search',
        description: 'Search the web and return structured results with titles, URLs, and snippets. Use this when no specific URL is known.',
        promptSnippet: 'Search the web for current or external information.',
        parameters: Type.Object({
          query: Type.String({ description: 'Search query.' }),
          count: Type.Optional(Type.Number({ description: 'Number of results. Defaults to 10.' })),
          timeoutSeconds: Type.Optional(Type.Number({ description: 'Timeout in seconds.' }))
        }, { additionalProperties: false }),
        execute: async (_toolCallId, params, signal) => {
          const result = await toolWebSearch(params, signal);
          return {
            content: [{ type: 'text', text: result.text }],
            details: result
          };
        }
      },
      {
        name: 'get_web',
        label: 'Get Web',
        description: 'Compatibility wrapper: if url is provided, behaves like web_fetch; if query is provided, behaves like web_search.',
        promptSnippet: 'Compatibility web helper for URL fetches or web searches.',
        parameters: Type.Object({
          url: Type.Optional(Type.String({ description: 'HTTP or HTTPS URL to fetch.' })),
          query: Type.Optional(Type.String({ description: 'Web search query.' })),
          extractMode: Type.Optional(Type.String({ description: 'For URL fetches: markdown or text.' })),
          count: Type.Optional(Type.Number({ description: 'For searches: number of results.' })),
          maxChars: Type.Optional(Type.Number({ description: 'For URL fetches: max characters.' })),
          timeoutSeconds: Type.Optional(Type.Number({ description: 'Timeout in seconds.' }))
        }, { additionalProperties: false }),
        execute: async (_toolCallId, params, signal) => {
          const result = params.url ? await toolWebFetch(params, signal) : await toolWebSearch(params, signal);
          return {
            content: [{ type: 'text', text: result.tool === 'web_search' ? result.text : formatWebToolContent(result) }],
            details: result
          };
        }
      },
      {
        name: 'browser',
        label: 'Browser',
        description: 'Light browser automation for live HTTP(S) pages: open tabs, list tabs, snapshot readable page state, click visible controls, fill fields, press keys, wait, and close tabs. Use only when web_fetch is not enough.',
        promptSnippet: 'Automate live browser pages when fetch/search cannot handle dynamic content.',
        parameters: Type.Object({
          action: Type.String({ description: 'status, tabs, open, snapshot, click, fill, press, wait, or close.' }),
          url: Type.Optional(Type.String({ description: 'HTTP(S) URL for open.' })),
          label: Type.Optional(Type.String({ description: 'Stable label for a tab.' })),
          targetId: Type.Optional(Type.String({ description: 'Tab id or label.' })),
          ref: Type.Optional(Type.String({ description: 'Element ref from latest snapshot.' })),
          text: Type.Optional(Type.String({ description: 'Text for fill, or visible text fallback for click.' })),
          key: Type.Optional(Type.String({ description: 'Key to press.' })),
          maxChars: Type.Optional(Type.Number({ description: 'Snapshot text budget.' })),
          timeoutSeconds: Type.Optional(Type.Number({ description: 'Timeout seconds.' })),
          visible: Type.Optional(Type.Boolean({ description: 'Show browser window. Defaults true.' }))
        }, { additionalProperties: false }),
        execute: async (_toolCallId, params, signal) => {
          const result = await toolBrowser(this, params, signal);
          return {
            content: [{ type: 'text', text: formatBrowserToolContent(result) }],
            details: result
          };
        }
      }
    ];
  }

  handlePiEvent(event, active) {
    if (!event || !active || this.runtimes.get(active.id) !== active) return;
    const sessionId = active.id;

    if (event.type === 'agent_start') {
      this.emit({ type: 'status', message: `Thinking (${displayPiThinkingLevel(active.session.thinkingLevel)})…`, sessionId });
      this.emitSessionsChanged();
      return;
    }

    if (event.type === 'queue_update') {
      this.emit({ type: 'queue:update', steering: [...event.steering], followUp: [...event.followUp], sessionId });
      return;
    }

    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      active.currentAssistantText = '';
      return;
    }

    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (update?.type === 'text_delta') {
        active.currentAssistantText += update.delta || '';
        this.emit({ type: 'assistant:content', content: active.currentAssistantText, sessionId });
      } else if (update?.type === 'thinking_delta') {
        this.emit({ type: 'status', message: 'Thinking…', sessionId });
      } else if (update?.type === 'toolcall_start') {
        this.emit({ type: 'status', message: 'Preparing action…', sessionId });
      }
      return;
    }

    if (event.type === 'message_end') {
      if (event.message?.role === 'assistant') {
        const content = messageText(event.message);
        if (content) {
          active.lastAssistantText = content;
          active.currentAssistantText = content;
          this.emit({ type: 'assistant:content', content, sessionId });
        }
        if (event.message.errorMessage) {
          this.emit({ type: 'status', message: event.message.errorMessage, sessionId });
        }
      } else if (event.message?.role === 'user') {
        const text = messageText(event.message);
        if (active.suppressedUserTexts?.has(text)) {
          active.suppressedUserTexts.delete(text);
          return;
        }
        const skillBlock = parseSkillBlock(text);
        if (skillBlock) {
          this.emitSkillUsed(active, {
            name: skillBlock.name,
            location: skillBlock.location,
            source: 'command'
          });
          if (!active.initialUserSeen && isInitialSkillInvocation(active.initialPromptText, skillBlock)) {
            active.initialUserSeen = true;
          } else if (skillBlock.userMessage) {
            this.emit({ type: 'user:delivered', mode: 'queued', text: skillBlock.userMessage, sessionId });
          }
        } else if (!active.initialUserSeen && text === active.initialPromptText) {
          active.initialUserSeen = true;
        } else if (text) {
          this.emit({ type: 'user:delivered', mode: 'queued', text, sessionId });
        }
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      active.toolCalls.set(event.toolCallId, { name: event.toolName, args: event.args || {} });
      const readSkill = event.toolName === 'read' ? skillFromReadArgs(event.args || {}) : null;
      if (readSkill) this.emitSkillUsed(active, { ...readSkill, source: 'read' });
      this.emit({ type: 'tool:start', id: event.toolCallId, name: event.toolName, args: event.args || {}, sessionId });
      return;
    }

    if (event.type === 'tool_execution_update') {
      return;
    }

    if (event.type === 'tool_execution_end') {
      if (active.cancelledToolCallIds?.has(event.toolCallId)) {
        active.cancelledToolCallIds.delete(event.toolCallId);
        return;
      }

      const toolCall = active.toolCalls.get(event.toolCallId);
      const args = toolCall?.args || {};
      active.toolCalls.delete(event.toolCallId);

      if (active.cancelRequested && event.isError) {
        this.emit({
          type: 'tool:cancelled',
          id: event.toolCallId,
          name: event.toolName || toolCall?.name,
          args,
          result: { ok: false, status: 'cancelled', summary: 'Cancelled' },
          sessionId
        });
        return;
      }

      this.emit({
        type: 'tool:result',
        id: event.toolCallId,
        name: event.toolName,
        args,
        result: summarizePiToolResult(event.toolName, event.result, !event.isError),
        sessionId
      });
      return;
    }

    if (event.type === 'compaction_start') {
      this.emit({ type: 'status', message: `Compacting context (${event.reason})…`, sessionId });
      return;
    }

    if (event.type === 'compaction_end') {
      this.emit({ type: 'status', message: event.errorMessage || 'Context compacted', sessionId });
      return;
    }

    if (event.type === 'auto_retry_start') {
      this.emit({ type: 'status', message: `Retrying model request (${event.attempt}/${event.maxAttempts})…`, sessionId });
      return;
    }

    if (event.type === 'agent_end') {
      const message = active.cancelRequested ? 'Cancelled' : (event.willRetry ? 'Retrying…' : 'Done');
      this.emit({ type: 'status', message, sessionId });
      this.emitSessionsChanged();
      return;
    }

    if (event.type === 'thinking_level_changed' || event.type === 'session_info_changed') {
      this.emitSessionsChanged();
    }
  }

  emitSkillUsed(active, skill) {
    if (!active || !skill?.name) return;
    if (!active.seenSkillKeys) active.seenSkillKeys = new Set();
    const key = `${skill.name}\u0000${skill.location || ''}\u0000${skill.source || ''}`;
    if (active.seenSkillKeys.has(key)) return;
    active.seenSkillKeys.add(key);
    this.emit({
      type: 'skill:used',
      name: skill.name,
      location: skill.location || '',
      source: skill.source || 'unknown',
      sessionId: active.id
    });
  }

  async requireActive(id, options = {}) {
    const active = await this.ensureRuntime(id, { select: options.select !== false });
    if (!active) throw new Error('Session not found.');
    if (id && !this.matchesRuntime(active, id)) throw new Error('Session not active.');
    return active;
  }

  setSelectedRuntime(runtime) {
    if (!runtime) return;
    this.active = runtime;
  }

  findRuntime(value) {
    if (!value) return this.active || null;
    const target = String(value);
    if (this.runtimes.has(target)) return this.runtimes.get(target);
    for (const runtime of this.runtimes.values()) {
      if (this.matchesRuntime(runtime, target)) return runtime;
    }
    return null;
  }

  matchesRuntime(runtime, value) {
    if (!runtime || !value) return false;
    const target = String(value);
    return target === runtime.id || target === runtime.sessionFile;
  }

  matchesActive(value) {
    return this.matchesRuntime(this.active, value);
  }

  runtimeInfo(runtime) {
    if (!runtime) return null;
    const timestamp = new Date();
    return {
      id: runtime.id,
      path: runtime.sessionFile,
      cwd: runtime.cwd,
      name: runtime.session.sessionName,
      created: timestamp,
      modified: timestamp,
      messageCount: runtime.session.messages.length,
      firstMessage: firstUserMessageTitle(runtime.session.messages),
      allMessagesText: runtime.session.messages.map(messageText).join('\n')
    };
  }

  activeInfo() {
    return this.runtimeInfo(this.active);
  }

  runtimeSummary(runtime) {
    if (!runtime) return null;
    return {
      id: runtime.id,
      title: runtime.session.sessionName || firstUserMessageTitle(runtime.session.messages) || 'New chat',
      workspaceRoot: runtime.cwd,
      thinkingLevel: fromPiThinkingLevel(runtime.session.thinkingLevel),
      status: runtimeStatus(runtime),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionFile: runtime.sessionFile,
      messageCount: runtime.session.messages.length,
      busy: !!(runtime.session.isStreaming || runtime.runInProgress)
    };
  }

  activeSummary() {
    return this.runtimeSummary(this.active);
  }

  sessionInfoToSummary(info) {
    const runtime = this.findRuntime(info.id);
    return {
      id: info.id,
      title: runtime?.session?.sessionName || info.name || info.firstMessage || 'New chat',
      workspaceRoot: runtime?.cwd || info.cwd || '',
      thinkingLevel: runtime ? fromPiThinkingLevel(runtime.session.thinkingLevel) : fromPiThinkingLevel(this.getSettings()?.thinkingLevel),
      status: runtime ? runtimeStatus(runtime) : 'idle',
      createdAt: info.created instanceof Date ? info.created.toISOString() : new Date(info.created || Date.now()).toISOString(),
      updatedAt: info.modified instanceof Date ? info.modified.toISOString() : new Date(info.modified || Date.now()).toISOString(),
      sessionFile: runtime?.sessionFile || info.path,
      messageCount: runtime?.session?.messages?.length ?? info.messageCount ?? 0,
      busy: !!(runtime?.session?.isStreaming || runtime?.runInProgress)
    };
  }

  getRendererMessages(runtime = this.active) {
    return (runtime?.session?.messages || []).map(toRendererMessage).filter(Boolean);
  }

  getActiveRendererMessages() {
    return this.getRendererMessages(this.active);
  }

  queueSnapshot(runtime = this.active) {
    const session = runtime?.session;
    return {
      steering: session ? [...session.getSteeringMessages()] : [],
      followUp: session ? [...session.getFollowUpMessages()] : []
    };
  }

  getConcurrencyState() {
    const maxConcurrency = normalizeMaxConcurrency(this.getSettings()?.maxConcurrency);
    const runningSessions = [...this.runtimes.values()]
      .filter((runtime) => runtime?.session?.isStreaming || runtime?.runInProgress)
      .map((runtime) => this.runtimeSummary(runtime));
    return {
      maxConcurrency,
      runningCount: runningSessions.length,
      runningSessions,
      canStart: runningSessions.length < maxConcurrency
    };
  }

  canStartRun(sessionId) {
    const runtime = this.findRuntime(sessionId);
    if (runtime?.session?.isStreaming || runtime?.runInProgress) return true;
    const concurrency = this.getConcurrencyState();
    return concurrency.runningCount < concurrency.maxConcurrency;
  }

  hasBusySessions() {
    return [...this.runtimes.values()].some((runtime) => runtime?.session?.isStreaming || runtime?.runInProgress);
  }

  async getSessionInfo(idOrPath) {
    if (!idOrPath) return null;
    const runtime = this.findRuntime(idOrPath);
    if (runtime) return this.runtimeInfo(runtime);
    const target = String(idOrPath);
    if (this.sessionIndex.has(target)) return this.sessionIndex.get(target);
    const sessions = await this.listSessions();
    if (this.sessionIndex.has(target)) return this.sessionIndex.get(target);
    for (const summary of sessions) {
      if (summary.sessionFile === target) return this.sessionIndex.get(summary.id) || null;
    }
    if (fssync.existsSync(target)) {
      const sdk = await this.sdk();
      const manager = sdk.SessionManager.open(target, this.sessionDir);
      const header = manager.getHeader();
      return {
        id: manager.getSessionId(),
        path: target,
        cwd: header?.cwd || manager.getCwd() || '',
        created: new Date(header?.timestamp || Date.now()),
        modified: new Date(),
        messageCount: manager.getEntries().length,
        firstMessage: firstUserMessageTitle(manager.buildSessionContext().messages),
        allMessagesText: ''
      };
    }
    return null;
  }

  async resolveSessionTarget(idOrPath) {
    if (!idOrPath) return null;
    const target = String(idOrPath);
    if (fssync.existsSync(target)) return { path: target };
    const info = await this.getSessionInfo(target);
    return info ? { path: info.path, id: info.id } : null;
  }

  disposeRuntime(runtimeOrId) {
    const runtime = typeof runtimeOrId === 'string' ? this.findRuntime(runtimeOrId) : runtimeOrId;
    if (!runtime) return;
    try { runtime.unsubscribe?.(); } catch {}
    try { runtime.session?.dispose?.(); } catch {}
    this.runtimes.delete(runtime.id);
    if (this.active === runtime) this.active = this.runtimes.values().next().value || null;
  }

  disposeActive() {
    this.disposeRuntime(this.active);
  }

  closeBrowserTabs() {
    for (const tab of this.browserTabs.values()) {
      try {
        if (!tab.window.isDestroyed()) tab.window.close();
      } catch {}
    }
    this.browserTabs.clear();
  }

  emitSessionsChanged() {
    this.listSessions()
      .then((sessions) => this.emit({ type: 'sessions:update', sessions }))
      .catch((error) => this.log('warn', 'pi:sessions:update-failed', { error: error?.message || String(error) }));
  }
}

function runtimeStatus(runtime) {
  if (!runtime) return 'idle';
  if (runtime.session?.isStreaming || runtime.runInProgress) return 'running';
  if (runtime.cancelRequested) return 'cancelled';
  return 'idle';
}

function makeProviderModel(modelId, compatibilityPreset = 'openai') {
  const preset = normalizeCompatibilityPreset(compatibilityPreset);
  const base = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS
  };

  if (preset === 'local-basic') {
    return {
      ...base,
      reasoning: false,
      compat: {
        supportsUsageInStreaming: false,
        supportsStrictMode: false,
        supportsReasoningEffort: false,
        maxTokensField: 'max_tokens',
        sendSessionAffinityHeaders: false
      }
    };
  }

  return {
    ...base,
    reasoning: true,
    compat: {
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
      supportsReasoningEffort: true,
      maxTokensField: 'max_completion_tokens',
      sendSessionAffinityHeaders: true
    }
  };
}

function normalizeCompatibilityPreset(value, fallback = 'openai') {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (MODEL_COMPATIBILITY_PRESETS.has(raw)) return raw;
  if (raw === 'local' || raw === 'basic' || raw === 'localbasic') return 'local-basic';
  if (raw === 'open-ai' || raw === 'default') return 'openai';
  return MODEL_COMPATIBILITY_PRESETS.has(fallback) ? fallback : 'openai';
}

function isStopCommandText(text) {
  const normalized = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?！？…,，。;；:：'"’”)]*$/u, '')
    .replace(/\s+/g, ' ');
  return new Set(['/stop', 'stop', '/abort', 'abort', '/cancel', 'cancel', 'esc', 'escape']).has(normalized);
}

function toPiThinkingLevel(value, fallback = 'none') {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!raw) return toPiThinkingLevel(fallback, 'none');
  if (['none', 'off', 'no', 'false', 'disabled', 'disable'].includes(raw)) return 'off';
  if (raw === 'minimal' || raw === 'min') return 'minimal';
  if (raw === 'xhigh' || raw === 'extrahigh' || raw === 'veryhigh') return 'xhigh';
  if (['low', 'medium', 'high'].includes(raw)) return raw;
  return toPiThinkingLevel(fallback, 'none');
}

function fromPiThinkingLevel(value) {
  const level = toPiThinkingLevel(value);
  return level === 'off' || level === 'minimal' ? 'none' : level;
}

function displayPiThinkingLevel(value) {
  const level = toPiThinkingLevel(value);
  return level === 'off' ? 'none' : level;
}

function formatGuardrailBlockedMessage(command, decision = {}) {
  return [
    'Command blocked by AI Guardrails.',
    decision.reason ? `Reason: ${decision.reason}` : '',
    '',
    'Command:',
    '```bash',
    String(command || ''),
    '```',
    '',
    'Disable protections in Settings → AI Guardrails → YOLO mode if you really want commands like this to run without approval.'
  ].filter((line) => line !== '').join('\n');
}

function toRendererMessage(message) {
  if (!message) return null;
  if (message.role === 'user') {
    const content = messageText(message);
    return content === EMPTY_RESPONSE_RETRY_PROMPT ? null : { role: 'user', content };
  }
  if (message.role === 'assistant') {
    const content = messageText(message);
    return content ? { role: 'assistant', content } : null;
  }
  if (message.role === 'bashExecution') {
    return {
      role: 'assistant',
      content: `Ran command:\n\n\`\`\`bash\n${message.command || ''}\n\`\`\`\n\n${message.output || ''}`
    };
  }
  if (message.role === 'compactionSummary') return { role: 'assistant', content: `Context compacted:\n\n${message.summary || ''}` };
  if (message.role === 'branchSummary') return { role: 'assistant', content: `Branch summary:\n\n${message.summary || ''}` };
  return null;
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

function isInitialSkillInvocation(initialPrompt, skillBlock) {
  const text = String(initialPrompt || '').trim();
  if (!text) return false;
  return text === `/skill:${skillBlock.name}` || text.startsWith(`/skill:${skillBlock.name} `);
}

function skillFromReadArgs(args = {}) {
  const rawPath = String(args.path || '').replace(/^@/, '').trim();
  if (!rawPath) return null;
  const normalized = rawPath.replace(/\\/g, '/');
  if (!/\bSKILL\.md$/i.test(normalized)) return null;
  const parts = normalized.split('/').filter(Boolean);
  const name = parts.length >= 2 ? parts[parts.length - 2] : 'skill';
  return { name, location: rawPath };
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text')
    .map((part) => part.text || '')
    .join('')
    .trim();
}

function getActiveLastAssistantText(active) {
  return active?.session?.getLastAssistantText?.() || active?.lastAssistantText || '';
}

function shouldRetryEmptyResponse(active, content) {
  if (String(content || '').trim()) return false;
  if (!active || active.cancelRequested || active.emptyResponseRetried) return false;
  if (active.session?.isStreaming) return false;

  const lastAssistant = findLastAssistantMessage(active.session?.messages || []);
  if (!lastAssistant) return false;

  const stopReason = String(lastAssistant.stopReason || '').toLowerCase();
  if (stopReason === 'error' || stopReason === 'aborted') return false;
  if (lastAssistant.errorMessage) return false;

  return true;
}

function findLastAssistantMessage(messages) {
  for (let index = (messages || []).length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
  }
  return null;
}

function firstUserMessageTitle(messages) {
  const first = (messages || []).find((message) => message?.role === 'user');
  const text = messageText(first).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}

function summarizePiToolResult(toolName, result, ok = true) {
  const text = toolResultText(result);
  const details = result?.details || result;
  const isOk = ok !== false;
  let summary = isOk ? 'Completed' : 'Failed';

  if (toolName === 'read') summary = `Read ${details?.path || details?.file || ''}`.trim();
  else if (toolName === 'write') summary = `Wrote ${details?.path || ''}`.trim();
  else if (toolName === 'edit') summary = `Edited ${details?.path || ''}`.trim();
  else if (toolName === 'bash') summary = `Command ${details?.exitCode === 0 || details?.code === 0 ? 'succeeded' : 'finished'}`;
  else if (toolName === 'grep') summary = `Grep ${details?.matches ?? ''}`.trim();
  else if (toolName === 'find') summary = 'Find completed';
  else if (toolName === 'ls') summary = 'Listed files';
  else if (toolName === 'web_search') summary = `Web search (${details?.results?.length || 0} results)`;
  else if (toolName === 'web_fetch') summary = `Fetched ${details?.finalUrl || details?.url || ''}`.trim();
  else if (toolName === 'browser') summary = `Browser ${details?.action || 'action'}${details?.tab?.label ? ` on ${details.tab.label}` : ''}`;

  return {
    ok: isOk,
    summary,
    preview: preview(text || JSON.stringify(details || {}, null, 2))
  };
}

function toolResultText(result) {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n');
  }
  if (result?.details?.stdout || result?.details?.stderr) return [result.details.stdout, result.details.stderr].filter(Boolean).join('\n');
  if (result?.text) return result.text;
  return '';
}

async function toolBrowser(manager, args, signal) {
  assertNotCancelled(signal);
  const action = String(args.action || '').trim().toLowerCase();

  if (action === 'status') {
    return { ok: true, tool: 'browser', action, available: isElectronBrowserAvailable(), tabs: listBrowserTabs(manager).length };
  }
  if (action === 'tabs') return { ok: true, tool: 'browser', action, tabs: listBrowserTabs(manager) };
  if (action === 'open') return browserOpen(manager, args, signal);
  if (action === 'snapshot') {
    const tab = requireBrowserTab(manager, args.targetId);
    const snapshot = await browserSnapshot(tab, args, signal);
    return { ok: true, tool: 'browser', action, tab: browserTabInfo(tab), ...snapshot };
  }
  if (action === 'click') {
    const tab = requireBrowserTab(manager, args.targetId);
    const clicked = await browserClick(tab, args, signal);
    return { ok: true, tool: 'browser', action, tab: browserTabInfo(tab), ...clicked };
  }
  if (action === 'fill') {
    const tab = requireBrowserTab(manager, args.targetId);
    const filled = await browserFill(tab, args, signal);
    return { ok: true, tool: 'browser', action, tab: browserTabInfo(tab), ...filled };
  }
  if (action === 'press') {
    const tab = requireBrowserTab(manager, args.targetId);
    const key = String(args.key || '').trim() || 'Enter';
    tab.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    tab.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    await delay(200, signal);
    return { ok: true, tool: 'browser', action, tab: browserTabInfo(tab), key };
  }
  if (action === 'wait') {
    const timeoutSeconds = clampInt(args.timeoutSeconds, 1, 120, 2);
    await delay(timeoutSeconds * 1000, signal);
    return { ok: true, tool: 'browser', action, waitedMs: timeoutSeconds * 1000 };
  }
  if (action === 'close') {
    const tab = requireBrowserTab(manager, args.targetId);
    closeBrowserTab(manager, tab.id);
    return { ok: true, tool: 'browser', action, closed: tab.id };
  }

  throw new Error(`Unknown browser action: ${action}`);
}

function isElectronBrowserAvailable() {
  try {
    const electron = require('electron');
    return !!electron.BrowserWindow;
  } catch {
    return false;
  }
}

async function browserOpen(manager, args, signal) {
  if (typeof args.url !== 'string' || !args.url.trim()) throw new Error('url is required for browser open.');
  const parsed = new URL(args.url.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('browser only supports HTTP(S) URLs.');
  await assertSafeWebFetchTarget(parsed.toString());

  const existing = findBrowserTab(manager, args.label || args.targetId);
  if (existing && existing.label && existing.label === args.label) {
    hardenBrowserToolWindow(existing.window, manager?.log || (() => {}));
    await existing.window.loadURL(parsed.toString());
    assertNotCancelled(signal);
    return { ok: true, tool: 'browser', action: 'open', tab: browserTabInfo(existing), reused: true };
  }

  const { BrowserWindow } = require('electron');
  if (!BrowserWindow) throw new Error('Electron BrowserWindow is not available.');

  const tabId = `t${manager.browserNextTabId++}`;
  const tab = {
    id: tabId,
    label: sanitizeBrowserLabel(args.label),
    window: new BrowserWindow({
      width: 1280,
      height: 900,
      show: args.visible !== false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `yolo-auto-browser-${tabId}`
      }
    })
  };

  hardenBrowserToolWindow(tab.window, manager?.log || (() => {}));
  tab.window.on('closed', () => manager.browserTabs.delete(tab.id));
  manager.browserTabs.set(tab.id, tab);

  const timeoutSeconds = clampInt(args.timeoutSeconds, 1, 120, 30);
  await withTimeout(tab.window.loadURL(parsed.toString()), timeoutSeconds * 1000, `browser open timed out after ${timeoutSeconds}s`);
  assertNotCancelled(signal);
  return { ok: true, tool: 'browser', action: 'open', tab: browserTabInfo(tab), reused: false };
}

async function browserSnapshot(tab, args, signal) {
  assertNotCancelled(signal);
  const maxChars = clampInt(args.maxChars, 100, 100_000, 12_000);
  const snapshot = await tab.window.webContents.executeJavaScript(`(${browserSnapshotScript})(${JSON.stringify(maxChars)})`, true);
  assertNotCancelled(signal);
  return snapshot;
}

async function browserClick(tab, args, signal) {
  assertNotCancelled(signal);
  const ref = String(args.ref || '').trim();
  const text = String(args.text || '').trim();
  if (!ref && !text) throw new Error('click requires ref or text.');
  const result = await tab.window.webContents.executeJavaScript(`(${browserClickScript})(${JSON.stringify({ ref, text })})`, true);
  assertNotCancelled(signal);
  if (!result?.clicked) throw new Error(result?.error || 'No matching clickable element found.');
  await delay(500, signal);
  return result;
}

async function browserFill(tab, args, signal) {
  assertNotCancelled(signal);
  const ref = String(args.ref || '').trim();
  const text = String(args.text || '');
  if (!ref) throw new Error('fill requires ref from latest snapshot.');
  const result = await tab.window.webContents.executeJavaScript(`(${browserFillScript})(${JSON.stringify({ ref, text })})`, true);
  assertNotCancelled(signal);
  if (!result?.filled) throw new Error(result?.error || 'No matching fillable field found.');
  await delay(200, signal);
  return result;
}

function hardenBrowserToolWindow(browserWindow, log = () => {}) {
  const webContents = browserWindow?.webContents;
  if (!webContents) return;

  try {
    const { installElectronSessionWebGuard } = require('./web-safety');
    installElectronSessionWebGuard(webContents.session, log);
  } catch (error) {
    log('warn', 'browser-tool-guard:install-failed', { error: error?.message || String(error) });
  }
}

function listBrowserTabs(manager) {
  return [...manager.browserTabs.values()].filter((tab) => !tab.window.isDestroyed()).map(browserTabInfo);
}

function browserTabInfo(tab) {
  return {
    id: tab.id,
    label: tab.label || undefined,
    title: tab.window.webContents.getTitle(),
    url: tab.window.webContents.getURL()
  };
}

function findBrowserTab(manager, targetId) {
  const target = String(targetId || '').trim();
  if (!target) return null;
  return manager.browserTabs.get(target) || [...manager.browserTabs.values()].find((tab) => tab.label === target) || null;
}

function requireBrowserTab(manager, targetId) {
  const tab = findBrowserTab(manager, targetId) || (manager.browserTabs.size === 1 ? [...manager.browserTabs.values()][0] : null);
  if (!tab || tab.window.isDestroyed()) throw new Error('Browser tab not found. Use browser action="tabs" or action="open" first.');
  return tab;
}

function closeBrowserTab(manager, tabId) {
  const tab = manager.browserTabs.get(tabId);
  if (!tab) return;
  manager.browserTabs.delete(tabId);
  if (!tab.window.isDestroyed()) tab.window.close();
}

function sanitizeBrowserLabel(value) {
  const label = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  return label || undefined;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function delay(ms, signal) {
  assertNotCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function browserSnapshotScript(maxChars) {
  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const labelFor = (el) => {
    const id = el.getAttribute('id');
    const aria = el.getAttribute('aria-label');
    const title = el.getAttribute('title');
    const placeholder = el.getAttribute('placeholder');
    const name = el.getAttribute('name');
    const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
    let label = '';
    if (id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (labelEl) label = labelEl.innerText.trim().replace(/\s+/g, ' ');
    }
    return [label, aria, title, placeholder, text, name].filter(Boolean)[0] || el.tagName.toLowerCase();
  };
  const selector = 'a,button,input,textarea,select,[role="button"],[role="link"],[onclick]';
  const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible).slice(0, 160);
  const controls = elements.map((el, index) => {
    const ref = `r${index + 1}`;
    el.setAttribute('data-yolo-ref', ref);
    return {
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      label: labelFor(el).slice(0, 180),
      href: el.href || undefined
    };
  });
  const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  return {
    title: document.title,
    url: location.href,
    text: text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]` : text,
    controls
  };
}

function browserClickScript({ ref, text }) {
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  let el = ref ? document.querySelector(`[data-yolo-ref="${CSS.escape(ref)}"]`) : null;
  if (!el && text) {
    const needle = text.toLowerCase();
    el = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"],[onclick]')).find((candidate) => visible(candidate) && (candidate.innerText || candidate.value || '').trim().toLowerCase().includes(needle));
  }
  if (!el) return { clicked: false, error: 'Element not found. Take a fresh snapshot and retry.' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { clicked: true, ref: ref || el.getAttribute('data-yolo-ref') || undefined, text: (el.innerText || el.value || '').trim().slice(0, 180) };
}

function browserFillScript({ ref, text }) {
  const el = document.querySelector(`[data-yolo-ref="${CSS.escape(ref)}"]`);
  if (!el) return { filled: false, error: 'Element not found. Take a fresh snapshot and retry.' };
  if (!('value' in el)) return { filled: false, error: 'Element is not fillable.' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { filled: true, ref, label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.tagName.toLowerCase() };
}

function formatBrowserToolContent(result) {
  const parts = [];
  if (result.tab) parts.push(`Tab: ${result.tab.label || result.tab.id} ${result.tab.title || ''}\n${result.tab.url || ''}`.trim());
  if (result.title) parts.push(`# ${result.title}`);
  if (result.url) parts.push(`URL: ${result.url}`);
  if (result.text) parts.push(result.text);
  if (Array.isArray(result.controls) && result.controls.length) {
    parts.push(['Controls:', ...result.controls.slice(0, 60).map((control) => {
      const href = control.href ? ` -> ${control.href}` : '';
      const type = control.type ? `/${control.type}` : '';
      return `- ${control.ref} ${control.tag || 'el'}${type}: ${control.label || ''}${href}`;
    })].join('\n'));
  }
  if (result.tabs) parts.push(JSON.stringify(result.tabs, null, 2));
  return parts.filter(Boolean).join('\n\n') || JSON.stringify(result, null, 2);
}

async function toolWebFetch(args, signal) {
  assertNotCancelled(signal);
  if (typeof args.url !== 'string' || !args.url.trim()) throw new Error('url is required.');

  let url;
  try {
    url = new URL(args.url.trim());
  } catch {
    throw new Error(`Invalid URL: ${args.url}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('web_fetch only supports HTTP(S) URLs.');
  await assertSafeWebFetchTarget(url.toString());

  const extractMode = args.extractMode === 'text' ? 'text' : 'markdown';
  const maxChars = clampInt(args.maxChars, 100, 500_000, TOOL_TEXT_LIMIT);
  const startedAt = Date.now();
  const response = await fetchUrl(url.toString(), args.timeoutSeconds, signal, {
    accept: 'text/markdown,text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
    safeRedirects: true
  });
  const contentType = response.headers.get('content-type') || '';
  const raw = await readResponseTextLimited(response, WEB_MAX_RESPONSE_BYTES, signal);
  const extracted = extractWebContent(raw.text, contentType, extractMode, response.url);
  const text = truncate(extracted.text, maxChars);

  return {
    ok: true,
    tool: 'web_fetch',
    status: response.status,
    statusText: response.statusText,
    httpOk: response.ok,
    url: url.toString(),
    finalUrl: response.url,
    contentType: normalizeContentType(contentType),
    title: extracted.title,
    extractMode,
    extractor: extracted.extractor,
    bytes: raw.bytesRead,
    responseTruncated: raw.truncated,
    truncated: extracted.text.length > maxChars,
    tookMs: Date.now() - startedAt,
    fetchedAt: new Date().toISOString(),
    text
  };
}

async function toolWebSearch(args, signal) {
  assertNotCancelled(signal);
  if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required.');

  const query = args.query.trim();
  const count = clampInt(args.count, 1, 20, 10);
  const startedAt = Date.now();
  const providers = [
    { name: 'duckduckgo-html', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parse: parseDuckDuckGoResults },
    { name: 'duckduckgo-lite', url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, parse: parseDuckDuckGoResults },
    { name: 'bing-html', url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`, parse: parseBingResults }
  ];
  const attempts = [];
  let selected;
  let lastError;

  for (const provider of providers) {
    assertNotCancelled(signal);
    try {
      const response = await fetchUrl(provider.url, args.timeoutSeconds, signal, {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        safeRedirects: true
      });
      const raw = await readResponseTextLimited(response, WEB_MAX_RESPONSE_BYTES, signal);
      const results = provider.parse(raw.text).slice(0, count);
      const attempt = {
        provider: provider.name,
        status: response.status,
        statusText: response.statusText,
        finalUrl: response.url,
        bytes: raw.bytesRead,
        resultCount: results.length
      };
      attempts.push(attempt);
      selected = { provider: provider.name, response, results };
      if (results.length > 0) break;
    } catch (error) {
      lastError = error;
      attempts.push({ provider: provider.name, error: error?.message || String(error) });
    }
  }

  if (!selected && lastError) throw lastError;

  const response = selected?.response;
  const results = selected?.results || [];
  const text = formatSearchResults(query, results, attempts);

  return {
    ok: true,
    tool: 'web_search',
    provider: selected?.provider || 'duckduckgo',
    query,
    count,
    status: response?.status,
    statusText: response?.statusText,
    finalUrl: response?.url,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    attempts,
    results,
    text
  };
}

async function assertSafeWebFetchTarget(url) {
  const { assertSafeWebUrl } = require('./web-safety');
  await assertSafeWebUrl(url);
}

// Used only by LLM-controlled web tools. Model/provider API calls are handled by the Pi SDK
// transport and intentionally do not go through this private-network blocklist.
async function fetchUrl(url, timeoutSecondsValue, signal, headers = {}) {
  const { guardedFetchUrl } = require('./web-safety');
  const timeoutSeconds = clampInt(timeoutSecondsValue, 1, 120, 30);
  const response = await guardedFetchUrl(url, {
    timeoutSeconds,
    maxRedirects: clampInt(headers.maxRedirects, 0, 20, 10),
    maxBytes: WEB_MAX_RESPONSE_BYTES,
    signal,
    headers: {
      accept: headers.accept || '*/*',
      'accept-encoding': 'identity',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
    }
  });

  const text = String(response.text || '');
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    url: response.url,
    bytesRead: response.bytesRead,
    truncated: response.truncated,
    redirects: response.redirects,
    text: async () => text
  };
}

async function readResponseTextLimited(response, maxBytes, signal) {
  assertNotCancelled(signal);
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = typeof response.text === 'function' ? await response.text() : String(response.text || '');
    assertNotCancelled(signal);
    const bytesRead = Number.isFinite(Number(response.bytesRead)) ? Number(response.bytesRead) : Buffer.byteLength(text, 'utf8');
    return { text, bytesRead, truncated: !!response.truncated };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  let truncated = false;

  while (true) {
    assertNotCancelled(signal);
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    let chunk = value;
    if (bytesRead + chunk.byteLength > maxBytes) {
      chunk = chunk.subarray(0, Math.max(0, maxBytes - bytesRead));
      truncated = true;
    }
    if (chunk.byteLength > 0) chunks.push(Buffer.from(chunk));
    bytesRead += chunk.byteLength;
    if (truncated || bytesRead >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }

  return { text: Buffer.concat(chunks, bytesRead).toString('utf8'), bytesRead, truncated };
}

function formatWebToolContent(result) {
  return [
    result.title ? `# ${result.title}` : '',
    `URL: ${result.finalUrl || result.url}`,
    `Status: ${result.status} ${result.statusText || ''}`.trim(),
    '',
    result.text || ''
  ].filter((part) => part !== '').join('\n');
}

function extractWebContent(raw, contentType, extractMode, finalUrl) {
  const lowerType = String(contentType || '').toLowerCase();
  if (lowerType.includes('application/json')) {
    const text = prettyJson(raw);
    const output = extractMode === 'text' ? text : `\`\`\`json\n${text}\n\`\`\``;
    return { title: undefined, extractor: 'json', text: sanitizeWebResearchText(output) };
  }
  if (lowerType.includes('html') || looksLikeHtml(raw)) {
    const title = extractHtmlTitle(raw);
    const markdown = htmlToMarkdown(raw, finalUrl);
    const output = extractMode === 'text' ? markdownToText(markdown) : markdown;
    return { title, extractor: 'basic-html', text: sanitizeWebResearchText(output) };
  }
  if (lowerType.includes('xml') || looksLikeXml(raw)) {
    return { title: undefined, extractor: 'xml-text', text: sanitizeWebResearchText(xmlToText(raw)) };
  }
  return { title: undefined, extractor: 'raw', text: sanitizeWebResearchText(String(raw || '').trim()) };
}

function sanitizeWebResearchText(text) {
  const withoutLargeBlobs = removeLargeWebBlobs(text);
  try {
    const { sanitizeExternalContent } = require('./web-safety');
    if (typeof sanitizeExternalContent === 'function') return sanitizeExternalContent(withoutLargeBlobs);
  } catch {}
  return withoutLargeBlobs;
}

function removeLargeWebBlobs(text) {
  return String(text || '')
    .replace(/data:[a-z0-9.+/-]+;base64,[a-z0-9+/=]{80,}/gi, '[REMOVED_DATA_URI]')
    .replace(/\b[a-z0-9+/]{400,}={0,2}\b/gi, '[REMOVED_LONG_BASE64]');
}

function xmlToText(xml) {
  let text = String(xml || '')
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<!doctype\b[\s\S]*?>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');

  text = stripHiddenHtmlElements(stripUnsafeHtmlElements(text))
    .replace(/<[^>]+>/g, ' ');

  return normalizeExtractedText(decodeHtmlEntities(text));
}

function htmlToMarkdown(html, baseUrl) {
  let text = stripHiddenHtmlElements(stripUnsafeHtmlElements(html))
    .replace(/<!--[\s\S]*?-->/g, ' ');

  text = text
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, body) => `\n# ${htmlInlineToMarkdown(body, baseUrl)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, body) => `\n## ${htmlInlineToMarkdown(body, baseUrl)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, body) => `\n### ${htmlInlineToMarkdown(body, baseUrl)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => `\n- ${htmlInlineToMarkdown(body, baseUrl)}\n`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, body) => `\n${htmlInlineToMarkdown(body, baseUrl)}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(div|section|article|header|footer|main|nav|aside|ul|ol|table|tr|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return normalizeExtractedText(decodeHtmlEntities(text));
}

function stripUnsafeHtmlElements(html) {
  return String(html || '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<object\b[\s\S]*?<\/object>/gi, ' ')
    .replace(/<embed\b[^>]*>/gi, ' ')
    .replace(/<canvas\b[\s\S]*?<\/canvas>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<form\b[\s\S]*?<\/form>/gi, ' ')
    .replace(/<(?:meta|link|base)\b[^>]*>/gi, ' ');
}

function stripHiddenHtmlElements(html) {
  let text = String(html || '');
  for (let index = 0; index < 5; index += 1) {
    const next = text
      .replace(/<([a-z][\w:-]*)\b(?=[^>]*\b(?:class|id)\s*=\s*(?:"[^"]*(?:\bhidden\b|\bsr-only\b|\bvisually-hidden\b|\bscreen-reader-text\b)[^"]*"|'[^']*(?:\bhidden\b|\bsr-only\b|\bvisually-hidden\b|\bscreen-reader-text\b)[^']*'|[^\s>]*(?:hidden|sr-only|visually-hidden|screen-reader-text)[^\s>]*))[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*\b(?:class|id)\s*=\s*(?:"[^"]*(?:\bhidden\b|\bsr-only\b|\bvisually-hidden\b|\bscreen-reader-text\b)[^"]*"|'[^']*(?:\bhidden\b|\bsr-only\b|\bvisually-hidden\b|\bscreen-reader-text\b)[^']*'|[^\s>]*(?:hidden|sr-only|visually-hidden|screen-reader-text)[^\s>]*)[^>]*>/gi, ' ')
      .replace(/<([a-z][\w:-]*)\b(?=[^>]*(?:\bhidden\b|\baria-hidden\s*=\s*(?:"true"|'true'|true)|\bstyle\s*=\s*(?:"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"|'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^']*'|[^\s>]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^\s>]*)))[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*(?:\bhidden\b|\baria-hidden\s*=\s*(?:"true"|'true'|true)|\bstyle\s*=\s*(?:"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"|'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^']*'|[^\s>]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^\s>]*))[^>]*>/gi, ' ');
    if (next === text) break;
    text = next;
  }
  return text;
}

function htmlInlineToMarkdown(value, baseUrl) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_m, d, s, b, label) => {
      const href = safeMarkdownHref(d || s || b || '', baseUrl);
      const cleanLabel = stripHtml(label).trim() || href;
      return href ? `[${cleanLabel}](${href})` : cleanLabel;
    })
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function markdownToText(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z0-9_-]*\n?/i, '').replace(/```$/, ''))
    .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/[*_~`]/g, '')
    .trim();
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const source = String(html || '');
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(source)) !== null) {
    const attrs = match[1] || '';
    const className = getHtmlAttribute(attrs, 'class');
    if (!hasHtmlClass(className, 'result__a') && !hasHtmlClass(className, 'result-link')) continue;

    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(getHtmlAttribute(attrs, 'href')));
    const title = stripHtml(match[2] || '');
    const snippet = findNearbySearchSnippet(source, anchorRegex.lastIndex);
    if (isUsableSearchResult(url, title)) results.push({ title, url, snippet });
  }
  if (results.length > 0) return dedupeSearchResults(results);

  anchorRegex.lastIndex = 0;
  while ((match = anchorRegex.exec(source)) !== null && results.length < 30) {
    const attrs = match[1] || '';
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(getHtmlAttribute(attrs, 'href')));
    const title = stripHtml(match[2] || '');
    if (isUsableSearchResult(url, title)) results.push({ title, url, snippet: '' });
  }

  return dedupeSearchResults(results);
}

function parseBingResults(html) {
  const results = [];
  const source = String(html || '');
  const blockRegex = /<li\b[^>]*class\s*=\s*(?:"[^"]*\bb_algo\b[^"]*"|'[^']*\bb_algo\b[^']*'|[^\s>]*\bb_algo\b[^\s>]*)[^>]*>([\s\S]*?)(?=<li\b[^>]*class\s*=\s*(?:"[^"]*\bb_algo\b|'[^']*\bb_algo\b|[^\s>]*\bb_algo\b)|<\/ol>)/gi;
  let match;

  while ((match = blockRegex.exec(source)) !== null) {
    const block = match[1] || '';
    const titleMatch = block.match(/<h2\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i);
    if (!titleMatch) continue;

    const url = decodeBingUrl(decodeHtmlEntities(getHtmlAttribute(titleMatch[1] || '', 'href')));
    const title = stripHtml(titleMatch[2] || '');
    const snippetMatch = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1] || '') : '';
    if (isUsableSearchResult(url, title)) results.push({ title, url, snippet });
  }

  return dedupeSearchResults(results);
}

function getHtmlAttribute(attrs, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(attrs || '').match(new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return match ? (match[1] || match[2] || match[3] || '') : '';
}

function hasHtmlClass(className, target) {
  return String(className || '').split(/\s+/).includes(target);
}

function findNearbySearchSnippet(source, fromIndex) {
  const nearby = String(source || '').slice(fromIndex, fromIndex + 3000);
  const snippetMatch = nearby.match(/<([a-z0-9]+)\b[^>]*class\s*=\s*(?:"[^"]*(?:result__snippet|result-snippet)[^"]*"|'[^']*(?:result__snippet|result-snippet)[^']*'|[^\s>]*(?:result__snippet|result-snippet)[^\s>]*)[^>]*>([\s\S]*?)<\/\1>/i);
  return snippetMatch ? stripHtml(snippetMatch[2] || '') : '';
}

function isUsableSearchResult(url, title) {
  if (!url || !title || !/^https?:\/\//i.test(url)) return false;
  if (!isSafeSearchResultUrl(url)) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host !== 'duckduckgo.com' && host !== 'html.duckduckgo.com' && host !== 'lite.duckduckgo.com' && host !== 'bing.com';
  } catch {
    return false;
  }
}

function isSafeSearchResultUrl(url) {
  try {
    const { isSafeHttpUrlSync } = require('./web-safety');
    return typeof isSafeHttpUrlSync === 'function' ? isSafeHttpUrlSync(url) : true;
  } catch {
    return true;
  }
}

function formatSearchResults(query, results, attempts = []) {
  if (results.length === 0) {
    const attemptText = attempts.length
      ? `\nSearch attempts: ${attempts.map((attempt) => `${attempt.provider}${attempt.error ? ` error=${attempt.error}` : ` status=${attempt.status || '?'} results=${attempt.resultCount || 0}`}`).join('; ')}`
      : '';
    return `No web results found for: ${query}${attemptText}`;
  }
  return [`Web search results for: ${query}`, '', ...results.map((result, index) => {
    const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
    if (result.snippet) lines.push(`   ${result.snippet}`);
    return lines.join('\n');
  })].join('\n');
}

function dedupeSearchResults(results) {
  const seen = new Set();
  const next = [];
  for (const result of results) {
    const key = result.url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(result);
  }
  return next;
}

function decodeDuckDuckGoUrl(url) {
  try {
    const parsed = new URL(url, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return url;
  }
}

function decodeBingUrl(url) {
  try {
    const parsed = new URL(url, 'https://www.bing.com');
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const encoded = host === 'bing.com' && parsed.pathname.startsWith('/ck/a') ? parsed.searchParams.get('u') : '';
    if (!encoded) return parsed.toString();

    const payload = encoded.startsWith('a1') ? encoded.slice(2) : encoded;
    const decoded = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : parsed.toString();
  } catch {
    return url;
  }
}

function stripHtml(value) {
  const text = stripHiddenHtmlElements(stripUnsafeHtmlElements(value))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return sanitizeWebResearchText(normalizeExtractedText(decodeHtmlEntities(text)));
}

function normalizeExtractedText(value) {
  return String(value || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHtmlTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : undefined;
}

function looksLikeHtml(value) {
  return /^\s*(?:<!doctype\s+html|<html|<head|<body|<div|<p\b)/i.test(String(value || ''));
}

function looksLikeXml(value) {
  return /^\s*(?:<\?xml|<rss\b|<feed\b|<urlset\b|<[a-z][\w:-]*(?:\s|>))/i.test(String(value || ''));
}

function normalizeContentType(value) {
  return String(value || '').split(';')[0].trim() || undefined;
}

function safeMarkdownHref(href, baseUrl) {
  const url = absolutizeUrl(href, baseUrl);
  if (!/^https?:\/\//i.test(url)) return '';
  return isSafeSearchResultUrl(url) ? url : '';
}

function absolutizeUrl(href, baseUrl) {
  try {
    return new URL(decodeHtmlEntities(href), baseUrl || undefined).toString();
  } catch {
    return '';
  }
}

function prettyJson(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return String(raw || '').trim();
  }
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === '#') {
      const codePoint = key[1] === 'x' ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
  });
}

function getExtraSkillDirs(settings = {}) {
  return (settings?.skills?.load?.extraDirs || [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function isSkillEnabled(skill, settings = {}) {
  const name = String(skill?.name || '').trim();
  if (!name) return true;
  return settings?.skills?.entries?.[name]?.enabled !== false;
}

function filterSkillsForSettings(result = {}, settings = {}) {
  return {
    ...result,
    skills: (result.skills || []).filter((skill) => isSkillEnabled(skill, settings))
  };
}

function normalizeSkillQuery(query) {
  return String(query || '').trim().replace(/^skill:?/i, '').toLowerCase();
}

function matchesSkillQuery(skill, query) {
  if (!query) return true;
  const haystack = `${skill.name || ''} ${skill.description || ''}`.toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((part) => haystack.includes(part));
}

function skillSortScore(skill, query) {
  if (!query) return 0;
  const name = String(skill.name || '').toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return 3;
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new Error('Cancelled');
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function truncate(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
}

function preview(value) {
  const text = String(value || '');
  return text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text;
}

module.exports = {
  PiSdkSessionManager,
  __testing: {
    extractWebContent,
    htmlToMarkdown,
    markdownToText,
    sanitizeWebResearchText,
    stripHtml,
    isUsableSearchResult,
    fetchUrl,
    hardenBrowserToolWindow
  }
};
