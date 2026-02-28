# Clawboard Classification and Routing Spec (Mission-Critical)

Companion UML: `OPENCLAW_CLAWBOARD_UML.md`

This spec is code-accurate for the current repository and adds mission-grade operating requirements.

## 1) System Boundary

- OpenClaw runtime produces user, assistant, and tool events.
- `extensions/clawboard-logger` sanitizes events, resolves continuity/session scope, and writes logs to Clawboard.
- Clawboard API (`backend/app/main.py`) persists state, publishes SSE, serves context/search, and bridges board chat to OpenClaw gateway.
- Classifier worker (`classifier/classifier.py`) classifies pending conversation bundles into topic/task/summary assignments.
- Embedding backends:
  - Search runtime: `backend/app/vector_search.py` (Qdrant-backed vectors in core runtime).
  - Classifier runtime: `classifier/embeddings_store.py` (Qdrant-backed vectors in core runtime).
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
| Canonical board state | SQLModel DB (`Space`, `Topic`, `Task`, `LogEntry`, `DeletedLog`, `SessionRoutingMemory`, `OpenClawRequestRoute`, `IngestReceipt`, `IngestQueue`, `OpenClawChatDispatchQueue`, `OrchestrationRun`, `OrchestrationItem`, `OrchestrationEvent`, `OpenClawGatewayHistoryCursor`, `OpenClawGatewayHistorySyncState`, `Attachment`, `Draft`, `InstanceConfig`) | Source of truth |
| Plugin spill queue | `~/.openclaw/clawboard-queue.sqlite` | Survives API/network outage |
| Classifier reindex queue | JSONL (`CLASSIFIER_REINDEX_QUEUE_PATH`) | Decouples embedding refresh from API writes |
| Classifier embeddings | Qdrant (`QDRANT_URL`/collection config) | Candidate retrieval namespaces |
| Search embeddings | Qdrant (`CLAWBOARD_QDRANT_URL`/collection config) | Runtime semantic ranking |
| Live replay buffer | In-memory `EventHub` ring buffer | Short-lived SSE recovery |
| Deletion feed | `DeletedLog` tombstones | Durable delete propagation to clients |

## 4) Hard Invariants (Current Contracts)

- Semantic conversation rows must not remain `classificationStatus=pending` indefinitely.
- Classified semantic conversations must have a topic assignment.
- Task assignment is optional and must belong to the selected topic.
- **Task Chat** (`clawboard:task:<topicId>:<taskId>`): messages **never** get allocated to another topic or task; classifier patches with fixed scope and does not reroute.
- **Topic Chat** (`clawboard:topic:<topicId>`): messages stay in **this topic only**; task inference/creation only within this topic and only when there is a clear, concrete task.
- When a topic-scoped request is promoted to a task, same-request rows are backfilled into that task scope so one user turn does not remain split across topic/task chats.
- Canonical request routing is ledgered in `OpenClawRequestRoute` (keyed by canonical `occhat-*` id); same-request follow-ups obey this route even when incoming metadata carries non-`occhat` run ids.
- Non-user follow-up rows (assistant/system/tool/action) in board sessions must prefer explicit board scope; when absent in topic sessions, task continuity can be inferred from session-routing memory (same session only).
- Slash commands and classifier/context artifacts are non-semantic and must not create topics/tasks.
- Cron delivery/control logs must never route into user topics/tasks.
- Idempotent ingest must tolerate retries and queue replays without duplicate logical sends.
- Bulk search/context paths must avoid loading unbounded raw payloads.
- Tool call action logs are excluded from semantic search and graph extraction by default.
- When a source space is resolved, classifier/context/search must stay within effective allowed-space visibility.
- Main-agent delegated-run supervision cadence is deterministic and bootstrap-installed (`1m -> 3m -> 10m -> 15m -> 30m -> 1h`, cap `1h`), with explicit user progress updates once elapsed runtime exceeds 5 minutes.

### 4.1 Allocation Guardrails (Absolute)

This section is normative for `ANATOMY.md` and `CONTEXT.md`.

- Allocation to Topic/Task is allowed only for logs in a direct user-request lineage.
- Board sessions are hard constraints:
  - `clawboard:task:<topicId>:<taskId>` is permanently pinned to that topic+task.
  - `clawboard:topic:<topicId>` is permanently pinned to that topic; task inference/creation can happen only inside that same topic.
- Subagent scope inheritance is allowed only when explicitly linked to the parent request chain:
  - explicit board scope on the log (`source.boardScope*`), or
  - explicit parent-child session linkage captured from `sessions_spawn` (`childSessionKey`) and cached by exact child session key.
- Cross-agent or global "latest scope" fallback is forbidden for allocation.
- Non-request/control-plane activity (cron, backups, maintenance, unanchored tool churn) must never be allocated to user Topic/Task chats.
- If an event cannot prove request lineage, it must remain detached (`topicId/taskId` empty) and/or terminal-filtered by ingest/classifier filters.

## 5) Ingestion, Allocation, and Routing Deep Dive

