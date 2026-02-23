# Forensic: Task Chat duplication, fake user message, heartbeat as User

**Context:** User sent one message in Task Chat; it was duplicated; a message appeared as if from the user that wasn’t; main agent didn’t follow up properly; heartbeat showed in logs as "User -> OpenClaw · channel: heartbeat".

---

## 1. Message duplication (one Enter, two messages)

**Cause:** The UI can fire `sendMessage()` twice before React state updates (e.g. double keydown or double click). Each call gets a new `request_id` from the backend, so:

- Backend persists one user log per `request_id` (`openclaw-chat:user:{request_id}`).
- Dispatch queue dedupes only by `request_id`, so two requests → two queue rows → two `chat.send` calls to the gateway.

**Fix:** In `BoardChatComposer`, a synchronous send guard was added:

- `sendingGuardRef` (ref, not state) is set to `true` at the start of `sendMessage()` and cleared in `finally`.
- If `sendMessage()` is invoked again before the first call finishes, the second call returns immediately without calling the API.
- The button is already disabled via `sending` state; the ref guards against rapid Enter/keydown or strict-mode double-invocation.

**Files:** `src/components/board-chat-composer.tsx` (guard ref + early return + reset in `finally`).

---

## 2. “Fake” user message (system message appearing as from User)

**Cause:** The OpenClaw gateway runs **heartbeat** by injecting the heartbeat prompt as the **user** message for that run (see openclaw-docs: “The heartbeat prompt is sent **verbatim** as the user message”). The run’s session is e.g. `agent:main:main` with channel `heartbeat`.

The clawboard-logger plugin’s **agent_end** handler walks the run’s transcript and logs conversation rows. For `role === "user"` it was logging them as `agentId: "user"`, `agentLabel: "User"` for **all** sessions. So:

- Heartbeat runs have a user-role message (the prompt) in the transcript.
- That was logged to Clawboard as a “User” message with `channel: heartbeat` (and possibly routed to a topic/task by `resolveRoutingScope` for `agent:main:main`), so logs showed “User -> OpenClaw · channel: heartbeat” and could pollute task threads.

**Fix:** In the plugin’s **agent_end** loop, when the run’s channel is **heartbeat** and `role === "user"`, we **skip** logging that message. Those prompts are system-driven, not from the human user, and should not appear as “User” in Clawboard.

**Files:** `extensions/clawboard-logger/index.ts` (agent_end: `if (role === "user" && ch === "heartbeat") continue` before building the log payload).

---

## 3. No proper response / subagent flow

**Observed:** Tool calls from main looked correct but there was no follow-up; a subagent flow was seen in logs (`Subagent c4d7b010 -> Agent coding`).

**Interpretation:**

- Main may have delegated to the coding agent via `sessions_spawn`; the “no follow-up” could be due to:
  - Subagent result not yet delivered back to the session the UI is watching, or
  - Session key / routing mismatch (e.g. UI on `clawboard:task:...` while the reply or tool results were attributed to another session), or
  - Watchdog/recovery or heartbeat running in between and affecting ordering or visibility.
- The “fake user message” (heartbeat logged as User) could make the thread look like the user had sent another message, adding confusion.

**Mitigations in this pass:** (1) and (2) reduce duplicates and misattribution, so the thread should be clearer and heartbeat no longer appears as a user message. No change was made to subagent routing or session key resolution in this forensic pass; that can be a follow-up if “no follow-up” persists.

---

## 4. Heartbeat posting as User (cross-wires)

**Cause:** Same as §2. Heartbeat runs are implemented as agent turns whose “user” message is the heartbeat prompt. The plugin was logging every `role === "user"` from agent_end as “User”, so heartbeat showed as “User -> OpenClaw · channel: heartbeat”.

**Fix:** Same as §2: skip logging user-role messages when the run’s channel is `heartbeat`, so heartbeat no longer appears as a user message in Clawboard.

---

## Summary of code changes

| Issue | Fix |
|-------|-----|
| Task Chat message duplicated on single Enter | `board-chat-composer.tsx`: `sendingGuardRef` + early return in `sendMessage()` and reset in `finally`. |
| Heartbeat (and similar) prompts shown as “User” in logs | `clawboard-logger` agent_end: skip logging `role === "user"` when `channel === "heartbeat"`. |
| Subagent delegation prompt shown as “User” in task thread | `clawboard-logger` agent_end: skip logging `role === "user"` when session is a subagent (`parseSubagentSession`). |

---

## Idempotency / dedupe (reference)

- **Backend** `/api/openclaw/chat`: one user log per request with `idempotency_key = openclaw-chat:user:{request_id}`; duplicate *same* request_id would dedupe, but two requests ⇒ two request_ids ⇒ two entries.
- **Dispatch queue**: dedupes by `requestId`; two different request_ids ⇒ two jobs ⇒ two `chat.send` calls.
- **Plugin** `message_received`: board sessions are skipped (Clawboard already persisted the user message), so no double log from the gateway echo.
- **Plugin** `agent_end`: board sessions already skip logging user-role messages; channel sessions skip user (handled by message_received); **heartbeat** user messages are skipped; **subagent** user-role messages (parent’s delegation prompt) are now skipped so they don’t appear as “User”.

