### What this document is
This describes, concretely, what **context the OpenClaw agent can see from Clawboard** today, and how the integration is **bidirectional**:
- **OpenClaw -> Clawboard**: the OpenClaw plugin logs messages/tool activity into Clawboard so it can be classified/indexed.
- **Clawboard -> OpenClaw**: before each agent run, the same plugin retrieves a small, ranked continuity bundle from Clawboard and prepends it into the agent prompt.

Primary implementation: `extensions/clawboard-logger/index.ts`.

As of Feb 2026, the plugin uses the single-call layered context endpoint:
- `GET /api/context` (prompt-ready block + structured data)
- Scope guardrail: retrieval is filtered by Clawboard Space visibility whenever the API can resolve a source space (from explicit `spaceId` or inferred `sessionKey`)

---

### Data flow (bidirectional bridge)
1. **User and agent messages happen in OpenClaw** (Discord/CLI/Clawboard UI, etc.).
2. The OpenClaw plugin `clawboard-logger` logs relevant events into Clawboard:
   - inbound user text (`message_received`)
   - outbound assistant text (`message_sending`)
   - tool calls/results/errors (`before_tool_call` / `after_tool_call`)
   - agent end output (`agent_end`, as a fallback when providers do not emit outbound hooks)
3. Clawboard persists logs (`LogEntry` rows) and emits live update events (SSE).
4. The **classifier** (`classifier/classifier.py`) asynchronously:
   - attaches logs to a **Topic** (always) and optional **Task**
   - writes short summary chips
   - updates `classificationStatus` (`pending -> classified/failed`)
   - updates embedding indices (Qdrant-backed in core runtimes; no local SQLite mirror)
5. On the next OpenClaw run, the same plugin retrieves a compact "continuity context" block from Clawboard and prepends it into the agent prompt (`before_agent_start`).

Net effect: the agent can "remember" what happened across Topics/Tasks/logs/notes without relying only on the current chat window or OpenClaw-native memory.

---

### Allocation guardrails for context eligibility (absolute)
Aligned with `CLASSIFICATION.md` section 4.1 and `ANATOMY.md` section 4.1.

- Only logs in direct user-request lineage are eligible for Topic/Task allocation and downstream continuity recall.
- `clawboard:task:<topicId>:<taskId>` sessions are hard-locked to that topic+task.
- `clawboard:topic:<topicId>` sessions are hard-locked to that topic; task promotion is allowed only inside that same topic.
- Subagent logs inherit board scope only when lineage is explicit:
  - explicit `source.boardScope*` on the row, or
  - explicit `sessions_spawn` child-session linkage captured by the logger.
- Cross-agent/global "latest scope" fallback is forbidden.
- Background/control-plane activity (cron, backup, maintenance, unanchored tool churn) must not be surfaced as user-request continuity in Topic/Task chats.
- Delegated-run supervision uses deterministic follow-up cadence (`1m -> 3m -> 10m -> 15m -> 30m -> 1h`, cap `1h`); running work older than 5 minutes must generate explicit user progress updates.

### What the agent sees (the injected context block)
On `before_agent_start`, if `contextAugment` is enabled (default), the plugin prepends a block like:

```text
[CLAWBOARD_CONTEXT_BEGIN]
Clawboard continuity hook is active for this turn...
Use this Clawboard retrieval context merged with existing OpenClaw memory/turn context...
Clawboard context (layered):
Current user intent: ...
Mode: ...
Active board location:
- ...
Working set topics:
- ...
Working set tasks:
- ...
Session routing memory (newest last):
- ...
Recent session timeline:
- ...
Semantic recall topics/tasks/logs:
- ...
Curated notes:
- ...
[CLAWBOARD_CONTEXT_END]
```

Construction is **server-side** via `GET /api/context` (the plugin injects the returned `block`).

Important constraints:
- The injected block is **hard-capped** (default `contextMaxChars=2200`).
- Retrieval is **best-effort** and time-budgeted (per-request timeout and a total budget).
- Very short user input should not stampede expensive recall:
  - `/api/context?mode=auto` keeps this cheap server-side (Layer A continuity; no heavy recall by default except scoped board-session continuity turns).
