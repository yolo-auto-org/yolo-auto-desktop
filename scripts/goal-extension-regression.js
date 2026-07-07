#!/usr/bin/env node
/*
 * Regression harness for YOLO Auto's bundled pi-goal-x integration.
 *
 * It verifies that the desktop SDK session loads the goal extension, that
 * /goals-set creates a disk-backed goal, and that autoContinue immediately
 * starts a hidden goal checkpoint turn with lifecycle tools available.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PiSdkSessionManager } = require('../src/main/pi-sdk-session-manager');

const MODEL = 'fixture-goal-model';

async function main() {
  const server = createFixtureServer();
  await listen(server, '127.0.0.1', 0);
  const { port } = server.address();

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-goal-regression-'));
  const userDataDir = path.join(tempRoot, 'user-data');
  const agentDir = path.join(tempRoot, 'agent');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });

  const events = [];
  const logs = [];
  const settings = {
    apiBaseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'fixture-key',
    model: MODEL,
    thinkingLevel: 'none',
    compatibilityPreset: 'local-basic',
    maxConcurrency: 1,
    guardrails: 'off',
    skills: {},
    agents: {}
  };

  const manager = new PiSdkSessionManager({
    userDataDir,
    agentDir,
    getSettings: () => settings,
    getDefaultWorkspaceRoot: () => workspaceRoot,
    emit: (event) => events.push(event),
    requestCommandApproval: async () => false,
    log: (level, message, meta) => logs.push({ level, message, meta })
  });

  try {
    const session = await manager.createSession({ workspaceRoot, thinkingLevel: 'none' });
    const extensions = manager.active.session.resourceLoader.getExtensions();
    const commands = new Set(extensions.extensions.flatMap((extension) => [...extension.commands.keys()]));
    assert.equal(extensions.errors.length, 0, `goal extension load errors: ${JSON.stringify(extensions.errors)}`);
    assert.equal(commands.has('goals-set'), true, 'pi-goal-x /goals-set command should be registered');

    await manager.run(session.id, '/goals-set Smoke goal from YOLO Auto Desktop');
    await waitFor(() => server.requests.length >= 1, 5_000, 'autoContinue checkpoint request');
    await waitFor(
      () => events.some((event) => event.type === 'tool:result' && event.name === 'pause_goal'),
      5_000,
      'pause_goal tool result'
    );
    await waitFor(() => !manager.hasBusySessions(), 5_000, 'goal smoke run to stop');

    const request = server.requests[0];
    const toolNames = requestToolNames(request);
    assert.equal(toolNames.includes('get_goal'), true, 'goal lifecycle tools should be allowed');
    assert.equal(toolNames.includes('pause_goal'), true, 'pause_goal should be available during active goal execution');

    const requestText = requestMessageText(request);
    assert.match(requestText, /\[GOAL CHECKPOINT goalId=/, 'autoContinue should send a goal checkpoint prompt');
    assert.match(requestText, /Smoke goal from YOLO Auto Desktop/, 'checkpoint should include the created objective');

    const goalFiles = await fs.readdir(path.join(workspaceRoot, '.pi', 'goals'));
    const activeGoal = goalFiles.find((name) => /^active_goal_.*\.md$/.test(name));
    assert.ok(activeGoal, `expected an active goal file, got ${goalFiles.join(', ')}`);
    const goalText = await fs.readFile(path.join(workspaceRoot, '.pi', 'goals', activeGoal), 'utf8');
    const metadata = JSON.parse(goalText.slice(0, goalText.indexOf('\n\n# Goal Prompt')));
    assert.equal(metadata.objective, 'Smoke goal from YOLO Auto Desktop');
    assert.equal(metadata.status, 'paused');
    assert.equal(metadata.pauseReason, 'smoke pause');

    const extensionErrors = logs.filter((entry) => entry.level === 'error' && /extension/i.test(entry.message));
    assert.deepEqual(extensionErrors, []);
    console.log('goal extension regression passed');
  } finally {
    try { manager.closeBrowserTabs?.(); } catch {}
    server.close();
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function createFixtureServer() {
  const requests = [];
  let callNumber = 0;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      const body = await readRequestBody(req);
      requests.push(JSON.parse(body || '{}'));
      callNumber += 1;

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });

      if (callNumber === 1) {
        writeSse(res, {
          id: 'chatcmpl-goal-1',
          object: 'chat.completion.chunk',
          created: 0,
          model: MODEL,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: 'call_goal_pause',
                type: 'function',
                function: {
                  name: 'pause_goal',
                  arguments: JSON.stringify({ reason: 'smoke pause' })
                }
              }]
            },
            finish_reason: null
          }]
        });
        writeSse(res, {
          id: 'chatcmpl-goal-1',
          object: 'chat.completion.chunk',
          created: 0,
          model: MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
        });
      } else {
        writeTextAnswer(res, `chatcmpl-goal-${callNumber}`, 'Goal smoke already paused.');
      }

      res.end('data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error?.message || String(error) } }));
    }
  });
  server.requests = requests;
  return server;
}

function writeTextAnswer(res, id, content) {
  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
  });
  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  });
  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  });
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function requestToolNames(request) {
  return Array.isArray(request?.tools)
    ? request.tools.map((tool) => tool?.function?.name || tool?.name || '').filter(Boolean).sort()
    : [];
}

function requestMessageText(request) {
  return (request?.messages || []).map((message) => contentText(message?.content)).join('\n');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('\n');
  return '';
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch {}
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
