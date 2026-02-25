# Clawboard Anatomy

This document is a full implementation map of how Clawboard works today: user-facing behavior, backend internals, classifier routing, retrieval, visibility scope, and realtime synchronization.

It is intended to be read with code open.

## Question

How does Clawboard work end-to-end, including every major user path, every scope/visibility rule, and the exact code paths between UI actions, APIs, classifiers, retrieval, and realtime updates?

## End-State Spec

- One canonical map from user intent -> UI -> API -> backend engine -> persistence -> realtime update.
- One canonical scope model for spaces/tags/visibility that matches runtime behavior exactly.
- One canonical retrieval model covering `/api/search`, `/api/context`, and graph extraction under the same scope guardrails.
- One canonical classification model covering ingest, scheduling, forcing, guardrails, and patch semantics.
- One canonical reliability model covering retries, fallback/degraded paths, and reconciliation.
- Full traceability from each project markdown spec to live implementation files and tests.

## Acceptance Criteria

Functional:
- Every high-impact user feature (board chat, topic/task lifecycle, search, context injection, graph, settings) is mapped to concrete frontend and backend code paths.
- Space visibility semantics explicitly document that runtime access uses explicit connectivity edges only, while `defaultVisible` is seed policy.
- Topic/task/log scope behavior and invariants are explicit and testable.
- Search/context/graph scoping is shown as one coherent contract.

Coverage:
- Every top-level API route in `backend/app/main.py` is cataloged by behavior family.
- Every root-level markdown spec is mapped to runtime code ownership.
- Degraded/error branches are cataloged, not just happy paths.

Quality:
- Unknowns are flagged explicitly.
- Blockers are listed explicitly; if none, that is stated.

Primary source files:
- `backend/app/main.py`
- `backend/app/db.py`
- `backend/app/models.py`
- `backend/app/schemas.py`
- `backend/app/vector_search.py`
- `backend/app/clawgraph.py`
- `backend/app/events.py`
- `backend/app/openclaw_gateway.py`
- `classifier/classifier.py`
- `extensions/clawboard-logger/index.ts`
- `src/components/unified-view.tsx`
- `src/components/app-shell.tsx`
- `src/components/clawgraph-live.tsx`
- `src/components/data-provider.tsx`
- `src/lib/use-live-updates.ts`
- `src/lib/use-semantic-search.ts`
- `src/lib/space-visibility.ts`
- `src/components/settings-live.tsx`

Related specs:
- `README.md`
- `CONTEXT.md`
- `CONTEXT.md` (Context Contract Spec section)
- `CLASSIFICATION.md`
- `CLASSIFICATION.md` (sections 16-17: coverage/trace matrices)
- `OPENCLAW_CLAWBOARD_UML.md`
- `TESTING.md`
- `SEED.md`
- `DESIGN_RULES.md`
- `HUMAN_INSTRUCTIONS.md`
- `design/brand-notes.md`
- `design/operator-runbook.md`
- `design/visual-end-state-spec.md`
- `research/RETENTION_AND_REDACTION_POLICY.md`
- `skills/clawboard/SKILL.md`
- `skills/clawboard/references/clawboard-api.md`
- `skills/clawboard/references/openclaw-hooks.md`
- `skills/clawboard/references/openclaw-memory-local.md`
- `skills/clawboard/references/routing-rules.md`
- `classifier/tests/fixtures/README.md`

## Inferred Defaults

- FastAPI backend (`backend/app/main.py`) is the canonical runtime authority for lifecycle, scope, search, context, and graph.
- Next.js UI is the canonical operator surface and consumes backend APIs directly.
- Classifier and logger plugin are always-on in normal operation.
- Postgres is the default runtime store (`CLAWBOARD_DB_URL`); SQLite remains supported for local/legacy flows with runtime migration/index guards.
- Qdrant is the primary dense-vector backend in production; lexical/BM25 paths continue to operate when dense retrieval is disabled or unavailable.

## Unknowns and Blockers

Unknowns (non-blocking):
- Frontend visual language details in design notes are normative for UX quality, but not all are runtime-enforced by tests.
- Historical local environment drift may affect exact latency profiles; behavior contracts remain stable.

Blockers:
- None. This document proceeds from implementation and tests currently present in-repo.

## 1) Product Purpose

Clawboard is a durable memory and routing layer that sits beside OpenClaw.

OpenClaw runs agents.
Clawboard stores everything useful, organizes it into Topics and Tasks, retrieves it intelligently, and feeds that context back into future turns.

Core value:
- Continuity across long-running work.
- Structured recall instead of raw chat-only memory.
- Visibility-safe retrieval using Space relationships.

## 2) One-Screen Mental Model

- `Topic` = project lane.
- `Task` = executable unit inside a topic.
- `LogEntry` = conversations, actions, notes, system/import rows.
- `SessionRoutingMemory` = short continuity memory keyed by `source.sessionKey`.
- `Space` = scope domain with explicit visibility graph.

