const THINKING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'];
const THINKING_LEVEL_SET = new Set(THINKING_LEVELS);

function normalizeThinkingLevel(value, fallback = 'none') {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!raw) return normalizeThinkingLevel(fallback, 'none');
  if (['none', 'no', 'off', 'false', 'disabled', 'disable'].includes(raw)) return 'none';
  if (raw === 'xhigh' || raw === 'extrahigh' || raw === 'veryhigh') return 'xhigh';
  if (THINKING_LEVEL_SET.has(raw)) return raw;
  return normalizeThinkingLevel(fallback, 'none');
}

function applyThinkingLevelToRequestBody(body, level) {
  const thinkingLevel = normalizeThinkingLevel(level);
  if (thinkingLevel === 'none') return body;

  // Most OpenAI-compatible chat endpoints use reasoning_effort. Keep this opt-in:
  // default "none" sends no extra field for broad compatibility.
  body.reasoning_effort = thinkingLevel;
  return body;
}

module.exports = {
  THINKING_LEVELS,
  normalizeThinkingLevel,
  applyThinkingLevelToRequestBody
};