Rebuild the plugin after editing `index.ts` (e.g. `npm run build` in the extension or project root so `dist/` is updated).

---

## 5. Subagent logs allocated to another Task Chat

**Observed:** A message with flow `Subagent c4d7b010 -> Agent coding`, session `agent:coding:subagent:c4d7b010-...`, was allocated to a different Task Chat than the one that spawned it.

**Cause:** Subagent scope inheritance in the plugin looked up board scope by the **subagent’s owner** (`boardScopeByAgent.get("coding")`). When the user sends from Task Chat, the **main** agent runs with `sessionKey = clawboard:task:...`, and we store that scope under **main** (`boardScopeByAgent.set("main", scope)`). The coding subagent never gets a scope stored under `"coding"`, so `inherited` was undefined and the plugin fell back to `resolveTopicId` / `resolveTaskId` on the raw session key, producing an ad-hoc or wrong topic/task. The classifier then had no board lock and could assign the log elsewhere.

**Fix:** When resolving scope for a subagent, if there is no scope for the subagent’s owner, **fall back to the most recent fresh board scope from any agent** (`getMostRecentFreshBoardScopeFromAgents()`), so subagent logs inherit the orchestrator’s board scope (the Task/Topic Chat that spawned them). This is **scalable** (no hardcoded `"main"`; works with multiple orchestrators; the most recently updated scope is typically the spawner). In `resolveRoutingScope`:

`inherited = exact ?? boardScopeByAgent.get(subagent.ownerAgentId) ?? getMostRecentFreshBoardScopeFromAgents(now)`

**Surviving restarts:** Board scope is also persisted to the plugin’s existing SQLite DB (`~/.openclaw/clawboard-queue.sqlite`) in a `board_scope_cache` table (per agent). When in-memory lookup finds no scope, the plugin reads the most recent scope from the DB, so subagent inheritance survives gateway/plugin restarts.

**Long-running subagents:** When scope is taken from the DB for a subagent, a configurable persistence TTL is used (default **48 hours**). So subagents that run for a day or two still inherit the task/topic that spawned them and don’t get orphaned or misaligned. Set `CLAWBOARD_BOARD_SCOPE_SUBAGENT_TTL_HOURS` (1–168) to override.

**Files:** `extensions/clawboard-logger/index.ts`, `extensions/clawboard-logger/index.js`.

---

## 6. Subagent delegation prompt appearing as “User” in task thread

**Observed:** In a Task Chat, tool calls and subagent activity stream in correctly. Then a message appears **on the right** (as if the human user sent it) that the user did not send—it should have been from the agent’s perspective (main or subagent reporting results). The content may look like instructions or markdown that doesn’t render well.

**Cause:** For **subagent** runs (e.g. `agent:coding:subagent:uuid`), the gateway’s transcript has:
- `role: "user"` = the **parent agent’s delegation prompt** (e.g. main’s instruction to coding),
- `role: "assistant"` = the subagent’s reply.

The plugin’s **agent_end** handler already skips logging `role === "user"` for **board** sessions (Clawboard UI already persisted the human’s message) and **channel** sessions (handled by message_received). It did **not** skip for **subagent** sessions. So when the run was a subagent, we logged that “user” message as `agentId: "user"`, `agentLabel: "User"`, and because scope is inherited from the parent’s board scope, the log was attached to the **same task**. Result: the parent’s delegation prompt showed in Memory check as a message from “User” (right side), with content that was never meant to be user-facing (hence odd/malformed markdown).

**Fix:** In subagent sessions, treat `role === "user"` as **orchestrator → subagent delegation**, not human input. We keep the row visible as `type: conversation`, but attribute it to the owning agent (`agentId: coding/docs/...`, label `Agent ...`) so it renders on the left lane and not as “You”.

**Hardening:** Apply the same remap in all ingestion paths:
- `agent_end` (plugin): map subagent `role:user` rows to owner agent attribution.
- `message_received` (plugin): same remap for inbound transcript events.
- OpenClaw history ingest (backend): same remap during recovery/backfill, including `speaker/audience` flow metadata.

**Files:** `extensions/clawboard-logger/index.ts`, `extensions/clawboard-logger/index.js`, `backend/app/main.py`.

---

## 7. Duplicate user message from history ingest channel mismatch

**Observed:** The human's opening message in a Task Chat appears twice in the Clawboard log — one copy at T+0 seconds (from the backend), another copy ~9 seconds later (from the history ingest background poll).

**Cause:** Two code paths write the same message:
1. **Backend `/api/openclaw/chat`** persists the user message immediately with `source.channel = "openclaw"` and `requestId = "occhat-..."`.
2. **Backend history ingest** (`_ingest_openclaw_history_messages`) later polls the gateway's transcript and finds the same `role: user` message. It infers `channel = "clawboard"` (from the session key prefix via `_openclaw_history_channel_from_session_key`). The idempotency key includes the channel, so `src:conversation:openclaw:user:occhat-...` ≠ `src:conversation:clawboard:user:occhat-...` → deduplication misses it → second row created.

