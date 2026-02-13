# Clawboard

Clawboard is a companion memory system for [OpenClaw](https://openclaw.ai):

- Stage 1: firehose logging (user/assistant/subagent/tool events).
- Stage 2: async classification into Topics and Tasks.
- Stage 3: Clawgraph memory map (entity + relationship synthesis).
- UI: Unified Board, Logs, Stats, Setup, Providers, and Clawgraph.

Clawboard runs alongside OpenClaw. OpenClaw remains the agent runtime; Clawboard provides durable memory capture, classification, curation, and retrieval context.

## Operating Docs

- Operator runbook: `design/operator-runbook.md`
- Visual system spec: `design/visual-end-state-spec.md`

## Stack Snapshot

- OpenClaw runtime + `clawboard-logger` plugin (stage-1 capture + response-time context extension)
- `web`: Next.js App Router UI (`src/`)
- `api`: FastAPI + SQLModel + SQLite (`backend/`)
- `classifier`: async worker (`classifier/classifier.py`) with embeddings + topic/task classification
- `qdrant`: vector index for dense retrieval (with SQLite mirror/fallback)
- Hybrid retrieval path in API search: dense + BM25 + lexical + RRF + late rerank
- Clawgraph memory map API/UI (`/api/clawgraph`, `/graph`)

## If OpenClaw Is Not Installed Yet

If you want to use Chutes as your provider, create an account at `https://chutes.ai` first, then run [`add_chutes.sh`](inference-providers/add_chutes.sh) before skill installation.

Local script:

```bash
bash inference-providers/add_chutes.sh
```

Remote fast path:

```bash
curl -fsSL https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh | bash
```

`scripts/bootstrap_openclaw.sh` will now prompt to launch this fast path when `openclaw` is missing.
It also sets token + browser access URL values during bootstrap.

## Quick Start (Recommended)

1. Create `.env` from the template:

```bash
cp .env.example .env
```

2. Set an API token (required for writes and non-localhost reads):

```bash
openssl rand -hex 32
```

Paste it into `.env` as:

```bash
CLAWBOARD_TOKEN=<your-token>
```

3. Start the stack:

```bash
docker compose up -d --build
```

4. Open:

- UI: `http://localhost:3010`
- API: `http://localhost:8010`
- API docs: `http://localhost:8010/docs`

If you need Tailscale/custom-domain access, set:

- `CLAWBOARD_PUBLIC_API_BASE=<browser-reachable-api-url>`
- `CLAWBOARD_PUBLIC_WEB_URL=<browser-reachable-ui-url>` (optional)

Example:

- Tailscale: `http://100.x.y.z:8010`
- Custom domain: `https://api.example.com`

## What Runs

- `web`: Next.js app (`:3010`)
- `api`: FastAPI + SQLite (`:8010`)
- `classifier`: async classifier worker (default 10s cadence)
- `qdrant`: vector index service on the internal Docker network (no host port publishing)
- `db` + `redis`: optional scale profile services (`docker compose --profile scale ...`), internal network only

Data is persisted in `./data` (`clawboard.db`, embeddings store, queue files).
For install defaults, users interact through `web` and `api`; database services are not exposed externally.

## Technology Stack

- OpenClaw gateway + plugins/hooks (source agent runtime)
- Clawboard logger plugin (`extensions/clawboard-logger`) for stage-1 firehose capture
- FastAPI + SQLModel backend (`backend/`)
- Next.js App Router frontend (`src/`)
- Classifier worker (`classifier/classifier.py`) with local embeddings + Qdrant-backed vector retrieval
- Docker Compose orchestration for `web` + `api` + `classifier` (+ optional scale profile services)

## How It Works

### Stage 1: Firehose Hook Logging (OpenClaw plugin)

- Plugin path: `extensions/clawboard-logger`.
- Captures inbound/outbound conversation and agent activity with OpenClaw hooks:
  - `message_received` (user inbound)
  - `message_sending` + `agent_end` fallback (assistant/main/subagent outbound)
  - `before_tool_call` / `after_tool_call` (tool actions)
- Writes logs to Clawboard as `pending` first so stage 1 never blocks on classification.
- Uses idempotency keys + source `messageId` guards to prevent duplicate conversation rows.

### Stage 2: Async Topic/Task Classifier

- Worker path: `classifier/classifier.py` (runs in `classifier` container).
- Runs every `CLASSIFIER_INTERVAL_SECONDS` (default `10`) with single-flight lock protection.
- Pulls pending conversation windows by `sessionKey`, then classifies with:
  - embeddings (`fastembed`) + hybrid retrieval
  - lexical + BM25 scoring
  - reciprocal rank fusion (RRF) + reranking
  - candidate topic/task retrieval
  - curated user notes (`type=note`) as weighted signals
  - optional OpenClaw memory snippets from sqlite (`OPENCLAW_MEMORY_DB_PATH` fallback support)
- Policy:
  - Topic is mandatory for conversation logs (high-level, human-meaningful naming).
  - Task is optional and only selected/created for explicit execution intent.
  - Topic names should reflect durable themes/entities, not prompt-leading filler text.
- Patches logs to `classified` with resolved `topicId` / `taskId`.
- Generates very short message summaries for chips (telegraphic style, no `SUMMARY:` prefix, transport metadata stripped).

Vector storage notes:

- Qdrant collection is auto-created when needed.
- API search auto-seeds Qdrant from SQLite embeddings if Qdrant is empty.
- SQLite embeddings remain as portability/fallback storage.

### Stage 3: Clawgraph Memory Synthesis

- API path: `GET /api/clawgraph`.
- Builds a graph from topics, tasks, logs, and note-weighted entity extraction:
  - nodes: `topic`, `task`, `entity`, `agent`
  - edges: `has_task`, `mentions`, `co_occurs`, `related_topic`, `related_task`, `agent_focus`
- Powers the Clawgraph page for interactive memory navigation.

### Main Agent Context Extension

- The same logger plugin also augments response-time context using `before_agent_start`.
- It prefers retrieving continuity context via `GET /api/context` (layered working set + routing memory + timeline + optional recall), and falls back to legacy multi-call retrieval when needed.
- This retrieval is additive to OpenClaw native memory (turn history, markdown/context, memory search), not a replacement.

## Local Dev (Without Docker)

Backend:

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8010
```

Frontend (from repo root, separate terminal):

```bash
NEXT_PUBLIC_CLAWBOARD_API_BASE=http://localhost:8010 npm run dev
```

Open `http://localhost:3000`.

## Key Config

Set these in `.env`:

- `CLAWBOARD_TOKEN`: required for all write endpoints and non-localhost reads. Localhost reads can be tokenless.
- `NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN`: optional frontend bootstrap token. This is embedded in the browser bundle, so use only on trusted/private networks.
- `CLAWBOARD_PUBLIC_API_BASE`: API URL reachable from the browser (important for Tailscale usage).
- `CLAWBOARD_PUBLIC_WEB_URL`: optional browser-facing UI URL for bootstrap summaries.
- `OPENCLAW_BASE_URL`: OpenClaw gateway URL for classifier calls from Docker.
- `OPENCLAW_GATEWAY_TOKEN`: OpenClaw gateway auth token (if your gateway requires it).
- `CLASSIFIER_INTERVAL_SECONDS`: classifier loop interval (default `10`).
- `CLASSIFIER_MAX_ATTEMPTS`: max classify retries before failed state (default `3`).
- `CLAWBOARD_TRUST_PROXY`: set `1` only when behind a trusted reverse proxy and you want `X-Forwarded-For` / `X-Real-IP` honored.

Advanced (optional) knobs (see `.env.example` for comments/defaults):

- `CLAWBOARD_SQLITE_TIMEOUT_SECONDS`: sqlite busy timeout under write contention.
- `CLAWBOARD_EVENT_BUFFER` / `CLAWBOARD_EVENT_SUBSCRIBER_QUEUE`: SSE replay buffer + per-subscriber queue depth.
- `CLAWBOARD_INGEST_MODE` / `CLAWBOARD_QUEUE_*`: async ingest queue mode.
- `CLAWBOARD_REINDEX_QUEUE_PATH`: reindex queue jsonl path (non-docker/local dev).
- `CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS`: include/exclude tool call/result/error `action` logs in semantic indexing + retrieval (`0` default).
- `CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_*` + `CLAWBOARD_SEARCH_WINDOW_*`: hard caps/windowing that keep search from exhausting API memory under heavy typing/search workloads.
- `CLAWBOARD_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS`: tighter scan cap for one-word queries (improves latency + precision on name lookups).
- `CLAWBOARD_SEARCH_CONCURRENCY_*`: bound concurrent deep searches and fail fast (`429 search_busy`) under burst traffic.
- `CLAWBOARD_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS`: max per-log content bytes scanned for deep query-term matching.
- `CLAWBOARD_SEARCH_SOURCE_TOPK_*` + `CLAWBOARD_RERANK_CHUNKS_PER_DOC`: candidate-pruning/rerank bounds for hybrid ranking.
- `CLAWBOARD_SEARCH_EMBED_QUERY_CACHE_SIZE`: in-process query-embedding cache size.
- `CLAWBOARD_DISABLE_SNOOZE_WORKER` / `CLAWBOARD_SNOOZE_POLL_SECONDS`: snooze reactivation worker.
- `CLAWBOARD_VECTOR_MODEL`: keep in sync with `CLASSIFIER_EMBED_MODEL` if you override embedding models.
- `CLAWBOARD_WEB_WATCHPACK_POLLING*`: web-dev Docker file watching.
- `CLAWBOARD_WEB_DEV_PREWARM*`: web-dev startup route prewarm (`/` + `/u`) to reduce first-hit compile delays.

Note: `CLAWBOARD_INTEGRATION_LEVEL` is used by `scripts/bootstrap_openclaw.sh` (installer), not as a standalone API server env default.
Security: remote/tailnet/domain API reads require token. Setup stores token in browser local storage (masked input) and sends it on all API reads/writes.
Docker security: compose does not publish DB/vector/cache ports; use API endpoints as the supported read/write/delete path.

## Guided backup: OpenClaw continuity → private GitHub repo
Clawboard includes a guided setup to back up an OpenClaw agent’s *curated continuity* (workspace root `*.md` + `memory/*.md`, and optionally `~/.openclaw/openclaw.json*` + `~/.openclaw/skills/`) into a dedicated **private** GitHub repo.

Run:
```bash
bash ~/.openclaw/skills/clawboard/scripts/setup-openclaw-memory-backup.sh
```

Notes:
- Prefers a GitHub **Deploy Key (SSH)** and prints the public key.
- When adding the deploy key in GitHub, **check “Allow write access”** or pushes will fail.
- Can install an OpenClaw cron job (every 15m) to keep the repo updated.

## OpenClaw Integration

### One-command bootstrap (recommended)

```bash
bash scripts/bootstrap_openclaw.sh
```

This deploys Clawboard, installs the skill, installs/enables `clawboard-logger`, and configures `/api/config`.
It also establishes token + browser-access URL defaults.

Useful flags:

- `--integration-level full|write|manual` (default `write`)
- `--no-backfill` (shortcut for `manual`)
- `--api-url http://localhost:8010`
- `--web-url http://localhost:3010`
- `--public-api-base https://api.example.com`
- `--public-web-url https://clawboard.example.com`
- `--title "My Clawboard"`
- `--token <token>`
- `--no-access-url-prompt`

### Manual setup

Token + access URL setup:

```bash
cp .env.example .env
openssl rand -hex 32
```

Then set:

- `CLAWBOARD_TOKEN=<your-token>`
- `CLAWBOARD_PUBLIC_API_BASE=<api-url-reachable-from-browser>`

Use:

- local: `http://localhost:8010`
- tailscale: `http://100.x.y.z:8010`
- custom domain: `https://api.example.com`

Install skill:

```bash
mkdir -p ~/.openclaw/skills
cp -R skills/clawboard ~/.openclaw/skills/clawboard
```

Install plugin:

```bash
openclaw plugins install -l /path/to/clawboard/extensions/clawboard-logger
openclaw plugins enable clawboard-logger
```

Plugin config example:

```json
{
  "plugins": {
    "entries": {
      "clawboard-logger": {
        "enabled": true,
        "config": {
          "baseUrl": "http://localhost:8010",
          "token": "YOUR_TOKEN"
        }
      }
    }
  }
}
```

The logger plugin writes events and augments `before_agent_start` with Clawboard retrieval context (`/api/context`, fallback `/api/search`) including weighted curated notes.

If the OpenClaw plugin SDK supports tool registration, it also registers explicit agent tools (`clawboard_search`, `clawboard_context`, `clawboard_get_*`, `clawboard_create_note`, `clawboard_update_task`). See `CONTEXT.md` and `CONTEXT_SPEC.md`.

### Agentic install prompt

Use this in OpenClaw:

```md
Install Clawboard end-to-end.
Include token setup and access URL setup (local/Tailscale/custom domain), then docker startup, skill install, plugin enable, gateway restart, and validation.
If OpenClaw is missing and I want Chutes, run add_chutes.sh first.
```

## API Notes

- Localhost reads can run without token.
- Non-localhost reads require `X-Clawboard-Token`.
- All write endpoints require `X-Clawboard-Token`.
- Live updates stream from `/api/stream` with replay-safe reconciliation via `/api/changes`.

Quick checks:

```bash
curl -s http://localhost:8010/api/health
curl -s http://localhost:8010/api/config
```

Write check:

```bash
curl -X POST http://localhost:8010/api/topics \
  -H 'Content-Type: application/json' \
  -H 'X-Clawboard-Token: YOUR_TOKEN' \
  -d '{"name":"Clawboard"}'
```

## Reset Data (Fresh Start)

```bash
docker compose down
rm -f data/clawboard.db data/clawboard.db-shm data/clawboard.db-wal
rm -f data/classifier_embeddings.db data/classifier.lock data/reindex-queue.jsonl
docker compose up -d --build
```

Or use:

```bash
bash deploy.sh reset-data --yes
bash deploy.sh fresh
```

## Tests

Full stack checks:

```bash
./tests.sh --skip-e2e
```

Backend unit tests only:

```bash
npm run test:backend
```

Playwright browsers (first run only):

```bash
npx playwright install
```

Run E2E:

```bash
npm run test:e2e
```

Public publish safety check:

```bash
npm run check:publish-safety
# optional stricter personal-name scan:
PRIVACY_NAME_REGEX='(<your-first-name>|<your-handle>)' npm run check:publish-safety
```

Full npm suite (lint + backend unit + build + e2e):

```bash
npm run test:all
```

## One-Time Vector Cleanup

Run this once after upgrading classifier/search filtering rules to remove stale/non-semantic vectors and enqueue targeted reindex for missing canonical vectors:

```bash
python3 scripts/one_time_vector_cleanup.py
```

This is also recommended after changing `CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS` so embeddings match the new ingestion policy.

Preview only:

```bash
python3 scripts/one_time_vector_cleanup.py --dry-run
```

Load or clear demo fixtures:

```bash
bash deploy.sh demo-load
bash deploy.sh demo-clear
```

Common deploy workflow commands:

```bash
bash deploy.sh test
bash deploy.sh fresh
bash deploy.sh token-both --generate
bash deploy.sh ensure-skill
bash deploy.sh ensure-plugin
```

## Optional: Chutes Provider Bootstrap

```bash
curl -fsSL https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh | bash
```

PowerShell:

```powershell
iwr -useb https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh | bash
```
