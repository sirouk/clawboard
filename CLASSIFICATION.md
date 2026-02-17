# Clawboard Classification and Routing Spec (Mission-Critical)

Companion UML: `OPENCLAW_CLAWBOARD_UML.md`

This spec is code-accurate for the current repository and adds mission-grade operating requirements.

## 1) System Boundary

- OpenClaw runtime produces user, assistant, and tool events.
- `extensions/clawboard-logger` sanitizes events, resolves continuity/session scope, and writes logs to Clawboard.
- Clawboard API (`backend/app/main.py`) persists state, publishes SSE, serves context/search, and bridges board chat to OpenClaw gateway.
- Classifier worker (`classifier/classifier.py`) classifies pending conversation bundles into topic/task/summary assignments.
- Embedding backends:
  - Search runtime: `backend/app/vector_search.py` (SQLite vector store, optional Qdrant).
  - Classifier runtime: `classifier/embeddings_store.py` (SQLite mirror, optional Qdrant).
- Clawboard UI consumes SSE + `/api/changes`, queries `/api/search`, and sends board chat through `/api/openclaw/chat`.

## 2) End-to-End Content Lifecycle

1. A user message or tool activity enters OpenClaw.
2. Logger plugin hooks fire (`message_received`, `message_sending`, `before_tool_call`, `after_tool_call`, `agent_end`).
3. Plugin sanitizes text:
   - Removes `[CLAWBOARD_CONTEXT_BEGIN]...END` blocks.
   - Removes classifier/control payload artifacts.
   - Strips transport noise (`summary:`, Discord wrappers, message ids, timestamp wrappers).
4. Plugin computes effective `source.sessionKey`, applies ignore prefixes, resolves board scope metadata, and sends `POST /api/log` (or `/api/ingest` queue mode) with idempotency.
5. API ingests with `append_log_entry()`:
   - Dedupes by idempotency first, then legacy source identifiers.
   - Normalizes board scope and topic/task/space consistency.
   - Filters cron-channel events immediately into terminal failed rows.
   - Emits `log.appended` SSE.
6. Classifier polls `/api/classifier/pending`, groups by session, and classifies one bundle per session per cycle.
7. Classifier patches scope rows through `PATCH /api/log/{id}` and appends session routing memory through `POST /api/classifier/session-routing`.
8. API emits `log.patched`; UI converges through SSE and `/api/changes`.
9. Query-time retrieval:
   - `/api/context` builds prompt-ready layered context.
   - `/api/search` runs bounded hybrid ranking for topics/tasks/logs/notes.
10. OpenClaw turns can consume `/api/context` in `before_agent_start`; injected context is stripped before persistence.

## 3) Persistence and Durability Map

| Layer | Store | Durability Role |
|---|---|---|
| Canonical board state | SQLModel DB (`Space`, `Topic`, `Task`, `LogEntry`, `DeletedLog`, `SessionRoutingMemory`, `Attachment`, `Draft`, `IngestQueue`) | Source of truth |
| Plugin spill queue | `~/.openclaw/clawboard-queue.sqlite` | Survives API/network outage |
| Classifier reindex queue | JSONL (`CLASSIFIER_REINDEX_QUEUE_PATH`) | Decouples embedding refresh from API writes |
| Classifier embeddings | SQLite (`CLASSIFIER_EMBED_DB`) + optional Qdrant | Candidate retrieval namespaces |
| Search embeddings | SQLite (`CLAWBOARD_VECTOR_DB_PATH`) + optional Qdrant | Runtime semantic ranking |
| Live replay buffer | In-memory `EventHub` ring buffer | Short-lived SSE recovery |
| Deletion feed | `DeletedLog` tombstones | Durable delete propagation to clients |

## 4) Hard Invariants (Current Contracts)

