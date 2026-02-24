# HEARTBEAT.md

## Active policy
- Heartbeat mode is active unless this file is emptied.

## Supervision cadence (required)
- Delegation follow-up ladder is fixed: `1m -> 3m -> 10m -> 15m -> 30m -> 1h`.
- Cap follow-up wait at `1h`.
- If elapsed runtime for a delegated run is `>5m`, send a "still in progress" user update with the next check ETA.

## Required heartbeat response
When the heartbeat fires:
1. **Read the Clawboard context already injected at the top of this prompt.** Any task with `status: "doing"` and a tag like `"session:<childSessionKey>"` is an in-flight delegation. Record its `taskId`, `childSessionKey`, and `agentId` (from `"agent:<id>"` tag) before calling any tools.
2. Call `sessions_list` to check for any active or recently completed sub-agent sessions.
3. For each session found:
   - If still running: report status, estimated completion, blockers, and the next check ETA from the ladder.
   - If completed but result not yet relayed: call `sessions_history` to get the result, then summarize it to Chris.
   - If completed and result delivered: no action needed.
4. Call `clawboard_search("delegating")` as a backup sweep for any in-flight delegation not already found in the injected context.
5. For each in-flight delegation, ensure a one-shot `cron.add` follow-up exists using the ladder `1m/3m/10m/15m/30m/1h` (reset to `1m` after respawn).
6. For each "doing" task with a `"session:<key>"` tag not matched in `sessions_list`: the delegation was lost. Call `clawboard_get_task(taskId)` to get the originalTask from the title, re-spawn with `sessions_spawn(agentId, originalTask)`, update Clawboard tags with the new session key, and `cron.add` a new follow-up at `+1m`.
7. If a delegated run has elapsed more than 5 minutes and is still running, send an explicit user-facing progress update now.
8. If nothing is active or pending: reply exactly `HEARTBEAT_OK`.

**Never skip the injected context check (step 1). It is the fastest, zero-tool-call recovery signal and works even after a gateway restart.**

## Follow-up contract
- If a sub-agent was spawned and its result has not been delivered yet, surface it now.
- Do not wait for Chris to ask again. If work is done, report it.
- If the sub-agent is still running and it has been more than 5 minutes, send a brief "still in progress" update and include the next ladder check ETA.

## Active recurring checks
- PR watch: `https://github.com/openclaw/openclaw/pull/4504`
- No fixed schedule unless you set one.

## Operating rule
- Do not wait for repeated prompts when work is open.
- Send timely updates at reasonable intervals or earlier if state changes.
- Completed work that has not been summarized to Chris = unfinished job. Fix it immediately.