Everything interesting is a loop:
1. Capture logs.
2. Classify pending logs to topic/task.
3. Reindex searchable memory.
4. Retrieve via `/api/search` and `/api/context`.
5. Inject context into next OpenClaw turn.
6. Capture new logs and repeat.

## 3) System Topology (Runtime Surfaces)

- OpenClaw runtime emits hook events.
- `extensions/clawboard-logger` sanitizes and posts logs.
- FastAPI (`backend/app/main.py`) is canonical API/state engine.
- SQLModel database (`backend/app/models.py`) is source of truth.
- Classifier worker (`classifier/classifier.py`) classifies async.
- Hybrid retrieval runtime (`backend/app/vector_search.py`) powers semantic + lexical ranking.
- Graph builder (`backend/app/clawgraph.py`) builds relationship graph from scoped data.
- Event hub + SSE (`backend/app/events.py` + `/api/stream`) pushes live updates.
- Next frontend consumes API, SSE, and local derived state.

Important deployment nuance:
- Frontend can use direct backend base URL via `src/lib/api.ts`.
- Some legacy/compat Next API routes exist under `src/app/api/*`, but canonical lifecycle/search/context/graph flows are centered in FastAPI.

## 4) Canonical Data Model and Invariants

Reference: `backend/app/models.py`, `backend/app/schemas.py`.

Primary tables:
- `Space`
- `Topic`
- `Task`
- `LogEntry`
- `DeletedLog`
- `SessionRoutingMemory`
- `IngestQueue`
- `Attachment`
- `Draft`
- `InstanceConfig`

Hard relationship rules enforced in runtime:
- A task must belong to its topic when both are set.
- A log with task assignment is normalized to that task’s topic and space.
- Conversation activity can unsnooze archived/snoozed topic/task.
- Classifier patches only scope windows, not whole sessions.
- Board task sessions are hard-locked to selected topic+task.

### 4.1 Absolute Allocation Guardrails (Normative)

Aligned with `CLASSIFICATION.md` section 4.1 and `CONTEXT.md` allocation guardrails.

- Topic/Task allocation is allowed only for logs with direct user-request lineage.
- Task chat keys (`clawboard:task:<topicId>:<taskId>`) are hard-pinned and never rerouted.
- Topic chat keys (`clawboard:topic:<topicId>`) are topic-pinned; task inference/creation is allowed only within that same topic.
- Subagent scope inheritance is allowed only via explicit lineage:
  - explicit `source.boardScope*` metadata, or
  - explicit `sessions_spawn` child-session linkage cached by exact child session key.
- Cross-agent/global "latest scope" fallback is forbidden.
- Background/control-plane activity (cron, backups, maintenance, unanchored tool churn) must never be allocated to user Topic/Task chats.
- If lineage is not provable, logs must stay detached and/or terminal-filtered.

## 5) Spaces, Tags, and Visibility Scope

Core files:
- `backend/app/main.py` (`_allowed_space_ids_for_source`, `_resolve_allowed_space_ids`, `_topic_matches_allowed_spaces`, `_task_matches_allowed_spaces`, `_log_matches_allowed_spaces`)
- `backend/app/db.py` (migration/seed behavior)
- `src/lib/space-visibility.ts`
- `src/components/settings-live.tsx`

### 5.1 Runtime visibility truth

Runtime visibility is explicit connectivity edges:
- Viewer space includes itself.
- Viewer can see target only if `viewer.connectivity[target] == true`.
- No implicit runtime fallback for missing edge.

### 5.2 `defaultVisible` semantics

`defaultVisible` is seed policy only:
- Used when new spaces are introduced and missing edges are initialized.
- Does not retroactively override existing explicit connectivity edges.

This is enforced in both backend migration/seed and frontend resolution logic.

### 5.3 Topic/Task/Log membership under scope

Topic membership = union of:
- `topic.spaceId`
- tag-derived spaces from `topic.tags` (non-`system:` tags, `space:<label>` accepted).

Task visible when:
- `task.spaceId` is allowed, or parent topic is allowed.

Log visible when:
- `log.spaceId` is allowed, or linked task/topic resolves into allowed spaces.

## 6) End-to-End Lifecycle Flows

### 6.1 OpenClaw ingest flow (off-board channels)

Primary code:
- `extensions/clawboard-logger/index.ts`
- `backend/app/main.py::append_log_entry`

Flow:
1. Hook fires (`message_received`, `message_sending`, `before_tool_call`, `after_tool_call`, `agent_end`).
2. Plugin sanitizes content:
   - strips injected context blocks
   - strips control/classifier artifacts
   - strips transport noise.