- Semantic conversation rows must not remain `classificationStatus=pending` indefinitely.
- Classified semantic conversations must have a topic assignment.
- Task assignment is optional and must belong to the selected topic.
- `clawboard:task:<topicId>:<taskId>` sessions are hard-locked and cannot reroute.
- `clawboard:topic:<topicId>` sessions pin topic; task inference may still occur inside that topic.
- Slash commands and classifier/context artifacts are non-semantic and must not create topics/tasks.
- Cron delivery/control logs must never route into user topics/tasks.
- Idempotent ingest must tolerate retries and queue replays without duplicate logical sends.
- Bulk search/context paths must avoid loading unbounded raw payloads.
- Tool call action logs are excluded from semantic search and graph extraction by default.
- When a source space is resolved, classifier/context/search must stay within effective allowed-space visibility.

## 5) Ingestion, Allocation, and Routing Deep Dive

### 5.1 Session Identity and Scope

- Continuity key is `source.sessionKey`.
- Session keys may include thread suffixes (`|thread:...`); board routing parses base scope for topic/task extraction.
- Plugin routing scope can come from:
  - explicit board session key
  - board scope metadata (`source.boardScope*`)
  - subagent inherited scope cache.
- API canonicalizes scope metadata into `source.boardScope*` fields for downstream consistency.
- Classifier board-session runs resolve allowed spaces from source scope and apply `allowedSpaceIds` on API reads/writes.

### 5.2 Idempotency and Duplicate Suppression

- Ingest key precedence:
  - `X-Idempotency-Key` header
  - payload `idempotencyKey`
  - source fallback (`messageId`/`requestId` + channel/actor/type context).
- DB unique index on `LogEntry.idempotencyKey` is canonical dedupe mechanism.
- Legacy identifier fallback handles senders that omit idempotency keys.

### 5.3 Immediate Filtering at Ingest

- `source.channel == cron-event` is terminal at ingest:
  - `classificationStatus=failed`
  - `classificationAttempts=1`
  - `classificationError=filtered_cron_event`
  - `topicId` and `taskId` cleared.

### 5.4 Queue Mode

- `/api/ingest` writes `IngestQueue` rows when `CLAWBOARD_INGEST_MODE=queue`.
- Startup worker transitions `pending -> processing -> done/failed`.
- `append_log_entry()` remains canonical persistence logic.

## 6) Classifier Runtime Deep Dive

### 6.1 Scheduler and Fairness

- Cycle sequence:
  - `process_reindex_queue()`
  - single-flight lock acquire
  - fetch pending conversations
  - group and prioritize sessions
  - classify up to configured budgets.
- Priority order:
  - channel-like sessions first
  - newest pending activity
  - larger backlog count.
- Board-scoped sessions execute through `_classify_session_scoped()` so classification candidates and mutations stay inside allowed spaces.
- Guardrails:
  - `CLASSIFIER_MAX_SESSIONS_PER_CYCLE`
  - `CLASSIFIER_MAX_SESSION_SECONDS`
  - `CLASSIFIER_CYCLE_BUDGET_SECONDS`
  - stale lock cleanup.

### 6.2 Bundle Construction

- Classifier does not classify a whole session at once.
- It anchors on the oldest pending conversation and classifies one coherent bundle.
- `_bundle_range()` behavior:
  - include nearest prior user turn when anchor is assistant
  - backtrack affirmation-only turns to prior non-affirmation intent
  - split when assistant has responded and next non-affirmation user intent begins.
- Patch scope extends to interleaved rows between bundle start and next request boundary.

### 6.3 Context Filtering

- Semantic context includes only `conversation` and `note`.
- Excludes slash commands, cron events, classifier payload noise, and context-injection artifacts.

### 6.4 Board Session Forcing

- `clawboard:task:*`:
  - direct scope patch to fixed topic+task
  - no reroute or retarget.
- `clawboard:topic:*`:
  - topic is pinned
  - task inference/creation remains allowed inside pinned topic.
- Subagent sessions can inherit latest classified scope to avoid routing drift.

### 6.5 Candidate Retrieval and Scoring