### 5.1 Session Identity and Scope

- Continuity key is `source.sessionKey`.
- Session keys may include thread suffixes (`|thread:...`); board routing parses base scope for topic/task extraction.
- Plugin routing scope can come from:
  - explicit board session key
  - board scope metadata (`source.boardScope*`)
  - explicit subagent linkage cache keyed by exact child session key (`sessions_spawn` `childSessionKey`, memory + sqlite).
- Gateway history-sync fallback seeding includes unresolved request sessions and delegated child session keys parsed from recent `sessions_spawn` lineage logs, so subagent transcripts can recover even with `sessions.list` degraded/disabled.
- Cross-agent/global recency fallback is intentionally disallowed.
- API canonicalizes scope metadata into `source.boardScope*` fields for downstream consistency.
- Classifier board-session runs resolve allowed spaces from source scope and apply `allowedSpaceIds` on API reads/writes.

### 5.2 Idempotency and Duplicate Suppression

- Ingest key precedence:
  - `X-Idempotency-Key` header
  - payload `idempotencyKey`
  - source fallback (`messageId`/`requestId` + channel/actor/type context).
- DB unique index on `LogEntry.idempotencyKey` is canonical dedupe mechanism.
- Legacy identifier fallback handles senders that omit idempotency keys.
- Assistant identifier fallback evaluates all candidate rows for the same request/message identifiers and only dedupes when normalized assistant payloads match (prevents replay collisions with unrelated subagent rows).

### 5.3 Immediate Filtering at Ingest

- `source.channel == cron-event` is terminal at ingest:
  - `classificationStatus=failed`
  - `classificationAttempts=1`
  - `classificationError=filtered_cron_event`
  - `topicId` and `taskId` cleared.
- Main-session heartbeat/control-plane conversations are terminal at ingest:
  - `classificationStatus=failed`
  - `classificationAttempts=1`
  - `classificationError=filtered_control_plane`
  - `topicId` and `taskId` cleared.
- Subagent scaffold envelopes (`[Subagent Context]...`) are terminal at ingest:
  - `classificationStatus=failed`
  - `classificationAttempts=1`
  - `classificationError=filtered_subagent_scaffold`
  - `topicId` and `taskId` cleared.
- Tool trace action rows (`Tool call|result|error`) are terminalized at ingest:
  - anchored rows -> `classificationStatus=classified`, `classificationError=filtered_tool_activity`
  - unanchored rows -> `classificationStatus=failed`, `classificationError=filtered_unanchored_tool_activity`
  - both paths set `classificationAttempts=1`.

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

### 6.4 Board Session Forcing (Surefire Rules)

- **Task Chat** (`clawboard:task:<topicId>:<taskId>`):
  - Messages **never** get allocated elsewhere. Classifier patches all scope logs with this topic+task and returns; no LLM, no candidate retrieval, no reroute.
  - Per-entry lock from `source.boardScope*` also forces topic+task when present.
- **Topic Chat** (`clawboard:topic:<topicId>`):
  - Messages stay in **this topic only**. Topic is pinned; classifier candidate retrieval is restricted to this topic (and its tasks).
  - Task inference or creation is allowed **only within this topic**, and only when there is a **clear, concrete task** (gated by `_task_creation_allowed` and `call_creation_gate`).
  - If promotion occurs, append/patch routing rebases in-scope request rows to the promoted task without changing topic ownership.
  - Never allocate to another topic.
- Subagent sessions can be pinned only by explicit board scope lineage (`source.boardScope*`) or prior classified scope in that same subagent session; never by global/cross-session recency fallback.

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
| Heartbeat/control-plane conversation | `failed` | `filtered_control_plane` |
| Subagent scaffold conversation | `failed` | `filtered_subagent_scaffold` |
| Anchored tool trace action | `classified` | `filtered_tool_activity` |
| Unanchored tool trace action | `failed` | `filtered_unanchored_tool_activity` |
| Classifier payload artifact | `failed` | `classifier_payload_noise` |
| Context injection artifact | `failed` | `context_injection_noise` |
| Other conversation noise | `failed` | `conversation_noise` |
| Fallback route on LLM failure | `classified` | `fallback:<reason>` |

### 6.10 Session Routing Memory

- Stored in `SessionRoutingMemory` keyed by `source.sessionKey`.
- Appends compact decisions: topic/task/anchor/timestamp.
- Used for ambiguous follow-ups without expanding context window.
- GC worker removes expired rows by TTL (`CLAWBOARD_SESSION_ROUTING_TTL_DAYS`).

### 6.11 Request Route Ledger

- Stored in `OpenClawRequestRoute`, keyed by canonical base request id (`occhat-*`).
- Source canonicalization prefers `source.requestId` when it is canonical; otherwise falls back to canonical `source.messageId`.
- Append and patch paths both upsert the ledger and emit `openclaw.request_route.updated` on route changes.
- Promotion semantics:
  - topic -> task is lockable and durable (`routeLocked=true`).
  - same-topic promotions are allowed; downscope from task -> topic is rejected.
  - conflicting cross-topic updates are ignored once route ownership is established.