3. Plugin resolves effective `sessionKey` and routing scope from explicit board keys/metadata plus explicit spawned-child linkage (no global recency fallback).
4. Plugin sends `POST /api/log` (or `/api/ingest` queue mode), with stable idempotency key.
5. API dedupes and normalizes scope metadata (`boardScope*`), enforces topic/task/space consistency, and terminal-filters control-plane/tool noise:
   - `filtered_cron_event`
   - `filtered_control_plane`
   - `filtered_subagent_scaffold`
   - `filtered_tool_activity`
   - `filtered_unanchored_tool_activity`
   - assistant identifier dedupe only collapses rows when normalized assistant payloads match across all identifier candidates (prevents subagent/main cross-match collisions).
6. API emits `log.appended` SSE.
7. Classifier later processes pending conversation rows.

Reliability:
- plugin retry window + durable local sqlite queue.
- backend write retry for transient sqlite lock contention.
- gateway history ingest skips injected context wrapper artifacts and still advances cursor, preventing replay loops of non-user-visible control text.

### 6.2 Board chat flow (Clawboard UI -> OpenClaw)

Primary code:
- `src/components/unified-view.tsx` (composer state + local pending UI)
- `backend/app/main.py::openclaw_chat`
- `backend/app/openclaw_gateway.py`

Flow:
1. User sends board chat message in topic/task pane.
2. Optional upload through `/api/attachments`.
3. `/api/openclaw/chat` persists user log first (fail-closed).
4. API enqueues durable dispatch work in `OpenClawChatDispatchQueue` and worker threads execute gateway `chat.send`.
5. API emits typing lifecycle events (`openclaw.typing` true/false).
6. Worker retry/backoff, stale-processing recovery, and optional auto-quarantine keep queue forward-progress under failures/restarts.
7. Optional in-flight probe logic (`OPENCLAW_CHAT_IN_FLIGHT_*`) can abort/retry long-stalled sends.
8. OpenClaw logger plugin returns assistant/tool rows through normal ingest path.
9. Watchdog and history-sync backfill paths log warnings/recover when assistant output is delayed/missing.
10. Stop/cancel path (`/api/openclaw/chat/cancel`) attempts gateway `chat.abort` and marks queue rows cancelled for the request chain.
11. Orchestration convergence keeps `main.response` open while any subagent item is non-terminal; run closes only after final main assistant completion.

Key invariant:
- User prompt is persisted before gateway dispatch so thread history remains coherent.

### 6.3 Classifier routing flow

Primary code:
- `classifier/classifier.py::main`, `_classify_session_scoped`, `classify_session`

Flow:
1. Poll pending conversations.
2. Group by session.
3. Prioritize session keys (channel-first + freshness + backlog).
4. Build one coherent bundle.
5. Apply forcing:
   - `clawboard:task:*` hard lock.
   - `clawboard:topic:*` topic lock with optional task inference.
6. Retrieve candidates (topic/task + context + optional memory hits).
7. Classify via LLM strict JSON path or heuristic fallback.
8. Run creation/task guardrails.
9. Repair/fallback summaries.
10. Patch scope rows (`PATCH /api/log/{id}`) with filter codes where needed.
11. Append routing memory (`POST /api/classifier/session-routing`).

Safety filters:
- cron events
- heartbeat/control-plane conversations
- subagent scaffold envelopes
- slash commands
- classifier payload artifacts
- context-injection artifacts
- tool-trace actions (`Tool call/result/error`) with anchored/unanchored terminalization
- system/import/memory-action rows.

### 6.4 Search flow (`/api/search`)

Primary code:
- `backend/app/main.py::search`, `_search_impl`
- `backend/app/vector_search.py::semantic_search`
- `src/lib/use-semantic-search.ts`

Pipeline:
1. Resolve source space and effective allowed spaces.
2. Build bounded windows (topics/tasks/logs).
3. Run full-history lexical rescue for query terms and merge older matching logs into the candidate set (visibility-scoped, capped).
4. Build log content previews/snippets without full raw scans.
5. Expand semantic query for low-signal board-scoped prompts when useful.
6. Run hybrid rank:
   - dense vectors (qdrant backend when enabled/available)
   - BM25
   - lexical
   - phrase
   - RRF
   - late chunk rerank.
7. Apply propagation boosts:
   - log -> task/topic
   - task -> topic
   - direct label boosts
   - note linkage weights
   - session continuity boosts.
8. Return ranked `topics`, `tasks`, `logs`, `notes` and `searchMeta`.

Load safety:
- concurrency gate with degraded busy fallback.
- bounded limits and deep-scan disable in degraded mode.

### 6.5 Context injection flow (`/api/context`)

Primary code:
- `backend/app/main.py::context`
- logger plugin `before_agent_start` in `extensions/clawboard-logger/index.ts`

Layer A always-on:
- board session location
- working set
- routing memory
- session timeline.

Layer B conditional:
- semantic recall by calling `_search_impl` (which uses vector backend through `semantic_search`).

Modes:
- `auto`
- `cheap`
- `full`
- `patient`.

Injection path:
1. Plugin finds latest user input.
2. Calls `/api/context`.
3. Receives prompt-ready `block`.
4. Prepends block between `[CLAWBOARD_CONTEXT_BEGIN]` and `[CLAWBOARD_CONTEXT_END]`.
5. Later ingest sanitization strips these markers to prevent feedback-loop pollution.