- Retrieval text defaults to user-only content to reduce assistant contamination.
- Topic/task candidate signals:
  - embedding similarity
  - BM25 raw and normalized score
  - lexical similarity
  - token coverage
  - phrase hit.
- Fusion formula:
  - `topical = max(vectorScore, bm25Norm)`
  - `support = min(vectorScore, bm25Norm)`
  - `score = topical*0.62 + support*0.18 + lexical*0.12 + coverage*0.06 + phrase*0.02`
- Additional behaviors:
  - archived/snoozed penalties
  - optional late-interaction `profileScore`
  - optional OpenClaw memory snippet assist.

### 6.6 LLM Path and Prompt Contracts

- LLM output is treated as untrusted and must match strict JSON templates.
- Validation enforces:
  - required topic object
  - optional task object
  - one summary for each pending id.
- Malformed output triggers one deterministic repair pass.
- Additional constrained LLM calls:
  - creation gate (`call_creation_gate`)
  - summary repair (`call_summary_repair`).
- On timeout/failure/disabled mode, classifier falls back to `classify_without_llm()`.

### 6.7 Topic and Task Guardrails

- Avoid weak-match lock-in to generic topics.
- Avoid duplicate creation by name-similarity thresholds.
- Reject task ids not belonging to selected topic.
- Reuse continuity topic/task for ambiguous low-signal follow-ups when appropriate.
- Route casual chatter through stable `Small Talk` fast path.

### 6.8 Summary Chip Resolution

- Resolution order:
  1. validated LLM summaries
  2. summary-repair output
  3. heuristic concise summary fallback.
- Target style: short, telegraphic, stable list-chip text.

### 6.9 Patch Semantics and Filter Codes

- Patching is scope-bound to bundle boundary plus interleaved rows.
- Non-semantic/filtered behavior:

| Condition | classificationStatus | classificationError |
|---|---|---|
| Slash command conversation | `classified` | `filtered_command` |
| System/import row | `classified` | `filtered_non_semantic` |
| Memory tool action | `classified` | `filtered_memory_action` |
| Cron event | `failed` | `filtered_cron_event` |
| Classifier payload artifact | `failed` | `classifier_payload_noise` |
| Context injection artifact | `failed` | `context_injection_noise` |
| Other conversation noise | `failed` | `conversation_noise` |
| Fallback route on LLM failure | `classified` | `fallback:<reason>` |

### 6.10 Session Routing Memory

- Stored in `SessionRoutingMemory` keyed by `source.sessionKey`.
- Appends compact decisions: topic/task/anchor/timestamp.
- Used for ambiguous follow-ups without expanding context window.
- GC worker removes expired rows by TTL (`CLAWBOARD_SESSION_ROUTING_TTL_DAYS`).

### 6.11 Optional Digest Maintenance

- If cycle budget remains, classifier may update topic/task digests.
- Digest updates are bounded (`CLASSIFIER_DIGEST_MAX_PER_CYCLE`) and lower priority than routing.

## 7) Search, Sorting, and Prompt Context

### 7.1 `/api/context` Layering

- Layer A (always): board session location, working set, routing memory, timeline.
- Layer A and Layer B are filtered by effective allowed spaces when source space is known.
- Layer B (conditional): semantic recall from `_search_impl`.
- Modes:
  - `auto`: semantic when query has signal; low-signal queries stay Layer A-only unless they are board-scoped (`clawboard:topic|task`) with non-empty input
  - `cheap`: disable semantic layer
  - `full`: always semantic
  - `patient`: always semantic with larger limits.

### 7.2 `/api/search` Hybrid Ranking

- Uses bounded log windows and deferred content snippets.
- Query can degrade into bounded busy fallback when concurrency gate is saturated.
- For low-signal board-session queries, semantic query text is auto-expanded with scoped hints (topic/task/session history) before hybrid ranking.
- Ranking signals:
  - dense vectors
  - BM25
  - lexical
  - phrase
  - RRF
  - chunk rerank.
- Parent propagation:
  - log to task/topic boosts
  - task to topic boosts.
