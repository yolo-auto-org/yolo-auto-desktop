---
name: browser-automation
description: Drive live web pages with the browser tool for multi-step browsing, forms, login checks, tab management, screenshots-by-snapshot, or pages that need JavaScript beyond plain fetch. Use when the user asks to navigate a site, click through pages, inspect dynamic content, fill forms, or recover from browser/page state issues.
user-invocable: false
---

# Browser Automation

Use this skill when `web_fetch` is not enough and the task needs a live page: dynamic content, tab state, clicking, forms, or multi-step navigation.

## Operating loop

1. Check state before acting:
   - `browser` with `action: "status"` for availability.
   - `browser` with `action: "tabs"` before opening duplicates.
2. Open important pages with a stable `label`, e.g. `label: "research"` or `label: "checkout"`.
3. Snapshot before clicking or typing:
   - `browser` with `action: "snapshot"` and the `targetId` label/tab.
   - Use refs from the latest snapshot for `click` and `fill`.
4. Act narrowly:
   - Prefer `click` or `fill` with a `ref` from the current snapshot.
   - Snapshot again after navigation, modal changes, form submission, or errors.
5. Stop for real blockers:
   - login, captcha, 2FA, payment, permissions, destructive actions, or anything requiring user approval.

## Tab hygiene

- Reuse an existing tab with the right label or URL when possible.
- Close duplicates created by retries.
- Do not rely on numeric tab positions. Use returned tab IDs such as `t1` or labels.

## Stale ref recovery

If a click/fill fails:
1. Snapshot the same target again.
2. Find the current visible control.
3. Retry once with the new ref.
4. If the page moved to a blocker state, report the blocker instead of looping.

## Good browser tool calls

```json
{ "action": "open", "url": "https://example.com", "label": "example" }
```

```json
{ "action": "snapshot", "targetId": "example" }
```

```json
{ "action": "click", "targetId": "example", "ref": "r4" }
```

```json
{ "action": "fill", "targetId": "example", "ref": "r7", "text": "hello@example.com" }
```

## Safety

- Do not submit purchases, send messages, publish posts, or make irreversible changes without explicit confirmation.
- If a site asks for private credentials or 2FA, ask the user to complete it in the browser and tell you when done.
- Prefer `web_search`/`web_fetch` for simple read-only research; use browser only when dynamic page state matters.
