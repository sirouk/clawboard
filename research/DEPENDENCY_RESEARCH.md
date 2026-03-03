# Dependency Research

## Current Stack Components
| Layer | Current Component | Evidence | Notes |
| --- | --- | --- | --- |
| Web UI | Next.js 16 + React 19 + TypeScript | `package.json`, `src/app/*`, `next.config.ts` | App Router frontend and client-side board UX. |
| Web Styling | Tailwind CSS 4 | `package.json`, `tailwind.config.js`, `postcss.config.mjs` | Utility styling with custom design tokens. |
| Web Validation | Zod | `package.json`, `src/app/api/*/route.ts` | Request validation in Next route handlers. |
| Backend API | FastAPI + Uvicorn + SQLModel + Pydantic v2 | `backend/requirements.txt`, `backend/app/main.py`, `backend/app/schemas.py` | Main API contracts, orchestration endpoints, SSE, search/context. |
| DB Driver | Psycopg 3 | `backend/requirements.txt`, `backend/app/db.py` | Postgres primary runtime with SQLite compatibility logic. |
| Vector Retrieval | FastEmbed + Qdrant | `backend/app/vector_search.py`, `classifier/embeddings_store.py`, `docker-compose.yaml` | Dense/hybrid search and classifier embedding storage. |
| Classifier Worker | Python requests + numpy + fastembed | `classifier/classifier.py`, `classifier/Dockerfile` | Poll/patch cycle for routing, summarization, and gating. |
| Plugin Integration | OpenClaw plugin SDK | `extensions/clawboard-logger/index.ts` | Capture + context hook bridge into Clawboard API. |
| Test Stack | Playwright + unittest + node test | `playwright.config.ts`, `tests.sh`, `package.json` | Multi-layer regression coverage (UI, backend, classifier, scripts). |

## Viable Alternatives (Where Uncertainty Exists)

### API Surface Strategy
- Path A (recommended): FastAPI as sole canonical backend; keep Next proxy only.
  - Pros: One contract surface, fewer drift bugs, clearer ownership.
  - Cons: Requires migration/deprecation of legacy Next Prisma routes.
- Path B: Keep dual APIs (FastAPI + Prisma-backed Next routes) with strict parity tests.
  - Pros: Lower immediate migration impact.
  - Cons: Ongoing maintenance tax, higher regression/drift risk.

### Vector Backend Strategy
- Current: Qdrant + FastEmbed.
- Alternative: Postgres-only lexical/tsvector retrieval.
  - Pros: Fewer moving parts.
  - Cons: Lower semantic recall quality and weaker long-context retrieval.

### Package Manager Strategy
- Current signals are mixed: `packageManager: pnpm` plus `package-lock.json` and `npm ci` in Docker/CI.
- Alternative: Standardize to one lockfile and one installer path.
  - Pros: Deterministic installs and simpler CI reasoning.
  - Cons: One-time migration work across scripts and docs.

## Dependency Risks
- Dual API and data-model drift between FastAPI/SQLModel and Next/Prisma route paths.
- Mixed Node lockfile/install strategy can cause reproducibility differences.
- Dense retrieval quality and startup behavior depend on vector infra availability and cache state.