- Additional boosts:
  - note linkage weight
  - session continuity
  - direct label match.

### 7.3 Unified View Visibility

- Default view hides non-classified logs.
- `?raw=1` includes everything for diagnostics.
- SSE plus `/api/changes` reconciliation handles stream drops and tombstone deletes.

## 8) OpenClaw Board Chat Bridge

- `POST /api/openclaw/chat` persists user message first, then asynchronously dispatches `chat.send` over gateway WS RPC.
- Attachments are uploaded and validated before send.
- API emits `openclaw.typing` lifecycle events.
- Assistant-log watchdog emits system warning when gateway returns but plugin logs do not arrive.

## 9) Reliability and Degradation Semantics

| Failure Domain | Detection | Current Degradation |
|---|---|---|
| API unreachable from plugin | HTTP failures/timeouts | plugin retries, then durable local sqlite queue |
| SQLite lock contention | OperationalError lock paths | bounded backoff and retry in key write paths |
| Classifier multi-instance contention | lock collision | single-flight lock prevents double processing |
| LLM timeout/invalid output | timeout and strict validator | compact retry, repair pass, then heuristic fallback |
| Vector backend outage | request failures | SQLite fallback where available |
| SSE stalls/drops | heartbeat gap + client watchdog | reconnect + `/api/changes` reconcile |
| Missing assistant logs after board send | watchdog grace timeout | system warning log in same session |

## 10) Operational Controls (Key Knobs)

### 10.1 Classifier

- `CLASSIFIER_LLM_MODE`
- `CLASSIFIER_INTERVAL_SECONDS`
- `CLASSIFIER_MAX_SESSIONS_PER_CYCLE`
- `CLASSIFIER_MAX_SESSION_SECONDS`
- `CLASSIFIER_CYCLE_BUDGET_SECONDS`
- `CLASSIFIER_LOOKBACK_LOGS`
- `CLASSIFIER_WINDOW_SIZE`
- `CLASSIFIER_TOPIC_SIM_THRESHOLD`
- `CLASSIFIER_TASK_SIM_THRESHOLD`
- `CLASSIFIER_MAX_ATTEMPTS`
- `CLASSIFIER_SESSION_ROUTING_ENABLED`
- `CLASSIFIER_SESSION_ROUTING_PROMPT_ITEMS`
- `CLASSIFIER_CREATION_AUDIT_*`
- `CLASSIFIER_AUDIT_*`

### 10.2 Session Routing Memory

- `CLAWBOARD_SESSION_ROUTING_MAX_ITEMS`
- `CLAWBOARD_SESSION_ROUTING_TTL_DAYS`
- `CLAWBOARD_SESSION_ROUTING_GC_SECONDS`
- `CLAWBOARD_SESSION_ROUTING_GC_BATCH`
- `CLAWBOARD_DISABLE_SESSION_ROUTING_GC`

### 10.3 Search

- `CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS`
- `CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_*`
- `CLAWBOARD_SEARCH_WINDOW_*`
- `CLAWBOARD_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS`
- `CLAWBOARD_SEARCH_CONCURRENCY_*`
- `CLAWBOARD_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS`
- `CLAWBOARD_SEARCH_SOURCE_TOPK_*`
- `CLAWBOARD_RERANK_CHUNKS_PER_DOC`
- `CLAWBOARD_SEARCH_EMBED_QUERY_CACHE_SIZE`

### 10.4 Ingestion and Queueing

- `CLAWBOARD_INGEST_MODE`
- `CLAWBOARD_QUEUE_POLL_SECONDS`
- `CLAWBOARD_QUEUE_BATCH`
- `CLAWBOARD_SQLITE_TIMEOUT_SECONDS`

## 11) Offworld Readiness Requirements

This section is normative for mission-grade operation.

### 11.1 Required SLO Targets

- Pending backlog age:
  - P95 oldest pending age under 5 minutes
  - hard ceiling under 30 minutes.
- Ingestion durability:
  - no data loss across API restarts and transient network faults.