- Context retrieval modes (passed to `GET /api/context?mode=...` and controlled by the OpenClaw plugin `clawboard-logger`):
  - `auto` (default): Layer A always; semantic recall when query has signal, plus low-signal board-session turns (for "resume/continue" in `clawboard:topic|task` chats)
  - `cheap`: Layer A only (fastest)
  - `full`: Layer A + semantic recall
  - `patient`: like `full`, but the server may use larger bounded recall limits (slower; best for planning)

Configuration knobs (OpenClaw plugin config):
- `contextMode`
- `contextFetchTimeoutMs`
- `contextMaxChars`

If you installed via `scripts/bootstrap_openclaw.sh`, you can set these in Clawboard `.env` as:
- `CLAWBOARD_LOGGER_CONTEXT_MODE`
- `CLAWBOARD_LOGGER_CONTEXT_FETCH_TIMEOUT_MS`
- `CLAWBOARD_LOGGER_CONTEXT_MAX_CHARS`
Then rerun bootstrap with `--skip-docker` to reconfigure the OpenClaw plugin.

---

### Where that context comes from (exact API calls)
The plugin fetches context from the Clawboard API.

Primary path (single call):

- Layered continuity + recall:
  - `GET /api/context?q=<query>&sessionKey=<key>&spaceId=<sourceSpace>&allowedSpaceIds=<csv>&mode=auto&includePending=1&maxChars=<n>&workingSetLimit=<n>&timelineLimit=<n>`
  - returns `{ block, data }`; the plugin injects `block` directly

This call is intentionally bounded and time-limited so it stays safe as instances grow.

---

### Space tags + visibility scope (what context can cross)
Clawboard context/search is visibility-scoped whenever a source space can be resolved.

Source-space resolution (server-side):
- explicit `spaceId` query param wins
- otherwise, endpoints such as `/api/context`, `/api/search`, `/api/topics`, and `/api/tasks` try to infer source space from `sessionKey` using:
  - recent logs (`source.boardScopeSpaceId`, then `log.spaceId`)
  - board session keys (`clawboard:topic:<topicId>` / `clawboard:task:<topicId>:<taskId>`)
  - session routing memory (`SessionRoutingMemory`)
- if neither explicit nor inferable, retrieval remains unscoped (back-compat behavior)

Effective allowlist resolution:
- baseline policy matches `/api/spaces/allowed` semantics:
  - source space is always included
  - explicit override: `source.connectivity[target] = true/false`
  - if no explicit override exists: hidden
- `defaultVisible` is used only to seed missing explicit edges when new spaces are added
- changing `defaultVisible` does not retroactively alter existing explicit connectivity
- if caller sends both `spaceId` and `allowedSpaceIds`, effective set is `allowedSpaceIds ∩ baseline`
- if caller sends only `allowedSpaceIds` (no source), effective set is used as-is

How Space tags affect membership:
- Topic membership is the union of:
  - `topic.spaceId` (primary owner)
  - tag-derived spaces from `topic.tags`
- tag parsing accepts both `space:<label>` and plain non-`system:` tags; labels normalize to `space-<slug>`
- labels `default`, `global`, `all`, `all-spaces` map to default space
- when topic create/update omits explicit `spaceId`, backend derives `topic.spaceId` from the first tag-derived space
- backend auto-creates missing `Space` rows for new tag-derived spaces

Task/log scope rules:
- task matches allowed spaces if its own `task.spaceId` is allowed, or its parent topic matches
- log matches allowed spaces if its own `log.spaceId` is allowed, or its linked task/topic matches
- `SessionRoutingMemory` items are filtered against effective allowed spaces before `/api/context` emits `A:routing_memory`

Practical consequence for OpenClaw plugin:
- plugin retrieval calls currently pass `sessionKey` (not explicit `spaceId`/`allowedSpaceIds`)
- for board sessions and normal sessions with prior scoped logs, server inference keeps context/search inside the expected visibility envelope
- for brand-new or unscoped sessions, callers should pass explicit `spaceId`/`allowedSpaceIds` if strict isolation is required

