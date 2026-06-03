#!/usr/bin/env node
/* Launches Electron to verify browser-tool guard scoping. */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

async function main() {
  const electron = require('electron');
  const runner = path.join(__dirname, 'electron-browser-guard-runner.js');
  const child = spawn(electron, [runner], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' }
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  if (exitCode !== 0) {
    process.stderr.write(stderr);
    process.stdout.write(stdout);
    throw new Error(`Electron browser guard runner failed with exit code ${exitCode}`);
  }

  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('YOLO_ELECTRON_BROWSER_GUARD_RESULT '));
  if (!line) {
    process.stderr.write(stderr);
    process.stdout.write(stdout);
    throw new Error('Electron browser guard runner did not produce a result.');
  }

  const result = JSON.parse(line.replace('YOLO_ELECTRON_BROWSER_GUARD_RESULT ', ''));
  assert.equal(result.defaultSessionGuarded, false, 'guard must not touch Electron defaultSession');
  assert.equal(result.guardedSessionGuarded, true, 'guarded browser-tool session should have guard installed');
  assert.equal(result.guardedHits, 0, 'guarded browser-tool window should block private/local subresource requests');
  assert.ok(result.blockedLogCount >= 1, 'guard should log the blocked browser request');

  console.log('electron browser guard regression passed');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