- Duplicate tolerance:
  - no duplicate visible conversation rows for the same idempotent logical send.
- Classification availability:
  - classifier loop operational above 99.9%.
- Retrieval latency:
  - `/api/search` P95 under agreed budget with bounded degraded mode.

### 11.2 Required Observability

- Poll `/api/metrics` continuously for:
  - `logs.pending`
  - `logs.oldestPendingAt`
  - `logs.failed`
  - creation totals and gate allow/block rates.
- Alert on sustained increase in:
  - `filtered_*` error families
  - `fallback:*` routes
  - creation gate blocks during clearly actionable workloads.

### 11.3 Required Pre-Release Drills

- `./tests.sh --skip-e2e` passes.
- `scripts/classifier_e2e_check.py` passes all scenarios.
- Board scope forcing invariants pass in staging.
- Queue outage drill:
  - stop API, generate traffic, restart, verify idempotent drain.
- LLM outage drill:
  - force LLM unavailability, verify heuristic fallback and pending drain.
- SSE outage drill:
  - disrupt stream path, verify `/api/changes` reconciliation convergence.

## 12) Offworld Hardening Backlog (High Priority)

1. Replace file lock with distributed leader election for multi-node classifier deployments.
2. Promote ingest queue to explicit retry policy with dead-letter queue and replay tooling.
3. Add prompt-schema version identifiers into classifier audit records for deterministic replay.
4. Add first-class per-log classification trace objects (decision path and candidate-score provenance).
5. Add chaos test suite for gateway outages, DB lock storms, and vector backend failures.
6. Add monotonic sequence ids for deterministic replay ordering across nodes.
7. Add signed backup/restore validation for DB, attachments, routing memory, and embeddings.
8. Add autoscaling policy tied to `oldestPendingAt` and classifier cycle timing.

## 13) Definition of Done (Mission Build)

- Invariants in section 4 hold under normal and degraded operation.
- SLO targets in section 11.1 are met in sustained load tests.
- Failure drills in section 11.3 pass without manual data repair.
- Hardening backlog items are implemented or explicitly accepted with mitigations and runbooks.
- This document and `OPENCLAW_CLAWBOARD_UML.md` remain synchronized with code changes.

## 14) Full Scenario Catalog (Normative)

This catalog enumerates the complete engineered scenario surface at the methodology level.

### 14.1 Logger and Ingestion Scenarios

| ID | Scenario | Expected Outcome | Primary Code Paths |
|---|---|---|---|
| ING-001 | `message_received` user conversation | conversation row appended with dedupe metadata | `extensions/clawboard-logger/index.ts` `message_received`, `backend/app/main.py` `append_log_entry` |
| ING-002 | `message_sending` assistant output | assistant conversation row appended; no duplicate `message_sent` content row | `extensions/clawboard-logger/index.ts` `message_sending` / `message_sent` |
| ING-003 | tool call start | `action` row with `Tool call:` summary | `extensions/clawboard-logger/index.ts` `before_tool_call` |
| ING-004 | tool call result/error | `action` row with `Tool result:` or `Tool error:` summary | `extensions/clawboard-logger/index.ts` `after_tool_call` |
| ING-005 | `agent_end` fallback capture | assistant rows recovered when direct send hooks do not fire | `extensions/clawboard-logger/index.ts` `agent_end` |
| ING-006 | board-session user message echo from OpenClaw | skipped to avoid double logging | `extensions/clawboard-logger/index.ts` board-session guard in `message_received` |
| ING-007 | ignore internal session prefixes | no log write | `extensions/clawboard-logger/ignore-session.ts` |
| ING-008 | classifier payload/chat-control blob observed | skipped from logging path | `extensions/clawboard-logger/index.ts` `isClassifierPayloadText` |
| ING-009 | context injection block appears in content | stripped before persistence | `extensions/clawboard-logger/index.ts` `sanitizeMessageContent` |
| ING-010 | primary send fails transiently | retry up to budget, then local durable queue spill | `extensions/clawboard-logger/index.ts` `postLogWithRetry` / `enqueueDurable` |
| ING-011 | queued row replay | same idempotency key reused on resend | `extensions/clawboard-logger/index.ts` `flushQueueOnce` |
| ING-012 | idempotency header/payload present | exact-once semantics by unique key | `backend/app/main.py` `_idempotency_key` + unique index |
| ING-013 | legacy sender without idempotency key | dedupe by source `messageId`/`requestId` fallback | `backend/app/main.py` `append_log_entry` legacy query branch |
| ING-014 | source carries board scope metadata only | topic/task inferred from source scope and normalized | `backend/app/main.py` `append_log_entry` board scope normalization |
| ING-015 | task/topic mismatch at ingest | task authority enforced; topic/space corrected | `backend/app/main.py` `append_log_entry` task/topic alignment |
| ING-016 | cron event channel row ingested | terminal failed row detached from topic/task | `backend/app/main.py` `append_log_entry` cron filter |
| ING-017 | conversation arrives on snoozed task/topic | item revived (active/unsnoozed) | `backend/app/main.py` `append_log_entry` revival branch |
| ING-018 | queue ingestion mode enabled | row enqueued and async worker processes status transitions | `backend/app/main.py` `/api/ingest`, `_queue_worker` |
| ING-019 | sqlite write lock during ingest | bounded retry/backoff path | `backend/app/main.py` `append_log_entry` OperationalError branch |
| ING-020 | assistant row appended | `openclaw.typing=false` event published | `backend/app/main.py` `append_log_entry` typing publish branch |

