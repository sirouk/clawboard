# Implementation Plan

## Goal
Deliver a deterministic, evidence-first BUILD path that reduces architectural ambiguity and regression risk while preserving current ClawBoard runtime behavior.

## Decision Focus
The main uncertainty is API ownership:
- FastAPI is clearly the dominant runtime path.
- Legacy Prisma-backed Next route handlers still exist and can drift from backend contracts.

This plan compares two viable implementation paths and recommends one.

## Implementation Paths

### Path A (Recommended): FastAPI Canonical, Next Proxy Compatibility
- Keep FastAPI as the only canonical business API.
- Keep `src/app/api/[...path]/route.ts` as a thin proxy/fallback.
- Deprecate or remove Prisma-backed Next API handlers after verification.

Pros
- Single source of truth for behavior and schema.
- Lower long-term maintenance and drift risk.
- Clearer incident/debug ownership.

Cons
- Requires migration/deprecation work and targeted regression checks.

### Path B: Dual API Surfaces with Contract Parity
- Keep both FastAPI and Prisma-backed Next API handlers.
- Add parity tests and explicit route ownership documentation.

Pros
- Lower immediate migration effort.
- Keeps legacy/offline flow options open.

Cons
- Ongoing contract-sync burden.
- Higher probability of subtle regressions.

## Recommended Path
Proceed with **Path A** unless a confirmed product requirement depends on legacy Prisma route behavior.

## Validation Criteria (Build Gate)
1. All UI mutations and reads used by production flows resolve against FastAPI contracts.
2. No functional regression in core flows: topic/task CRUD, chat send/stop, SSE live updates, classifier classification loop.
3. CI passes (`quality`, `e2e`, `visual`) and `tests.sh` passes in local full-stack mode.
4. API ownership and routing behavior are documented and test-enforced.
5. Legacy route handling decision is explicit (removed, redirected, or contract-guarded).

## Actionable Tasks

### Workstream 1: API Ownership and Routing
1. Add route-usage telemetry or logs to identify active calls to Prisma-backed Next API handlers.
2. Enumerate all frontend `apiFetch("/api/*")` call sites and map each to FastAPI endpoint ownership.
3. For any legacy-only endpoint, either:
   - implement equivalent backend endpoint, or
   - explicitly mark as deprecated and block usage.
4. Tighten Next route surface so non-proxy legacy handlers cannot silently diverge.

### Workstream 2: Contract and Data Consistency
1. Create/update contract tests for key endpoints shared by UI flows (`/api/topics`, `/api/tasks`, `/api/log`, `/api/openclaw/chat`, `/api/changes`, `/api/stream`).
2. Add negative tests for auth semantics (token-required writes, localhost read behavior).
3. Verify consistency between backend models/schemas and UI TypeScript expectations.

### Workstream 3: Runtime Reliability
1. Validate chat dispatch + cancel flow under concurrent sends in topic/task sessions.
2. Validate SSE reconnect + reconcile behavior under network interruption and stale event-id conditions.
3. Validate classifier behavior for pinned board scopes (topic-only, task-locked, promotion).

### Workstream 4: Dependency and Build Determinism
1. Choose one Node package manager/lockfile path for CI + Docker + local docs.
2. Update bootstrap/test docs to reflect the chosen install path.
3. Ensure deterministic container build path remains aligned with chosen lock strategy.

## Execution Order
1. Workstream 1 (ownership mapping and telemetry)
2. Workstream 2 (contract guardrails)
3. Workstream 3 (runtime regression verification)
4. Workstream 4 (dependency/build determinism cleanup)

## Assumptions
- No hidden hard requirement exists for Prisma-backed Next API handlers in production traffic.
- Docker compose topology (`web`, `api`, `classifier`, `db`, `qdrant`) remains the deployment baseline.
- Build phase has permission to add tests and deprecate legacy routes where verified safe.

## Risks That Remain
- If legacy route usage is still active in an untracked workflow, aggressive removal can break local paths.
- Mixed lockfile/install strategy may continue causing environment drift until standardized.
