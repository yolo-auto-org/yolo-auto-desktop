#!/usr/bin/env node
/*
 * Regression harness for YOLO Auto's bundled pi-loop-police integration.
 *
 * It verifies that the desktop SDK session loads the Loop Police extension and
 * that an adjacent identical tool call is blocked before it can spin forever.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PiSdkSessionManager } = require('../src/main/pi-sdk-session-manager');

const MODEL = 'fixture-loop-police-model';

async function main() {
  const server = createFixtureServer();
  await listen(server, '127.0.0.1', 0);
  const { port } = server.address();

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-loop-police-regression-'));
  const userDataDir = path.join(tempRoot, 'user-data');
  const agentDir = path.join(tempRoot, 'agent');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'README.md'), '# Loop Police Fixture\n\nRead me once, not forever.\n', 'utf8');

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
    assert.equal(extensions.errors.length, 0, `extension load errors: ${JSON.stringify(extensions.errors)}`);
    assert.equal(commands.has('loop-police'), true, 'pi-loop-police /loop-police command should be registered');

    const skills = manager.active.session.resourceLoader.getSkills();
    assert.equal(
      (skills.skills || []).some((skill) => skill.name === 'loop-police-help'),
      true,
      'pi-loop-police skill should be loaded from the bundled package'
    );

    const result = await manager.run(session.id, 'Read README.md twice with identical read calls, then summarize.');
    assert.match(result.content, /Loop police smoke complete/, 'fixture should reach the final answer after the blocked loop');

    const readResults = events.filter((event) => event.type === 'tool:result' && event.name === 'read');
    assert.ok(readResults.length >= 2, `expected at least two read results, got ${readResults.length}`);

    const blockedRead = readResults.find((event) => event.result?.ok === false && /TOOL CALL LOOP/i.test(event.result?.preview || ''));
    assert.ok(blockedRead, `expected loop-police to block the repeated read call, got ${JSON.stringify(readResults)}`);

    const extensionErrors = logs.filter((entry) => entry.level === 'error' && /extension/i.test(entry.message));
    assert.deepEqual(extensionErrors, []);
    console.log('loop-police regression passed');
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

      if (callNumber === 1 || callNumber === 2) {
        writeReadToolCall(res, `chatcmpl-loop-${callNumber}`, `call_loop_read_${callNumber}`);
      } else {
        writeTextAnswer(res, `chatcmpl-loop-${callNumber}`, 'Loop police smoke complete.');
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

function writeReadToolCall(res, id, toolCallId) {
  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: toolCallId,
          type: 'function',
          function: {
            name: 'read',
            arguments: JSON.stringify({ path: 'README.md' })
          }
        }]
      },
      finish_reason: null
    }]
  });
  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
  });
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