### 14.2 Classifier Scheduling and Bundle Selection Scenarios

| ID | Scenario | Expected Outcome | Primary Code Paths |
|---|---|---|---|
| CLS-001 | no pending conversations in session | cleanup-only filtering applied; no semantic routing | `classifier/classifier.py` `classify_session` early-return paths |
| CLS-002 | pending rows include cron events | cron rows terminal-filtered without routing | `classifier/classifier.py` `_is_cron_event` branches |
| CLS-003 | oldest pending conversation anchor | starvation prevention; oldest-first bundle processing | `classifier/classifier.py` `classify_session` anchor selection |
| CLS-004 | anchor is assistant | bundle backtracks to nearest prior user turn | `classifier/classifier.py` `_bundle_range` |
| CLS-005 | anchor user turn is affirmation | bundle backtracks to prior non-affirmation intent | `classifier/classifier.py` `_bundle_range` |
| CLS-006 | assistant responded and user starts new intent | bundle boundary split before new non-affirmation request | `classifier/classifier.py` `_bundle_range` |
| CLS-007 | interleaved actions/system rows between turns | same bundle `scope_logs` patched consistently | `classifier/classifier.py` scope range logic |
| CLS-008 | task-scoped board session | hard pin to topic+task; no reroute | `classifier/classifier.py` forced task scope branch |
| CLS-009 | topic-scoped board session | topic pinned, task inference allowed inside topic | `classifier/classifier.py` forced topic handling |
| CLS-010 | subagent session with prior classified scope | inherits latest classified topic/task scope | `classifier/classifier.py` subagent continuity branch |
| CLS-011 | low-signal follow-up (`yes/ok`) | continuity memory consulted and may force prior topic/task | `classifier/classifier.py` continuity logic |
| CLS-012 | explicit “new thread/topic” cue | continuity force suppressed | `classifier/classifier.py` explicit new-thread detection |
| CLS-013 | small-talk bundle | routed to stable `Small Talk` topic | `classifier/classifier.py` `_is_small_talk_bundle` fast path |
| CLS-014 | non-affirmation user signal present | user-only retrieval text used | `classifier/classifier.py` `user_window_text` branch |
| CLS-015 | ambiguous bundle without user signal | window text augmented with continuity anchor | `classifier/classifier.py` ambiguity text augmentation |
| CLS-016 | session over max attempts | no further patch attempts for that row | `classifier/classifier.py` `MAX_ATTEMPTS` guards |