- GC worker removes stale route rows by TTL (`CLAWBOARD_OPENCLAW_REQUEST_ROUTE_TTL_DAYS`).

### 6.12 Optional Digest Maintenance

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
- API emits both `openclaw.typing` (typing=true/false) and `openclaw.thread_work` (active=true/false, with optional `reason` and `requestId`) lifecycle events. Both are emitted at dispatch start, on failure, on cancel, and on terminal assistant/system ingest.
- Assistant-log watchdog emits system warning when gateway returns but plugin logs do not arrive.
- History-sync ingest skips injected context wrapper artifacts while still advancing the per-session cursor.
- Orchestration convergence does not mark `main.response` done while any delegated subagent item is still non-terminal.
- Unified board freeform send selects one deterministic board session key per turn (new topic, selected topic, or selected task), and UI focus follows that target.
- Topic-session promotions to task scope update both row scope metadata and same-request allocations so subsequent rows converge into the promoted task chat.

## 9) Reliability and Degradation Semantics

| Failure Domain | Detection | Current Degradation |
|---|---|---|
| API unreachable from plugin | HTTP failures/timeouts | plugin retries, then durable local sqlite queue |
| SQLite lock contention | OperationalError lock paths | bounded backoff and retry in key write paths |
| Classifier multi-instance contention | lock collision | single-flight lock prevents double processing |
| LLM timeout/invalid output | timeout and strict validator | compact retry, repair pass, then heuristic fallback |
| Vector backend outage | request failures | Graceful degrade to lexical/BM25 + heuristic routing paths |
| SSE stalls/drops | heartbeat gap + client watchdog | exponential backoff reconnect (1 s→30 s, ±25% jitter) + `/api/changes` reconcile; `navigator.onLine` guard prevents blind retries offline; `online` event triggers immediate reconnect |
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

- `CLAWBOARD_SEARCH_MODE` (`auto|hybrid|fast`)
- `CLAWBOARD_SEARCH_ENABLE_DENSE`
- `CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS`
- `CLAWBOARD_SEARCH_ENABLE_HEAVY_SEMANTIC` (legacy compatibility toggle)
- `CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_*`
- `CLAWBOARD_SEARCH_WINDOW_*`
- `CLAWBOARD_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS`
- `CLAWBOARD_SEARCH_CONCURRENCY_*`
- `CLAWBOARD_SEARCH_LOG_CONTENT_MATCH_CLIP_CHARS`
- `CLAWBOARD_SEARCH_SOURCE_TOPK_*`
- `CLAWBOARD_SEARCH_GLOBAL_LEXICAL_RESCUE_*`
- `CLAWBOARD_RERANK_CHUNKS_PER_DOC`
- `CLAWBOARD_SEARCH_EMBED_QUERY_CACHE_SIZE`

### 10.4 Ingestion and Queueing

- `CLAWBOARD_INGEST_MODE`
- `CLAWBOARD_QUEUE_POLL_SECONDS`
- `CLAWBOARD_QUEUE_BATCH`
- `CLAWBOARD_SQLITE_TIMEOUT_SECONDS`

### 10.5 OpenClaw Bridge Dynamics

- `OPENCLAW_CHAT_DISPATCH_*` (durable send queue workers, retries, stale recovery, quarantine)
- `OPENCLAW_CHAT_IN_FLIGHT_*` (optional post-send progress probe and abort/retry window)
- `OPENCLAW_CHAT_BOARD_IN_FLIGHT_PROBE_SECONDS` (post-send orchestration probe interval for board sessions)
- `OPENCLAW_CHAT_ASSISTANT_LOG_*` (watchdog cadence and backfill throttles)
- `OPENCLAW_GATEWAY_HISTORY_SYNC_*` (gateway history fallback reconciliation)

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
| ING-021 | main-session heartbeat/control-plane conversation ingested | terminal failed row, `classificationError=filtered_control_plane`, `topicId`/`taskId` cleared | `backend/app/main.py` `append_log_entry` control-plane filter |
| ING-022 | subagent scaffold conversation ingested | terminal failed row, `classificationError=filtered_subagent_scaffold`, `topicId`/`taskId` cleared | `backend/app/main.py` `append_log_entry` scaffold filter |
| ING-023 | scoped tool trace action row ingested | terminalized as `classificationStatus=classified`, `classificationError=filtered_tool_activity` | `backend/app/main.py` `append_log_entry` anchored tool trace branch |
| ING-024 | unanchored tool trace action row ingested | terminalized as `classificationStatus=failed`, `classificationError=filtered_unanchored_tool_activity`, `topicId`/`taskId` cleared | `backend/app/main.py` `append_log_entry` unanchored tool trace branch |

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
| CLS-010 | subagent session with explicit board lineage | inherits pinned scope from explicit board linkage or prior classified rows in the same subagent session; no cross-session fallback | `extensions/clawboard-logger/index.ts` explicit `sessions_spawn` linkage + `classifier/classifier.py` subagent continuity branch |
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
| FIL-009 | heartbeat/control-plane conversation | `failed`, detached | `filtered_control_plane` |
| FIL-010 | subagent scaffold conversation | `failed`, detached | `filtered_subagent_scaffold` |
| FIL-011 | tool trace action (anchored/unanchored) | `classified` when anchored, `failed` when unanchored | `filtered_tool_activity` / `filtered_unanchored_tool_activity` |

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
| CHAT-004 | gateway returns or fails | failure emits `openclaw.typing=false`; success clears typing on terminal ingest (assistant/system terminal) | `backend/app/main.py` `_run_openclaw_chat`, `append_log_entry` |
| CHAT-005 | assistant plugin logs arrive | watchdog no-op | `backend/app/main.py` `_OpenClawAssistantLogWatchdog._check` |
| CHAT-006 | assistant plugin logs missing | system warning appended to same session | `backend/app/main.py` watchdog error branch |
| CHAT-007 | persist user message fails | fail closed; no gateway send | `backend/app/main.py` `/api/openclaw/chat` exception branch |
| CHAT-008 | gateway/attachment read failure | system error log persisted | `backend/app/main.py` `_log_openclaw_chat_error` |

