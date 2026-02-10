### What this document is
This describes, concretely, what **context the OpenClaw agent can see from Clawboard** today, and how the integration is **bidirectional**:
- **OpenClaw -> Clawboard**: the OpenClaw plugin logs messages/tool activity into Clawboard so it can be classified/indexed.
- **Clawboard -> OpenClaw**: before each agent run, the same plugin retrieves a small, ranked continuity bundle from Clawboard and prepends it into the agent prompt.

Primary implementation: `extensions/clawboard-logger/index.ts`.

As of Feb 2026, the plugin prefers the single-call layered context endpoint:
- Primary: `GET /api/context` (prompt-ready block + structured data)
- Back-compat fallback: legacy multi-call retrieval (`/api/search` + session/topic hydration) if `/api/context` is unavailable

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
Clawboard continuity context:
Current user intent: ...
Retrieval mode: ...
OpenClaw memory signals (sessions/markdown/recent retrieval):
- ...
Recent turns:
- ...
Likely topics:
- ...
Likely active tasks:
- ...
Recent thread timeline:
- ...
Curated user notes (high weight):
- ...
Topic memory:
Topic ...
- ...
[CLAWBOARD_CONTEXT_END]
```

Construction is usually **server-side** via `GET /api/context` (the plugin injects the returned `block`).

Back-compat: if the server does not implement `/api/context`, the plugin falls back to building the block client-side in `retrieveContext(...)` / `buildContextBlock(...)` in `extensions/clawboard-logger/index.ts`.

Important constraints:
- The injected block is **hard-capped** (default `contextMaxChars=2200`).
- Retrieval is **best-effort** and time-budgeted (per-request timeout and a total budget).
- Very short user input should not stampede expensive recall:
  - `/api/context?mode=auto` keeps this cheap server-side (Layer A continuity; no heavy recall by default).
  - the legacy fallback retriever still ignores very short input (`normalizedQuery.length < 6`) to avoid stampeding `/api/search`.

---

### Where that context comes from (exact API calls)
The plugin fetches context from the Clawboard API.

Primary path (single call):

- Layered continuity + recall:
  - `GET /api/context?q=<query>&sessionKey=<key>&mode=auto&includePending=1&maxChars=<n>&workingSetLimit=<n>&timelineLimit=<n>`
  - returns `{ block, data }`; the plugin injects `block` directly

Back-compat fallback (older servers without `/api/context`):

- The legacy retriever makes a small number of bounded requests (defaults shown are from code in `extensions/clawboard-logger/index.ts`):

- Topics list:
  - `GET /api/topics`
- Session continuity logs (if `sessionKey` exists):
  - `GET /api/log?sessionKey=<key>&type=conversation&limit=80&offset=0`
- Hybrid semantic + lexical lookup (includes pending, so it can be useful before the classifier finishes):
  - `GET /api/search?q=<query>&sessionKey=<key>&includePending=1`
  - limits used by the plugin are derived from `contextTopicLimit/contextTaskLimit/contextLogLimit`:
    - `limitTopics = max(12, contextTopicLimit*4)`
    - `limitTasks = max(24, contextTaskLimit*5)`
    - `limitLogs = max(120, contextLogLimit*30)`
- For the top-ranked topics, it hydrates:
  - `GET /api/tasks?topicId=<topicId>`
  - `GET /api/log?topicId=<topicId>&type=conversation&limit=<contextLogLimit>&offset=0`
- Notes:
  - it uses semantic `notes` from `/api/search`
  - plus a fallback lookup by related log ids:
    - `GET /api/log?type=note&relatedLogId=<comma-separated log ids>&limit=120&offset=0`

This is intentionally a small number of bounded requests with tight timeouts so it stays safe as instances grow.

---

### Ranking and continuity (how the plugin decides "likely" topics/tasks)
The injected block is not "everything"; it is a ranked shortlist built from:
- In the primary `/api/context` path, ranking happens server-side.
- The details below describe the legacy plugin-side fallback ranker (used only when `/api/context` is unavailable).
- `sessionKey` continuity (what you were recently talking about in that session)
- semantic search results (`/api/search`)
- lightweight lexical similarity on names/titles (token overlap)
- curated note weights from search results (capped boost)

Topic scoring (simplified from `retrieveContext(...)`):
- Start with semantic topic scores from `/api/search` plus a small note-weight boost (`+ min(0.24, noteWeight)`).
- Apply a **continuity boost** for the most recent topics seen in session logs (`max(0.5, 0.9 - i*0.08)`).
- Apply lexical similarity against `topic.name + topic.description` (scaled).
- Keep topics with `score > 0.12` or topics that were recently seen in session, then take the top `contextTopicLimit` (default 3).

Task scoring (within those topics):
- lexical similarity vs `task.title`
- continuity boost if that task appeared recently in session (`+0.25`)
- semantic score + note-weight boost (capped)
- keep the top `contextTaskLimit` (default 3), with a small minimum-score guard

Timeline selection:
- takes up to `contextLogLimit` (default 6) conversation entries from:
  - most-recent session conversation logs, then
  - semantic-matching logs
- formats each entry as a single line (`User:` vs `OpenClaw/Agent:`) with aggressive clipping

Curated notes:
- notes are attached to timeline entries by `relatedLogId`
- the block includes up to 2 notes per log entry, and up to ~4 total note lines

Topic memory:
- for each selected topic, include the most recent ~2 conversation log lines in that topic

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

Additional guardrail:
- The plugin ignores internal classifier sessions by default via `DEFAULT_IGNORE_SESSION_PREFIXES = ["internal:clawboard-classifier:"]`
  - file: `extensions/clawboard-logger/ignore-session.ts`
  - env override: `CLAWBOARD_LOGGER_IGNORE_SESSION_PREFIXES`

---

### Agent tools (bidirectional skills for the main agent)
In addition to passive prompt injection, the plugin registers explicit agent tools (when the OpenClaw SDK supports `registerTool`) so the agent can read and update Clawboard intentionally:

- `clawboard.search` (hybrid recall): calls `GET /api/search`
- `clawboard.context` (layered bundle): calls `GET /api/context`
- `clawboard.get_topic`: calls `GET /api/topics/{id}`
- `clawboard.get_task`: calls `GET /api/tasks/{id}`
- `clawboard.get_log`: calls `GET /api/log/{id}`
- `clawboard.create_note`: creates a curated note (calls `POST /api/log` with `type=note`)
- `clawboard.update_task`: updates task fields (calls `PATCH /api/tasks/{id}`)

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