### 14.3 Classifier Decision and Guardrail Scenarios

| ID | Scenario | Expected Outcome | Primary Code Paths |
|---|---|---|---|
| CLS-020 | LLM enabled and returns valid strict JSON | validated result used | `classifier/classifier.py` `call_classifier`, `_validate_classifier_result` |
| CLS-021 | LLM response malformed | deterministic repair call attempted once | `classifier/classifier.py` `call_classifier` repair branch |
| CLS-022 | LLM timeout/error | heuristic fallback path selected | `classifier/classifier.py` fallback via `classify_without_llm` |
| CLS-023 | forced topic but LLM fails entirely | deterministic board-safe fallback keeps pinned topic | `classifier/classifier.py` forced-topic fallback branch |
| CLS-024 | weak reuse signal + clear topic intent | classifier favors new topic creation | `classifier/classifier.py` post-LLM topic guardrail |
| CLS-025 | create proposed but strong lexical anchor exists | classifier reuses existing topic candidate | `classifier/classifier.py` anti-dup topic guardrail |
| CLS-026 | creation gate blocks topic/task create | reuse existing id or suppress create | `classifier/classifier.py` `call_creation_gate` handling |
| CLS-027 | task id proposed from different topic | rejected by `valid_task_ids` guardrail | `classifier/classifier.py` task guard branch |
| CLS-028 | task intent absent and not continuity-sticky | task cleared/null | `classifier/classifier.py` task finalization |
| CLS-029 | task intent present but no confident candidate | continuity reuse or controlled create path | `classifier/classifier.py` task fallback heuristics |
| CLS-030 | missing or low-signal summaries | summary repair then concise fallback | `classifier/classifier.py` `call_summary_repair` + fallback |
| CLS-031 | LLM/gate unavailable and heuristics fail | `mark_window_failure` increments attempts and terminal progression | `classifier/classifier.py` `mark_window_failure` |
| CLS-032 | continuity memory enabled | decision appended for future ambiguous turns | `classifier/classifier.py` `append_session_routing_memory` |

### 14.4 Patch Outcome and Filter Scenario Catalog

| ID | Scenario | Expected Outcome | Error Code |
|---|---|---|---|
| FIL-001 | slash command conversation | `classified`, non-semantic | `filtered_command` |
| FIL-002 | system/import row | `classified`, non-semantic | `filtered_non_semantic` |
| FIL-003 | memory action row | `classified`, non-semantic | `filtered_memory_action` |
| FIL-004 | cron event row | `failed`, detached | `filtered_cron_event` |
| FIL-005 | classifier payload artifact | `failed`, detached unless locked scope | `classifier_payload_noise` |
| FIL-006 | injected context artifact | `failed`, detached unless locked scope | `context_injection_noise` |
| FIL-007 | other conversation noise | `failed`, detached unless locked scope | `conversation_noise` |
| FIL-008 | fallback semantic route | `classified` with degraded provenance marker | `fallback:<reason>` |

### 14.5 Search, Context, and UI Synchronization Scenarios

