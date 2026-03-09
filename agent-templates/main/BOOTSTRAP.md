# BOOTSTRAP.md

## Delegation Rails

Every delegated run must create three durable artifacts:
1. A specialist session started with `sessions_spawn(...)`.
2. A Clawboard task state update when a board `taskId` is available:
   - `status: "doing"`
   - tags include `delegating`, `agent:<agentId>`, `session:<childSessionKey>`
3. A one-shot `cron.add` follow-up scheduled on the ladder `1m -> 3m -> 10m -> 15m -> 30m -> 1h`.

If any one of those rails is missing, the delegation is not durable enough.

## Board Session Notes

- Board chat sessions are task-scoped: `clawboard:task:<topicId>:<taskId>`.
- The current `taskId` should already be present in injected Clawboard context.
- If the injected context is not enough, call `clawboard_context()` and read `boardSession.taskId`.
- If an exact `taskId` is still not explicit, skip `clawboard_update_task()` instead of guessing from a task title or digest snippet.
- Semantic recall from other tasks is not enough to prove the current task already has live delegated work. Only current-task tags, explicit `session:<key>` markers, or an internal completion event count.
- Non-board sessions can skip the Clawboard task write, but they still require the cron follow-up.

## Follow-Up Algorithm

After `sessions_spawn(...)`:
1. Save the returned `childSessionKey`.
2. Your next action must be a plain-text dispatch update to the user immediately.
3. Do not perform extra tool work between `sessions_spawn(...)` and that dispatch update unless the run would fail without it.
4. If a board `taskId` exists, best-effort write/update the task with the delegation tags after the dispatch update.
5. Do not call `session_status(childSessionKey)` in that same post-spawn turn unless the user explicitly asked for an immediate probe or you are recovering a dropped run.
6. Schedule the first one-shot `cron.add` follow-up for `+1m`.
7. If the task write or cron step fails, do not retract or delay the user-facing dispatch update.

When a follow-up fires:
1. If a board `taskId` exists, check the task first. If it is already done, stop.
2. Call `session_status(sessionKey=childSessionKey)`.
3. If a queued subagent completion message is present:
   - read the injected current-task thread before any extra tool call or task write,
   - treat that wake-up as internal supervision, not a fresh user request,
   - if the result is already visible there, do not restate or paraphrase the full body,
   - do not re-dispatch specialists that already spawned or completed for the same task unless the run is clearly lost,
   - close the loop by validating the work, adding only the key delta/caveats, and stating whether the request is satisfied or what decision remains,
   - clear the delegation tags,
   - mark the task done when appropriate,
   - stop scheduling follow-ups.
4. If the specialist is still running:
   - send a progress update when elapsed time is greater than 5 minutes,
   - schedule the next rung on the ladder,
   - never extend beyond `1h`.
5. If `session_status` cannot find the specialist session, or the run is terminal and no queued completion was relayed:
   - re-spawn the same specialist with the same task goal,
   - update the Clawboard task tags with the new `session:<childSessionKey>`,
   - reset the ladder back to `1m`.
6. If the specialist failed terminally:
   - report the failure to the user,
   - clear delegation tags,
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

Clawboard is the external ledger. If prior state seems missing, check Clawboard before saying context was lost.

## User-Facing Rule

The user must always receive a text reply.
- Delegated now: say who owns it and when the next checkpoint will happen.
- Still running: say what is running and the next check ETA.
- Completed: curate and deliver. If the specialist result is already visible in the thread, do not mirror the whole body back.
- Failed: say what failed and what happens next.
