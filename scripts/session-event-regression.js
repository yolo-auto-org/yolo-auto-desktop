#!/usr/bin/env node
const assert = require('node:assert/strict');
const { PiSdkSessionManager } = require('../src/main/pi-sdk-session-manager');

function makeManager(events) {
  return new PiSdkSessionManager({
    userDataDir: process.cwd(),
    agentDir: process.cwd(),
    getSettings: () => ({}),
    getDefaultWorkspaceRoot: () => process.cwd(),
    emit: (event) => events.push(event),
    requestCommandApproval: async () => false,
    log: () => {}
  });
}

function makeRuntime(cancelRequested = false) {
  return {
    id: `runtime-${Math.random()}`,
    cwd: process.cwd(),
    sessionFile: '',
    runInProgress: false,
    session: { thinkingLevel: 'off', sessionName: 'test session', messages: [], isStreaming: false },
    currentAssistantText: '',
    currentAssistantThinkingText: '',
    toolCalls: new Map(),
    composingToolSummaries: new Map(),
    cancelledToolCallIds: new Set(),
    failedToolCallIds: new Set(),
    cancelRequested,
    statusState: 'idle',
    statusMessage: ''
  };
}

function sendAssistantEnd(manager, runtime, errorMessage) {
  manager.runtimes.set(runtime.id, runtime);
  manager.handlePiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [], errorMessage }
  }, runtime);
}

const abortedEvents = [];
const abortedManager = makeManager(abortedEvents);
const abortedRuntime = makeRuntime(false);
sendAssistantEnd(abortedManager, abortedRuntime, 'Request was aborted');
assert.equal(abortedRuntime.statusState, 'cancelled');
assert.equal(abortedEvents.some((event) => event.type === 'run:error'), false);
assert.equal(abortedEvents.at(-1).message, 'Cancelled');

const cancelledEvents = [];
const cancelledManager = makeManager(cancelledEvents);
const cancelledRuntime = makeRuntime(true);
sendAssistantEnd(cancelledManager, cancelledRuntime, 'provider stream closed');
assert.equal(cancelledRuntime.statusState, 'cancelled');
assert.equal(cancelledEvents.some((event) => event.type === 'run:error'), false);

const errorEvents = [];
const errorManager = makeManager(errorEvents);
const errorRuntime = makeRuntime(false);
sendAssistantEnd(errorManager, errorRuntime, 'provider exploded');
assert.equal(errorRuntime.statusState, 'error');
assert.equal(errorEvents.some((event) => event.type === 'run:error' && event.message === 'provider exploded'), true);

console.log('session event regression passed');