| ID | Scenario | Expected Outcome | Primary Code Paths |
|---|---|---|---|
| SRCH-001 | `/api/context` auto mode low-signal query | non-board low-signal skips semantic; board-scoped low-signal with non-empty query runs semantic | `backend/app/main.py` `context` low-signal/board-session gating |
| SRCH-002 | `/api/context` full/patient mode | semantic layer forced | `backend/app/main.py` `context` mode branch |
| SRCH-003 | board session query | active board topic/task surfaced first and context layers remain visibility-scoped | `backend/app/main.py` `context` board-session promotion + allowed-space filtering |
| SRCH-004 | search gate saturated | bounded degraded busy fallback returned | `backend/app/main.py` `/api/search` gate branch |
| SRCH-005 | deep search disabled in fallback | no deep content scan while preserving semantic ordering | `backend/app/main.py` `/api/search` degraded limits |
| SRCH-006 | search default filters | system/import/tool-call/memory-action/command logs excluded | `backend/app/vector_search.py` `semantic_search` filters |
| SRCH-007 | parent propagation from log/task matches | topic/task base scores boosted with caps | `backend/app/main.py` `_search_impl` propagation |
| SRCH-008 | notes attached to related logs | note weights boost rank and note rows emitted | `backend/app/main.py` `_search_impl` note weighting |
| SRCH-009 | SSE drop/stall | client reconnect + `/api/changes` reconcile | `src/lib/use-live-updates.ts`, `/api/stream`, `/api/changes` |
| SRCH-010 | stream replay window missed | `stream.reset` forces full resync | `backend/app/main.py` `/api/stream` reset branch |
| SRCH-011 | unified default view | non-classified logs hidden by default | `src/components/unified-view.tsx` visibleLogs |
| SRCH-012 | `?raw=1` diagnostics view | pending/failed/non-semantic logs visible | `src/components/unified-view.tsx` showRaw |

### 14.6 OpenClaw Board Chat Bridge Scenarios

| ID | Scenario | Expected Outcome | Primary Code Paths |
|---|---|---|---|
| CHAT-001 | board chat send | user message persisted before gateway dispatch | `backend/app/main.py` `/api/openclaw/chat` |
| CHAT-002 | attachment upload + send | validated and bound to log; gateway payload includes bytes | `backend/app/main.py` `/api/attachments`, `_run_openclaw_chat` |
| CHAT-003 | gateway send in-flight | `openclaw.typing=true` published | `backend/app/main.py` `_run_openclaw_chat` |
| CHAT-004 | gateway returns or fails | `openclaw.typing=false` always published | `backend/app/main.py` `_run_openclaw_chat` finally block |
| CHAT-005 | assistant plugin logs arrive | watchdog no-op | `backend/app/main.py` `_OpenClawAssistantLogWatchdog._check` |
| CHAT-006 | assistant plugin logs missing | system warning appended to same session | `backend/app/main.py` watchdog error branch |
| CHAT-007 | persist user message fails | fail closed; no gateway send | `backend/app/main.py` `/api/openclaw/chat` exception branch |
| CHAT-008 | gateway/attachment read failure | system error log persisted | `backend/app/main.py` `_log_openclaw_chat_error` |

## 15) Coverage Traceability and Full-Coverage Gate

- Scenario-to-test traceability lives in `CLASSIFICATION_TEST_MATRIX.md`.
- “Full coverage” for this system means all scenario IDs in section 14 satisfy:
  - at least one deterministic automated assertion path (unit, integration, or e2e), and
  - explicit expected-state contracts (`classificationStatus`, `classificationError`, topic/task allocation, summary behavior), and
  - failure-mode assertions for degraded branches where applicable.
- Coverage quality gates:
  - all unit suites under `classifier/tests/*` pass,
  - `scripts/classifier_e2e_check.py` passes all scenarios,
  - no unbounded pending growth in `/api/metrics.logs.oldestPendingAt` under sustained test load.
- Current audited status (`2026-02-17`) is tracked in `CLASSIFICATION_TEST_MATRIX.md`:
  - Trace coverage (code-path): `77/77` (`100.0%`) in `CLASSIFICATION_TRACE_MATRIX.md`
  - Trace gate: `MET`
  - `Covered: 77/77`
  - `Partial: 0/77`
  - `Gap: 0/77`
  - Automated behavior gate: `MET`

## Reference Files

- `OPENCLAW_CLAWBOARD_UML.md`
- `CLASSIFICATION_TRACE_MATRIX.md`
- `scripts/classification_trace_audit.py`
- `backend/app/main.py`
- `backend/app/models.py`
- `backend/app/vector_search.py`
- `backend/app/clawgraph.py`
- `backend/app/openclaw_gateway.py`
- `extensions/clawboard-logger/index.ts`
- `classifier/classifier.py`
- `classifier/embeddings_store.py`
- `CLASSIFICATION_TEST_MATRIX.md`
