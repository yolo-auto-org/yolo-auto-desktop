const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { getHomeBasePath, getHomeWorkspacePath } = require('./home-base');
const { normalizeThinkingLevel } = require('./thinking-levels');
const { normalizeGuardrails } = require('./command-guardrails');

const COMPATIBILITY_PRESETS = new Set(['openai', 'local-basic']);
const DEFAULT_MAX_CONCURRENCY = 2;
const MIN_MAX_CONCURRENCY = 1;
const MAX_MAX_CONCURRENCY = 8;
const DEFAULT_CONTEXT_WINDOW = 131_072;
const DEFAULT_COMPACTION_ENABLED = true;
const DEFAULT_COMPACTION_RESERVE_TOKENS = Math.round(DEFAULT_CONTEXT_WINDOW * 0.25);
const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
const MIN_COMPACTION_TOKENS = 1_000;
const MAX_COMPACTION_TOKENS = 1_000_000;
const API_KEYS_FILENAME = 'api-keys.json';
const DEFAULT_API_BASE_URL = 'https://yolo-auto.com/v1';
const DEFAULT_MODEL = 'qwen3.6-35b-a3b';
const LEGACY_DEFAULT_API_BASE_URL = 'https://api.openai.com/v1';
const LEGACY_DEFAULT_MODEL = 'gpt-4.1-mini';
const TOOL_DEFINITIONS = Object.freeze([
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
]);
const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));

function normalizeCompatibilityPreset(value, fallback = 'openai') {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (COMPATIBILITY_PRESETS.has(raw)) return raw;
  if (raw === 'local' || raw === 'basic' || raw === 'localbasic') return 'local-basic';
  if (raw === 'open-ai' || raw === 'default') return 'openai';
  return COMPATIBILITY_PRESETS.has(fallback) ? fallback : 'openai';
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function apiKeysPath() {
  return path.join(getHomeBasePath(), API_KEYS_FILENAME);
}

function normalizeMaxConcurrency(value, fallback = DEFAULT_MAX_CONCURRENCY) {
  const number = Number.parseInt(String(value ?? ''), 10);
  const fallbackNumber = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_MAX_CONCURRENCY;
  const normalizedFallback = Math.min(MAX_MAX_CONCURRENCY, Math.max(MIN_MAX_CONCURRENCY, Math.round(fallbackNumber)));
  if (!Number.isFinite(number)) return normalizedFallback;
  return Math.min(MAX_MAX_CONCURRENCY, Math.max(MIN_MAX_CONCURRENCY, number));
}

function normalizeCompactionSettings(current = {}, fallback = {}) {
  const source = current && typeof current === 'object' ? current : {};
  const fallbackSource = fallback && typeof fallback === 'object' ? fallback : {};

  return {
    enabled: normalizeBooleanSetting(source.enabled, normalizeBooleanSetting(fallbackSource.enabled, DEFAULT_COMPACTION_ENABLED)),
    reserveTokens: normalizeTokenSetting(
      source.reserveTokens,
      normalizeTokenSetting(fallbackSource.reserveTokens, DEFAULT_COMPACTION_RESERVE_TOKENS)
    ),
    keepRecentTokens: normalizeTokenSetting(
      source.keepRecentTokens,
      normalizeTokenSetting(fallbackSource.keepRecentTokens, DEFAULT_COMPACTION_KEEP_RECENT_TOKENS)
    )
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
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const fallbackNumber = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_COMPACTION_RESERVE_TOKENS;
  const normalizedFallback = Math.min(MAX_COMPACTION_TOKENS, Math.max(MIN_COMPACTION_TOKENS, Math.round(fallbackNumber)));
  if (!Number.isFinite(parsed)) return normalizedFallback;
  return Math.min(MAX_COMPACTION_TOKENS, Math.max(MIN_COMPACTION_TOKENS, parsed));
}

function getDefaultSettings() {
  return {
    apiBaseUrl: process.env.YOLO_AUTO_BASE_URL || process.env.OPENAI_BASE_URL || DEFAULT_API_BASE_URL,
    apiKey: process.env.YOLO_AUTO_API_KEY || process.env.OPENAI_API_KEY || '',
    model: normalizeModelId(process.env.YOLO_AUTO_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL, DEFAULT_MODEL),
    thinkingLevel: normalizeThinkingLevel(process.env.YOLO_AUTO_THINKING_LEVEL || process.env.OPENAI_REASONING_EFFORT || 'high', 'high'),
    compatibilityPreset: normalizeCompatibilityPreset(process.env.YOLO_AUTO_COMPATIBILITY_PRESET || process.env.YOLO_AUTO_MODEL_COMPATIBILITY || 'openai'),
    maxConcurrency: normalizeMaxConcurrency(process.env.YOLO_AUTO_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY),
    guardrails: getDefaultGuardrails(),
    tools: normalizeToolSettings(),
    compaction: normalizeCompactionSettings({
      enabled: process.env.YOLO_AUTO_COMPACTION_ENABLED,
      reserveTokens: process.env.YOLO_AUTO_COMPACTION_RESERVE_TOKENS,
      keepRecentTokens: process.env.YOLO_AUTO_COMPACTION_KEEP_RECENT_TOKENS
    }),
    workspaceRoot: getHomeWorkspacePath(),
    activeSessionId: '',
    skills: {
      entries: {},
      load: {
        extraDirs: []
      }
    },
    agents: {
      defaults: {}
    }
  };
}

function getDefaultGuardrails() {
  const yoloFlag = String(process.env.YOLO_AUTO_YOLO || process.env.YOLO_AUTO_YOLO_MODE || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'yolo'].includes(yoloFlag)) return { mode: 'off' };
  return normalizeGuardrails(process.env.YOLO_AUTO_GUARDRAILS || process.env.YOLO_AUTO_GUARDRAILS_MODE || 'ask');
}

function loadSettings() {
  const defaults = getDefaultSettings();
  const storedKey = loadStoredApiKey();

  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const saved = JSON.parse(raw);
    const { settings: sanitizedSaved, migratedApiKey } = migrateLegacyApiKey(saved, storedKey);
    const merged = mergeSettings(defaults, migrateLegacyProviderDefaults(sanitizedSaved, defaults));
    return {
      ...merged,
      apiKey: migratedApiKey.found ? migratedApiKey.apiKey : defaults.apiKey
    };
  } catch {
    return {
      ...defaults,
      apiKey: storedKey.found ? storedKey.apiKey : defaults.apiKey
    };
  }
}

