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
- Non-board sessions can skip the Clawboard task write, but they still require the cron follow-up.

## Follow-Up Algorithm

After `sessions_spawn(...)`:
1. Save the returned `childSessionKey`.
2. If a board `taskId` exists, write/update the task with the delegation tags.
3. Schedule the first one-shot `cron.add` follow-up for `+1m`.

When a follow-up fires:
1. If a board `taskId` exists, check the task first. If it is already done, stop.
2. Call `sessions_history(childSessionKey)`.
3. If the specialist completed successfully:
   - relay the result to the user,
   - clear the delegation tags,
   - mark the task done when appropriate,
   - stop scheduling follow-ups.
4. If the specialist is still running:
   - send a progress update when elapsed time is greater than 5 minutes,
   - schedule the next rung on the ladder,
   - never extend beyond `1h`.
5. If the specialist session was lost or never produced a usable result:
   - re-spawn the same specialist with the same task goal,
   - update the Clawboard task tags with the new `session:<childSessionKey>`,
   - reset the ladder back to `1m`.
6. If the specialist failed terminally:
   - report the failure to the user,
   - clear delegation tags,
   - do not silently retry forever.

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
- Completed: summarize and deliver.
- Failed: say what failed and what happens next.
