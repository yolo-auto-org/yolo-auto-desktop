const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { getHomeWorkspacePath } = require('./home-base');
const { normalizeThinkingLevel } = require('./thinking-levels');
const { normalizeGuardrails } = require('./command-guardrails');

const COMPATIBILITY_PRESETS = new Set(['openai', 'local-basic']);
const DEFAULT_MAX_CONCURRENCY = 2;
const MIN_MAX_CONCURRENCY = 1;
const MAX_MAX_CONCURRENCY = 8;

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

  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const saved = JSON.parse(raw);
    return mergeSettings(defaults, saved);
  } catch {
    return defaults;
  }
}

function saveSettings(nextSettings) {
  const merged = mergeSettings(getDefaultSettings(), nextSettings);
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
  return merged;
}

function mergeSettings(defaults, saved = {}) {
  const merged = {
    ...defaults,
    ...saved,
    thinkingLevel: normalizeThinkingLevel(saved.thinkingLevel, defaults.thinkingLevel),
    compatibilityPreset: normalizeCompatibilityPreset(saved.compatibilityPreset, defaults.compatibilityPreset),
    maxConcurrency: normalizeMaxConcurrency(saved.maxConcurrency, defaults.maxConcurrency),
    guardrails: normalizeGuardrails(saved.guardrails, defaults.guardrails),
    skills: {
      ...defaults.skills,
      ...(saved.skills || {}),
      entries: {
        ...(defaults.skills?.entries || {}),
        ...(saved.skills?.entries || {})
      },
      load: {
        ...(defaults.skills?.load || {}),
        ...(saved.skills?.load || {})
      }
    },
    agents: {
      ...defaults.agents,
      ...(saved.agents || {}),
      defaults: {
        ...(defaults.agents?.defaults || {}),
        ...(saved.agents?.defaults || {})
      },
      list: saved.agents?.list || defaults.agents?.list
    }
  };

  return merged;
}

module.exports = {
  getDefaultSettings,
  loadSettings,
  saveSettings,
  normalizeCompatibilityPreset,
  normalizeMaxConcurrency,
  normalizeGuardrails
};
