### What the classifier is
The classifier is a **background worker** (`classifier/classifier.py`) that turns raw conversation logs into structured board state by:
- Choosing a **Topic** (always) and an optional **Task**
- Writing a short **summary chip** per message
- Updating each log’s `classificationStatus` from `pending` → `classified` (or `failed` after retries)

It does this **asynchronously** after logs are ingested, so the UI can be fast and ingestion can be simple.

---

### The objects it reasons about
From the API’s POV (`backend/app/models.py`):
- `LogEntry` is the atomic event: `type` (`conversation|action|note|system|import`), `content`, `summary`, `raw`, `source.sessionKey`, plus classifier metadata:
  - `classificationStatus`: `pending|classified|failed`
  - `classificationAttempts`, `classificationError`
  - `topicId`, `taskId`

From the classifier’s POV:
- A **session** = all logs sharing a `source.sessionKey` (Discord thread, OpenClaw thread, board chat, etc.)
- A **bundle** = one coherent request/response “chunk” inside a session (prevents collapsing an entire session into one topic)

---

### Runtime topology (how it runs in prod/dev)
In `docker-compose.yaml` there’s a dedicated `classifier` service that:
- Polls the API at `CLAWBOARD_API_BASE`
- Optionally calls the OpenClaw gateway as an LLM (`OPENCLAW_*` env)
- Maintains a lightweight embedding index (SQLite always, Qdrant optionally) via `classifier/embeddings_store.py`

It’s not a web server. It’s a loop.

---

## The main loop (scheduling + fairness)
Entry point: `main()` in `classifier/classifier.py`.

Every cycle:
1. **Process embedding reindex queue** (`process_reindex_queue()`).
   - Reads JSONL requests from `CLASSIFIER_REINDEX_QUEUE_PATH` (written by API’s `enqueue_reindex_request()` in `backend/app/main.py`).
   - Upserts/deletes vectors for topics/tasks/logs so retrieval stays current.
2. Acquire a **single-flight lock file** (`acquire_lock()` / `release_lock()`).
   - Prevents multiple classifier instances from double-processing.
   - Has stale-lock cleanup.
3. Fetch **pending conversation logs** via `GET /api/classifier/pending` (API endpoint in `backend/app/main.py`).
4. Group them by `source.sessionKey`, compute per-session stats, then **prioritize sessions**:
   - “Channel-ish” sessions first (`channel:` prefix or `source.channel` present)
   - Newest pending activity next
   - Then larger backlogs
5. Classify up to `MAX_SESSIONS_PER_CYCLE`, with:
   - A total cycle budget (`CYCLE_BUDGET_SECONDS`)
   - A per-session timeout guard (`MAX_SESSION_SECONDS`) via `SIGALRM` where available

This is why fresh chats should get classified quickly without starving old backlogs.

---

## What happens inside `classify_session(session_key)`
This is the heart of the logic.

### 1) Load context
It pulls a lookback window:
- `ctx_logs` = last `LOOKBACK_LOGS` logs for the session (any types)
- plus pending logs not already present
- sorted oldest → newest

Then it builds `ctx_context` by filtering down to logs that are semantically useful:
- Includes `conversation` and `note`
- Excludes slash commands, internal artifacts, classifier payload noise, etc. (`_is_context_log()`)

### 2) Find the next “bundle” to classify (very important)
It does **not** classify “the session”. It classifies one bundle at a time:
- It anchors on the **oldest pending conversation** to avoid starvation.
- `_bundle_range(conversations, anchor_idx)` decides `(start,end)`:
  - If anchor is assistant, backtrack to include the nearest prior user turn.
  - If anchor is a user “affirmation” (`yes/ok/ship it`), backtrack to the last non-affirmation user intent.
  - It includes multiple user turns before the assistant responds.
  - Once the assistant has responded, the next non-affirmation user message starts a new bundle.

Then it forms:
- `bundle` = the target request/response segment
- `window` = bundle plus limited prior context (to handle “yes/ok” bundles without signal)

### 3) Determine patch scope (bundle conversations + interleaved actions)
It patches more than just the conversation rows:
- `scope_logs` = logs between bundle start and the boundary where the next request begins
- This is how interleaved `action` logs (tool calls, etc.) get attached to the same topic/task without stamping the entire session.

### 4) Board session forcing (clawboard-specific routing safety)
It parses session keys like:
- `clawboard:topic:<topicId>`
- `clawboard:task:<topicId>:<taskId>`
via `_parse_board_session_key()`.

Two behaviors:
- If it’s **Topic+Task scoped** (`clawboard:task:...`):
  - It **never reroutes**.
  - It directly patches all pending logs in scope to that topic+task and returns early.
- If it’s **Topic scoped** (`clawboard:topic:...`):
  - The topic is pinned, but the classifier may still infer/create/select a task inside that topic.
  - Internally it forces the topic candidate list to only that topic and later overrides topic choice to remain pinned.

This is specifically to prevent the “I sent a message in a thread and it disappeared into another topic/task” failure mode.