## 15) Coverage Traceability and Full-Coverage Gate

- Scenario-to-test traceability lives in section 16 of this file.
- “Full coverage” for this system means all scenario IDs in section 14 satisfy:
  - at least one deterministic automated assertion path (unit, integration, or e2e), and
  - explicit expected-state contracts (`classificationStatus`, `classificationError`, topic/task allocation, summary behavior), and
  - failure-mode assertions for degraded branches where applicable.
- Coverage quality gates:
  - all unit suites under `classifier/tests/*` pass,
  - `scripts/classifier_e2e_check.py` passes all scenarios,
  - no unbounded pending growth in `/api/metrics.logs.oldestPendingAt` under sustained test load.
- Current audited status (`2026-02-28`) is tracked in sections 16 and 17:
  - Trace coverage (code-path): `84/84` (`100.0%`) in section 17
  - Trace gate: `MET`
  - `Covered: 84/84`
  - `Partial: 0/84`
  - `Gap: 0/84`
  - Automated behavior gate: `MET`

## Reference Files

- `OPENCLAW_CLAWBOARD_UML.md`
- `scripts/classification_trace_audit.py`
- `backend/app/main.py`
- `backend/app/models.py`
- `backend/app/vector_search.py`
- `backend/app/clawgraph.py`
- `backend/app/openclaw_gateway.py`
- `extensions/clawboard-logger/index.ts`
- `classifier/classifier.py`
- `classifier/embeddings_store.py`

## 16) Scenario Coverage Matrix (Merged)

This section is merged from the former `CLASSIFICATION_TEST_MATRIX.md`.


This matrix maps every normative scenario in `CLASSIFICATION.md` section 14 to current automated evidence.

Snapshot date: `2026-02-28`

Trace-level companion:
- section 17 confirms path-level trace coverage for all scenarios: `84/84` (`100.0%`).

Status legend:
- `Covered`: deterministic automated assertion exists for the scenario outcome.
- `Partial`: automated tests touch the path but do not assert the full contract.
- `Gap`: no deterministic automated assertion found.

### Coverage Summary

| Family | Covered | Partial | Gap | Total |
|---|---:|---:|---:|---:|
| ING | 24 | 0 | 0 | 24 |
| CLS (Scheduling/Bundling) | 16 | 0 | 0 | 16 |
| CLS (Decision/Guardrails) | 13 | 0 | 0 | 13 |
| FIL | 11 | 0 | 0 | 11 |
| SRCH | 12 | 0 | 0 | 12 |
| CHAT | 8 | 0 | 0 | 8 |
| **Total** | **84** | **0** | **0** | **84** |

Automated behavior full-coverage gate status: `MET` (`84/84` covered).

