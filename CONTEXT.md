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
   - updates embedding indices (SQLite always, Qdrant optionally)
5. On the next OpenClaw run, the same plugin retrieves a compact "continuity context" block from Clawboard and prepends it into the agent prompt (`before_agent_start`).

Net effect: the agent can "remember" what happened across Topics/Tasks/logs/notes without relying only on the current chat window or OpenClaw-native memory.

---

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
