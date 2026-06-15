# Context Usage, Session I/O, and Status Plan

## Goal

Show users how much context a session is using, the session-level input/output token totals, and the current session status. Keep the design compatible with future context compaction controls and basic settings.

## Current repo status

- `src/main/pi-sdk-session-manager.js` already uses Pi `AgentSession.getSessionStats()` in the local `/session` command.
- Pi exposes `AgentSession.getContextUsage()` / `SessionStats.contextUsage` with `{ tokens, contextWindow, percent }`.
- Pi assistant messages carry usage totals (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, cost).
- Compaction is enabled by default through app settings:
  - `enabled: true`
  - `reserveTokens: 32000` (auto-compaction starts at about 75% of the default 128k context window)
  - `keepRecentTokens: 20000`
- Renderer session summaries now carry normalized metrics; the active footer and session lists show context/input/output at a glance.

## MVP user experience

1. **Active session header/status**
   - Show a compact meter near the existing status/model area:
     - `Context: 42k / 128k (33%)`
     - `I/O: 310k in · 24k out`
     - Status: `Idle`, `Running`, `Compacting`, `Retrying`, `Cancelled`, or `Error`
   - If Pi reports unknown context after compaction, show `Context: ? / 128k` with tooltip `Will update after the next model response`.

2. **Session management list**
   - Add lightweight metrics to each session row/card:
     - context percent if known
     - input/output totals
     - status
   - Keep this concise; detailed metrics belong in the active session panel or tooltip.

3. **Local command enhancement**
   - Extend `/session` output to include context usage and separate input/output/cache tokens.

## Data model

Add a normalized metrics object to every session summary returned to the renderer:

```js
{
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    lastTurn: {
      input: 0,
      output: 0,
      total: 0,
      cost: 0,
      at: ''
    }
  },
  context: {
    tokens: null,          // number or null when unknown
    contextWindow: 128000,
    percent: null,         // number or null when unknown
    status: 'unknown'      // known | unknown | unavailable
  },
  status: {
    state: 'idle',         // idle | running | compacting | retrying | cancelling | cancelled | error
    message: 'Ready',
    updatedAt: ''
  },
  compaction: {
    enabled: true,
    reserveTokens: 32000,
    keepRecentTokens: 20000,
    lastCompactedAt: '',
    lastTokensBefore: null
  }
}
```

Notes:
- Treat Pi JSONL session messages as the source of truth for token usage.
- Use a derived cache only for fast list rendering, not as the canonical record.
- Do **not** persist raw prompts or provider payloads in this MVP. Raw context inspection can be a future opt-in debug/export feature because it may contain secrets.

## Backend implementation shape

1. **Create a metrics utility**
   - Add `src/main/session-metrics.js` with helpers:
     - `emptySessionMetrics()`
     - `metricsFromAgentSession(session, runtimeStatus)`
     - `metricsFromMessages(messages, modelContextWindow)`
     - `mergeRuntimeStatus(metrics, event)`
     - formatting helpers for `/session` output
   - Aggregate usage from assistant messages and `session.getSessionStats()` when available.
   - Use `session.getContextUsage()` for active runtimes.

2. **Extend runtime state**
   - In `PiSdkSessionManager.activatePiSessionManager()`, initialize `active.status` and `active.metrics`.
   - In `handlePiEvent()` update status/metrics on:
     - `agent_start` -> `running`
     - `auto_retry_start` -> `retrying`
     - `compaction_start` -> `compacting`
     - `compaction_end` -> `idle` or `error`, record compaction result metadata
     - `message_end` for assistant messages -> update usage/context
     - `agent_end` -> `idle`, `cancelled`, or `retrying`
   - Emit a renderer event such as `session:metrics` or include metrics in existing `sessions:update`.

3. **Extend session summaries**
   - Add `metrics` to `runtimeSummary()` and `sessionInfoToSummary()`.
   - For unloaded sessions, parse/aggregate from the session file only when needed, or maintain a small derived cache under Electron user data.
   - Keep `listSessions()` fast by using cached metrics and refreshing asynchronously.

4. **Add IPC if needed**
   - Existing bootstrap/list/select payloads can carry metrics.
   - Add `sessions:metrics(sessionId)` only if lazy loading detailed metrics is cleaner for the UI.

5. **Compaction settings foundation**
   - `src/main/settings.js` now owns normalized compaction settings:
     - `compaction.enabled`
     - `compaction.reserveTokens`
     - `compaction.keepRecentTokens`
   - `createAgentSessionForManager()` should continue to consume normalized settings rather than hard-coded overrides.
   - Optional future display warning threshold can live under `context.warningPercent`.

## Renderer implementation shape

1. **State**
   - Store `state.activeSession.metrics` and session row `session.metrics`.

2. **Active status display**
   - Add a small context/usage strip in `src/renderer/index.html` near status/model.
   - Render with helper functions:
     - `formatTokens(42000) -> 42k`
     - `formatContext(metrics.context)`
     - `formatUsage(metrics.usage)`
   - Update from bootstrap, `sessions:update`, and the new metrics event.

3. **Session lists**
   - Add concise metrics text to `createSessionItem()` and `createSessionTableRow()`.
   - Keep mobile/narrow layout readable; hide details behind title/tooltips if needed.

4. **Settings placeholder**
   - Add a future `Context` settings section/tab once backend settings exist:
     - Auto compaction toggle
     - Reserve tokens
     - Keep recent tokens
     - Show context meter toggle / warning threshold

## Future phases

### Phase 1: Metrics only
- Session-level context meter, input/output tokens, cost, and status.
- No behavior changes except replacing `/session` output.

### Phase 2: Basic compaction controls
- Expand compaction Settings UI if needed.
- Add manual `Compact now` button using existing `active.session.compact()` path.
- Show last compaction timestamp and `tokensBefore`.

### Phase 3: Optional context inspection/export
- Opt-in developer feature to capture/request a redacted context preview before model calls.
- Prefer counts by default; raw context can include secrets from files, tools, and prompts.

## Acceptance criteria

- Active session displays context usage and input/output totals after each assistant response.
- Session list shows current status for idle/running/compacting/retrying/cancelled sessions.
- `/session` reports context usage, input/output/cache tokens, total tokens, and cost.
- After compaction, context can display `unknown` without errors until the next model response.
- Compaction defaults remain identical to current behavior unless the user changes settings.
