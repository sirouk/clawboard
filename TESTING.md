# Testing

This repo has tests across all major codepaths:

- Frontend (Next.js): Playwright end-to-end tests (`tests/e2e/*.spec.ts`)
- Backend API (FastAPI): Python `unittest` (`backend/tests/test_*.py`)
- Classifier (Python): unit tests + an end-to-end classifier check (`classifier/tests`, `scripts/classifier_e2e_check.py`)
- OpenClaw extension (Node): Node test runner (`extensions/clawboard-logger/*.test.mjs`)
- Ops scripts (Bash): Node test runner executes scripts against a temp sandbox (`tests/scripts/*.test.mjs`)

Agentic orchestration/runtime regressions are covered inside backend unit tests, including:
- main-only direct completion,
- single-subagent supervision convergence,
- multi-subagent convergence gating,
- duplicate spawn idempotency,
- history-ingest context-wrapper suppression and cursor safety.

## Quick Commands

```bash
# Lint + backend + classifier + extension + script tests + build + e2e
npm run test:all

# Playwright only
npm run test:e2e

# TypeScript type safety gate
npm run typecheck

# Visual regression suite (baseline compare)
npm run test:visual

# Regenerate visual baselines
npm run test:visual:update

# Backend unit tests only
npm run test:backend

# Classifier unit tests only
npm run test:classifier

# Logger extension unit tests only
npm run test:logger

# Bash script tests only (runs against temp sandbox)
npm run test:scripts
```

## Full System Checks (Docker)

For the full local integration loop (docker services + security checks + classifier e2e + e2e UI tests), run:

```bash
./tests.sh
```

To skip Playwright (faster iteration):

```bash
./tests.sh --skip-e2e
```

## Notes

- The script tests intentionally copy the bash scripts into a temporary directory and stub external commands
  like `docker` and `openclaw` so they can safely exercise `--apply` paths without touching your real machine state.
- The Playwright suite uses `tests/mock-api.mjs` as a deterministic API server.
- Visual baselines are stored under `tests/visual/*-snapshots/`.
- Playwright now defaults to hermetic web servers (`reuseExistingServer: false`) to avoid stale local state.
  Set `PLAYWRIGHT_REUSE_SERVER=1` only when you explicitly want to reuse already-running test servers.
- Playwright ports are configurable via env:
  `PLAYWRIGHT_WEB_PORT` (default `3050`) and `PLAYWRIGHT_MOCK_API_PORT` (default `3051`).
- To run against an already-running stack (for example web on `3010`), skip Playwright-managed servers:
  `PLAYWRIGHT_USE_EXTERNAL_SERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3010 PLAYWRIGHT_API_BASE=http://localhost:8010 npm run test:e2e`
- Visual CI runs include WebKit by default (local runs stay Chromium-only unless `PLAYWRIGHT_VISUAL_WEBKIT=1`).
- Visual snapshot paths are platform-neutral (`.../{arg}-{projectName}.png`) so the same baselines work on macOS and Linux.
- CI quality now includes `lint + typecheck + backend + classifier + logger + scripts`.
- On CI Playwright failures, artifacts (`test-results`, `playwright-report`) are uploaded for triage.
- GitHub branch protection should require the `required-gate` check from `.github/workflows/ci.yml`.
