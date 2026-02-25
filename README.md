# Clawboard

Clawboard is a memory and context layer for [OpenClaw](https://openclaw.ai/).
It captures activity, organizes it into useful structure, and feeds the right context back at response time.

OpenClaw stays the agent runtime.
Clawboard adds durable memory, classification, retrieval, and operator-facing UI.

## Why It Exists

- Keep long-running agent work coherent across sessions.
- Turn raw conversation/tool logs into Topics, Tasks, and searchable memory.
- Give operators a fast board + logs + graph interface for steering and review.
- Improve response-time context quality without replacing OpenClaw's native memory.

## How It Works

Clawboard runs as a multi-stage pipeline:

1. Stage 1: Capture
- `clawboard-logger` plugin records user/assistant/subagent/tool events as durable logs.

2. Stage 2: Classify
- Async classifier groups logs into Topics and optional Tasks.
- Embeddings + lexical ranking + reranking are used for better assignment and retrieval.

3. Stage 3: Retrieve + Visualize
- API provides context endpoints (`/api/context`, `/api/search`) for response-time augmentation.
- UI provides Unified Board, Logs, Stats, Setup, Providers, and Clawgraph.

## Plain-English Mental Model

Think of Clawboard like a smart school binder for your AI:

- `Topic` = a class folder (example: "Website Launch")
- `Task` = an assignment inside that folder (example: "Fix login redirect bug")
- `Conversation log` = every message/action that happened
- `Note` = important highlight you want remembered

Statuses are how the system tracks state:

- Tasks: `todo`, `doing`, `blocked`, `done` (plus due dates, priority, snooze, etc.)
- Logs: `pending` (not sorted yet), `classified` (sorted into topic/task), `failed` (filtered/noise)

### The self-improving loop

1. You chat in OpenClaw.
2. The logger plugin saves messages/tool activity into Clawboard.
3. The classifier reviews new `pending` logs and decides:
   - which Topic they belong to
   - which Task (if any) they belong to
   - a short summary chip
4. It stores routing memory so short follow-ups like "ok continue" can still stay in the right place.
5. Search/indexes update so relevant older work can be found quickly.
6. Before the next model turn, Clawboard builds a compact context block via `/api/context`:
   - active board location (where you are speaking from)
   - active working set (important topics/tasks)
   - recent timeline
   - routing memory
   - semantic recall from past related logs/notes
7. That context is injected into the prompt, so responses stay coherent over long-running work.

### Why this matters

- You repeat yourself less.
- The AI stays aligned to the right project/task.
- Retrieval is scoped by Space visibility rules when a source space is known.

## Architecture

- `web` (Next.js): operator UI and API proxy routes.
- `api` (FastAPI + Postgres): source-of-truth store and retrieval endpoints.
- `classifier` (Python worker): async topic/task classification and embedding updates.
- `qdrant` (required for production): primary vector index for dense retrieval.
- `extensions/clawboard-logger`: OpenClaw plugin for capture and context hook integration.

## Runtime Guarantees (Current)

- Board-session scope is deterministic:
  - `clawboard:task:<topicId>:<taskId>` is hard-pinned to that topic/task.
  - `clawboard:topic:<topicId>` is topic-pinned; task promotion/inference can happen only inside that same topic.
- Only direct user-request lineage is allocatable into Topic/Task continuity.
- Control-plane/background noise is filtered from conversational continuity:
  - heartbeat/control-plane, cron-event, subagent scaffold payloads, and unanchored tool traces are detached/terminal-filtered.
- Ingest is idempotent:
  - dedupe prefers idempotency keys and falls back to source identifiers.
- Search/context/graph respect Space visibility allowlists when source space can be resolved.
- Chat bridge is persist-first:
  - user row is stored before gateway dispatch.
  - durable dispatch queue + watchdog/history-sync recovery guard long-running requests.
- Assistant replay dedupe is payload-safe:
  - request/message identifier matches are only collapsed when normalized assistant content matches.
- Orchestration convergence is strict:
  - `main.response` stays running while any delegated subagent item is non-terminal.

See `ANATOMY.md`, `CONTEXT.md`, and `CLASSIFICATION.md` for full contracts.

## OpenClaw Complement Model

Clawboard is additive to OpenClaw, not a replacement.

- OpenClaw handles runtime orchestration and core memory behavior.
- Clawboard contributes extra structured continuity through logger hooks + `/api/context`.
- At response time, Clawboard can provide focused recall (topic/task continuity, weighted notes, timeline snippets) to improve precision over long horizons.

## Quick Start (Docker)

1. Copy env template:

```bash
cp .env.example .env
```

2. Generate and set token:

```bash
openssl rand -hex 32
```

Set in `.env`:

```bash
CLAWBOARD_TOKEN=<your-token>
```

3. Start stack:

```bash
docker compose up -d --build
```

4. Open:

- UI: `http://localhost:3010`
- API: `http://localhost:8010`
- API docs: `http://localhost:8010/docs`

## OpenClaw Integration

Recommended bootstrap:

```bash
curl -fsSL https://raw.githubusercontent.com/sirouk/clawboard/main/scripts/bootstrap_openclaw.sh | bash
```

This can configure token + URLs, install skill/plugin, and wire logger behavior for end-to-end flow.

Bootstrap characteristics (current):

- idempotent reruns (safe to run repeatedly)
- atomic per-file deployment of shipped docs/templates
- deploys main-agent templates (`AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`) into the resolved OpenClaw main workspace
- deploys Clawboard contract docs (`ANATOMY.md`, `CONTEXT.md`, `CLASSIFICATION.md`, etc.) into the same workspace
- applies directive reconciliation so main-agent execution lanes (main-only direct, single-specialist, multi-specialist/huddle) remain aligned with repository contracts
- migrates legacy `CLAWBOARD_LOGGER_DISABLE_OPENCLAW_MEMORY_SEARCH` to `CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH`

If OpenClaw is not installed and you want Chutes first:

```bash
curl -fsSL https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh | bash
```

## Security Model

- All write endpoints require `X-Clawboard-Token`.
- Non-localhost reads require token.
- Localhost reads can be tokenless for local dev workflows.
- DB/vector/cache services are kept on internal Docker network (not host-published in default compose profile).

Important envs:

- `CLAWBOARD_TOKEN`
- `CLAWBOARD_PUBLIC_API_BASE`
- `CLAWBOARD_PUBLIC_WEB_URL` (optional)
- `OPENCLAW_BASE_URL`
- `OPENCLAW_WS_URL` (optional explicit websocket endpoint; use `wss://` only with valid TLS certs)
- `OPENCLAW_GATEWAY_HOST_HEADER` (optional host override for websocket connects)
- `OPENCLAW_GATEWAY_TOKEN` (if your gateway requires auth)
- `CLASSIFIER_INTERVAL_SECONDS`

Operationally important groups:

- Context injection/plugin behavior:
  - `CLAWBOARD_LOGGER_CONTEXT_MODE`
  - `CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS`
  - `CLAWBOARD_LOGGER_CONTEXT_FETCH_RETRIES`
  - `CLAWBOARD_LOGGER_CONTEXT_FALLBACK_MODES`
  - `CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS`
  - `CLAWBOARD_LOGGER_CONTEXT_CACHE_TTL_MS`
  - `CLAWBOARD_LOGGER_CONTEXT_CACHE_MAX_ENTRIES`
  - `CLAWBOARD_LOGGER_CONTEXT_USE_CACHE_ON_FAILURE`
  - `CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH`
- Search behavior:
  - `CLAWBOARD_SEARCH_MODE` (`auto|hybrid|fast`)
  - `CLAWBOARD_SEARCH_ENABLE_DENSE`
  - `CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS`
  - `CLAWBOARD_SEARCH_ENABLE_HEAVY_SEMANTIC` (legacy compatibility toggle)
  - `CLAWBOARD_SEARCH_GLOBAL_LEXICAL_RESCUE_*` (full-history lexical rescue with PostgreSQL tsvector + GIN index path, index-aligned SQL expression, and bounded fallback behavior)
- Cross-agent request lineage persistence:
  - `OPENCLAW_REQUEST_ID_TTL_SECONDS`
  - `OPENCLAW_REQUEST_ID_MAX_ENTRIES`
  - `OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS`
  - `OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES`
  - `CLAWBOARD_BOARD_SCOPE_SUBAGENT_TTL_HOURS`
- Gateway dispatch/watchdog/history sync:
  - `OPENCLAW_CHAT_DISPATCH_*`
  - `OPENCLAW_CHAT_IN_FLIGHT_*`
  - `OPENCLAW_CHAT_ASSISTANT_LOG_*`
  - `OPENCLAW_GATEWAY_HISTORY_SYNC_*`

## Operations

Fresh data reset:

```bash
bash deploy.sh reset-data --yes
bash deploy.sh fresh
```

Health checks:

```bash
curl -s http://localhost:8010/api/health
curl -s http://localhost:8010/api/config
```

Dispatch/watchdog visibility:

```bash
curl -s -H "X-Clawboard-Token: $CLAWBOARD_TOKEN" http://localhost:8010/api/openclaw/chat-dispatch/status
```

Legacy SQLite to Postgres migration helper (one-time, older installs only):

```bash
docker compose run --rm -v "$PWD":/workspace -w /workspace api \
  python /workspace/scripts/migrate_sqlite_to_postgres.py --dry-run
docker compose run --rm -v "$PWD":/workspace -w /workspace api \
  python /workspace/scripts/migrate_sqlite_to_postgres.py --yes --truncate-target
```

## Testing

Core commands:

```bash
npm run lint
npm run test:e2e
npm run test:backend
npm run test:classifier
npm run test:logger
npm run test:scripts
npm run test:all
```

Formal full-system soak (docker + security + classifier e2e + backend + frontend + Playwright):

```bash
./tests.sh
./tests.sh --skip-e2e
```

Agentic runtime regression scenarios (main-only, single-subagent, multi-subagent, ingest replay safety) are included in backend unit discovery, so they run automatically inside `./tests.sh`.

Visual regression:

```bash
npm run test:visual
npm run test:visual:update
```

## Public Repo Safety

Before pushing public changes:

```bash
npm run check:publish-safety
```

Optional stricter name scan:

```bash
PRIVACY_NAME_REGEX='(<your-first-name>|<your-handle>)' npm run check:publish-safety
```

This check blocks common leaks in tracked files:

- `.env` or private data paths
- DB/key/cert artifacts
- high-confidence secret literals
- machine-local absolute paths

## Project Docs

- Core architecture map: `ANATOMY.md`
- Context contract and plugin bridge: `CONTEXT.md`
- Classification/routing spec and scenario matrix: `CLASSIFICATION.md`
- Context spec companion: `CONTEXT_SPEC.md`
- Operator runbook: `design/operator-runbook.md`
- Visual system spec: `design/visual-end-state-spec.md`
- Testing guide: `TESTING.md`

## Thanks

Clawboard is built to complement [OpenClaw](https://openclaw.ai/).
Thanks to Peter Steinberger for OpenClaw and the surrounding ecosystem work:

- https://openclaw.ai/
- https://github.com/steipete
