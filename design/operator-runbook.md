# Clawboard Operator Runbook

This runbook is for operators who need to run Clawboard safely without changing code.

## Operating Goal

Keep memory capture, classification, and UI access continuously available for non-technical users.

## End-State Acceptance Criteria

- `docker compose up -d --build` starts `web`, `api`, `classifier`, and `qdrant` without manual edits.
- `http://localhost:3010` loads and users can open `/u`, `/log`, `/graph`, `/stats`, and `/setup`.
- New messages appear in `/log` and are classified into topic/task state within normal classifier cadence.
- Operators can create, edit, snooze, and complete tasks in `/u` using only UI actions.
- Recovery from restart preserves data from `./data`.
- CI check `required-gate` passes before merges to protected branches.

## First-Time Bring-Up

1. Prepare env file:
```bash
cp .env.example .env
```
2. Set `CLAWBOARD_TOKEN` in `.env` to a strong random value:
```bash
openssl rand -hex 32
```
3. Start services:
```bash
docker compose up -d --build
```
4. Verify:
- UI: `http://localhost:3010`
- API docs: `http://localhost:8010/docs`
- Setup page shows expected API base and token behavior.

## Daily Operator Checklist

1. Confirm UI loads and board search works on `/u`.
2. Confirm recent events appear on `/log`.
3. Confirm classifier health: new conversation lines transition from pending to classified.
4. Confirm one task can be opened and replied to in chat.
5. Confirm no unexpected read-only state in normal operator sessions.

## Weekly Reliability Checklist

1. Pull latest image/code and restart:
```bash
docker compose pull
docker compose up -d
```
2. Run tests:
```bash
npm run typecheck
npm run test:e2e
npm run test:visual
```
3. Verify disk usage for `./data` stays below local threshold.
4. Validate backup flow if enabled (see README backup section).

## Incident Playbooks

### UI unavailable

1. Check container status:
```bash
docker compose ps
```
2. Read logs:
```bash
docker compose logs --tail=200 web api classifier
```
3. Restart impacted services:
```bash
docker compose restart web api classifier
```

### Messages not classifying

1. Check classifier logs for errors/timeouts.
2. Confirm OpenClaw API reachability from classifier container.
3. Verify embedding dependencies are healthy (`fastembed`, qdrant connectivity).
4. Restart classifier:
```bash
docker compose restart classifier
```

### Read-only mode unexpectedly enabled

1. Confirm `CLAWBOARD_TOKEN` is set in `.env`.
2. Confirm browser token entry in `/setup` matches server token.
3. Refresh browser and retry write action.

### Search/Graph appears stale

1. Confirm new logs are arriving in `/log`.
2. Wait one classifier interval and re-check.
3. Restart `classifier` and `api` if state remains stale.

## Change-Control Guardrails

- Do not merge UI/backend changes unless CI `required-gate` is green.
- For visual changes, update baselines only with intentional design changes:
```bash
npm run test:visual:update
```
- Use PRs with screenshots for UX-impacting changes.

## Branch Protection Requirement

Set protected branches to require status check:

- `required-gate`

This single check already aggregates quality, e2e, and visual jobs from `.github/workflows/ci.yml`.