### 6.6 Graph flow (`/api/clawgraph` and Graph page)

Primary code:
- `backend/app/main.py::clawgraph`, `_build_clawgraph_payload`
- `backend/app/clawgraph.py::build_clawgraph`
- `src/components/clawgraph-live.tsx`

Flow:
1. Frontend resolves selected space + allowed spaces.
2. Calls `/api/clawgraph` with scope params.
3. Backend filters scoped topics/tasks/logs before graph extraction.
4. Graph builder creates:
   - structural topic/task nodes
   - entity/agent nodes
   - edges: `has_task`, `mentions`, `co_occurs`, `related_topic`, `related_task`, `agent_focus`.
5. Graph query runs scoped semantic search (`/api/search` with same space guardrails).
6. Frontend regenerates a query-rooted subgraph from semantic+lexical roots (bounded BFS neighborhood, capped nodes/edges).
7. Frontend applies edge-threshold slider (default `90`).
8. Graph refreshes on visibility and data revision changes.

### 6.7 Realtime sync flow (SSE + reconcile)

Primary code:
- `backend/app/events.py`
- `backend/app/main.py::/api/stream`, `/api/changes`
- `src/lib/use-live-updates.ts`
- `src/components/data-provider.tsx`

Behavior:
- SSE stream emits live event payloads with event IDs.
- Client tracks last event ID and reconnects with replay.
- If replay window missed, server emits `stream.reset`.
- Client then reconciles via `/api/changes`.
- Watchdog + fallback polling prevents stale UI under broken sockets.

### 6.8 Main-Agent Supervisor Rails (Templates + Directives)

Deployed via bootstrap (`agent-templates/main/*` + `directives/main/GENERAL_CONTRACTOR.md`):
- **Main-only direct lane**: trivial asks that are faster than delegation.
- **Single-specialist lane (default)**: one domain owner via `sessions_spawn`.
- **Multi-specialist lane (huddle/federated)**: multiple delegated workstreams, then one synthesized final response.

Operational guarantees:
- Delegation ladder cadence remains fixed: `1m -> 3m -> 10m -> 15m -> 30m -> 1h`.
- Progress updates are required once elapsed delegated runtime exceeds 5 minutes.
- Bootstrap verifies lane/lifecycle markers after deployment so fresh installs get aligned rails.

## 7) Frontend User Journey (Board-Centric)

### 7.1 App bootstrap

- `DataProvider` performs initial reconcile (`/api/changes`).
- UI hydrates spaces/topics/tasks/logs/drafts.
- Live SSE connection starts.

### 7.2 Space selection and scoped board

- Space selected from nav dropdown.
- Allowed spaces recomputed from explicit connectivity.
- Topics/tasks/logs are filtered in-memory by allowed space set.
- Semantic search refresh keys include `spaceVisibilityRevision`.

### 7.3 Topic and task operations

- Create/edit/reorder topic/task via `/api/topics*` and `/api/tasks*`.
- Backend enforces parent/scope consistency and reindex queue updates.
- SSE upserts update UI immediately.

### 7.4 Messaging in topic/task chats

- User sends via board composer.
- Pending local message state appears immediately.
- Backend persistence + SSE reconcile clears pending and shows canonical rows.

### 7.5 Search and recall

- Search box uses `useSemanticSearch` with debounce and retry on 429.
- Fallback lexical matching still used where semantic misses.
- Active chat panes preserve lexical fallback so fresh pending rows are visible.

### 7.6 Graph exploration

- Graph view uses scoped remote graph by default, local fallback if needed.
- Node highlighting can combine semantic query matches and graph label matches.

### 7.7 Settings-driven scope changes

- Connectivity toggles and default seed policy are updated in Settings.
- Changes emit space upsert events.
- Unified view/search/graph recompute scope via visibility revision keys.

## 8) Path Crosswalk (UI -> API -> Core Engine)