### 5) Build retrieval text (user-only when possible)
To pick candidates, it prefers **user-only text** (`user_window_text()`), because assistant replies often contain broad boilerplate that can poison retrieval.

If the bundle is only “yes/ok”, it uses the larger window text.

Notes are joined into the text via `build_notes_index()` so curated notes can influence classification.

### 6) Small-talk fast path
If the bundle looks like small talk (`_is_small_talk_bundle()`), it attaches it to a stable **“Small Talk”** topic (creating it if needed) and returns. This avoids topic explosion.

### 6b) Session routing memory (continuity without huge context)
Low-signal follow-ups like **“yes/ok/ship it/thanks”** often refer to intent that may be *older than* `LOOKBACK_LOGS`.

To handle this without stuffing huge history into the LLM window, Clawboard maintains a small **server-side** per-session memory row:
- Model: `SessionRoutingMemory` (`backend/app/models.py`)
- Endpoints (token required):
  - `GET /api/classifier/session-routing?sessionKey=...`
  - `POST /api/classifier/session-routing` (append one decision)

The classifier reads this memory at the start of `classify_session()` and, when the current bundle is ambiguous, it will:
- **Prefer continuity** (force the last known topic for the session)
- Optionally keep the last task **sticky** for that topic so “ok/yes” turns remain in the same task thread
- Pass a compact `continuity` block into the LLM prompt (when LLM mode is enabled)

Auto-maintenance:
- The API runs a small GC loop that deletes session memory rows whose `updatedAt` is older than `CLAWBOARD_SESSION_ROUTING_TTL_DAYS` (default: 90 days).

### 7) Candidate retrieval (topics + tasks)
This is hybrid semantic + lexical ranking done *locally in the classifier*, not via `/api/search`.

#### Embedding store
`classifier/embeddings_store.py` provides:
- Always-on **SQLite** vector store (`/data/classifier_embeddings.db` by default)
- Optional **Qdrant** backend if `QDRANT_URL` is set
- `kind` namespaces:
  - `topic`
  - `task:<topicId>` (tasks are retrieved *within a topic*)
  - `log`

Vectors are computed with `fastembed` using `CLASSIFIER_EMBED_MODEL` (default `BAAI/bge-small-en-v1.5`), cached in-process.

#### Topic candidate scoring (`topic_candidates()`)
For each topic, it computes:
- `vectorScore`: cosine similarity from embeddings (`embed_topk("topic", q)`)
- `bm25Norm`: BM25 normalized by best doc in the candidate set
- `lexicalScore`: string similarity (`SequenceMatcher + token Jaccard`)
- `coverageScore`: token overlap coverage
- `phraseScore`: exact query-as-substring in candidate text

Then it fuses them with a conservative weighted formula:
- `topical = max(vectorScore, bm25Norm)`
- `support = min(vectorScore, bm25Norm)`
- `score = topical*0.62 + support*0.18 + lexical*0.12 + coverage*0.06 + phrase*0.02`

Tasks use the same pattern inside `task_candidates(topic_id, query)`.

It only hydrates “recent context” (API roundtrips for recent logs) for candidates above a minimum score, because that’s expensive.

### 8) LLM classification (optional) with strict JSON and repair
If enabled (`CLASSIFIER_LLM_MODE` and gateway token present), it calls OpenClaw:
- `call_classifier(...)` sends a JSON blob containing:
  - `window` (conversation rows with clipped content and notes)
  - `candidateTopics` + `recent` context per candidate
  - `candidateTasks` + `recent` context per candidate
  - `memory` snippets from OpenClaw’s memory DB (see below)
  - `pendingIds`
  - a rigid `outputTemplate`
  - explicit rules (topic mandatory; task optional; summaries required; no generic names; etc.)
- It tries a full prompt, then a compact prompt if needed.
- It validates with `_validate_classifier_result()`.
- If output is malformed, it does one deterministic “repair” call to regenerate strict JSON.

So the LLM is treated like a fallible function: validate, repair, then apply guardrails.

### 9) Topic selection guardrails + creation gate
Even after the LLM returns:
- If LLM “picked an existing topic” but retrieval is weak and the bundle has topic intent, it may force **create a new topic** (prevents generic buckets absorbing unrelated bundles).
- If LLM wants to create a topic but retrieval is a very strong match *with lexical anchor*, it may reuse the existing topic (prevents duplicate topics).
- It dedupes by name similarity (`TOPIC_NAME_SIM_THRESHOLD`).

If it’s going to create, it may call a second LLM:
- `call_creation_gate(...)` is a conservative gatekeeper that can block creation or suggest an existing id.
- Decisions are optionally audited to `CLASSIFIER_CREATION_AUDIT_PATH`.

If LLM is disabled or fails, it falls back to `classify_without_llm()` which:
- prefers strong candidates, else continuity, else derives a topic name heuristically and may create if allowed.

