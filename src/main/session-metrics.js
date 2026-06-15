const fs = require('node:fs');

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_COMPACTION_SETTINGS = Object.freeze({
  enabled: true,
  reserveTokens: 32_000,
  keepRecentTokens: 20_000
});

function emptySessionMetrics(options = {}) {
  const now = options.updatedAt || new Date().toISOString();
  const compaction = normalizeCompactionSnapshot(options.compaction);
  return {
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: 0,
      lastTurn: {
        input: 0,
        output: 0,
        total: 0,
        cost: 0,
        at: ''
      }
    },
    context: {
      tokens: null,
      contextWindow: normalizeContextWindow(options.contextWindow),
      percent: null,
      status: 'unknown'
    },
    status: {
      state: normalizeStatusState(options.state),
      message: String(options.message || ''),
      updatedAt: now
    },
    compaction
  };
}

function metricsFromAgentSession(session, options = {}) {
  const contextWindow = normalizeContextWindow(options.contextWindow || session?.model?.contextWindow);
  const metrics = metricsFromMessages(session?.messages || [], contextWindow, options);

  const stats = safeCall(() => session?.getSessionStats?.());
  if (stats?.tokens) {
    metrics.usage.input = normalizeNumber(stats.tokens.input);
    metrics.usage.output = normalizeNumber(stats.tokens.output);
    metrics.usage.cacheRead = normalizeNumber(stats.tokens.cacheRead);
    metrics.usage.cacheWrite = normalizeNumber(stats.tokens.cacheWrite);
    metrics.usage.total = normalizeNumber(stats.tokens.total)
      || metrics.usage.input + metrics.usage.output + metrics.usage.cacheRead + metrics.usage.cacheWrite;
    metrics.usage.cost = normalizeNumber(stats.cost);
  }

  const contextUsage = safeCall(() => session?.getContextUsage?.()) || stats?.contextUsage;
  if (contextUsage) metrics.context = normalizeContextUsage(contextUsage, contextWindow);

  return withStatus(metrics, options);
}

function metricsFromMessages(messages = [], contextWindow = DEFAULT_CONTEXT_WINDOW, options = {}) {
  const metrics = emptySessionMetrics({ ...options, contextWindow });
  let lastAssistantUsage = null;
  let lastCompaction = null;

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant' && message.usage) {
      const usage = normalizeUsage(message.usage);
      addUsage(metrics.usage, usage);
      lastAssistantUsage = { usage, timestamp: message.timestamp };
    }

    if (message?.role === 'compactionSummary') {
      lastCompaction = {
        timestamp: message.timestamp,
        tokensBefore: normalizeNumber(message.tokensBefore)
      };
    }
  }

  applyLastUsage(metrics, lastAssistantUsage, contextWindow);
  if (lastCompaction) {
    metrics.compaction.lastCompactedAt = toIsoTimestamp(lastCompaction.timestamp);
    metrics.compaction.lastTokensBefore = lastCompaction.tokensBefore || null;
    if (!lastAssistantUsage || Number(lastCompaction.timestamp || 0) >= Number(lastAssistantUsage.timestamp || 0)) {
      metrics.context.tokens = null;
      metrics.context.percent = null;
      metrics.context.status = 'unknown';
    }
  }

  return withStatus(metrics, options);
}

function metricsFromSessionFile(filePath, options = {}) {
  if (!filePath) return emptySessionMetrics(options);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return metricsFromSessionEntries(entries, options);
  } catch {
    const metrics = emptySessionMetrics(options);
    metrics.context.status = 'unavailable';
    return metrics;
  }
}

function metricsFromSessionEntries(entries = [], options = {}) {
  const contextWindow = normalizeContextWindow(options.contextWindow);
  const metrics = emptySessionMetrics({ ...options, contextWindow });
  let lastAssistantUsage = null;
  let lastAssistantUsageIndex = -1;
  let lastCompaction = null;
  let lastCompactionIndex = -1;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type === 'message' && entry.message?.role === 'assistant' && entry.message.usage) {
      const usage = normalizeUsage(entry.message.usage);
      addUsage(metrics.usage, usage);
      lastAssistantUsage = { usage, timestamp: entry.timestamp || entry.message.timestamp };
      lastAssistantUsageIndex = index;
    }

    if (entry?.type === 'compaction') {
      lastCompaction = {
        timestamp: entry.timestamp,
        tokensBefore: normalizeNumber(entry.tokensBefore)
      };
      lastCompactionIndex = index;
    }
  }

  applyLastUsage(metrics, lastAssistantUsage, contextWindow);
  if (lastCompaction) {
    metrics.compaction.lastCompactedAt = toIsoTimestamp(lastCompaction.timestamp);
    metrics.compaction.lastTokensBefore = lastCompaction.tokensBefore || null;
    if (lastCompactionIndex > lastAssistantUsageIndex) {
      metrics.context.tokens = null;
      metrics.context.percent = null;
      metrics.context.status = 'unknown';
    }
  }

  return withStatus(metrics, options);
}

