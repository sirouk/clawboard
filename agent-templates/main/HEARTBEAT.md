# HEARTBEAT.md

## Active policy
- Heartbeat mode is active unless this file is emptied.

## Supervision cadence (required)
- Delegation follow-up ladder is fixed: `1m -> 3m -> 10m -> 15m -> 30m -> 1h`.
- Cap follow-up wait at `1h`.
- If elapsed runtime for a delegated run is `>5m`, send a "still in progress" user update with the next check ETA.
- Do not send another status-only update if nothing materially changed and the last visible status for that task was less than 5 minutes ago.

## Required heartbeat response
When the heartbeat fires:
1. **Read the Clawboard context already injected at the top of this prompt.** Any task with `status: "doing"` and a tag like `"session:<childSessionKey>"` is an in-flight delegation. Record its `taskId`, `childSessionKey`, and `agentId` (from `"agent:<id>"` tag) before calling any tools.
2. For each recorded `childSessionKey`, call `session_status`.
3. For each delegated run:
    - If `session_status` shows it is still running: report status, blockers, and the next check ETA from the ladder.
   - If a queued subagent completion message is present: treat it as an internal supervision wake-up, not a fresh user ask. Read the injected current-task thread first. If the result is already visible there, do not restate the full body, do not use `sessions_send(...)` just to ask for the same result again, and do not re-dispatch specialists already tied to that task. If sibling specialists from the same workflow are still active, keep the partial result internal unless it changes the user's next decision or the user has gone `>5m` without a visible update. Do not send a user-facing message that only says you are checking or waiting on the other specialists. Close the loop with validation, key delta/caveats, and a clear satisfied-or-blocked status before any extra tool call or task write.
   - If the run is already completed and you have already relayed the result: no action needed.
4. Call `clawboard_search("delegating")` as a backup sweep for any in-flight delegation not already found in the injected context.
5. For each in-flight delegation, ensure a one-shot `cron.add` follow-up exists using the ladder `1m/3m/10m/15m/30m/1h` (reset to `1m` after respawn).
6. For each "doing" task with a `"session:<key>"` tag whose `session_status` lookup is missing, failed, or clearly terminal without a relayed result: the delegation was lost. Call `clawboard_get_task(taskId)` to get the originalTask from the title, re-spawn with `sessions_spawn(agentId, originalTask)`, update Clawboard tags with the new session key, and `cron.add` a new follow-up at `+1m`.
7. If a delegated run has elapsed more than 5 minutes and is still running, send an explicit user-facing progress update now.
8. If a delegated run is blocked on missing constraints or a real user decision, surface that blocker immediately instead of waiting for another heartbeat.
9. If nothing is active or pending: reply exactly `HEARTBEAT_OK`.

**Never skip the injected context check (step 1). It is the fastest, zero-tool-call recovery signal and works even after a gateway restart.**

## Follow-up contract
- If a sub-agent was spawned and its result has not been delivered yet, surface it now.
- If the result is already visible in the task thread, do not parrot it back. Add only the supervisor delta: validation, caveats, or the next decision.
- If sibling specialists from the same workflow are still active, do not emit another status-only user update for each partial completion unless there is a new blocker, a user decision is needed, or `>5m` have elapsed since the last visible status.
- When a partial completion stays internal, the preferred next action is no user-facing text. Routine supervision belongs in `session_status(...)`, not in another visible bookkeeping reply.
- Do not wait for the user to ask again. If work is done, report it.
- If the sub-agent is still running and it has been more than 5 minutes, send a brief "still in progress" update and include the next ladder check ETA.
- If the last visible status update is newer than 5 minutes and nothing materially changed, do not send another status-only update yet.
- If the sub-agent needs a user decision to proceed, ask for that decision now.

## Active recurring checks
- PR watch: `https://github.com/openclaw/openclaw/pull/4504`
- No fixed schedule unless you set one.

## Operating rule
- Do not wait for repeated prompts when work is open.
- Send timely updates at reasonable intervals or earlier if state changes.
- Completed work that has not been summarized to the user = unfinished job. Fix it immediately.