### ING Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| ING-001 | `message_received` user conversation is appended with dedupe metadata | `extensions/clawboard-logger/behavior.test.mjs` `message_received logs user conversation with dedupe metadata (ING-001)` | Covered |
| ING-002 | `message_sending` assistant row appended; duplicate `message_sent` row avoided | `extensions/clawboard-logger/behavior.test.mjs` `message_sending logs assistant row; message_sent does not duplicate it (ING-002)` | Covered |
| ING-003 | tool call start emits `action` log (`Tool call:`) | `extensions/clawboard-logger/behavior.test.mjs` `before_tool_call emits action log with tool call summary (ING-003)` | Covered |
| ING-004 | tool result/error emits `action` log (`Tool result:`/`Tool error:`) | `extensions/clawboard-logger/behavior.test.mjs` `after_tool_call emits action log for result and error (ING-004)` | Covered |
| ING-005 | `agent_end` fallback captures assistant output when send hooks miss | `extensions/clawboard-logger/behavior.test.mjs` `agent_end fallback captures assistant output when send hooks are absent (ING-005)` | Covered |
| ING-006 | board-session user echo from OpenClaw is skipped (no double log) | `extensions/clawboard-logger/behavior.test.mjs` `board-session user message echo is skipped to avoid double logging (ING-006)` | Covered |
| ING-007 | ignore-session prefixes prevent writes | `extensions/clawboard-logger/behavior.test.mjs` `ignored internal session prefixes do not write logs (ING-007)` | Covered |
| ING-008 | classifier payload/control blobs are skipped in logger path | `extensions/clawboard-logger/behavior.test.mjs` `classifier/control payload text is suppressed in logging hooks (ING-008)` | Covered |
| ING-009 | injected context blocks are stripped before persistence | `extensions/clawboard-logger/behavior.test.mjs` `injected context blocks are stripped before persistence (ING-009)` | Covered |
| ING-010 | transient send failures retry, then durable local queue spill | `extensions/clawboard-logger/behavior.test.mjs` `send failures spill to durable queue and replay keeps idempotency key (ING-010, ING-011)` | Covered |
| ING-011 | durable queue replay reuses same idempotency key | `extensions/clawboard-logger/behavior.test.mjs` `send failures spill to durable queue and replay keeps idempotency key (ING-010, ING-011)` | Covered |
| ING-012 | idempotency key enforces exact-once append behavior | `backend/tests/test_idempotency.py::test_append_log_dedupes_on_x_idempotency_key` | Covered |
| ING-013 | fallback dedupe by source message/request id when key missing | `backend/tests/test_idempotency.py::test_append_log_dedupes_on_source_message_id_when_key_missing` | Covered |
| ING-014 | board scope metadata-only source is normalized into canonical scope fields | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_014_source_scope_metadata_is_normalized` | Covered |
| ING-015 | task/topic mismatch is corrected to task authority | `backend/tests/test_append_log_entry.py::test_append_log_aligns_topic_to_task` | Covered |
| ING-016 | cron-event ingest is terminal filtered + detached | `backend/tests/test_append_log_entry.py::test_append_log_filters_cron_event_logs` | Covered |
| ING-021 | main-session heartbeat/control-plane conversation is terminal filtered + detached | `backend/tests/test_append_log_entry.py::test_append_log_filters_main_session_heartbeat_control_plane_conversation` | Covered |
| ING-022 | subagent scaffold conversation is terminal filtered + detached | `backend/tests/test_append_log_entry.py::test_append_log_filters_subagent_scaffold_conversation` | Covered |
| ING-023 | scoped tool trace action is terminalized as classified filtered tool activity | `backend/tests/test_append_log_entry.py::test_append_log_marks_scoped_tool_trace_action_as_terminal_classified` | Covered |
| ING-024 | unanchored tool trace action is terminalized as failed + detached | `backend/tests/test_append_log_entry.py::test_append_log_marks_unanchored_tool_trace_action_as_terminal_failed` | Covered |
| ING-017 | conversation activity revives snoozed topic/task | `backend/tests/test_unsnooze_on_activity.py::test_conversation_revives_snoozed_topic_and_task` | Covered |
| ING-018 | queue ingest mode writes `IngestQueue` and worker drains statuses | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_018_queue_ingest_and_worker_drain` | Covered |
| ING-019 | SQLite lock during ingest follows bounded retry/backoff | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_019_append_retries_sqlite_lock_then_commits` | Covered |
| ING-020 | assistant append publishes `openclaw.typing=false` | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_020_assistant_append_publishes_typing_false` | Covered |

