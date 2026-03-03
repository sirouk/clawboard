# Codebase Map

## Top-Level Directories
- `src/`: Next.js app router UI and browser-facing API proxy routes.
- `backend/`: FastAPI service (source-of-truth API, persistence contracts, orchestration, retrieval, SSE).
- `classifier/`: Python classifier worker (routing, summarization, embedding updates, creation gate logic).
- `extensions/clawboard-logger/`: OpenClaw plugin for ingest + context augmentation hooks.
- `lib/`: Legacy Next-side data layer using Prisma and SQLite-oriented schema.
- `prisma/`: Prisma schema and migrations for legacy Next API routes.
- `scripts/`: Bootstrap, migration, and operational automation.
- `tests/`, `backend/tests/`, `classifier/tests/`: E2E, visual, backend, and classifier test suites.
- `research/`: Planning and discovery artifacts.

## Runtime Entrypoints
- Web app: `npm run dev` / `npm run build` / `npm run start` from `package.json`.
- Web container: `Dockerfile.web` -> Next build/start.
- API service: `backend/Dockerfile` -> `uvicorn app.main:app` (entry module: `backend/app/main.py`).
- Classifier worker: `classifier/Dockerfile` -> `python /app/classifier.py`.
- Full stack orchestration: `docker-compose.yaml`.
- OpenClaw plugin runtime: `extensions/clawboard-logger/index.ts` (compiled and installed via bootstrap scripts).

## Primary Request/Data Flows
- UI data and mutations: components call `apiFetch("/api/*")` (`src/lib/api.ts`), with base URL resolved from runtime env/local storage.
- Server/API proxy flow: Next catch-all proxy forwards `/api/*` to backend (`src/app/api/[...path]/route.ts`).
- FastAPI source-of-truth flow: persistence, routing, search/context, SSE, orchestration (`backend/app/main.py`).
- Live updates: backend SSE `/api/stream` + frontend reconciliation fallback (`src/lib/use-live-updates.ts`, `src/components/data-provider.tsx`).
- Classifier loop: polls pending logs and patches classification assignments (`classifier/classifier.py`).

## Secondary/Legacy Flow
- Prisma-backed Next route handlers still exist (`src/app/api/topics/route.ts`, `src/app/api/tasks/route.ts`, `src/app/api/log/route.ts`, etc.) and use `lib/db.ts` + `lib/prisma.ts`.

## Architecture Assumptions (Explicit)
- Assumption A1: FastAPI is the canonical API for production state transitions and retrieval.
- Assumption A2: Next API catch-all proxy is intended as compatibility/edge forwarding, not canonical business logic.
- Assumption A3: Prisma-backed Next routes are legacy/compatibility until proven otherwise by usage telemetry.
- Assumption A4: `qdrant` is expected for production-grade dense retrieval (with bounded fallback behavior in code).
