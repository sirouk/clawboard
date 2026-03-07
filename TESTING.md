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
- history-ingest context-wrapper suppression and cursor safety,
- thread-scoped cancellation across main-thinking, delegated-subagent, and subagent-active phases.

UI stop controls are covered in Playwright:
- topic/task composer typed `/stop` + `/abort` cancellation,
- unified composer typed `/stop`,
- unified selected-target Stop button request scoping.

## Quick Commands

```bash
# Lint + backend + classifier + extension + script tests + build + e2e
pnpm test:all

# Playwright only
pnpm test:e2e

# TypeScript type safety gate
pnpm typecheck

# Visual regression suite (baseline compare)
pnpm test:visual

# Regenerate visual baselines
pnpm test:visual:update

# Backend unit tests only
pnpm test:backend

# Classifier unit tests only
pnpm test:classifier

# Logger extension unit tests only
pnpm test:logger

# Bash script tests only (runs against temp sandbox)
pnpm test:scripts
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
  `PLAYWRIGHT_USE_EXTERNAL_SERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3010 PLAYWRIGHT_API_BASE=http://localhost:8010 pnpm test:e2e`
- Visual CI runs include WebKit by default (local runs stay Chromium-only unless `PLAYWRIGHT_VISUAL_WEBKIT=1`).
- Visual snapshot paths are platform-neutral (`.../{arg}-{projectName}.png`) so the same baselines work on macOS and Linux.
- CI quality now includes `lint + typecheck + backend + classifier + logger + scripts`.
- On CI Playwright failures, artifacts (`test-results`, `playwright-report`) are uploaded for triage.
- GitHub branch protection should require the `required-gate` check from `.github/workflows/ci.yml`.

## Manual UI Spot Checks

Use these when the change is mostly visual or interaction-heavy and you want a fast sanity pass in a real browser:

1. Unified one-box composer
- Type into the top composer and confirm the draft stays intact while potential matches appear below.
- Verify the chip and send label change correctly across `new topic`, `topic -> new task`, and `task -> continue`.
- Confirm `Enter` sends, `Shift+Enter` inserts a newline, and the textarea grows without an internal scrollbar.

2. Task continuation targeting
- Type a query that should surface an existing task.
- Confirm matching topics expand automatically and the actionable choice is at the task level.
- Make sure unrelated low-confidence topics do not dominate the typing state.

3. Mobile task chat
- Open a task on a phone-sized viewport.
- Confirm chat becomes fullscreen, the close/status controls are readable, and the composer stays anchored at the bottom.
- Close the chat and make sure the board returns cleanly.