function withStatus(metrics, options = {}) {
  const next = metrics || emptySessionMetrics(options);
  next.status = {
    state: normalizeStatusState(options.state || next.status?.state),
    message: String(options.message || next.status?.message || ''),
    updatedAt: options.updatedAt || next.status?.updatedAt || new Date().toISOString()
  };
  if (options.compaction) next.compaction = { ...next.compaction, ...normalizeCompactionSnapshot(options.compaction) };
  if (options.contextStatus && next.context.status !== 'known') next.context.status = options.contextStatus;
  return next;
}

function normalizeContextUsage(contextUsage, fallbackWindow = DEFAULT_CONTEXT_WINDOW) {
  const contextWindow = normalizeContextWindow(contextUsage?.contextWindow || fallbackWindow);
  const tokens = contextUsage?.tokens === null || contextUsage?.tokens === undefined
    ? null
    : normalizeNumber(contextUsage.tokens);
  const percent = tokens === null
    ? null
    : normalizePercent(contextUsage?.percent, tokens, contextWindow);
  return {
    tokens,
    contextWindow,
    percent,
    status: tokens === null ? 'unknown' : 'known'
  };
}

function normalizeUsage(usage = {}) {
  const cost = usage.cost && typeof usage.cost === 'object' ? usage.cost : {};
  const input = normalizeNumber(usage.input);
  const output = normalizeNumber(usage.output);
  const cacheRead = normalizeNumber(usage.cacheRead);
  const cacheWrite = normalizeNumber(usage.cacheWrite);
  const total = normalizeNumber(usage.totalTokens || usage.total) || input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    cost: normalizeNumber(cost.total || usage.cost)
  };
}

function addUsage(target, usage) {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.total += usage.total;
  target.cost += usage.cost;
}

function applyLastUsage(metrics, lastAssistantUsage, contextWindow) {
  if (!lastAssistantUsage) return;
  const usage = lastAssistantUsage.usage;
  metrics.usage.lastTurn = {
    input: usage.input,
    output: usage.output,
    total: usage.total,
    cost: usage.cost,
    at: toIsoTimestamp(lastAssistantUsage.timestamp)
  };
  if (usage.total > 0) {
    metrics.context.tokens = usage.total;
    metrics.context.contextWindow = normalizeContextWindow(contextWindow);
    metrics.context.percent = normalizePercent(undefined, usage.total, metrics.context.contextWindow);
    metrics.context.status = 'known';
  }
}

function formatSessionMetrics(metrics = emptySessionMetrics()) {
  const usage = metrics.usage || {};
  const context = metrics.context || {};
  const lines = [
    `Context: ${formatContextUsage(context)}`,
    `Tokens: ${formatTokenCount(usage.total)} (${formatTokenCount(usage.input)} input, ${formatTokenCount(usage.output)} output, ${formatTokenCount(usage.cacheRead)} cache read, ${formatTokenCount(usage.cacheWrite)} cache write)`,
    `Cost: $${Number(usage.cost || 0).toFixed(4)}`
  ];
  if (metrics.compaction?.lastCompactedAt) {
    lines.push(`Last compaction: ${metrics.compaction.lastCompactedAt}${metrics.compaction.lastTokensBefore ? ` (${formatTokenCount(metrics.compaction.lastTokensBefore)} before)` : ''}`);
  }
  return lines;
}

function formatContextUsage(context = {}) {
  const contextWindow = normalizeContextWindow(context.contextWindow);
  const tokens = context.tokens === null || context.tokens === undefined ? null : normalizeNumber(context.tokens);
  const percent = context.percent === null || context.percent === undefined ? null : Number(context.percent);
  const percentText = Number.isFinite(percent) ? ` (${Math.round(percent)}%)` : '';
  return `${tokens === null ? '?' : formatTokenCount(tokens)} / ${formatTokenCount(contextWindow)}${percentText}`;
}

function formatTokenCount(value) {
  const number = normalizeNumber(value);
  if (number >= 1_000_000) return `${trimFixed(number / 1_000_000)}M`;
  if (number >= 1_000) return `${trimFixed(number / 1_000)}k`;
  return String(number);
}

function trimFixed(value) {
  const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return fixed.replace(/\.0$/, '');
}

function normalizeCompactionSnapshot(compaction = {}) {
  const source = compaction && typeof compaction === 'object' ? compaction : {};
  return {
    enabled: source.enabled !== false,
    reserveTokens: normalizeNumber(source.reserveTokens) || DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: normalizeNumber(source.keepRecentTokens) || DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    lastCompactedAt: source.lastCompactedAt || '',
    lastTokensBefore: source.lastTokensBefore ?? null
  };
}

function normalizeStatusState(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['running', 'compacting', 'retrying', 'cancelling', 'cancelled', 'error'].includes(raw)) return raw;
  return 'idle';
}

function normalizeContextWindow(value) {
  const number = normalizeNumber(value);
  return number > 0 ? number : DEFAULT_CONTEXT_WINDOW;
}

function normalizePercent(value, tokens, contextWindow) {
  const number = Number(value);
  if (Number.isFinite(number)) return Math.max(0, Math.min(100, number));
  if (!contextWindow) return null;
  return Math.max(0, Math.min(100, (tokens / contextWindow) * 100));
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function toIsoTimestamp(value) {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_SETTINGS,
  emptySessionMetrics,
  metricsFromAgentSession,
  metricsFromMessages,
  metricsFromSessionEntries,
  metricsFromSessionFile,
  formatSessionMetrics,
  formatContextUsage,
  formatTokenCount
};