function saveSettings(nextSettings) {
  const source = nextSettings && typeof nextSettings === 'object' ? { ...nextSettings } : {};
  let storedKey = loadStoredApiKey();

  if (Object.prototype.hasOwnProperty.call(source, 'apiKey')) {
    const nextApiKey = normalizeApiKey(source.apiKey);
    storedKey = nextApiKey ? saveStoredApiKey(nextApiKey) : clearStoredApiKey();
    delete source.apiKey;
  }

  const merged = mergeSettings(getDefaultSettings(), source);
  const withApiKey = {
    ...merged,
    apiKey: storedKey.found ? storedKey.apiKey : merged.apiKey
  };

  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(stripApiKey(withApiKey), null, 2));
  return withApiKey;
}

function mergeSettings(defaults, saved = {}) {
  const source = saved && typeof saved === 'object' ? saved : {};
  const merged = {
    ...defaults,
    ...source,
    model: normalizeModelId(source.model, defaults.model),
    thinkingLevel: normalizeThinkingLevel(source.thinkingLevel, defaults.thinkingLevel),
    compatibilityPreset: normalizeCompatibilityPreset(source.compatibilityPreset, defaults.compatibilityPreset),
    maxConcurrency: normalizeMaxConcurrency(source.maxConcurrency, defaults.maxConcurrency),
    guardrails: normalizeGuardrails(source.guardrails, defaults.guardrails),
    tools: normalizeToolSettings(source.tools, defaults.tools),
    compaction: normalizeCompactionSettings(source.compaction, defaults.compaction),
    skills: {
      ...defaults.skills,
      ...(source.skills || {}),
      entries: {
        ...(defaults.skills?.entries || {}),
        ...(source.skills?.entries || {})
      },
      load: {
        ...(defaults.skills?.load || {}),
        ...(source.skills?.load || {})
      }
    },
    agents: {
      ...defaults.agents,
      ...(source.agents || {}),
      defaults: {
        ...(defaults.agents?.defaults || {}),
        ...(source.agents?.defaults || {})
      },
      list: source.agents?.list || defaults.agents?.list
    }
  };

  return merged;
}

