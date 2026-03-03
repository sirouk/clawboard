# Research Summary

<confidence>0.87</confidence>

## Scope Completed
- Inspected repository structure, runtime entrypoints, and execution stack across web, backend, classifier, plugin, and test surfaces.
- Replaced placeholder research artifacts with evidence-backed documents for BUILD handoff.

## Key Findings
- The runtime is a hybrid system: `web` (Next.js), `api` (FastAPI), `classifier` (Python worker), `db` (Postgres), and `qdrant` (vector store) defined in `docker-compose.yaml`.
- The primary production API path is FastAPI (`backend/app/main.py`) with broad endpoints for chat dispatch, search/context, SSE, orchestration, and metrics.
- Frontend data access uses `apiFetch("/api/*")` and is designed to work against either direct backend base URLs or Next proxy routes (`src/app/api/[...path]/route.ts`).
- A second, legacy API surface still exists in Next route handlers backed by Prisma (`src/app/api/topics/route.ts`, `src/app/api/tasks/route.ts`, `src/app/api/log/route.ts`, plus `lib/db.ts`), creating contract-drift risk.
- Test coverage is extensive and split across layers: Playwright E2E/visual, backend Python tests, classifier tests, plugin tests, and script tests.

## Highest-Risk Uncertainty
- It is unclear whether Prisma-backed Next API routes are still required for active workflows or are now compatibility-only.
- This uncertainty impacts implementation path choice (consolidate vs maintain dual APIs) and is addressed in `IMPLEMENTATION_PLAN.md` with two viable paths.

## BUILD Handoff Readiness
- Required planning artifacts are now concrete and portable.
- The implementation plan includes explicit validation gates and actionable tasks.
