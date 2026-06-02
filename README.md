# yolo-auto-desktop

A local desktop personal assistant for daily driving your life.

YOLO Auto is a desktop agent shell for both everyday computer chores and serious coding work. It can organize messy folders, summarize documents, draft notes, prepare plans, rename photos, create archives, inspect repositories, edit code, run builds/tests, search files, and use safe local commands while you watch.

The runtime is now built on the Pi coding-agent SDK, so coding workflows get Pi's production-grade session, tool, skill, extension, and compaction foundations while the UI stays desktop-friendly.

## Run locally

```bash
npm install
npm start
```

`npm start` first runs `scripts/ensure-electron.js`, which downloads/extracts the Electron binary if npm did not do it correctly.

Open Settings in the app and enter an OpenAI-compatible endpoint:

- API Base URL: `https://api.openai.com/v1` or your yolo-auto endpoint
- API Key
- Model
- Default thinking level (`none`, `low`, `medium`, `high`, `xhigh`)

You can also seed settings with environment variables:

```bash
YOLO_AUTO_API_KEY=... YOLO_AUTO_MODEL=... npm start
```

Supported env vars:

- `YOLO_AUTO_API_KEY` / `OPENAI_API_KEY`
- `YOLO_AUTO_BASE_URL` / `OPENAI_BASE_URL`
- `YOLO_AUTO_MODEL` / `OPENAI_MODEL`
- `YOLO_AUTO_THINKING_LEVEL` / `OPENAI_REASONING_EFFORT`
- `YOLO_AUTO_COMPATIBILITY_PRESET` / `YOLO_AUTO_MODEL_COMPATIBILITY` (`openai` or `local-basic`)

## Skills

YOLO Auto keeps a home base at `~/.yolo-auto-desktop`. New sessions start there until the user chooses another folder.

YOLO Auto also creates `~/.yolo-auto-desktop/AGENTS.md` and `~/.yolo-auto-desktop/SOUL.md` if missing, then loads them into each chat as standing instructions and persona/tone context. If the selected folder has its own `AGENTS.md` or `SOUL.md`, those are loaded too. Do not put secrets in these files; they are sent to the configured model.

Skills live in `~/.yolo-auto-desktop/skills/<skill-name>/SKILL.md`. On app startup, YOLO Auto creates the home base and seeds starter skills there if they are missing.

At session start, eligible skills are discovered and a compact skill list is injected into the model prompt. The assistant reads the matching `SKILL.md` with `read` before following its workflow.

Starter skills: `text-transform`, `web-research`, `browser-automation`.

Additional Pi skills can be added through Pi-style settings/resources under the home base or selected project (for example `skills` paths in settings, package resources, or `.pi/skills`).

## Current MVP

- Electron desktop shell over the `@earendil-works/pi-coding-agent` SDK
- Clean chat interface
- Folder picker for changing the active session folder
- Durable Pi JSONL session runtime with coding-agent session files in Electron app data (`pi-sessions`)
- Pi coding tools enabled: `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`
- Additional desktop web tools: `web_search`, `web_fetch`, `browser`, plus `get_web` compatibility
- Pi context management: session persistence, retry settings, skills, prompt templates, extensions, and automatic compaction support through the SDK
- Home base at `~/.yolo-auto-desktop` with Pi-style resources: `AGENTS.md`, `SOUL.md`, and skills in `~/.yolo-auto-desktop/skills`
- Starter skills: `text-transform`, `web-research`, and `browser-automation`
- OpenAI-compatible provider registration through the Pi model registry
- Default thinking level in Settings plus per-chat thinking level override
- Lightweight model compatibility presets for OpenAI-compatible vs local/basic endpoints
- Local command shorthands: `!cmd`, `!!cmd`, `/compact`, `/session`, and `/tools`
- While a session works: Enter steers, Alt+Enter queues a follow-up, Esc/Cancel or typing `/stop` stops that session
- Local file, web, and command abilities kept behind a simple desktop UI
- Guardrails in the system prompt for reversible steps and confirmation before destructive actions
- App logs in Electron user data (`app.log`) with an in-app Logs button and retry logging for transient model failures