---

### Ranking and continuity (how the plugin decides "likely" topics/tasks)
The injected block is not "everything"; it is a ranked shortlist built from:
- Ranking happens server-side in `/api/context`.
- `/api/context` and `/api/search` apply ranking only after allowed-space filtering when a source space is resolved.
- The resulting block combines:
  - active board location (when in board chat)
  - working set topics/tasks
  - routing memory
  - recent timeline
  - optional semantic recall sections (mode-dependent)

---

### Safety: preventing feedback loops and "retrieval pollution"
Two separate protections exist to keep injected context from poisoning logs, embeddings, or the classifier:

1. **Sanitization before logging/searching**
   - `sanitizeMessageContent(...)` in `extensions/clawboard-logger/index.ts` removes:
     - any `[CLAWBOARD_CONTEXT_BEGIN] ... [CLAWBOARD_CONTEXT_END]` region
     - the "Clawboard continuity hook is active..." preamble
     - other transport noise (Discord tags, local-time prefixes, message-id decorations)
   - This keeps the *agent's prompt augmentation* from being re-ingested as if it were the user/assistant's content.

2. **Classifier noise filtering**
   - `classifier/classifier.py` detects injected context artifacts via `_is_injected_context_artifact(...)`
   - those entries are treated as noise (`context_injection_noise`) and excluded from semantic context and bundling logic

3. **Tool activity filtering for semantic retrieval**
   - API indexing/search excludes `action` logs that are tool call/result/error traces by default
   - opt-in switch: `CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS=1`
   - Clawgraph memory map excludes tool call/result/error `action` logs unconditionally
   - burst protection: bounded search gate (`CLAWBOARD_SEARCH_CONCURRENCY_*`) keeps `/api/search` responsive under rapid typing by failing fast with `429 search_busy`
   - efficiency tuning: `CLAWBOARD_SEARCH_SINGLE_TOKEN_WINDOW_MAX_LOGS`, `CLAWBOARD_SEARCH_SOURCE_TOPK_*`, `CLAWBOARD_RERANK_CHUNKS_PER_DOC`, and `CLAWBOARD_SEARCH_EMBED_QUERY_CACHE_SIZE`

4. **Control-plane and tool-trace suppression at ingest/classification**
   - logger conversation hooks suppress heartbeat/control-plane and subagent scaffold payloads before they hit Clawboard
   - API ingest terminal-filters any surviving control-plane conversations:
     - `filtered_control_plane`
     - `filtered_subagent_scaffold`
     - plus `filtered_cron_event` for `source.channel=cron-event`
   - API ingest terminalizes tool trace actions:
     - anchored traces -> `classified` + `filtered_tool_activity`
     - unanchored traces -> `failed` + `filtered_unanchored_tool_activity` (detached)
   - classifier re-applies the same filters for historical/pending rows so old data converges to guardrails

Additional guardrail:
- The plugin ignores internal classifier sessions by default via `DEFAULT_IGNORE_SESSION_PREFIXES = ["internal:clawboard-classifier:"]`
  - file: `extensions/clawboard-logger/ignore-session.ts`
  - env override: `CLAWBOARD_LOGGER_IGNORE_SESSION_PREFIXES`

---

### Agent tools (bidirectional skills for the main agent)
In addition to passive prompt injection, the plugin registers explicit agent tools (when the OpenClaw SDK supports `registerTool`) so the agent can read and update Clawboard intentionally:

- `clawboard_search` (hybrid recall): calls `GET /api/search`
- `clawboard_context` (layered bundle): calls `GET /api/context`
- `clawboard_get_topic`: calls `GET /api/topics/{id}`
- `clawboard_get_task`: calls `GET /api/tasks/{id}`
- `clawboard_get_log`: calls `GET /api/log/{id}`
- `clawboard_create_note`: creates a curated note (calls `POST /api/log` with `type=note`)
- `clawboard_update_task`: updates task fields (calls `PATCH /api/tasks/{id}`)

Current limitation:
- tool schemas expose `sessionKey`/`topicId` controls, but not explicit `spaceId`/`allowedSpaceIds`; visibility scope is normally inferred from session continuity on the server