| User Action | Frontend Entry | API Route | Core Backend Logic | Side Effects |
|---|---|---|---|---|
| Open app | `src/components/data-provider.tsx` | `GET /api/changes` | `_build_changes_payload` | Hydrates full store |
| Realtime updates | `src/lib/use-live-updates.ts` | `GET /api/stream` | `EventHub` replay/reset/ping | Live upserts/deletes |
| Reconcile after missed stream window | `src/lib/use-live-updates.ts` | `GET /api/changes?since=...` | change cursor merge | Repairs stale local state |
| Health check | Ops probe | `GET /api/health` | lightweight health path | liveness gate |
| Read instance config | settings bootstrap | `GET /api/config` | instance + auth mode resolution | informs setup state |
| Update instance config | settings save | `POST /api/config` | token-gated config patch | emits config update |
| List spaces | nav/settings | `GET /api/spaces` | `_list_spaces` + default ensure | deterministic space list |
| Create/update space | settings/setup | `POST /api/spaces` | `upsert_space` + connectivity seeding | `space.upserted` SSE |
| Change space visibility | `src/components/settings-live.tsx` | `PATCH /api/spaces/{id}/connectivity` | explicit connectivity patch | scope changes propagate |
| Resolve effective allowed spaces | board/search/graph scope | `GET /api/spaces/allowed` | `_allowed_space_ids_for_source` | scoped allowed-space set |
| Cleanup removed space tag | settings maintenance | `POST /api/spaces/{id}/cleanup-tag` | tag scrub + re-home topics | scope normalization |
| List topics | board panel | `GET /api/topics` | scope/status filtering + ordering | board columns load |
| Update topic | topic editor | `PATCH /api/topics/{id}` | partial patch + normalization | `topic.upserted` SSE |
| Reorder topics | drag-and-drop | `POST /api/topics/reorder` | sequential `sortIndex` persistence | deterministic ordering |
| Create topic | `src/components/unified-view.tsx` | `POST /api/topics` | tag->space derivation + dedupe + reindex queue | `topic.upserted` SSE |
| Delete topic | topic controls | `DELETE /api/topics/{id}` | detach dependents + delete | topic removed, logs retained |
| List tasks | board panel | `GET /api/tasks` | topic/scope/status filters | lane cards load |
| Update task | task editor | `PATCH /api/tasks/{id}` | partial patch + topic-space normalization | `task.upserted` SSE |
| Reorder tasks | drag-and-drop | `POST /api/tasks/reorder` | sequential `sortIndex` in topic | deterministic ordering |
| Create task | `src/components/unified-view.tsx` | `POST /api/tasks` | topic/space consistency + dedupe + reindex | `task.upserted` SSE |
| Delete task | task controls | `DELETE /api/tasks/{id}` | detach dependent logs + delete | card removed, logs retained |
| List logs | board timeline/search context | `GET /api/log` | bounded log query + filters | timeline data |
| Read one log | log detail surfaces | `GET /api/log/{id}` | row fetch + scope-safe serialization | detail payload |
| Append log directly | plugin/internal tools | `POST /api/log` | `append_log_entry` + idempotency + normalize | `log.appended` SSE |
| Queue ingest row | plugin queue mode | `POST /api/ingest` | enqueue for async ingest drain | eventual append |
| Patch log/classification | classifier/manual ops | `PATCH /api/log/{id}` | guarded patch + retry + sanitize | `log.upserted` SSE |
| Delete one log | moderation/manual cleanup | `DELETE /api/log/{id}` | delete + note cleanup | `log.deleted` SSE |
| Send board chat | composer in `src/components/unified-view.tsx` | `POST /api/openclaw/chat` | persist-first + gateway dispatch + typing events | queued response + SSE |
| Discover OpenClaw skills | board/composer helper | `GET /api/openclaw/skills` | gateway capability passthrough | skill metadata |
| Attachment validation | composer preflight | `GET /api/attachments/policy` | policy payload | client-side guardrails |
| Upload files | composer attachments | `POST /api/attachments` | mime/size validation + storage + metadata | attachment IDs for chat |
| Download attachment | attachment viewer | `GET /api/attachments/{id}` | guarded blob retrieval | file stream |
| Save draft | composer autosave | `POST /api/drafts` | upsert short-lived draft row | cross-refresh draft continuity |
| Run semantic board search | `src/lib/use-semantic-search.ts` | `GET /api/search` | `_search_impl` + `semantic_search` | ranked topics/tasks/logs |
| Build context for model | logger `before_agent_start` | `GET /api/context` | Layer A + optional Layer B | prompt block returned |
| See graph | `src/components/clawgraph-live.tsx` | `GET /api/clawgraph` | scoped graph extraction | rendered graph nodes/edges |
| View classifier queue | ops/debug | `GET /api/classifier/pending` | pending-row query | queue observability |
| Read routing memory | ops/debug | `GET /api/classifier/session-routing` | session memory fetch | continuity visibility |
| Write routing memory | classifier | `POST /api/classifier/session-routing` | session memory append/upsert | improves follow-up routing |
| Trigger classifier replay | UI/ops path | `POST /api/classifier/replay` | mark bundle pending from anchor | logs repatched next cycles |
| Trigger targeted reindex | ops/debug | `POST /api/reindex` | enqueue embedding refresh | search freshness |
| Purge topic chat | UI controls | `POST /api/topics/{id}/topic_chat/purge` | irreversible delete + tombstones | delete events |
| Purge log thread forward | UI controls | `POST /api/log/{id}/purge_forward` | session-scope destructive purge | delete events |
| Fresh rebuild | admin controls | `POST /api/admin/start-fresh-replay` | wipe derived topic/task + mark logs pending | classifier re-derives |
| Operational telemetry | dashboards/ops | `GET /api/metrics` | metrics snapshot | lag/queue observability |

## 9) Hidden Plumbing ("Code Between the Code")