### CLS Scheduling and Bundling Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| CLS-001 | no pending conversations -> cleanup-only path | `classifier/tests/test_classifier_failure_paths.py::test_cls_001_no_pending_conversations_uses_cleanup_only_path` | Covered |
| CLS-002 | cron events in pending set are terminal-filtered without routing | `classifier/tests/test_cron_event_filtering.py::test_classify_session_filters_cron_event_logs_without_routing` | Covered |
| CLS-003 | oldest pending conversation anchor selected first | `classifier/tests/test_classifier_additional_coverage.py::test_cls_003_oldest_pending_bundle_is_classified_first` | Covered |
| CLS-004 | assistant anchor backtracks to nearest prior user turn | `classifier/tests/test_classifier_heuristics.py::test_bundle_range_backtracks_from_assistant_to_prior_user_turn` | Covered |
| CLS-005 | affirmation anchor backtracks to prior non-affirmation intent | `classifier/tests/test_classifier_heuristics.py::test_bundle_range_backtracks_from_affirmation_to_prior_user_intent` | Covered |
| CLS-006 | boundary split when assistant responded and new user intent begins | `classifier/tests/test_classifier_heuristics.py::test_bundle_range_splits_on_new_user_request_after_assistant` | Covered |
| CLS-007 | interleaved rows are patched in-scope consistently | `scripts/classifier_e2e_check.py` scenarios `multi-bundle`, `board-task-fixed-scope` | Covered |
| CLS-008 | task-scoped board session is hard-pinned | `classifier/tests/test_board_sessions.py::test_classify_session_task_scope_keeps_task_fixed`; `scripts/classifier_e2e_check.py` `board-task-fixed-scope` | Covered |
| CLS-009 | topic-scoped board session pins topic while allowing task inference | `classifier/tests/test_board_sessions.py::test_classify_session_topic_scope_can_promote_to_task_without_moving_topic`; `scripts/classifier_e2e_check.py` `board-topic-promote-task` | Covered |
| CLS-010 | subagent session inherits only explicit board lineage | `classifier/tests/test_board_sessions.py::test_subagent_session_with_existing_task_scope_stays_pinned`; `extensions/clawboard-logger/behavior.test.mjs` `subagent tool logs inherit board scope from parent board session when ctx.agentId is absent`; `extensions/clawboard-logger/behavior.test.mjs` `subagent tool logs do not inherit board scope without explicit spawn linkage` | Covered |
| CLS-011 | low-signal follow-up can force continuity scope | `classifier/tests/test_session_routing_continuity.py::test_low_signal_followup_forces_continuity_topic_in_llm_mode` | Covered |
| CLS-012 | explicit "new thread/topic" cue suppresses continuity forcing | `classifier/tests/test_classifier_additional_coverage.py::test_cls_012_explicit_new_thread_suppresses_continuity_forcing` | Covered |
| CLS-013 | small-talk fast path routes to stable small-talk scope | `classifier/tests/test_classifier_additional_coverage.py::test_cls_013_small_talk_fast_path_uses_stable_small_talk_topic` | Covered |
| CLS-014 | user-only retrieval text used to avoid assistant contamination | `classifier/tests/test_classifier_additional_coverage.py::test_cls_014_retrieval_text_prefers_user_turns` | Covered |
| CLS-015 | ambiguous low-signal bundle can use continuity anchor augmentation | `classifier/tests/test_session_routing_continuity.py::test_low_signal_followup_forces_continuity_topic_in_llm_mode` | Covered |
| CLS-016 | max-attempts guard prevents endless retries | `classifier/tests/test_classifier_failure_paths.py::test_cls_016_max_attempts_guard_prevents_reprocessing` | Covered |

### CLS Decision and Guardrail Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| CLS-020 | valid strict JSON LLM output is accepted | `classifier/tests/test_strict_json.py::test_validate_classifier_result_happy_path`; `classifier/tests/test_board_sessions.py` LLM-path tests | Covered |
| CLS-021 | malformed LLM output triggers deterministic repair pass | `classifier/tests/test_classifier_failure_paths.py::test_cls_021_call_classifier_repairs_malformed_output_once` | Covered |
| CLS-022 | LLM timeout/error falls back to heuristic classification | `classifier/tests/test_classifier_failure_paths.py::test_cls_022_llm_timeout_falls_back_to_heuristic_classifier` | Covered |
| CLS-023 | forced-topic fallback stays pinned when LLM fails | `classifier/tests/test_classifier_failure_paths.py::test_cls_023_forced_topic_stays_pinned_when_llm_times_out` | Covered |
| CLS-024 | clear topical intent can create/reuse non-generic topic correctly | `classifier/tests/test_classifier_heuristics.py::test_topical_conversation_no_tasks_allows_topic_creation`; `scripts/classifier_e2e_check.py` `topical-no-tasks` | Covered |
| CLS-025 | anti-dup guardrail reuses strong lexical candidate over weak create | `classifier/tests/test_classifier_failure_paths.py::test_cls_025_guardrail_reuses_strong_candidate_over_new_topic` | Covered |
| CLS-026 | creation gate block suppresses create or reuses existing id | `classifier/tests/test_classifier_failure_paths.py::test_cls_026_creation_gate_block_reuses_existing_topic_id` | Covered |
| CLS-027 | task id from foreign topic is rejected | `classifier/tests/test_summary_repair.py::test_task_guardrail_ignores_task_id_from_other_topic` | Covered |
| CLS-028 | no task intent -> task cleared/null | `classifier/tests/test_classifier_heuristics.py::test_small_talk_has_no_task_intent`; `scripts/classifier_e2e_check.py` `small-talk` | Covered |
| CLS-029 | task intent with low confidence uses continuity/controlled create | `classifier/tests/test_classifier_additional_coverage.py::test_cls_029_task_intent_low_confidence_reuses_continuity_task` | Covered |
| CLS-030 | missing summaries repaired, then concise fallback if needed | `classifier/tests/test_summary_repair.py::test_classify_session_repairs_missing_summaries` | Covered |
| CLS-031 | unrecoverable path increments attempts and progresses terminally | `classifier/tests/test_classifier_failure_paths.py::test_cls_031_unrecoverable_path_marks_terminal_failure` | Covered |
| CLS-032 | continuity decisions are appended to session routing memory | `classifier/tests/test_classifier_additional_coverage.py::test_cls_032_classification_appends_session_routing_memory` | Covered |

