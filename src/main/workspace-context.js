const fs = require('node:fs/promises');
const path = require('node:path');

const CONTEXT_FILENAMES = ['AGENTS.md', 'SOUL.md'];
const CONTEXT_FILE_MAX_CHARS = 20_000;
const CONTEXT_TOTAL_MAX_CHARS = 40_000;

async function loadWorkspaceContextFiles({ homeBaseRoot = '', workspaceRoot = '', log = () => {} } = {}) {
  const roots = uniqueRoots([
    homeBaseRoot && { root: homeBaseRoot, source: 'home-base' },
    workspaceRoot && !samePath(workspaceRoot, homeBaseRoot) && { root: workspaceRoot, source: 'selected-folder' }
  ].filter(Boolean));

  const files = [];
  let remaining = CONTEXT_TOTAL_MAX_CHARS;

  for (const entry of roots) {
    for (const name of CONTEXT_FILENAMES) {
      if (remaining <= 0) return files;
      const loaded = await readContextFile(entry.root, name, log);
      if (!loaded || !loaded.content.trim()) continue;

      const maxChars = Math.min(CONTEXT_FILE_MAX_CHARS, remaining);
      const content = truncateContext(loaded.content, maxChars, name);
      remaining -= content.length;
      files.push({
        name,
        source: entry.source,
        path: loaded.path,
        content
      });
    }
  }

  return files;
}

function formatWorkspaceContextForPrompt(files) {
  if (!Array.isArray(files) || files.length === 0) return '';

  const blocks = files.map((file) => [
    `<context_file name="${xmlEscape(file.name)}" source="${xmlEscape(file.source)}" path="${xmlEscape(file.path)}">`,
    file.content,
    '</context_file>'
  ].join('\n'));

  return `\n\nUser-editable context files are loaded below. AGENTS.md contains standing operating instructions. SOUL.md contains persona, tone, and boundaries. Follow them unless higher-priority instructions conflict.\n<workspace_context>\n${blocks.join('\n\n')}\n</workspace_context>`;
}

async function readContextFile(root, name, log) {
  try {
    const rootReal = await fs.realpath(root);
    const requested = path.join(rootReal, name);
    const fileReal = await fs.realpath(requested);
    if (!isInside(rootReal, fileReal)) {
      log('warn', 'context-file:skip-escape', { root: rootReal, name, path: fileReal });
      return null;
    }

    const stat = await fs.stat(fileReal);
    if (!stat.isFile()) return null;

    return {
      path: fileReal,
      content: await fs.readFile(fileReal, 'utf8')
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log('warn', 'context-file:read-failed', { root, name, error: error?.message || String(error) });
    }
    return null;
  }
}

function uniqueRoots(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = normalizePath(entry.root);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function truncateContext(content, maxChars, name) {
  const text = String(content || '').trimEnd();
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';

  const marker = `\n\n[...truncated, read ${name} for full content...]\n\n`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);

  const budget = maxChars - marker.length;
  const head = Math.floor(budget * 0.75);
  const tail = budget - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

function isInside(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(a, b) {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(value) {
  if (!value) return '';
  return path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
}

function xmlEscape(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

module.exports = {
  CONTEXT_FILENAMES,
  loadWorkspaceContextFiles,
  formatWorkspaceContextForPrompt
};
