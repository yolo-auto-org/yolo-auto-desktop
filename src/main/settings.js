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
const API_KEYS_FILENAME = 'api-keys.json';

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

function getDefaultSettings() {
  return {
    apiBaseUrl: process.env.YOLO_AUTO_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.YOLO_AUTO_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.YOLO_AUTO_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    thinkingLevel: normalizeThinkingLevel(process.env.YOLO_AUTO_THINKING_LEVEL || process.env.OPENAI_REASONING_EFFORT || 'none'),
    compatibilityPreset: normalizeCompatibilityPreset(process.env.YOLO_AUTO_COMPATIBILITY_PRESET || process.env.YOLO_AUTO_MODEL_COMPATIBILITY || 'openai'),
    maxConcurrency: normalizeMaxConcurrency(process.env.YOLO_AUTO_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY),
    guardrails: getDefaultGuardrails(),
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
    const merged = mergeSettings(defaults, sanitizedSaved);
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
    storedKey = saveStoredApiKey(source.apiKey);
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
    thinkingLevel: normalizeThinkingLevel(source.thinkingLevel, defaults.thinkingLevel),
    compatibilityPreset: normalizeCompatibilityPreset(source.compatibilityPreset, defaults.compatibilityPreset),
    maxConcurrency: normalizeMaxConcurrency(source.maxConcurrency, defaults.maxConcurrency),
    guardrails: normalizeGuardrails(source.guardrails, defaults.guardrails),
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

function migrateLegacyApiKey(saved, storedKey) {
  if (!saved || typeof saved !== 'object' || !Object.prototype.hasOwnProperty.call(saved, 'apiKey')) {
    return { settings: saved, migratedApiKey: storedKey };
  }

  const legacyKey = normalizeApiKey(saved.apiKey);
  const settings = stripApiKey(saved);
  let migratedApiKey = storedKey;

  if (!migratedApiKey.found) {
    try {
      migratedApiKey = saveStoredApiKey(legacyKey);
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

function stripApiKey(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const { apiKey, ...withoutApiKey } = source;
  return withoutApiKey;
}

function normalizeApiKey(value) {
  return String(value || '').trim();
}

module.exports = {
  getDefaultSettings,
  loadSettings,
  saveSettings,
  normalizeCompatibilityPreset,
  normalizeMaxConcurrency,
  normalizeGuardrails,
  apiKeysPath
};
