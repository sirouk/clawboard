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

## Architecture

- `web` (Next.js): operator UI and API proxy routes.
- `api` (FastAPI + SQLite): source-of-truth store and retrieval endpoints.
- `classifier` (Python worker): async topic/task classification and embedding updates.
- `qdrant` (optional but recommended): vector index for dense retrieval.
- `extensions/clawboard-logger`: OpenClaw plugin for capture and context hook integration.

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
- `OPENCLAW_GATEWAY_TOKEN` (if your gateway requires auth)
- `CLASSIFIER_INTERVAL_SECONDS`

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

## Testing

Core commands:

```bash
npm run test:e2e
npm run test:backend
npm run test:all
```

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

## Recent Improvements (Last Few Days)

- Mobile fullscreen chat UX stabilized (layering, status handling, keyboard behavior).
- Status transitions now behave predictably in fullscreen task chat flows.
- Visual regression suite added (`tests/visual`) with dedicated Playwright visual config.
- API route contracts aligned with backend payload expectations.
- CI + test coverage expanded across E2E, backend, classifier, scripts, and visual checks.
- Publish-safety checks added for public sharing hygiene.

## Project Docs

- Operator runbook: `design/operator-runbook.md`
- Visual system spec: `design/visual-end-state-spec.md`
- Testing guide: `TESTING.md`
- Context details: `CONTEXT.md` and `CONTEXT_SPEC.md`

## Thanks

Clawboard is built to complement [OpenClaw](https://openclaw.ai/).
Thanks to Peter Steinberger for OpenClaw and the surrounding ecosystem work:

- https://openclaw.ai/
- https://github.com/steipete
