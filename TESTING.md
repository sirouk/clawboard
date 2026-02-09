# Testing

This repo has tests across all major codepaths:

- Frontend (Next.js): Playwright end-to-end tests (`tests/e2e/*.spec.ts`)
- Backend API (FastAPI): Python `unittest` (`backend/tests/test_*.py`)
- Classifier (Python): unit tests + an end-to-end classifier check (`classifier/tests`, `scripts/classifier_e2e_check.py`)
- OpenClaw extension (Node): Node test runner (`extensions/clawboard-logger/*.test.mjs`)
- Ops scripts (Bash): Node test runner executes scripts against a temp sandbox (`tests/scripts/*.test.mjs`)

## Quick Commands

```bash
# Lint + backend + classifier + extension + script tests + build + e2e
npm run test:all

# Playwright only
npm run test:e2e

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