### 10) Task selection/creation (within the chosen topic)
Tasks are stricter than topics:
- Task intent is detected by `_window_has_task_intent()` which relies on `_derive_task_title()` + `_looks_actionable()` cues.
- It will only apply a task if `task_intent` is true.
- It never trusts a task id that doesn’t belong to the selected topic (`valid_task_ids` guardrail).
- It uses:
  - strong candidate reuse when similarity ≥ `TASK_SIM_THRESHOLD`
  - name-dedupe (`TASK_NAME_SIM_THRESHOLD`)
  - creation gate for new tasks (same `call_creation_gate()` but task-specific)

There are continuity fallbacks:
- If task intent exists but no confident match, it may reuse the latest classified task in that topic.
- If there’s exactly one open task, it can pick it.
- If it’s in board topic chat and the LLM explicitly proposed/selected a task, it forces `task_intent = True` (so topic chats can promote into tasks even if heuristics were conservative).

### 11) Summary chips (required for pending ids)
The classifier tries, in order:
1. Use LLM-provided summaries (per pending id), but reject “low signal” ones (`_is_low_signal_summary()`).
2. If missing, call `call_summary_repair()` (LLM) to fill gaps.
3. Fallback to heuristic `_concise_summary()`.

Summaries are designed to be short, telegraphic, and stable for UI chips.

### 12) Patch logs back into Clawboard
For each log in `scope_logs` still pending and under attempt budget:
- Handles special cases:
  - slash commands → `filtered_command`
  - classifier payload noise / injected context artifacts → mark `failed` with a specific code
  - `system/import` → `filtered_non_semantic`
  - memory tool actions → `filtered_memory_action`
- Normal case:
  - patch `topicId`, `taskId`, `summary` (conversation only)
  - set `classificationStatus=classified`
  - increment `classificationAttempts`

Patching is via `PATCH /api/log/{id}`.

---

## The OpenClaw memory integration (why it’s there)
`memory_snippets(query_text)` optionally queries an OpenClaw **SQLite FTS** DB (mounted into the classifier container) to retrieve a few snippets from your memory files.

Those snippets are:
- included in the LLM prompt (`memory`)
- used by `_refine_topic_name()` to pick a better focus term when the topic name is low-signal

This is not the primary routing mechanism; it’s a naming/context assist.

---

## Embeddings maintenance (how retrieval stays “warm”)
Two mechanisms:
- **Inline updates**: after `upsert_topic()` / `upsert_task()`, the classifier immediately `embed_upsert(...)`.
- **Reindex queue**: the API appends JSONL reindex requests (`enqueue_reindex_request()`), and the classifier drains them each cycle.

The embedding store always mirrors to SQLite, and optionally mirrors to Qdrant (same collection name by default), so search and classification can share the vector backend if configured.

---

## The important knobs (things you can tune)
In `classifier/classifier.py`:
- `CLASSIFIER_LLM_MODE`: `auto|off|...`
- `WINDOW_SIZE`, `LOOKBACK_LOGS`
- `TOPIC_SIM_THRESHOLD`, `TASK_SIM_THRESHOLD`
- `TOPIC_NAME_SIM_THRESHOLD`, `TASK_NAME_SIM_THRESHOLD`
- `MAX_ATTEMPTS`
- Session routing memory: `CLASSIFIER_SESSION_ROUTING_ENABLED`, `CLASSIFIER_SESSION_ROUTING_PROMPT_ITEMS`
- Audit rotation: `CLASSIFIER_CREATION_AUDIT_MAX_BYTES`, `CLASSIFIER_CREATION_AUDIT_MAX_FILES`, `CLASSIFIER_AUDIT_MAX_BYTES`, `CLASSIFIER_AUDIT_MAX_FILES`
- loop/latency: `INTERVAL`, `MAX_SESSIONS_PER_CYCLE`, `MAX_SESSION_SECONDS`, `CYCLE_BUDGET_SECONDS`

In `classifier/embeddings_store.py`:
- `QDRANT_URL`, `QDRANT_COLLECTION`, `QDRANT_DIM`, `QDRANT_API_KEY`

In `backend/app/main.py` (API):
- Session routing memory retention: `CLAWBOARD_SESSION_ROUTING_MAX_ITEMS`, `CLAWBOARD_SESSION_ROUTING_TTL_DAYS`, `CLAWBOARD_SESSION_ROUTING_GC_SECONDS`, `CLAWBOARD_SESSION_ROUTING_GC_BATCH`, `CLAWBOARD_DISABLE_SESSION_ROUTING_GC`

---

## The classifier’s “philosophy” (in plain English)
- Always attach conversations to a **topic**, but be conservative about spawning new ones.
- Only attach/create a **task** when the bundle is clearly actionable (or explicitly confirmed).
- Keep sessions flexible by classifying **one bundle at a time**, not the whole thread.
- Use embeddings + BM25 as retrieval anchors, then let the LLM decide within tight constraints.
- Treat LLM outputs as untrusted: validate, repair, then apply guardrails.
- Never let the classifier “move” board-scoped chats out of the place the user typed them.
