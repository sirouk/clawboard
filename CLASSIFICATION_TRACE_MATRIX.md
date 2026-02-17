# Classification Trace Matrix

This artifact audits trace-level coverage of every scenario ID in `CLASSIFICATION.md` section 14.

Trace-level coverage means each scenario maps to existing implementation files (path-level trace), not necessarily full behavioral test assertions.

## Summary

- Scenarios traced: `77/77` (`100.0%`)
- Source of truth: `CLASSIFICATION.md` section 14
- Auditor: `scripts/classification_trace_audit.py`

## Family Summary

| Family | Traced | Total |
|---|---:|---:|
| ING | 20 | 20 |
| CLS | 29 | 29 |
| FIL | 8 | 8 |
| SRCH | 12 | 12 |
| CHAT | 8 | 8 |

## Scenario Trace Table

| ID | Description | Trace Files | Trace Status | Notes |
|---|---|---|---|---|
| ING-001 | `message_received` user conversation | `extensions/clawboard-logger/index.ts`, `backend/app/main.py` | Traced | OK |
| ING-002 | `message_sending` assistant output | `extensions/clawboard-logger/index.ts` | Traced | OK |
| ING-003 | tool call start | `extensions/clawboard-logger/index.ts` | Traced | OK |
| ING-004 | tool call result/error | `extensions/clawboard-logger/index.ts` | Traced | OK |
| ING-005 | `agent_end` fallback capture | `extensions/clawboard-logger/index.ts` | Traced | OK |
| ING-006 | board-session user message echo from OpenClaw | `extensions/clawboard-logger/index.ts` | Traced | OK |
| ING-007 | ignore internal session prefixes | `extensions/clawboard-logger/ignore-session.ts` | Traced | OK |
| ING-008 | classifier payload/chat-control blob observed | `extensions/clawboard-logger/index.ts` | Traced | OK |
| ING-009 | context injection block appears in content | `extensions/clawboard-logger/index.ts` | Traced | OK |
| ING-010 | primary send fails transiently | `extensions/clawboard-logger/index.ts` | Traced | OK |
| ING-011 | queued row replay | `extensions/clawboard-logger/index.ts` | Traced | OK |
| ING-012 | idempotency header/payload present | `backend/app/main.py` | Traced | OK |
| ING-013 | legacy sender without idempotency key | `backend/app/main.py` | Traced | OK |
| ING-014 | source carries board scope metadata only | `backend/app/main.py` | Traced | OK |
| ING-015 | task/topic mismatch at ingest | `backend/app/main.py` | Traced | OK |
| ING-016 | cron event channel row ingested | `backend/app/main.py` | Traced | OK |
| ING-017 | conversation arrives on snoozed task/topic | `backend/app/main.py` | Traced | OK |
| ING-018 | queue ingestion mode enabled | `backend/app/main.py` | Traced | OK |
| ING-019 | sqlite write lock during ingest | `backend/app/main.py` | Traced | OK |
| ING-020 | assistant row appended | `backend/app/main.py` | Traced | OK |
| CLS-001 | no pending conversations in session | `classifier/classifier.py` | Traced | OK |
| CLS-002 | pending rows include cron events | `classifier/classifier.py` | Traced | OK |
| CLS-003 | oldest pending conversation anchor | `classifier/classifier.py` | Traced | OK |
| CLS-004 | anchor is assistant | `classifier/classifier.py` | Traced | OK |
| CLS-005 | anchor user turn is affirmation | `classifier/classifier.py` | Traced | OK |
| CLS-006 | assistant responded and user starts new intent | `classifier/classifier.py` | Traced | OK |
| CLS-007 | interleaved actions/system rows between turns | `classifier/classifier.py` | Traced | OK |
| CLS-008 | task-scoped board session | `classifier/classifier.py` | Traced | OK |
| CLS-009 | topic-scoped board session | `classifier/classifier.py` | Traced | OK |
| CLS-010 | subagent session with prior classified scope | `classifier/classifier.py` | Traced | OK |
| CLS-011 | low-signal follow-up (`yes/ok`) | `classifier/classifier.py` | Traced | OK |
| CLS-012 | explicit “new thread/topic” cue | `classifier/classifier.py` | Traced | OK |
| CLS-013 | small-talk bundle | `classifier/classifier.py` | Traced | OK |
| CLS-014 | non-affirmation user signal present | `classifier/classifier.py` | Traced | OK |
| CLS-015 | ambiguous bundle without user signal | `classifier/classifier.py` | Traced | OK |
| CLS-016 | session over max attempts | `classifier/classifier.py` | Traced | OK |
| CLS-020 | LLM enabled and returns valid strict JSON | `classifier/classifier.py` | Traced | OK |
| CLS-021 | LLM response malformed | `classifier/classifier.py` | Traced | OK |
| CLS-022 | LLM timeout/error | `classifier/classifier.py` | Traced | OK |
| CLS-023 | forced topic but LLM fails entirely | `classifier/classifier.py` | Traced | OK |
| CLS-024 | weak reuse signal + clear topic intent | `classifier/classifier.py` | Traced | OK |
| CLS-025 | create proposed but strong lexical anchor exists | `classifier/classifier.py` | Traced | OK |
| CLS-026 | creation gate blocks topic/task create | `classifier/classifier.py` | Traced | OK |
| CLS-027 | task id proposed from different topic | `classifier/classifier.py` | Traced | OK |
| CLS-028 | task intent absent and not continuity-sticky | `classifier/classifier.py` | Traced | OK |
| CLS-029 | task intent present but no confident candidate | `classifier/classifier.py` | Traced | OK |
| CLS-030 | missing or low-signal summaries | `classifier/classifier.py` | Traced | OK |
| CLS-031 | LLM/gate unavailable and heuristics fail | `classifier/classifier.py` | Traced | OK |
| CLS-032 | continuity memory enabled | `classifier/classifier.py` | Traced | OK |
| FIL-001 | slash command conversation | `classifier/classifier.py` | Traced | OK |
| FIL-002 | system/import row | `classifier/classifier.py` | Traced | OK |
| FIL-003 | memory action row | `classifier/classifier.py` | Traced | OK |
| FIL-004 | cron event row | `classifier/classifier.py` | Traced | OK |
| FIL-005 | classifier payload artifact | `classifier/classifier.py` | Traced | OK |
| FIL-006 | injected context artifact | `classifier/classifier.py` | Traced | OK |
| FIL-007 | other conversation noise | `classifier/classifier.py` | Traced | OK |
| FIL-008 | fallback semantic route | `classifier/classifier.py` | Traced | OK |
| SRCH-001 | `/api/context` auto mode low-signal query | `backend/app/main.py` | Traced | OK |
| SRCH-002 | `/api/context` full/patient mode | `backend/app/main.py` | Traced | OK |
| SRCH-003 | board session query | `backend/app/main.py` | Traced | OK |
| SRCH-004 | search gate saturated | `backend/app/main.py` | Traced | OK |
| SRCH-005 | deep search disabled in fallback | `backend/app/main.py` | Traced | OK |
| SRCH-006 | search default filters | `backend/app/vector_search.py` | Traced | OK |
| SRCH-007 | parent propagation from log/task matches | `backend/app/main.py` | Traced | OK |
| SRCH-008 | notes attached to related logs | `backend/app/main.py` | Traced | OK |
| SRCH-009 | SSE drop/stall | `src/lib/use-live-updates.ts` | Traced | OK |
| SRCH-010 | stream replay window missed | `backend/app/main.py` | Traced | OK |
| SRCH-011 | unified default view | `src/components/unified-view.tsx` | Traced | OK |
| SRCH-012 | `?raw=1` diagnostics view | `src/components/unified-view.tsx` | Traced | OK |
| CHAT-001 | board chat send | `backend/app/main.py` | Traced | OK |
| CHAT-002 | attachment upload + send | `backend/app/main.py` | Traced | OK |
| CHAT-003 | gateway send in-flight | `backend/app/main.py` | Traced | OK |
| CHAT-004 | gateway returns or fails | `backend/app/main.py` | Traced | OK |
| CHAT-005 | assistant plugin logs arrive | `backend/app/main.py` | Traced | OK |
| CHAT-006 | assistant plugin logs missing | `backend/app/main.py` | Traced | OK |
| CHAT-007 | persist user message fails | `backend/app/main.py` | Traced | OK |
| CHAT-008 | gateway/attachment read failure | `backend/app/main.py` | Traced | OK |