**Fix:** In `_openclaw_history_conversation_idempotency_key`, normalize `"openclaw"`, `"clawboard"`, and `"webchat"` to a single canonical value (`"openclaw"`) before building the idempotency key. These are all equivalent board-session delivery channels; messages from any of them should share the same deduplication bucket.

**Files:** `backend/app/main.py` (`_openclaw_history_conversation_idempotency_key`).

---

## 8. OpenClaw `[System Message]` notifications appearing as user messages

**Observed:** In a Task Chat thread, after a subagent fails, a message appears on the **right lane** (as if the human sent it) with content like `[System Message] [sessionId: ...] A subagent task "..." just failed: ...`. The user never sent this.

**Cause:** When a spawned subagent fails, OpenClaw injects a `[System Message]` notification into the parent agent's conversation as `role: "user"`. The plugin's `agent_end` handler correctly skips board-session `role: user` messages (they're already persisted by the backend). However, the **history ingest** path (`_ingest_openclaw_history_messages`) for non-subagent board sessions treated all `role == "user"` entries as human messages (`agentId = "user"`, `type = "conversation"`). The `[System Message]` prefix wasn't detected, so the notification rendered on the right lane as if it came from you.

**Fix:** In `_ingest_openclaw_history_messages`, for `role == "user"` messages in non-subagent sessions, check if the normalized text starts with `[System Message]`. If it does, attribute the entry as `type: system`, `agentId: system`, `agentLabel: OpenClaw` so it renders as a system event rather than a user message.

**Files:** `backend/app/main.py` (`_ingest_openclaw_history_messages`).

---

## 9. Board session user messages in history ingest (definitive dedup)

**Observed:** Even with channel-normalised idempotency keys (§7), user messages in Task Chat can still be duplicated if the gateway does not echo the `requestId: occhat-...` back in the history payload. Relying on key-based dedup is fragile.

**Fix:** In `_ingest_openclaw_history_messages`, for `role == "user"` in **non-subagent** sessions, if the session key is a board session (`_parse_board_session_key(session_key)` returns a topic/task), **skip** the message entirely. `/api/openclaw/chat` is the exclusive writer for board session user messages; history ingest should only handle assistant, tool, and system rows for those sessions.

**Files:** `backend/app/main.py` (`_ingest_openclaw_history_messages`).

---

## 10. Incoming channel message content-fingerprint dedup

**Observed:** For external channel messages (Discord, Slack, etc.), `message_received` deduplicates only by `messageId`. Platforms can re-deliver the same logical message with a new `messageId` on reconnect; the 30 s in-memory `recentIncoming` set and server-side request-id checks then miss it.

**Fix:** In the plugin’s `message_received` handler, add a content fingerprint dedup layer for non-subagent (human) messages: `incomingFingerprintDedupeKey(channelId, sessionKey, cleanRaw)` with prefix `incoming-fp:`, and a 60 s TTL. Same pattern as outbound `outgoingFingerprintDedupeKey`. Subagent delegation prompts are excluded (fingerprint key is null for `inboundSubagent`).

**Files:** `extensions/clawboard-logger/index.ts`, `extensions/clawboard-logger/index.js`.

---

## Ownership model and dedup layers

Single owner per message type; other paths skip or dedupe.

| Message origin | Owned by | Other paths |
|----------------|----------|-------------|
| Board session user msg | `/api/openclaw/chat` (backend) | History ingest: skip `role:user` for board sessions; plugin `message_received`: early return; plugin `agent_end`: `continue` |
| Channel session user msg | Plugin `message_received` | `agent_end`: skip `role:user` for channel sessions; history ingest: dedup via messageId/requestId + `_find_existing_openclaw_user_request_log` |
| Subagent delegation prompt | Plugin `agent_end` + history ingest | Attributed to owner agent, not "user" |
| System/heartbeat injections | Skipped or re-attributed as `agentId: system` | All paths |

**Dedup layers (defence in depth):**

- **Frontend:** `sendingGuardRef` prevents concurrent double-send.
- **Backend:** `idempotency_key` (e.g. `openclaw-chat:user:{request_id}`); UNIQUE index on `idempotencyKey`; `_find_existing_openclaw_user_request_log` for `occhat-` requestIds; IntegrityError catch-and-return.
- **Dispatch queue:** UNIQUE on `requestId`; IntegrityError rollback.
- **Plugin `message_received`:** Board sessions return early; channel sessions: `incomingKey` (messageId) + `inboundFingerprintKey` (content, 60 s TTL); `rememberIncoming(key, ttlMs)`.
- **Plugin `agent_end`:** Board/channel/heartbeat/subagent `role:user` skip or remap as documented above.
- **History ingest:** Channel-normalised idempotency key; skip board-session `role:user`; `[System Message]` re-attribution; identifier-based and fallback hash keys.
