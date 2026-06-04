#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const includeDirs = ['src', 'scripts'];
const skip = new Set(['node_modules', '.git', 'release', 'dist', 'out']);
const files = [];

for (const dir of includeDirs) walk(path.join(rootDir, dir));
files.push(path.join(rootDir, 'electron-builder.config.cjs'));

let failed = false;
for (const filePath of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`\nSyntax check failed: ${path.relative(rootDir, filePath)}\n`);
    process.stderr.write(result.stderr || result.stdout || 'Unknown syntax error');
  }
}

if (failed) process.exit(1);
console.log(`syntax checks passed for ${files.length} js files`);

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (/\.(?:cjs|mjs|js)$/i.test(entry.name)) files.push(fullPath);
  }
}