function loadStoredApiKey() {
  try {
    const raw = fs.readFileSync(apiKeysPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'apiKey')) {
      return { found: true, apiKey: normalizeApiKey(parsed.apiKey) };
    }
    if (typeof parsed === 'string') return { found: true, apiKey: normalizeApiKey(parsed) };
  } catch {}

  return { found: false, apiKey: '' };
}

function saveStoredApiKey(value) {
  const apiKey = normalizeApiKey(value);
  const filePath = apiKeysPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ apiKey, updatedAt: new Date().toISOString() }, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Some filesystems/platforms do not support chmod; the file still lives in the user's home base.
  }
  return { found: true, apiKey };
}

function clearStoredApiKey() {
  try {
    fs.rmSync(apiKeysPath(), { force: true });
  } catch {
    // Clearing the key should be best-effort; settings will still stop carrying it.
  }
  return { found: false, apiKey: '' };
}

function migrateLegacyApiKey(saved, storedKey) {
  if (!saved || typeof saved !== 'object' || !Object.prototype.hasOwnProperty.call(saved, 'apiKey')) {
    return { settings: saved, migratedApiKey: storedKey };
  }

  const legacyKey = normalizeApiKey(saved.apiKey);
  const settings = stripApiKey(saved);
  let migratedApiKey = storedKey;

  if (!migratedApiKey.found) {
    try {
      migratedApiKey = legacyKey ? saveStoredApiKey(legacyKey) : clearStoredApiKey();
    } catch {
      // Keep using the legacy key for this run if migration cannot write the home-base file.
      // Leave the old settings file untouched so the key is not lost.
      return { settings: saved, migratedApiKey: { found: true, apiKey: legacyKey } };
    }
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch {
    // If legacy cleanup fails, do not block startup; future saves will write sanitized settings.
  }

  return { settings, migratedApiKey };
}

function migrateLegacyProviderDefaults(source, defaults) {
  if (String(source.apiBaseUrl || '').trim() !== LEGACY_DEFAULT_API_BASE_URL) return source;
  if (normalizeModelId(source.model) !== normalizeModelId(LEGACY_DEFAULT_MODEL)) return source;
  return {
    ...source,
    apiBaseUrl: defaults.apiBaseUrl,
    model: defaults.model
  };
}

function normalizeToolSettings(currentTools = {}, fallbackTools = {}) {
  const source = currentTools && typeof currentTools === 'object' ? currentTools : {};
  const fallback = fallbackTools && typeof fallbackTools === 'object' ? fallbackTools : {};
  const sourceEntries = source.entries && typeof source.entries === 'object' ? source.entries : {};
  const fallbackEntries = fallback.entries && typeof fallback.entries === 'object' ? fallback.entries : {};
  const entries = {};

  for (const tool of TOOL_DEFINITIONS) {
    const fallbackEnabled = readToolEnabled(fallbackEntries[tool.name], true);
    entries[tool.name] = { enabled: readToolEnabled(sourceEntries[tool.name], fallbackEnabled) };
  }

  return { entries };
}

function readToolEnabled(entry, fallback = true) {
  if (typeof entry === 'boolean') return entry;
  if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'enabled')) {
    return entry.enabled !== false;
  }
  return fallback !== false;
}

function isKnownToolName(name) {
  return TOOL_NAMES.has(String(name || '').trim());
}

function stripApiKey(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const { apiKey, ...withoutApiKey } = source;
  return withoutApiKey;
}

function normalizeApiKey(value) {
  return String(value || '').trim();
}

function normalizeModelId(value, fallback = '') {
  const model = String(value || '').trim();
  const fallbackModel = String(fallback || '').trim();
  return (model || fallbackModel).toLowerCase();
}

module.exports = {
  getDefaultSettings,
  loadSettings,
  saveSettings,
  normalizeCompatibilityPreset,
  normalizeMaxConcurrency,
  normalizeModelId,
  normalizeCompactionSettings,
  normalizeGuardrails,
  normalizeToolSettings,
  isKnownToolName,
  TOOL_DEFINITIONS,
  apiKeysPath,
  clearStoredApiKey
};
