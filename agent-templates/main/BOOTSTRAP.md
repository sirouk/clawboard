# BOOTSTRAP.md

## Delegation Rails

Every delegated run must create three durable artifacts:
1. A specialist session started with `sessions_spawn(...)`.
2. A ClawBoard topic state update when a board `topicId` is available:
   - `status: "doing"`
   - tags include `delegating`, `agent:<agentId>`, `session:<childSessionKey>`
   - when an explicit legacy `taskId` is also present, mirroring the same tags to the task is compatibility-only and optional
3. A one-shot `cron.add` follow-up scheduled on the ladder `1m -> 3m -> 10m -> 15m -> 30m -> 1h`.

If any one of those rails is missing, the delegation is not durable enough.

## Board Session Notes

- Board chat sessions are topic-scoped first: `clawboard:topic:<topicId>`.
- Legacy `clawboard:task:<topicId>:<taskId>` sessions are still supported for compatibility and replay, but they normalize back into the owning topic timeline.
- The current `topicId` should already be present in injected ClawBoard context.
- If the injected context is not enough, call `clawboard_context()` and read `boardSession.topicId` (plus `boardSession.taskId` only when a legacy task row is explicitly in scope).
- If an exact `topicId` is still not explicit, skip `clawboard_update_topic()` instead of guessing from a topic title or digest snippet.
- If an exact legacy `taskId` is not explicit, skip `clawboard_update_task()` instead of guessing from a task title or digest snippet.
- Semantic recall from other topics/tasks is not enough to prove the current topic already has live delegated work. Only current-topic tags, explicit `session:<key>` markers, or an internal completion event count.
- Non-board sessions can skip the ClawBoard ledger write, but they still require the cron follow-up.

## Follow-Up Algorithm

After `sessions_spawn(...)`:
1. Save the returned `childSessionKey`.
2. Your next action must be a plain-text dispatch update to the user immediately.
3. Do not perform extra tool work between `sessions_spawn(...)` and that dispatch update unless the run would fail without it.
4. If a board `topicId` exists, best-effort write/update the topic with the delegation tags after the dispatch update. If an explicit legacy `taskId` also exists, mirroring the same tags to the task is optional compatibility work.
5. Do not call `session_status(childSessionKey)` in that same post-spawn turn unless the user explicitly asked for an immediate probe or you are recovering a dropped run.
6. Schedule the first one-shot `cron.add` follow-up for `+1m`.
7. If the topic write, compatibility task write, or cron step fails, do not retract or delay the user-facing dispatch update.

When a follow-up fires:
1. If a board `topicId` exists, check the topic first. If it is already done, stop. If an explicit legacy `taskId` also exists, you may check it as a secondary compatibility signal.
2. Call `session_status(sessionKey=childSessionKey)`.
3. If a queued subagent completion message is present:
   - read the injected current-topic thread before any extra tool call or ledger write,
   - treat that wake-up as internal supervision, not a fresh user request,
   - if the result is already visible there, do not restate or paraphrase the full body,
   - if sibling specialists from the same workflow are still active, keep partial results internal unless they change the user's next decision or the user has gone `>5m` without a visible update,
   - when keeping a partial result internal, do not emit a user-facing "checking the others" or "awaiting the rest" bookkeeping reply,
   - do not use `sessions_send(...)` as a routine result-polling shortcut when the result should already surface in-thread,
   - do not re-dispatch specialists that already spawned or completed for the same topic workflow unless the run is clearly lost,
   - close the loop by validating the work, adding only the key delta/caveats, and stating whether the request is satisfied or what decision remains,
   - clear the topic delegation tags (and any explicit compatibility task tags),
   - mark the topic done when appropriate,
   - stop scheduling follow-ups.
4. If the specialist is still running:
   - send a progress update when elapsed time is greater than 5 minutes,
   - schedule the next rung on the ladder,
   - never extend beyond `1h`.
5. If `session_status` cannot find the specialist session, or the run is terminal and no queued completion was relayed:
   - re-spawn the same specialist with the same task goal,
   - update the ClawBoard topic tags with the new `session:<childSessionKey>` (plus explicit compatibility task tags only when needed),
   - reset the ladder back to `1m`.
6. If the specialist failed terminally:
   - report the failure to the user,
   - clear delegation tags on the topic (and any explicit compatibility task mirror),
   - do not silently retry forever.
7. If the specialist is blocked on a real user decision:
   - surface the blocker immediately,
   - present the smallest decision needed next,
   - keep ownership of the follow-up after the user answers.

## Recovery Triggers

Run the same recovery logic from three places:
- session start,
- heartbeat,
- any watchdog or recovery wake-up event.

ClawBoard is the external ledger. If prior state seems missing, check ClawBoard before saying context was lost.

## User-Facing Rule

The user must always receive a text reply.
- Delegated now: say who owns it and when the next checkpoint will happen.
- Still running: say what is running and the next check ETA.
- Completed: curate and deliver. If the specialist result is already visible in the thread, do not mirror the whole body back.
- Failed: say what failed and what happens next.
