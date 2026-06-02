const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME_BASE_DIR = path.join(os.homedir(), '.yolo-auto-desktop');
const HOME_WORKSPACE_DIR = path.join(HOME_BASE_DIR, 'workspace');
const HOME_SKILLS_DIR = path.join(HOME_BASE_DIR, 'skills');
const STARTER_SKILLS_DIR = path.join(__dirname, '..', 'skills');
const HOME_AGENTS_FILE = path.join(HOME_BASE_DIR, 'AGENTS.md');
const HOME_SOUL_FILE = path.join(HOME_BASE_DIR, 'SOUL.md');

function getHomeBasePath() {
  return HOME_BASE_DIR;
}

function getHomeSkillsPath() {
  return HOME_SKILLS_DIR;
}

function getHomeWorkspacePath() {
  return HOME_WORKSPACE_DIR;
}

function ensureHomeBase(log = () => {}) {
  fs.mkdirSync(HOME_BASE_DIR, { recursive: true });
  fs.mkdirSync(HOME_WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(HOME_SKILLS_DIR, { recursive: true });
  seedHomeContextFiles(log);
  seedStarterSkills(log);
  return {
    homeBaseRoot: HOME_BASE_DIR,
    workspaceRoot: HOME_WORKSPACE_DIR,
    skillsRoot: HOME_SKILLS_DIR,
    agentsPath: HOME_AGENTS_FILE,
    soulPath: HOME_SOUL_FILE
  };
}

function seedHomeContextFiles(log) {
  writeIfMissing(HOME_AGENTS_FILE, defaultAgentsTemplate(), log, 'context:seed-agents');
  writeIfMissing(HOME_SOUL_FILE, defaultSoulTemplate(), log, 'context:seed-soul');
}

function writeIfMissing(filePath, content, log, event) {
  if (fs.existsSync(filePath)) return;
  fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
  log('info', event, { path: filePath });
}

function defaultAgentsTemplate() {
  return `# AGENTS.md - YOLO Auto Home Base

This is YOLO Auto's home base. Use it for durable instructions, preferences, notes, and small helper files.

## Operating defaults
- Be a practical desktop assistant for everyday life/admin work and a rigorous coding agent for software tasks.
- For coding: inspect before editing, prefer exact patches, run relevant checks/tests, and report what changed.
- Prefer clear, reversible steps and explain important changes briefly.
- Ask before destructive actions like deleting, overwriting, force-pushing, rewriting history, or bulk-moving many files.
- Do not expose secrets or private data. If credentials are needed, ask the user to provide them safely.
- Do not store secrets in AGENTS.md or SOUL.md; they are loaded into the model prompt.
- Keep chat concise; write long drafts, plans, reports, or coding notes to files when useful.

## Custom notes
Add standing instructions for this assistant here.
`;
}

function defaultSoulTemplate() {
  return `# SOUL.md - Persona & Boundaries

You are YOLO Auto: a calm, capable local desktop assistant.

- Tone: concise, friendly, direct, and practical.
- Style: do the work instead of giving long tutorials when tools can handle it.
- Ask a clarifying question when the goal, destination, or safety risk is unclear.
- Stay transparent about actions taken and important command results.
- Keep the user's trust: no snooping, no secret exfiltration, no destructive surprises.
`;
}

function seedStarterSkills(log) {
  if (!fs.existsSync(STARTER_SKILLS_DIR)) return;

  for (const entry of fs.readdirSync(STARTER_SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const source = path.join(STARTER_SKILLS_DIR, entry.name);
    const destination = path.join(HOME_SKILLS_DIR, entry.name);
    if (fs.existsSync(destination)) continue;

    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
    log('info', 'skills:seed', { name: entry.name, destination });
  }
}

module.exports = {
  ensureHomeBase,
  getHomeBasePath,
  getHomeSkillsPath,
  getHomeWorkspacePath,
  HOME_AGENTS_FILE,
  HOME_SOUL_FILE
};
