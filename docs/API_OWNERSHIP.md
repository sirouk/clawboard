# API Ownership Contract

## Purpose
Define who owns API behavior, which Next.js routes are compatibility-only, and how operators verify ownership in production.

## Decision
- Canonical business API owner: FastAPI in `backend/app/main.py`.
- Next.js `src/app/api/*` owner role: transport proxy and compatibility guardrails only.

## Assumptions
- Frontend callsites continue to target same-origin `/api/*` routes.
- `CLAWBOARD_SERVER_API_BASE` (or fallback `CLAWBOARD_PUBLIC_API_BASE`, then `NEXT_PUBLIC_CLAWBOARD_API_BASE`) points to a reachable FastAPI service.
- Write endpoints still require `X-Clawboard-Token`; proxy routes inject a fallback token from server env when absent.

## Current Next.js API Surface

### Canonical Proxy Routes
- `src/app/api/[...path]/route.ts`: catch-all proxy for canonical `/api/*` endpoints not explicitly handled elsewhere.
- `src/app/api/openclaw/chat/route.ts`: explicit proxy with request schema validation for `POST` and `DELETE`.
- `src/app/api/openclaw/skills/route.ts`: explicit proxy for skill discovery.

### Legacy Compatibility Proxy Shims
- `src/app/api/topics/route.ts`
- `src/app/api/topics/[id]/route.ts`
- `src/app/api/tasks/route.ts`
- `src/app/api/tasks/[id]/route.ts`
- `src/app/api/log/route.ts`

These shims proxy to FastAPI and emit ownership telemetry so deprecation progress can be measured.

### Explicitly Deprecated Legacy Routes (Blocked)
- `src/app/api/topics/ensure/route.ts` returns `410 Gone`
- `src/app/api/tasks/upsert/route.ts` returns `410 Gone`
- `src/app/api/events/route.ts` returns `410 Gone`
- `src/app/api/events/append/route.ts` returns `410 Gone`
- `src/app/api/events/upsert/route.ts` returns `410 Gone`
- `src/app/api/import/start/route.ts` returns `410 Gone`
- `src/app/api/import/status/route.ts` returns `410 Gone`

## Ownership Telemetry Contract

### For legacy shim requests proxied to FastAPI
- `x-clawboard-api-owner: fastapi`
- `x-clawboard-api-compat: legacy-next-shim`
- `x-clawboard-api-legacy-route: <legacy route id>`

### For blocked deprecated Next.js routes
- `x-clawboard-api-owner: nextjs`
- `x-clawboard-api-compat: legacy-next-blocked`
- `x-clawboard-api-legacy-route: <legacy route id>`

### Runtime warnings
- Next.js logs one warning per unique `(status, method, legacyRouteId)` key:
```text
[api-ownership] Legacy Next API route proxied: ...
[api-ownership] Legacy Next API route blocked: ...
```

## Rationale
- Avoids dual-write drift between Prisma-backed Next handlers and FastAPI handlers.
- Keeps contract changes concentrated in one canonical backend.
- Preserves backward compatibility during migration by keeping legacy paths observable instead of silently removing them.

## Runbook Checks

### Automated enforcement
```bash
npm run test:scripts
```
This includes `tests/scripts/api-ownership.test.mjs`, which enforces:
- no Next API route imports from `lib/db`
- canonical overlap routes use `proxyApiRequest(...)` with `legacyRouteId`
- deprecated-only routes use `blockLegacyApiRoute(...)`
- proxy helper exposes ownership headers and warning telemetry

### Manual header verification
```bash
curl -i -H "X-Clawboard-Token: $CLAWBOARD_TOKEN" http://localhost:3010/api/topics
curl -i -X POST -H "X-Clawboard-Token: $CLAWBOARD_TOKEN" http://localhost:3010/api/topics/ensure
```
Expected:
- `/api/topics` includes `x-clawboard-api-owner: fastapi`
- `/api/topics/ensure` returns `410` with `x-clawboard-api-owner: nextjs`

### Legacy-route usage visibility
```bash
docker compose logs --tail=200 web | rg "\[api-ownership\]"
```

## Change Policy
- Do not add new business logic to Next.js API handlers for endpoints already owned by FastAPI.
- New compatibility shims must use `proxyApiRequest(...)` and set `legacyRouteId`.
- Route removals must convert to `blockLegacyApiRoute(...)` first; hard-delete only after clients have migrated.