This is what turns "helpful retrieval context" into an expert system that continuously improves its own working memory while it works.

---

### Topic/task digests (compressed memory)
Clawboard supports short digests on Topics and Tasks:

- fields: `digest`, `digestUpdatedAt`
- written opportunistically by the classifier (LLM when available; heuristic fallback)
- digest-only updates are designed not to bump user-facing `updatedAt` (so lists do not reorder)
- digests are excluded from embedding/index text to avoid retrieval pollution (they are shown as context, not used to generate it)

---

### Session keys (how context is routed to the right place)
Clawboard uses `source.sessionKey` as the main continuity bucket across channels and UIs.

The plugin computes an "effective session key" in `computeEffectiveSessionKey(...)` (`extensions/clawboard-logger/session-key.ts`):
- If the session is a **Clawboard board chat**, it uses reserved session keys:
  - `clawboard:topic:<topicId>`
  - `clawboard:task:<topicId>:<taskId>`
  These keys intentionally win over provider conversation ids to prevent mis-attribution.
- Otherwise it prefers the provider's `conversationId`, and optionally appends `|thread:<threadId>` to avoid collisions.
- If nothing else exists, it falls back to `channel:<channelId>` (broad bucket).

Important: to avoid double-logging Clawboard UI chat, the plugin explicitly skips logging `message_received` when the effective session key parses as a board session (`parseBoardSessionKey(...)`), because Clawboard's own backend persists those messages immediately via its board chat endpoint.

During ingest, Clawboard normalizes source scope metadata (`boardScopeTopicId`, `boardScopeTaskId`, `boardScopeSpaceId`) so later context/search calls can infer the correct source space from session continuity.

For subagents, board scope inheritance is explicit-link only:
- parent board-scoped runs that call `sessions_spawn` can publish child session keys into the logger cache
- child sessions inherit only when the exact child session key has linked board scope (memory + persisted sqlite cache)
- there is no cross-agent/global "latest scope" fallback

---

### Config knobs (what you can tune)
The plugin is configured via `extensions/clawboard-logger/openclaw.plugin.json` and the `ClawboardLoggerConfig` type in `extensions/clawboard-logger/index.ts`.

Key settings:
- `baseUrl` (required): Clawboard API base URL
- `token` (optional): sent as `X-Clawboard-Token`
- `enabled` (default true)
- `queuePath` (default `~/.openclaw/clawboard-queue.sqlite`): local durable queue for log delivery
- `queue` (default false): if true, send to `/api/ingest` (server-side async queue) instead of `/api/log`
- `contextAugment` (default true): turn prompt injection on/off
- `contextMaxChars` (default 2200)
- `contextTopicLimit` (default 3)
- `contextTaskLimit` (default 3)
- `contextLogLimit` (default 6)
- `autoTopicBySession` (default OFF): if enabled, the plugin can auto-create a synthetic topic per OpenClaw session key (tagged `["openclaw"]`). Most setups rely on the classifier instead.

---

### Practical implications (what this enables)
Because the agent sees:
- the most likely Topics/Tasks,
- a compact recent timeline,
- and high-weight curated notes,

...it can:
- answer with continuity even if the current chat window is short
- respect Topic/Task boundaries and ongoing work
- avoid re-asking for stable facts that were already captured as notes
- leverage Clawboard's hybrid retrieval in addition to OpenClaw-native memory

### Context Contract Spec (Merged)

This section is merged from the former CONTEXT_SPEC.md.


This document defines the **end-state contract** for how Clawboard provides **robust, efficient, bidirectional context** to the OpenClaw agent (and vice versa), at scale.


#### Goals

- **Continuity without huge prompts**: handle ambiguity over long history without stuffing massive context into every run.
- **Cheap-by-default**: most turns should use a small, deterministic "working set" bundle; semantic recall is conditional.
- **Bidirectional improvement loop**:
  - OpenClaw emits conversation + tool activity into Clawboard (durable memory).
  - OpenClaw can *query and update* Clawboard through explicit tools (notes, task status, etc.).
