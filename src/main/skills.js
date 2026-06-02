const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getHomeSkillsPath } = require('./home-base');

function discoverSkills({ settings = {}, agentId = 'desktop' } = {}) {
  const roots = buildSkillRoots(settings);
  const allowlist = getAgentSkillAllowlist(settings, agentId);
  const byName = new Map();
  const diagnostics = [];

  for (const root of roots) {
    for (const candidate of scanSkillRoot(root.path)) {
      const parsed = readSkill(candidate, root);
      if (!parsed.ok) {
        diagnostics.push(parsed.diagnostic);
        continue;
      }

      const skill = parsed.skill;
      if (byName.has(skill.name)) continue;

      if (allowlist && !allowlist.includes(skill.name)) {
        diagnostics.push({ skill: skill.name, location: skill.location, reason: 'Not in agent skill allowlist.' });
        continue;
      }

      const gate = isSkillEligible(skill, settings);
      if (!gate.ok) {
        diagnostics.push({ skill: skill.name, location: skill.location, reason: gate.reason });
        continue;
      }

      byName.set(skill.name, skill);
    }
  }

  return {
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics
  };
}

function getAgentSkillAllowlist(settings, agentId) {
  const agents = settings?.agents || {};
  const specific = Array.isArray(agents.list)
    ? agents.list.find((agent) => agent && String(agent.id || '') === String(agentId || 'desktop'))
    : null;

  if (specific && Object.prototype.hasOwnProperty.call(specific, 'skills')) {
    return Array.isArray(specific.skills) ? specific.skills : [];
  }

  if (Object.prototype.hasOwnProperty.call(agents.defaults || {}, 'skills')) {
    return Array.isArray(agents.defaults.skills) ? agents.defaults.skills : [];
  }

  return null;
}

function buildSkillRoots(settings) {
  const roots = [
    { path: getHomeSkillsPath(), source: 'home' }
  ];

  for (const extraDir of settings?.skills?.load?.extraDirs || []) {
    roots.push({ path: expandHome(String(extraDir)), source: 'extra' });
  }

  return roots;
}

function scanSkillRoot(rootPath) {
  const root = safeRealpath(rootPath);
  if (!root) return [];

  const found = [];
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory()) continue;

    const direct = path.join(root, entry.name, 'SKILL.md');
    if (isContainedSkillFile(root, direct)) found.push(direct);

    const groupDir = path.join(root, entry.name);
    for (const nested of safeReadDir(groupDir)) {
      if (!nested.isDirectory()) continue;
      const grouped = path.join(groupDir, nested.name, 'SKILL.md');
      if (isContainedSkillFile(root, grouped)) found.push(grouped);
    }
  }

  return found;
}

function readSkill(skillPath, root) {
  try {
    const content = fs.readFileSync(skillPath, 'utf8');
    const frontmatter = parseFrontmatter(content);
    const name = normalizeSkillName(frontmatter.name || path.basename(path.dirname(skillPath)));
    const description = String(frontmatter.description || '').trim();

    if (!name || !description) {
      return {
        ok: false,
        diagnostic: { location: skillPath, reason: 'Missing required name or description.' }
      };
    }

    const skillDir = path.dirname(skillPath);
    return {
      ok: true,
      skill: {
        name,
        description,
        location: skillPath,
        dir: skillDir,
        source: root.source,
        userInvocable: frontmatter['user-invocable'] !== false,
        disableModelInvocation: frontmatter['disable-model-invocation'] === true,
        metadata: frontmatter.metadata || {}
      }
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: { location: skillPath, reason: error.message }
    };
  }
}

function parseFrontmatter(content) {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};

  const text = content.slice(3, end).replace(/\r/g, '');
  const lines = text.split('\n');
  const out = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2] || '';

    if (key === 'metadata' && !value.trim()) {
      const block = [];
      while (index + 1 < lines.length && !/^[A-Za-z0-9_-]+:\s*/.test(lines[index + 1])) {
        index += 1;
        block.push(lines[index]);
      }
      out[key] = parseMetadata(block.join('\n'));
    } else if (key === 'metadata') {
      out[key] = parseMetadata(value);
    } else {
      out[key] = parseScalar(value);
    }
  }

  return out;
}

function parseScalar(value) {
  const trimmed = String(value || '').trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseMetadata(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};

  try {
    return JSON.parse(removeTrailingCommas(raw));
  } catch {
    return {};
  }
}

function removeTrailingCommas(value) {
  return value.replace(/,\s*([}\]])/g, '$1');
}

function isSkillEligible(skill, settings) {
  const entry = settings?.skills?.entries?.[skill.name] || {};
  if (entry.enabled === false) return { ok: false, reason: 'Disabled in settings.' };

  const yolo = skill.metadata?.yoloAuto || skill.metadata?.yolo || {};
  if (yolo.always) return { ok: true };

  const osGate = yolo.os;
  if (osGate) {
    const allowed = Array.isArray(osGate) ? osGate : [osGate];
    if (!allowed.includes(process.platform)) return { ok: false, reason: `OS gate excluded ${process.platform}.` };
  }

  const requires = yolo.requires || {};
  for (const bin of requires.bins || []) {
    if (!hasCommand(bin)) return { ok: false, reason: `Missing required binary: ${bin}` };
  }
  if (Array.isArray(requires.anyBins) && requires.anyBins.length > 0 && !requires.anyBins.some(hasCommand)) {
    return { ok: false, reason: `Missing one of required binaries: ${requires.anyBins.join(', ')}` };
  }
  for (const envName of requires.env || []) {
    if (!process.env[envName] && !entry.env?.[envName] && !(yolo.primaryEnv === envName && entry.apiKey)) {
      return { ok: false, reason: `Missing required env: ${envName}` };
    }
  }
  for (const configPath of requires.config || []) {
    if (!getByPath(settings, configPath)) return { ok: false, reason: `Missing required config: ${configPath}` };
  }

  return { ok: true };
}

function formatSkillsForPrompt(skills) {
  const visible = (skills || []).filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return '';

  const rows = visible.map((skill) => (
    `  <skill name="${xmlEscape(skill.name)}" location="${xmlEscape(skill.location)}" user-invocable="${skill.userInvocable ? 'true' : 'false'}">${xmlEscape(skill.description)}</skill>`
  )).join('\n');

  return `\n\nSkills are auto-loaded for this session. Use them when the user's request matches a skill description or when the user starts a message with /skill-name. Before using a skill, read its SKILL.md at the listed location with the read tool, then follow its workflow. Do not read unrelated skills. Available skills:\n<available_skills>\n${rows}\n</available_skills>`;
}

function hasCommand(command) {
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [command], { stdio: 'ignore' });
    } else {
      execFileSync('sh', ['-lc', `command -v ${shellQuote(command)}`], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function getByPath(object, dottedPath) {
  return String(dottedPath || '').split('.').filter(Boolean).reduce((current, key) => current?.[key], object);
}

function isContainedSkillFile(root, skillPath) {
  const realFile = safeRealpath(skillPath);
  if (!realFile || path.basename(realFile).toLowerCase() !== 'skill.md') return false;
  return isInside(root, realFile);
}

function isInside(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRealpath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function safeReadDir(value) {
  try {
    return fs.readdirSync(value, { withFileTypes: true });
  } catch {
    return [];
  }
}

function expandHome(value) {
  const os = require('node:os');
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeSkillName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function xmlEscape(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

module.exports = {
  discoverSkills,
  formatSkillsForPrompt,
  isInside
};