### FIL Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| FIL-001 | command conversation -> `classified` + `filtered_command` | `classifier/tests/test_board_sessions.py::test_unlocked_command_logs_do_not_inherit_topic_scope`; `scripts/classifier_e2e_check.py` `filtering-mixed` | Covered |
| FIL-002 | system/import row -> `classified` + `filtered_non_semantic` | `scripts/classifier_e2e_check.py` scenarios `filtering-mixed`, `board-task-fixed-scope` | Covered |
| FIL-003 | memory action row -> `classified` + `filtered_memory_action` | `scripts/classifier_e2e_check.py` scenarios `filtering-mixed`, `board-task-fixed-scope` | Covered |
| FIL-004 | cron row -> `failed` + `filtered_cron_event` detached | `classifier/tests/test_cron_event_filtering.py`; `backend/tests/test_append_log_entry.py::test_append_log_filters_cron_event_logs` | Covered |
| FIL-005 | classifier payload artifact -> `failed` + `classifier_payload_noise` | `classifier/tests/test_classifier_failure_paths.py::test_fil_005_and_fil_006_noise_error_code_specific_branches` | Covered |
| FIL-006 | context injection artifact -> `failed` + `context_injection_noise` | `classifier/tests/test_classifier_failure_paths.py::test_fil_005_and_fil_006_noise_error_code_specific_branches` | Covered |
| FIL-007 | other conversation noise -> `failed` + `conversation_noise` | `classifier/tests/test_classifier_failure_paths.py::test_fil_007_noise_error_code_defaults_to_conversation_noise` | Covered |
| FIL-008 | fallback semantic route -> `classified` + `fallback:<reason>` | `classifier/tests/test_classifier_failure_paths.py::test_fil_008_fallback_route_sets_fallback_error_code` | Covered |
| FIL-009 | heartbeat/control-plane conversation -> `failed` + detached | `classifier/tests/test_control_plane_and_tool_filtering.py::test_classify_session_filters_main_session_heartbeat_control_plane_conversation` | Covered |
| FIL-010 | subagent scaffold conversation -> `failed` + detached | `classifier/tests/test_control_plane_and_tool_filtering.py::test_classify_session_filters_subagent_scaffold_conversation` | Covered |
| FIL-011 | tool trace action -> anchored classified, unanchored failed | `classifier/tests/test_control_plane_and_tool_filtering.py::test_classify_session_marks_scoped_tool_action_filtered_in_forced_task_scope`; `classifier/tests/test_control_plane_and_tool_filtering.py::test_classify_session_marks_unanchored_tool_action_as_terminal_failed`; assertion expects `classificationError=filtered_tool_activity` for the anchored path | Covered |

### SRCH and Context Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| SRCH-001 | `/api/context` auto + low-signal query skips semantic unless board-scoped | `backend/tests/test_context_endpoint.py::test_context_auto_low_signal_skips_semantic_layer`; `backend/tests/test_context_endpoint.py::test_context_auto_low_signal_board_session_runs_semantic_layer` | Covered |
| SRCH-002 | `/api/context` full/patient force semantic layer | `backend/tests/test_context_endpoint.py::test_context_full_includes_semantic`; `backend/tests/test_context_endpoint.py::test_context_patient_includes_semantic` | Covered |
| SRCH-003 | board-session context surfaces active board scope first and filters routing memory by allowed spaces | `backend/tests/test_context_endpoint.py::test_context_board_session_surfaces_active_task`; `backend/tests/test_context_endpoint.py::test_context_filters_routing_memory_by_allowed_spaces` | Covered |
| SRCH-004 | `/api/search` gate saturation returns degraded busy fallback | `backend/tests/test_search_endpoint.py::test_search_busy_falls_back_to_degraded_mode`; `backend/tests/test_search_endpoint.py::test_search_uses_degraded_fallback_when_gate_is_busy` | Covered |
| SRCH-005 | degraded fallback disables deep scans and tightens limits | `backend/tests/test_search_endpoint.py::test_search_busy_falls_back_to_degraded_mode` | Covered |
| SRCH-006 | default semantic filters exclude command/tool/non-semantic noise | `backend/tests/test_vector_search.py::test_semantic_search_excludes_slash_command_logs`; `backend/tests/test_vector_search.py::test_semantic_search_excludes_tool_call_logs_by_default`; `backend/tests/test_vector_search.py::test_semantic_search_excludes_system_and_import_logs_by_default`; `backend/tests/test_vector_search.py::test_semantic_search_excludes_memory_action_logs_by_default` | Covered |
| SRCH-007 | parent propagation boosts topic/task scores from matched children | `backend/tests/test_search_endpoint.py::test_search_caps_log_propagation_for_topics`; `backend/tests/test_search_endpoint.py::test_search_uses_task_signal_to_lift_parent_topic` | Covered |
| SRCH-008 | linked notes are emitted and weighted in retrieval output | `backend/tests/test_search_endpoint.py::test_search_linked_notes_are_emitted_and_weight_scores` | Covered |
| SRCH-009 | SSE drop/stall recovers with reconnect + `/api/changes` reconciliation | `backend/tests/test_stream_replay.py::test_reconnect_plus_changes_reconcile_recovers_topic_updates`; `backend/tests/test_stream_replay.py::test_reconnect_replays_only_new_events_after_cursor`; `tests/e2e/sse.spec.ts` | Covered |
| SRCH-010 | stale replay cursor emits `stream.reset` | `backend/tests/test_stream_replay.py::test_stale_cursor_returns_stream_reset` | Covered |
| SRCH-011 | unified default view hides non-classified rows | `tests/e2e/classification.spec.ts` (pending row invisible until classified) | Covered |
| SRCH-012 | `?raw=1` shows pending/failed/non-semantic logs in unified view | `tests/e2e/classification.spec.ts` `raw=1 shows pending logs that default unified view hides` | Covered |

