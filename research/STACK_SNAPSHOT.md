# Stack Snapshot

- generated_on: 2026-03-03
- snapshot_scope: repository static evidence (manifests, runtime entrypoints, compose topology, test surfaces)

## Deterministic Scoring Method
Each hypothesis is scored out of 100 using fixed evidence weights:
- Runtime entrypoints present and wired: 30
- Compose/service topology alignment: 25
- Package/manifest alignment: 20
- Test/CI alignment for the stack: 15
- Operational automation alignment (bootstrap/deploy/scripts): 10

Deterministic confidence score: **91/100**
- Rationale: all core runtime layers are strongly evidenced in code and compose; remaining uncertainty is functional ownership of legacy Next Prisma routes.

## Ranked Stack Hypotheses

| Rank | Hypothesis | Score | Evidence |
| --- | --- | --- | --- |
| 1 | Hybrid platform: Next.js frontend + FastAPI backend + Python classifier + Postgres + Qdrant | 91 | `docker-compose.yaml`, `backend/app/main.py`, `classifier/classifier.py`, `src/app/*`, `tests.sh` |
| 2 | FastAPI-centric platform with Next.js as UI/proxy shell | 84 | `src/app/api/[...path]/route.ts`, `src/lib/api.ts`, broad backend endpoint surface in `backend/app/main.py` |
| 3 | Next.js monolith with Prisma-backed API routes | 58 | `src/app/api/topics/route.ts`, `src/app/api/tasks/route.ts`, `lib/db.ts`, `prisma/schema.prisma` |

## Alternatives Summary
- Alternative A (recommended for BUILD): consolidate on Hypothesis #1/#2 by deprecating legacy Prisma-backed Next API routes.
- Alternative B: keep dual API surfaces with contract-parity tests and explicit ownership boundaries.

## Why Hypothesis #1 Wins
- It is the only hypothesis fully consistent with container orchestration, backend runtime behavior, classifier loop design, and full-stack test scripts.
