---
name: clawboard
description: "Bootstrap and operate Clawboard with OpenClaw: connect over local/Tailscale, onboard the user with tracking preferences, set up topic routing, append every conversation/action with agent attribution, and optionally configure local memory search (session indexing + local embeddings). Use when installing the Clawboard skill, connecting OpenClaw to a Clawboard instance, or enabling automatic tracking/backfill."
---

# Clawboard

## Overview

Guide a user through connecting OpenClaw to a self-hosted Clawboard instance and enabling automatic, topic-based tracking of conversations, tasks, and actions.

Clawboard is the sidecar memory for OpenClaw: every input and output should be reflected there unless the user explicitly opts out.

Code-path guarantee: the **Clawboard logger plugin** performs the always‑on logging. The skill is used for onboarding and configuration; the plugin does the continuous capture even if the agent forgets to call a tool.

## Onboarding Questions (ask once, keep it brief)

- What is the Clawboard API base URL (FastAPI, local or Tailscale)? The Next.js API is removed.
- Does the Clawboard server require a token? If yes, provide it.
- What instance name should Clawboard display?
- Which integration level should we use?
  - Manual only (UI edits)
  - Assistant can write (topics/tasks/logs)
  - Full backfill (import memory + sessions)
- Should I auto-log every user message and assistant reply?
- Should I auto-log tool actions and code changes as “action” events?
- Should I auto-create tasks when tasks are implied?
- Do you want session memory search enabled (index transcripts)?
- Do you want local embeddings (no API keys) for memory search?
- Which top-level topics should be seeded?
- Do you want to enable the Chutes provider for OpenClaw? (If yes, use the helper scripts below.)

If the user declines any item, skip it and continue.

## Connect prompt (use verbatim)

Use this exact prompt when first connecting OpenClaw to a Clawboard instance:

```
To connect OpenClaw to Clawboard, I need:
1) Clawboard API base URL (FastAPI, local or Tailscale).
2) Does the server require a write token? If yes, paste it.
3) Instance display name.
4) Integration level: manual / write / full backfill.

Once I have those, I’ll validate /api/health and /api/config and start logging.
```

## Workflow

See also: `SEED.md` in the Clawboard repo root for bootstrap notes (token, instance config, and quick curl checks).

### 0) Install the skill (manual now, Clawhub later)

Clawhub is **coming soon**. Until the skill is published there, use the manual install path.

Manual install (current):

- Clone the repo to a stable local path and copy the skill folder to `~/.openclaw/skills/` or `<workspace>/skills/`.

```
git clone https://github.com/sirouk/clawboard ~/clawboard
mkdir -p ~/.openclaw/skills
cp -R ~/clawboard/skills/clawboard ~/.openclaw/skills/clawboard
```
- Priority: workspace > local > bundled.

OpenClaw loads skills from workspace and local folders automatically on the next session.

### 1) Install the always-on logger plugin (required)

Install and enable the Clawboard logger plugin so every turn is captured even if the agent misses a call:

```
openclaw plugins install -l ~/clawboard/extensions/clawboard-logger
openclaw plugins enable clawboard-logger
```

If you see `extracted package missing package.json`, update your local repo:

```
cd ~/clawboard
git pull
```

Set plugin config with the Clawboard base URL and token (if required):

```
"plugins": {
  "entries": {
    "clawboard-logger": {
      "enabled": true,
      "config": {
        "baseUrl": "http://clawboard:8010",
        "token": "YOUR_TOKEN",
        "contextAugment": true,
        "contextMaxChars": 2200
      }
    }
  }
}
```

Token note:
- If your API server sets `CLAWBOARD_TOKEN`, use the same value here.
- If no token is required, omit the `token` field or leave it empty.

### 2) Validate connectivity

- `GET /api/health`
- `GET /api/config`

If the host is on Tailscale, use the tailnet hostname or IP (example: `http://clawboard-node:8000`). If the request fails, ask the user to confirm the Tailscale hostname, port, and that Clawboard API is running.

### 3) Seed Clawboard

- Ensure core topics exist using `POST /api/topics`.
- Set instance title and integration level with `POST /api/config`.
- Append a first log entry confirming connection.
- Create an **onboarding topic** (if missing) and an **onboarding task** pinned by default.
- When onboarding is complete, mark the onboarding task as `done`.