- **Visibility-safe retrieval**: context/search must respect Space-tag membership and Space visibility policy when a source space is known.
- **Production-safe defaults**: no noisy auditing enabled by default; stable retention/rotation where logs are enabled.
- **No retrieval pollution**: system metadata and injected context must not poison embeddings/search.

#### Non-Goals (for this layer)

- A full "agentic planner" inside Clawboard.
- Unlimited context windows (this design assumes context cost matters).
- Provider-specific memory features beyond the OpenClaw plugin contract.

#### Space Scope Contract (Space Tags + Visibility)

##### Source Space Resolution

- `spaceId` query param is authoritative when provided.
- If `spaceId` is omitted, server may infer source space from `sessionKey` (recent logs, board session key routing, session routing memory).
- If no source space can be resolved, requests are unscoped for backward compatibility.

##### Allowed Space Set

- Baseline visibility set for a source space:
  - include source space itself
  - apply explicit `source.connectivity[target]` overrides
  - if no override exists, treat as hidden
- `defaultVisible` is a seed policy, not a runtime fallback:
  - used when a new space is added and missing explicit connectivity edges are initialized
  - changing `defaultVisible` does not retroactively override existing explicit connectivity
- If both `spaceId` and `allowedSpaceIds` are provided, effective set is intersection: `allowedSpaceIds ∩ baseline`.
- If only `allowedSpaceIds` is provided, use it as-is.

##### Space Tag Mapping Rules

- Topic membership is `topic.spaceId` union tag-derived spaces from `topic.tags`.
- Tag parsing:
  - accept `space:<label>` and plain non-`system:` tags
  - normalize label to `space-<slug>`
  - `default|global|all|all-spaces` normalize to default space
- Topic create/update without explicit `spaceId` may derive ownership from first tag-derived space.
- Task/log scope inheritance:
  - task visible if own `task.spaceId` matches, or parent topic matches
  - log visible if own `log.spaceId` matches, or linked task/topic matches

#### Two-Layer Memory Contract

##### Layer A: Always-On Continuity (Cheap)

Included on every turn (even very short user input) and designed to be stable and bounded:

- all Layer A candidates are pre-filtered to effective allowed spaces when a source space is resolved
- **Working set** (ranked, small):
  - pinned topics/tasks
  - tasks in `doing`/`blocked`
  - high priority / due-soon tasks
  - excludes archived/snoozed by default
- **Routing memory**:
  - the most recent topic/task matches for the current `sessionKey`
  - supports "marrying" new logs to the right topic/task even when the user is terse
  - filtered by effective allowed-space scope before emission
- **Session timeline**:
  - last N conversation lines in the session (clipped)

##### Layer B: Conditional Recall (More Expensive)

Included only when useful:

- all Layer B recall candidates are pre-filtered to effective allowed spaces when a source space is resolved
- hybrid recall (semantic + lexical) across:
  - topics
  - tasks
  - conversation logs
  - curated notes (high weight)
- optional topic/task digests (see below)

Triggering rules (default):

- `mode=cheap`: Layer A only
- `mode=full`: Layer A + Layer B
- `mode=patient`: Layer A + Layer B, but the server may use larger bounded recall limits (slower; best for planning)
- `mode=auto`: Layer B when query has signal, or for low-signal board-session turns (`clawboard:topic|task`) where scoped semantic recall helps continuity

#### Server Endpoint: `GET /api/context`

##### Purpose

Return a **prompt-ready**, size-bounded context block plus structured data for agent tooling/UI debugging.

##### Inputs

- `sessionKey` (optional): continuity bucket
- `q` (optional): retrieval hint; may be empty for cheap continuity
- `spaceId` (optional): explicit source space for visibility resolution
- `allowedSpaceIds` (optional): explicit allowed space ids (comma-separated)
- `mode` (optional): `auto|cheap|full|patient` (default `auto`)
- `includePending` (optional): include unclassified logs when building context
- `maxChars` (optional): hard cap for returned `block`
- `workingSetLimit` (optional): bound Layer A working set
- `timelineLimit` (optional): bound Layer A timeline

