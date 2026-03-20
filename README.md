# ClawBoard

ClawBoard is a memory and context layer for [OpenClaw](https://openclaw.ai/).
It captures activity, organizes it into useful structure, and feeds the right context back at response time.

OpenClaw stays the agent runtime.
ClawBoard adds durable memory, classification, retrieval, and operator-facing UI.

Current board model: `Space -> Topic + Chat`.
Legacy task rows and task-scoped session keys are still supported for compatibility and replay, but the primary operator workflow is topic-first.

## Documentation Contract

- `README.md` is the short orchestration map: what ClawBoard is, how it fits beside OpenClaw, and the main runtime flow.
- `ANATOMY.md` is the exhaustive implementation reference: the qualified end-to-end detail, code-path map, invariants, recovery paths, and explicit unknowns/blockers.

Read this file first for the gist.
Read `ANATOMY.md` when you need the full, checked system picture.

## Why It Exists

- Keep long-running agent work coherent across sessions.
- Turn raw conversation/tool logs into Topics, optional task compatibility rows, and searchable memory.
- Give operators a fast board + logs + graph interface for steering and review.
- Improve response-time context quality without replacing OpenClaw's native memory.

## How It Works

ClawBoard runs as a multi-stage pipeline:

1. Stage 1: Capture
- `clawboard-logger` plugin records user/assistant/subagent/tool events as durable logs.

2. Stage 2: Classify
- Async classifier groups logs into Topics and optional compatibility Tasks.
- Embeddings + lexical ranking + reranking are used for better assignment and retrieval.

3. Stage 3: Retrieve + Visualize
- API provides context endpoints (`/api/context`, `/api/search`) for response-time augmentation.
- UI provides Unified Board, Workspaces, Logs, Stats, Setup, Providers, and Clawgraph.

## Plain-English Mental Model

Think of ClawBoard like a smart school binder for your AI:

- `Topic` = a class folder (example: "Website Launch")
- `Task` = a legacy assignment row that can still hang off a topic when older flows or specialized views need it
- `Conversation log` = every message/action that happened
- `Note` = important highlight you want remembered

Statuses are how the system tracks state:

- Topics: `active`, `doing`, `blocked`, `done`, `snoozed` (plus tags, sort order, visibility)
- Tasks: compatibility surface for older flows; still supported where present
- Logs: `pending` (not sorted yet), `classified` (sorted into topic/task), `failed` (filtered/noise)

### The self-improving loop

1. You chat in OpenClaw.
2. The logger plugin saves messages/tool activity into ClawBoard.
3. The classifier reviews new `pending` logs and decides:
   - which Topic they belong to
   - which compatibility Task (if any) they belong to
   - a short summary chip
4. It stores routing memory so short follow-ups like "ok continue" can still stay in the right place.
5. Search/indexes update so relevant older work can be found quickly.
6. Before the next model turn, ClawBoard builds a compact context block via `/api/context`:
   - active board location (where you are speaking from)
   - active working set (important topics plus compatibility task hints when relevant)
   - recent timeline
   - routing memory
   - semantic recall from past related logs/notes
7. That context is injected into the prompt, so responses stay coherent over long-running work.

### Why this matters

- You repeat yourself less.
- The AI stays aligned to the right topic and current line of work.
- Retrieval is scoped by Space visibility rules when a source space is known.

## Architecture

- `web` (Next.js): operator UI and API proxy routes.
- `api` (FastAPI + Postgres): source-of-truth store and retrieval endpoints.
- `classifier` (Python worker): async topic/task classification and embedding updates.
- `qdrant` (required for production): primary vector index for dense retrieval.
- `extensions/clawboard-logger`: OpenClaw plugin for capture and context hook integration.

## Runtime Guarantees (Current)

- Board continuity is topic-first:
  - the operator surface is `Space -> Topic + Chat`.
  - legacy task/task-session traffic is still ingested and replayed so older data does not strand history.
- Board-session scope is deterministic:
  - `clawboard:topic:<topicId>` is the primary operator session key.
  - legacy `clawboard:task:<topicId>:<taskId>` sessions are still hard-pinned, then normalized back into the owning topic timeline for continuity.
- Browser recovery is replay-safe:
  - SSE persists durable `eventTs` / `sinceSeq` cursors in local storage.
  - cached board snapshots persist their replay cursor too, so reloads can resume incrementally instead of forcing a full cold snapshot.
- Board chat routing is main-mediated:
  - messages sent in board topic sessions go through main orchestration, which may delegate to the worker subagent lane.
  - compatibility task sessions still route through the same main-agent orchestration lane rather than directly pinning ownership to a subagent.
- `agentId` on `POST /api/openclaw/chat` is advisory metadata for ClawBoard dispatch bookkeeping (queue/orchestration context), not an authoritative direct-route override.
- Only direct user-request lineage is allocatable into Topic/Task continuity.
- Control-plane/background noise is filtered from conversational continuity:
  - heartbeat/control-plane, cron-event, subagent scaffold payloads, and unanchored tool traces are detached/terminal-filtered.
- Ingest is idempotent:
  - dedupe prefers idempotency keys and falls back to source identifiers.
- Search/context/graph respect Space visibility allowlists when source space can be resolved.
- Chat bridge is persist-first:
  - user row is stored before gateway dispatch.
  - durable dispatch queue + watchdog/history-sync recovery guard long-running requests.
- Thread activity + stop controls are thread-scoped:
  - board responding state is driven by `openclaw.typing`, `openclaw.thread_work`, and orchestration run activity.
  - topic/task composers expose Stop and `/stop`/`/abort`; unified top-composer Stop targets the selected topic thread.
  - cancel requests call `DELETE /api/openclaw/chat` with `sessionKey` (+ `requestId` when available), and backend fans out linked child/subagent sessions when lineage is known.
- Unified Board uses a single specialized composer:
  - typing a draft message also surfaces potential topic/task matches.
  - no selection means `start topic`.
  - selecting a topic means `continue topic`.
  - selecting a task match resolves to its parent topic instead of creating fresh task-scoped send state.
  - `Enter` sends, `Shift+Enter` inserts a newline, and the send label mirrors the action.
- Browser API traffic is same-origin by default:
  - when no explicit browser API base is configured, the web app uses the Next `/api/*` proxy.
  - direct browser-to-API base overrides remain available for advanced/self-hosted setups.
- Assistant replay dedupe is payload-safe:
  - request/message identifier matches are only collapsed when normalized assistant content matches.
- Orchestration convergence is strict:
  - `main.response` stays running while any delegated subagent item is non-terminal.

See `ANATOMY.md`, `CONTEXT.md`, and `CLASSIFICATION.md` for full contracts.

## OpenClaw Complement Model

ClawBoard is additive to OpenClaw, not a replacement.

- OpenClaw handles runtime orchestration and core memory behavior.
- ClawBoard contributes extra structured continuity through logger hooks + `/api/context`.
- At response time, ClawBoard can provide focused recall (topic continuity, weighted notes, timeline snippets, and compatibility task hints) to improve precision over long horizons.

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
curl -fsSL https://raw.githubusercontent.com/sirouk/clawboard/main/scripts/bootstrap_clawboard.sh | bash
```

This can configure token + URLs, install skill/plugin, and wire logger behavior for end-to-end flow.

Bootstrap characteristics (current):

- idempotent reruns (safe to run repeatedly)
- atomic per-file deployment of shipped docs/templates plus atomic skill/plugin swaps during OpenClaw install
- deploys main-agent templates (`AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`) into the resolved OpenClaw main workspace
- provisions the worker workspace (`worker`) and, by default, asks to enroll it so main can delegate through a real team
- supports non-interactive worker enrollment with `--setup-agentic-team` or `CLAWBOARD_AGENTIC_TEAM_SETUP=always`
- optionally writes worker web-search and social API environment wiring (`CLAWBOARD_WEB_SEARCH_PROVIDER`, `SEARXNG_BASE_URL`, `BRAVE_API_KEY`, `BLUESKY_*`, `MASTODON_*`)
- writes workspace-IDE defaults so ClawBoard can open resolved agent workspaces in a separate code-server tab, with dark-mode and trusted-workspace defaults seeded on first bootstrap
- deploys ClawBoard contract docs (`ANATOMY.md`, `CONTEXT.md`, `CLASSIFICATION.md`, etc.) into the same workspace
- applies scope-aware directive reconciliation (`directives/all/*` + `directives/<agent-id>/*`) with in-place updates, stale-block pruning, and a locally regenerated team roster
- keeps main-agent execution lanes (main-only direct, single-worker, multi-worker/huddle) aligned with repository contracts
- syncs main `subagents.allowAgents` from configured non-main agents for elastic delegation pool growth without manual list drift
- audits injected bootstrap file sizes against OpenClaw `bootstrapMaxChars` / `bootstrapTotalMaxChars` limits and fails fast before prompt truncation
- migrates legacy `CLAWBOARD_LOGGER_DISABLE_OPENCLAW_MEMORY_SEARCH` to `CLAWBOARD_LOGGER_ENABLE_OPENCLAW_MEMORY_SEARCH`

If OpenClaw is not installed and you want Chutes first:

```bash
curl -fsSL https://raw.githubusercontent.com/sirouk/clawboard/main/inference-providers/add_chutes.sh | bash
```

## Security Model

- All write endpoints require `X-ClawBoard-Token`.
- Non-localhost reads require token.
- Localhost reads can be tokenless for local dev workflows.
- DB/vector/cache services are kept on internal Docker network (not host-published in default compose profile).

Important envs:

- `CLAWBOARD_TOKEN`
- `CLAWBOARD_PUBLIC_API_BASE`
- `CLAWBOARD_PUBLIC_WEB_URL` (optional)
- `NEXT_PUBLIC_CLAWBOARD_INITIAL_CHANGES_LIMIT_LOGS`
- `CLAWBOARD_CHANGES_PRECOMPILE_LIMIT_LOGS`
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
  - `OPENCLAW_CHAT_LOOP_BREAKER_UNKNOWN_TOOL_THRESHOLD`
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
curl -s -H "X-ClawBoard-Token: $CLAWBOARD_TOKEN" http://localhost:8010/api/openclaw/chat-dispatch/status
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
pnpm lint
pnpm test:e2e
pnpm test:backend
pnpm test:classifier
pnpm test:logger
pnpm test:scripts
pnpm test:all
pnpm test:e2e:live-smoke
```

Live stack smoke test (`test:e2e:live-smoke`) expects a running stack and external server wiring. Defaults target `http://localhost:8010` (API) + `http://localhost:3010` (web); override with `PLAYWRIGHT_API_BASE` / `PLAYWRIGHT_BASE_URL`. For protected deployments set `PLAYWRIGHT_CLAWBOARD_TOKEN` or export `CLAWBOARD_TOKEN`.

Formal full-system soak (docker + security + classifier e2e + backend + frontend + Playwright):

```bash
./tests.sh
./tests.sh --skip-e2e
```

Agentic runtime regression scenarios (main-only, single-subagent, multi-subagent, ingest replay safety) are included in backend unit discovery, so they run automatically inside `./tests.sh`.

Visual regression:

```bash
pnpm test:visual
pnpm test:visual:update
```

## Public Repo Safety

Before pushing public changes:

```bash
pnpm check:publish-safety
```

Optional stricter name scan:

```bash
PRIVACY_NAME_REGEX='(<your-first-name>|<your-handle>)' pnpm check:publish-safety
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
- Product/UX rules: `DESIGN_RULES.md`
- Bootstrap/auth notes: `SEED.md`
- Testing guide: `TESTING.md`
- System sequence/reference diagram: `OPENCLAW_CLAWBOARD_UML.md`
- API ownership contract and migration runbook: `docs/API_OWNERSHIP.md`
- Operator runbook: `design/operator-runbook.md`
- Visual system spec: `design/visual-end-state-spec.md`

## Thanks

ClawBoard is built to complement [OpenClaw](https://openclaw.ai/).
Thanks to Peter Steinberger for OpenClaw and the surrounding ecosystem work:

- https://openclaw.ai/
- https://github.com/steipete