### 3a) Task-scoped conversations

- When a message clearly relates to a specific task, include `taskId` in the log entry.
- The task view shows only logs with `taskId` set (task-specific conversation timeline).
- The topic view shows the full topic timeline newest → oldest.
- **Curated notes:** users can append notes to any log entry. These are sent as `type: "note"` with `relatedLogId` pointing at the original entry. When OpenClaw builds context for a topic/task, include these curated notes as “user annotations” alongside the conversation history.

### 4) Always-on tracking

- Log every user message as a `conversation` entry.
- Log every assistant reply as a `conversation` entry.
- Log meaningful work as an `action` entry (tool runs, code changes, deployments, decisions).
- Always include `agentId` + `agentLabel` in log entries.
- OpenClaw must generate `summary` for each message (1–2 lines) and store full text in `raw`.
- In this repo, summaries are generated by the **Clawboard logger plugin** (OpenClaw side) using a lightweight truncation heuristic. If you want LLM summaries, replace the summarizer in the plugin and keep the same `summary`/`raw` payload shape.
- Clawboard UI shows summaries by default; users can click “...” or “Show full prompts.”
- Tasks support **pinning**. Use `pinned: true` to keep priority tasks at the top; users and OpenClaw can toggle it via `POST /api/tasks`.
- The plugin also injects Clawboard continuity context at `before_agent_start` (topics, tasks, recent timeline, curated notes) unless `contextAugment` is disabled.

### 4a) API awareness (mandatory)

- Treat `references/clawboard-api.md` as the **authoritative API contract**.
- Use it to know all fields OpenClaw can control: topics, tasks (including `pinned`), and log entries.

### 4b) Never skip a beat (mandatory logging)

Wire OpenClaw to emit log events on every turn and tool interaction. Do **not** treat logging as optional.

- Use OpenClaw hook points for inbound/outbound events so no message is missed.
- Prefer plugin hooks inside the agent loop: `message_received`, `message_sent`, `before_tool_call`, `after_tool_call`, `agent_end`.
- Required event coverage:
  - inbound user message → log `conversation` (summary + raw)
  - outbound assistant reply → log `conversation` (summary + raw)
  - tool calls and significant actions → log `action`
  - agent completion → log a final `action` summary if needed
- If Clawboard is unavailable, queue locally and flush on next run.

See `references/openclaw-hooks.md` for hook locations, CLI commands, and lifecycle event names.

### 5) Topic routing with minimal questions

- Use recency, keywords, and active tasks to pick a topic.
- Ask the user only if confidence is low.
- Ask one short question with 2–4 options.
- Store the answer as a routing rule.

See `references/routing-rules.md`.

### 6) Optional: local memory search (privacy-first)

If the user wants local embeddings and session memory search, run the helper:

- `{baseDir}/scripts/setup-openclaw-local-memory.sh`

This configures:

- `agents.defaults.compaction.memoryFlush.enabled = true`
- `agents.defaults.memorySearch.experimental.sessionMemory = true`
- `agents.defaults.memorySearch.sources = ["memory", "sessions"]`
- `agents.defaults.memorySearch.provider = "local"`
- `agents.defaults.memorySearch.fallback = "none"`
- `agents.defaults.memorySearch.local.modelPath = <downloaded model>`

See `references/openclaw-memory-local.md` for details and caveats.

### 7) Backfill (when requested)

- Import historical conversations and memory into Clawboard.
- Use stable IDs so re-runs are idempotent.
- Keep newest-first display while preserving true timestamps.

## References

- `references/clawboard-api.md`
- `references/routing-rules.md`
- `references/openclaw-memory-local.md`
- `references/openclaw-hooks.md`
### 8) Optional: enable Chutes provider (recommended)

Use the helper scripts (self-contained: install OpenClaw if needed, add Chutes auth, configure the provider, and set the agent primary model only):

**macOS / Linux / WSL / Git Bash:**

```
curl -fsSL https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh | bash
```

**Windows (PowerShell + Git Bash/WSL):**

```
iwr -useb https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh | bash
```

No repo cloning is required.

Model list refresh:
- The installer writes `~/.openclaw/update_chutes_models.sh`.
- A cron job runs it every 4 hours (if `crontab` is available).
- You can run the script manually at any time to refresh Chutes models.