These are not top-level features, but they are why the system stays robust:

- Idempotency stack in ingest:
  - header key
  - payload key
  - source message/request fallback.
- Scope metadata normalization:
  - board scope fields are canonicalized at ingest.
- Retry/backoff for sqlite lock contention:
  - append/patch/update paths use bounded retry loops.
- Precompile caches:
  - `/api/clawgraph`, `/api/changes`, `/api/metrics` use revision-keyed short caches.
- SSE resilience:
  - bounded event ring buffer
  - per-subscriber queue bounds
  - replay by event id
  - stream reset when cursor too old.
- Search safety:
  - bounded content preview scans
  - concurrency gate with degraded fallback.
- Classifier strictness:
  - strict JSON validator + deterministic repair pass
  - heuristic fallback paths prevent stuck pending rows.

## 10) Performance and Scalability Patterns

Backend:
- Postgres connection-pool tuning + runtime indexes in `backend/app/db.py`.
- SQLite WAL/timeout/null-pool safeguards are kept for local/legacy sqlite deployments.
- deferred large fields (`raw`, large content) in heavy endpoints.
- bounded windows and chunked query patterns.
- qdrant-backed dense retrieval plus sparse fallback paths.

Classifier:
- session fairness and cycle budget enforcement.
- bundle-level classification instead of whole-session rewrites.
- lower-priority digest maintenance only when budget remains.

Frontend:
- debounced semantic search.
- visibility-revision keyed recalculation.
- SSE + reconcile watchdog to prevent stale state.

OpenClaw bridge dynamics:
- durable dispatch queue workers with retry/backoff and stale-row recovery.
- assistant-log watchdog + history-sync fallback for delayed/missing assistant rows.
- request-chain cancel semantics fan out to linked sessions where available.

## 11) Data Age, Size, and Recall Limits

Important distinction:
- There is no hard coded "topic/task age cap" that prevents accessing old rows.
- Old data remains queryable if it exists in storage.
- `/api/search` uses bounded recent windows for hot-path performance, plus gated full-history lexical rescue (PostgreSQL tsvector/GIN when available, with SQL expression kept index-aligned; bounded fallback otherwise) so older matching logs still enter ranking.

What is bounded:
- endpoint response windows (`/api/log` limit/offset, `/api/search` bounded scan limits, `/api/context` max chars and limits).
- expensive retrieval depths for performance.

Retention policy:
- see `research/RETENTION_AND_REDACTION_POLICY.md` for operational retention/cleanup guidance.

## 12) Testing and Coverage Posture

High-level test suites:
- backend unit/integration: `backend/tests/*`
- classifier unit/integration: `classifier/tests/*`
- logger plugin tests: `extensions/clawboard-logger/*.test.mjs`
- e2e Playwright: `tests/e2e/*`

Classification and routing traceability:
- `CLASSIFICATION.md` section 16: scenario-level behavioral assertions (`77/77 covered`).
- `CLASSIFICATION.md` section 17: implementation-path trace coverage (`77/77 traced`).

Core commands:
- `npm run test:backend`
- `npm run test:classifier`
- `npm run test:e2e`
- `npm run test:all`

## 13) Design Contracts and Non-Goals

Contracts:
- Visibility safety when source space is resolved.
- Board session routing determinism (`clawboard:topic:*`, `clawboard:task:*:*`).
- Retrieval pollution defenses (sanitize + classifier noise filters).
- Async eventual consistency via SSE + reconcile.
- Delegated-run supervision cadence is deterministic in bootstrap-installed main-agent policy: `1m -> 3m -> 10m -> 15m -> 30m -> 1h` (cap `1h`), with explicit user status updates after `>5m`.

Non-goals:
- Unbounded prompt stuffing.
- Replacing OpenClaw runtime memory/orchestration.
- Treating `defaultVisible` as runtime fallback after explicit connectivity exists.

## 14) Practical Read Order (for Engineers)

If you are new and want maximum signal fast:
1. `README.md`
2. `CONTEXT.md`
3. `CLASSIFICATION.md`
4. `backend/app/main.py`
5. `classifier/classifier.py`
6. `extensions/clawboard-logger/index.ts`
7. `src/components/unified-view.tsx`
8. `src/components/data-provider.tsx` + `src/lib/use-live-updates.ts`

If you are debugging a live issue:
1. Reproduce in UI.
2. Trace API calls and payload shape.
3. Confirm SSE delivery/reconcile.
4. Validate scope (`spaceId`, `allowedSpaceIds`, `sessionKey`).
5. Validate classifier pending/patch progression.
6. Validate search/context output under the same scope.

## 15) Unique Path Catalog (Happy + Alternate + Failure)