### CHAT Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| CHAT-001 | board chat persists user log before/with gateway dispatch | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_001_persists_user_log_before_background_dispatch` | Covered |
| CHAT-002 | attachment upload/validation + binding into chat payload | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_002_attachment_payload_is_bound_into_gateway_call`; `backend/tests/test_attachments.py::test_upload_and_download_roundtrip` | Covered |
| CHAT-003 | gateway in-flight publishes `openclaw.typing=true` | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_003_run_openclaw_chat_emits_typing_start_without_forced_stop_on_success` | Covered |
| CHAT-004 | failures publish `openclaw.typing=false`; successful sends clear on terminal ingest | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_004_gateway_failure_still_emits_typing_false`; `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_020_assistant_append_publishes_typing_false` | Covered |
| CHAT-005 | assistant logs arriving in grace window => watchdog no-op | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_005_watchdog_noop_when_assistant_log_arrives` | Covered |
| CHAT-006 | missing assistant logs => watchdog warning log appended | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_006_watchdog_logs_when_assistant_is_missing` | Covered |
| CHAT-007 | user-log persist failure fail-closes (no dispatch) | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_007_openclaw_chat_fail_closes_when_persist_fails` | Covered |
| CHAT-008 | gateway/attachment read failure persists system error log | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_008_missing_attachment_persists_error_and_skips_gateway` | Covered |

### Required Work to Reach Full Coverage

No remaining gaps. All scenario IDs in section 14 are now backed by deterministic automated assertions.

## 17) Scenario Trace Matrix (Merged)

This section is merged from the former `CLASSIFICATION_TRACE_MATRIX.md`.


This artifact audits trace-level coverage of every scenario ID in `CLASSIFICATION.md` section 14.

Trace-level coverage means each scenario maps to existing implementation files (path-level trace), not necessarily full behavioral test assertions.

### Summary

- Scenarios traced: `84/84` (`100.0%`)
- Source of truth: `CLASSIFICATION.md` section 14
- Auditor: `scripts/classification_trace_audit.py`

### Family Summary

| Family | Traced | Total |
|---|---:|---:|
| ING | 24 | 24 |
| CLS | 29 | 29 |
| FIL | 11 | 11 |
| SRCH | 12 | 12 |
| CHAT | 8 | 8 |

### Scenario Trace Table

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
| ING-021 | main-session heartbeat/control-plane conversation ingested | `backend/app/main.py` | Traced | OK |
| ING-022 | subagent scaffold conversation ingested | `backend/app/main.py` | Traced | OK |
| ING-023 | scoped tool trace action row ingested | `backend/app/main.py` | Traced | OK |
| ING-024 | unanchored tool trace action row ingested | `backend/app/main.py` | Traced | OK |
| CLS-001 | no pending conversations in session | `classifier/classifier.py` | Traced | OK |
| CLS-002 | pending rows include cron events | `classifier/classifier.py` | Traced | OK |
| CLS-003 | oldest pending conversation anchor | `classifier/classifier.py` | Traced | OK |
| CLS-004 | anchor is assistant | `classifier/classifier.py` | Traced | OK |
| CLS-005 | anchor user turn is affirmation | `classifier/classifier.py` | Traced | OK |
| CLS-006 | assistant responded and user starts new intent | `classifier/classifier.py` | Traced | OK |
| CLS-007 | interleaved actions/system rows between turns | `classifier/classifier.py` | Traced | OK |
| CLS-008 | task-scoped board session | `classifier/classifier.py` | Traced | OK |
| CLS-009 | topic-scoped board session | `classifier/classifier.py` | Traced | OK |
| CLS-010 | subagent session with explicit board lineage | `extensions/clawboard-logger/index.ts`; `classifier/classifier.py` | Traced | OK |
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
| FIL-009 | heartbeat/control-plane conversation ingested | `backend/app/main.py` | Traced | OK |
| FIL-010 | subagent scaffold conversation ingested | `backend/app/main.py` | Traced | OK |
| FIL-011 | tool trace action (anchored/unanchored) | `classifier/classifier.py`; `backend/app/main.py` | Traced | OK |
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
