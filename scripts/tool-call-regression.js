#!/usr/bin/env node
/*
 * Regression harness for YOLO Auto's Pi SDK tool-call stream.
 *
 * It starts a deterministic OpenAI-compatible fixture server, runs real
 * PiSdkSessionManager sessions against it, and compares the normalized stream
 * output to tests/fixtures/tool-call-regression.expected.json.
 *
 * This intentionally does NOT patch production code. Use --update only when the
 * known-good stream shape changes intentionally.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PiSdkSessionManager } = require('../src/main/pi-sdk-session-manager');

const FIXTURE_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'tool-call-regression.expected.json');
const UPDATE = process.argv.includes('--update');
const MODEL = 'fixture-tool-model';

async function main() {
  const server = createFixtureServer();
  await listen(server, '127.0.0.1', 0);
  const { port } = server.address();

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-tool-regression-'));
  const userDataDir = path.join(tempRoot, 'user-data');
  const agentDir = path.join(tempRoot, 'agent');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'README.md'), '# Fixture README\n\nThis file proves the read tool executed.\n', 'utf8');

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
    emit: (event) => events.push(stripVolatile(event)),
    requestCommandApproval: async () => false,
    log: (level, message, meta) => logs.push({ level, message, meta })
  });

  try {
    const readSession = await manager.createSession({ workspaceRoot, thinkingLevel: 'none' });
    const readResult = await manager.run(readSession.id, 'Read README.md, then answer with the fixture result.');

    const unsafeWebSession = await manager.createSession({ workspaceRoot, thinkingLevel: 'none' });
    const unsafeWebResult = await manager.run(unsafeWebSession.id, 'Try the unsafe web fixture URL, then report the result.');

    const actual = normalizeRun({
      results: { read: readResult, unsafeWebFetch: unsafeWebResult },
      events,
      requests: server.requests,
      privateFetchHits: server.privateFetchHits
    });

    if (UPDATE) {
      await fs.mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
      await fs.writeFile(FIXTURE_PATH, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
      console.log(`Updated ${path.relative(process.cwd(), FIXTURE_PATH)}`);
    } else {
      const expected = JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8'));
      assert.deepEqual(actual, expected);
      console.log('tool-call regression fixture passed');
    }
  } finally {
    try { manager.closeBrowserTabs?.(); } catch {}
    server.close();
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function createFixtureServer() {
  let callNumber = 0;
  let privateFetchHits = 0;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/private') {
        privateFetchHits += 1;
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('PRIVATE FIXTURE SHOULD NOT BE FETCHED');
        return;
      }

      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      const body = await readRequestBody(req);
      const payload = JSON.parse(body || '{}');
      callNumber += 1;
      requests.push(normalizeRequest(payload));

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });

      if (callNumber === 1) {
        writeSse(res, {
          id: 'chatcmpl-fixture-1',
          object: 'chat.completion.chunk',
          created: 0,
          model: MODEL,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: 'call_fixture_read',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: '{"path":"README.md"}'
                }
              }]
            },
            finish_reason: null
          }]
        });
        writeSse(res, {
          id: 'chatcmpl-fixture-1',
          object: 'chat.completion.chunk',
          created: 0,
          model: MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
        });
      } else if (callNumber === 2) {
        writeTextAnswer(res, 'chatcmpl-fixture-2', 'Fixture final answer.');
      } else if (callNumber === 3) {
        const port = server.address().port;
        writeSse(res, {
          id: 'chatcmpl-fixture-3',
          object: 'chat.completion.chunk',
          created: 0,
          model: MODEL,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: 'call_fixture_unsafe_web_fetch',
                type: 'function',
                function: {
                  name: 'web_fetch',
                  arguments: JSON.stringify({ url: `http://127.0.0.1:${port}/private`, maxChars: 500 })
                }
              }]
            },
            finish_reason: null
          }]
        });
        writeSse(res, {
          id: 'chatcmpl-fixture-3',
          object: 'chat.completion.chunk',
          created: 0,
          model: MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
        });
      } else {
        writeTextAnswer(res, 'chatcmpl-fixture-4', 'Unsafe web fetch was blocked.');
      }

      res.end('data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error?.message || String(error) } }));
    }
  });
  server.requests = requests;
  Object.defineProperty(server, 'privateFetchHits', { get: () => privateFetchHits });
  return server;
}

function writeTextAnswer(res, id, content) {
  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{
      index: 0,
      delta: { role: 'assistant', content },
      finish_reason: null
    }]
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
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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

function normalizeRun({ results, events, requests, privateFetchHits }) {
  const assistantContents = events
    .filter((event) => event.type === 'assistant:content')
    .map((event) => event.content || '');
  const leakedAssistantMarkup = assistantContents.filter(containsLeakedToolMarkup);

  return {
    finalContent: {
      read: results?.read?.content || '',
      unsafeWebFetch: results?.unsafeWebFetch?.content || ''
    },
    privateFetchHits,
    requestCount: requests.length,
    requestToolNames: requests.map((request) => request.toolNames),
    toolStarts: events
      .filter((event) => event.type === 'tool:start')
      .map((event) => ({ name: event.name, args: event.args })),
    toolResults: events
      .filter((event) => event.type === 'tool:result')
      .map((event) => ({ name: event.name, ok: event.result?.ok, summary: event.result?.summary })),
    assistantContents,
    leakedAssistantMarkup
  };
}

function normalizeRequest(payload) {
  return {
    model: payload.model,
    stream: payload.stream,
    messageRoles: Array.isArray(payload.messages) ? payload.messages.map((message) => message.role) : [],
    toolNames: Array.isArray(payload.tools)
      ? payload.tools.map((tool) => tool?.function?.name || tool?.name || '').filter(Boolean).sort()
      : []
  };
}

function stripVolatile(event) {
  const copy = JSON.parse(JSON.stringify(event || {}));
  delete copy.sessionId;
  if (copy.args?.path) copy.args.path = String(copy.args.path).replace(/\\/g, '/');
  if (copy.args?.url) copy.args.url = normalizeFixtureUrl(copy.args.url);
  return copy;
}

function normalizeFixtureUrl(value) {
  return String(value || '').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:[PORT]');
}

function containsLeakedToolMarkup(text) {
  return /<\/?(?:invoke|tool_calls?|app_skill)\b/i.test(String(text || ''));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