| Path ID | Trigger | Core Path | Expected Outcome |
|---|---|---|---|
| ING-01 | Logger sends new row | plugin -> `POST /api/log` -> `append_log_entry` | row stored, normalized, `log.appended` event |
| ING-02 | Duplicate delivery | same idempotency key/message id | duplicate suppressed; no duplicate history row |
| ING-03 | Queue mode enabled | plugin -> `POST /api/ingest` -> queue drain -> append | eventual consistent ingest with retry safety |
| ING-04 | Incoming task/topic mismatch | append normalization | task/topic/space coerced to valid hierarchy |
| ING-05 | SQLite lock contention | bounded retry wrappers | transient retry; request fails only after cap |
| CHAT-01 | Board send success | UI composer -> `/api/openclaw/chat` -> gateway -> ingest | durable user row then assistant/tool rows |
| CHAT-02 | Gateway returns no assistant payload | watchdog path in backend/log stream | system warning row explains likely logger issue |
| CHAT-03 | Attachment rejected | policy or upload validation path | send blocked with reason; no bad blob stored |
| VIS-01 | Viewer has explicit connectivity edge true | `_allowed_space_ids_for_source` | candidate space becomes visible |
| VIS-02 | No explicit connectivity edge | same function | candidate space hidden by default |
| VIS-03 | `defaultVisible` patched | patch endpoint + seed logic | affects seeding of new/missing edges only |
| VIS-04 | Space tag removed | `/api/spaces/{id}/cleanup-tag` | tags scrubbed; topics re-homed safely |
| CLS-01 | Board task session key | classifier forcing branch | logs hard-routed to selected task/topic |
| CLS-02 | Board topic session key | classifier forcing branch | logs scoped to topic; task inferred when valid |
| CLS-03 | Normal session classification | candidate retrieval + LLM JSON | pending rows patched with assignments |
| CLS-04 | Invalid LLM output | strict parse failure fallback | deterministic repair/heuristic fallback applies |
| CLS-05 | Replay requested | `/api/classifier/replay` | older rows marked pending for re-derivation |
| CLS-06 | Subagent child session from board-scoped request | logger `sessions_spawn` linkage + classifier same-session continuity | child logs stay in parent request scope; unrelated subagents stay detached |
| SRCH-01 | Normal semantic query | `/api/search` -> `_search_impl` -> `semantic_search` | hybrid-ranked topics/tasks/logs/notes |
| SRCH-02 | Low-signal query in scoped session | auto semantic hint expansion branch | stronger scoped recall without global noise |
| SRCH-03 | Search system under pressure | concurrency gate/degraded branch | bounded results or busy-safe fallback response |
| SRCH-04 | `includePending=false` | search filter path | only classified logs considered |
| CTX-01 | `mode=cheap` | `/api/context` | Layer A only, no semantic layer |
| CTX-02 | `mode=auto` + low signal | context gating branch | semantic skipped unless board-scoped hint applies |
| CTX-03 | `mode=full` or `mode=patient` | context semantic branch | Layer B semantic recall included |
| CTX-04 | Long generated block | `maxChars` clip path | prompt block clipped deterministically |
| CTX-05 | scoped request | allowed-space filtering in timeline/working set/semantic | no cross-scope leakage |
| GPH-01 | Graph fetch | `/api/clawgraph` scoped extract -> build | nodes/edges only from allowed scope |
| GPH-02 | UI threshold raised | frontend graph threshold filter | weak edges hidden client-side |
| SSE-01 | Stream reconnect within window | replay-by-last-event-id | no full refresh needed |
| SSE-02 | Cursor too old | server emits `stream.reset` | client reconciles via `/api/changes` |
| SSE-03 | Socket degraded | watchdog + polling fallback | eventual convergence maintained |
| DATA-01 | Delete topic/task | delete endpoints | object removed, dependent logs detached not lost |
| DATA-02 | Purge actions | topic-chat/log-forward purge endpoints | destructive delete with tombstones/events |
| ADMIN-01 | Start fresh replay | admin endpoint | derived topics/tasks reset, logs pending for rebuild |

## 16) Markdown-to-Code Traceability Coverage