##### Outputs (response JSON)

- `ok: boolean`
- `sessionKey?: string`
- `q?: string`
- `mode: "auto"|"cheap"|"full"|"patient"`
- `layers: string[]` (emitted sections; examples: `A:working_set`, `A:routing_memory`, `A:timeline`, `A:board_session`, `B:semantic`)
- `block: string` (prompt-ready, clipped to `maxChars`)
- `data: object` (structured result: working set items, timeline rows, recall shortlist)

##### Invariants

- `block.length <= maxChars` always
- bounded query execution (no unbounded scans)
- cacheable-by-key on the server side (implementation detail): `(sessionKey, q, mode, includePending, limits)`
- when source space is resolved, response content is restricted to the effective allowed-space set
- topic/task/log scope checks must include tag-derived topic spaces (not only primary `spaceId`)

#### Agent Tools (OpenClaw plugin)

Expose explicit, auditable tools so context is not a one-way street:

- `clawboard_search(q, ...)` -> `/api/search`
- `clawboard_context(q?, mode?, ...)` -> `/api/context`
- `clawboard_get_topic(id)` -> `/api/topics/{id}`
- `clawboard_get_task(id)` -> `/api/tasks/{id}`
- `clawboard_get_log(id, includeRaw?)` -> `/api/log/{id}`
- `clawboard_create_note(relatedLogId, text, topicId?, taskId?)` -> `POST /api/log` (type=`note`)
- `clawboard_update_task(id, ...)` -> `PATCH /api/tasks/{id}`

Tool design constraints:

- strong parameter validation and safe defaults
- tools should return small JSON by default (avoid dumping giant raw payloads)
- current plugin tool wrappers may rely on `sessionKey`-based space inference rather than explicit `spaceId/allowedSpaceIds` controls

#### Digests (Topic/Task "Compressed Memory")

##### Concept

Each topic/task can hold a short **digest** that compresses long history into stable facts and current status.

##### Requirements

- digest writes are **system-managed**:
  - `createdBy="classifier"` metadata (or equivalent internal field)
  - optional hidden UI tag `system:classified` is allowed, but **must be excluded** from embedding/index text
- digest-only updates must **not** bump user-facing `updatedAt` (avoid reordering lists)
- digest should be updated opportunistically:
  - minimum interval (default 15 minutes)
  - per-cycle budget to avoid churn
  - LLM path when available; heuristic fallback otherwise

#### Safety / Quality

- Injected context blocks must be sanitized out of logs before re-ingestion.
- Reserved/system tags must not pollute embeddings or search ranking.
- Audit logging:
  - disabled by default in production
  - if enabled, must have rotation/retention to prevent unbounded growth

#### Acceptance Criteria

##### Functional

1. `GET /api/context` returns a non-empty `block` for normal usage and never exceeds `maxChars`.
2. `mode=cheap` includes Layer A (working set + routing memory + timeline) even for short `q`.
3. `mode=full` includes Layer B recall results (topics/tasks/logs/notes) when available.
4. OpenClaw plugin `before_agent_start` uses `/api/context` as the retrieval path (no legacy client-side reconstruction fallback).
5. Agent tools are available to the main agent:
   - read tools: search/context/get_*
   - write tools: create_note/update_task
6. Topic/task digests can be updated by the classifier without reordering user lists (digest-only updates do not change `updatedAt`).
7. When a source space is resolved (`spaceId` or inferable `sessionKey`), `/api/context` and `/api/search` exclude topics/tasks/logs outside the effective allowed-space set.
8. Topic scope evaluation includes both primary `topic.spaceId` and tag-derived spaces from `topic.tags`.

##### Performance / Robustness

9. `/api/context` is bounded and does not perform unbounded scans proportional to total log count.
10. Very short turns do not stampede semantic recall by default (`mode=auto` stays cheap unless needed), except scoped board-session continuity turns where semantic recall is intentionally enabled.

##### Regression Safety

11. Existing `/api/search` behavior remains stable; `/api/context` is additive.
12. No feedback loop: injected prompt context is not re-logged or embedded as if it were user content.