| Markdown Spec | Contract Focus | Runtime / Test Anchors |
|---|---|---|
| `README.md` | product purpose, architecture, operator entry points | `backend/app/main.py`, `src/components/*`, `extensions/clawboard-logger/index.ts` |
| `CONTEXT.md` | context bridge and injection behavior | `backend/app/main.py::context`, `extensions/clawboard-logger/index.ts` |
| `CONTEXT.md` (Context Contract Spec section) | formal two-layer context contract and invariants | `/api/context`, `_search_impl`, `backend/tests/test_context_endpoint.py` |
| `CLASSIFICATION.md` | classifier lifecycle, forcing, guardrails, replay | `classifier/classifier.py`, `/api/log` patch paths, replay endpoints |
| `CLASSIFICATION.md` section 16 | scenario coverage commitments | `backend/tests/*`, `classifier/tests/*`, `tests/e2e/classification.spec.ts` |
| `CLASSIFICATION.md` section 17 | scenario-to-implementation trace | `classifier/classifier.py`, `backend/app/main.py` route/function mappings |
| `OPENCLAW_CLAWBOARD_UML.md` | sequence and component topology | ingest path, board chat path, context/search/classifier sequences |
| `TESTING.md` | validation command surface | npm scripts + pytest suites in repo |
| `SEED.md` | bootstrap/auth and seed checks | `backend/app/db.py`, `/api/config`, `/api/spaces*` |
| `DESIGN_RULES.md` | UX operating rules | `src/components/unified-view.tsx`, `src/components/app-shell.tsx`, `src/components/data-provider.tsx` |
| `HUMAN_INSTRUCTIONS.md` | human task queue notes | operational reference; no direct runtime behavior |
| `design/brand-notes.md` | visual identity guidance | frontend styling/component decisions |
| `design/operator-runbook.md` | day-2 operations and incident playbooks | `/api/metrics`, `/api/stream`, classifier/search/context health paths |
| `design/visual-end-state-spec.md` | visual QA acceptance criteria | Playwright specs in `tests/e2e/*` and component states |
| `research/RETENTION_AND_REDACTION_POLICY.md` | lifecycle + redaction contract | cleanup commands, delete/purge endpoints, retention operations |
| `skills/clawboard/SKILL.md` | Codex helper workflow | developer-assist only, no production runtime effect |
| `skills/clawboard/references/clawboard-api.md` | API reference for Codex skill | mirrors backend routes; documentation aid |
| `skills/clawboard/references/openclaw-hooks.md` | hook integration notes | `extensions/clawboard-logger/index.ts` behavior guide |
| `skills/clawboard/references/openclaw-memory-local.md` | memory-local integration notes | context/search behavior guidance |
| `skills/clawboard/references/routing-rules.md` | routing semantics reference | classifier forcing and session-key scope rules |
| `classifier/tests/fixtures/README.md` | fixture semantics for classifier tests | `classifier/tests/*` |

## 17) API Surface Inventory (Complete)

Routes currently implemented in `backend/app/main.py`:

- Health:
  - `GET /api/health`
- Attachments:
  - `GET /api/attachments/policy`
  - `POST /api/attachments`
  - `GET /api/attachments/{attachment_id}`
- OpenClaw bridge:
  - `POST /api/openclaw/chat`
  - `GET /api/openclaw/skills`
- Realtime/config/admin:
  - `GET /api/stream`
  - `GET /api/config`
  - `POST /api/config`
  - `POST /api/admin/start-fresh-replay`
- Spaces:
  - `GET /api/spaces`
  - `POST /api/spaces`
  - `PATCH /api/spaces/{space_id}/connectivity`
  - `GET /api/spaces/allowed`
  - `POST /api/spaces/{space_id}/cleanup-tag`
- Topics:
  - `GET /api/topics`
  - `GET /api/topics/{topic_id}`
  - `PATCH /api/topics/{topic_id}`
  - `POST /api/topics/reorder`
  - `POST /api/topics`
  - `DELETE /api/topics/{topic_id}`
- Tasks:
  - `GET /api/tasks`
  - `GET /api/tasks/{task_id}`
  - `PATCH /api/tasks/{task_id}`
  - `POST /api/tasks/reorder`
  - `POST /api/tasks`
  - `DELETE /api/tasks/{task_id}`
- Classifier:
  - `GET /api/classifier/pending`
  - `GET /api/classifier/session-routing`
  - `POST /api/classifier/session-routing`
  - `POST /api/classifier/replay`
- Logs/purge:
  - `GET /api/log`
  - `GET /api/log/{log_id}`
  - `POST /api/log`
  - `POST /api/ingest`
  - `PATCH /api/log/{log_id}`
  - `DELETE /api/log/{log_id}`
  - `POST /api/topics/{topic_id}/topic_chat/purge`
  - `POST /api/log/{log_id}/purge_forward`
- Sync and derived views:
  - `GET /api/changes`
  - `POST /api/drafts`
  - `GET /api/clawgraph`
  - `GET /api/context`
  - `GET /api/search`
  - `POST /api/reindex`
  - `GET /api/metrics`

## 18) Verification Loop (Keep Anatomy Accurate)

1. Confirm route inventory drift:
   - `rg '^@app\\.(get|post|patch|delete|put)' backend/app/main.py`
2. Confirm scope semantics drift:
   - `backend/app/main.py` (`_allowed_space_ids_for_source`, `_seed_missing_space_connectivity`)
   - `src/lib/space-visibility.ts` (`resolveSpaceVisibilityFromViewer`)
3. Confirm context/search contracts:
   - `backend/app/main.py::context`
   - `backend/app/main.py::_search_impl`
   - `backend/app/vector_search.py`
4. Confirm classifier contracts:
   - `classifier/classifier.py`
5. Run regression suites:
   - `npm run test:backend`
   - `npm run test:classifier`
   - `npm run test:e2e`
6. Re-check matrix docs for scenario coverage drift:
   - `CLASSIFICATION.md` section 16
   - `CLASSIFICATION.md` section 17
