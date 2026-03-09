# Clawboard SEED / Bootstrap Notes

This repo ships two pieces:

- **FastAPI backend** (port 8010 on host) — source of truth: topics, tasks, logs
- **Next.js web UI** (port 3010 on host)

## Token / Auth

If you set `CLAWBOARD_TOKEN`, **all write endpoints** require:

- Header: `X-Clawboard-Token: <token>`

Read endpoints (e.g. `/api/health`, `/api/config` GET, list endpoints) remain open.

### Docker Compose

The recommended setup is to store settings in `.env` and load them into containers.

- Create `.env` (see `.env.example`)
- Compose loads it via `env_file:` in `docker-compose.yaml`

**Important for remote access:** the web UI now prefers the same-origin `/api/*` proxy
when no explicit browser API base is configured. That is the safest default.

Only set `NEXT_PUBLIC_CLAWBOARD_API_BASE` / `CLAWBOARD_PUBLIC_API_BASE` when you intentionally
want direct browser-to-API traffic. If you point that value at `http://localhost:8010`,
remote browsers will try to call *their own* localhost.

For direct remote API access, set `CLAWBOARD_PUBLIC_API_BASE` in `.env` to a reachable host, e.g.
`https://clawboard.example.test:8010`.

## Instance config

Set instance display name + integration level:

```bash
curl -X POST 'http://localhost:8010/api/config' \
  -H 'Content-Type: application/json' \
  -H 'X-Clawboard-Token: YOUR_TOKEN' \
  -d '{"title":"Clawboard Instance","integrationLevel":"full"}'
```

`integrationLevel` values:
- `manual`
- `write`
- `full`

The canonical installer is `scripts/bootstrap_clawboard.sh`.
`scripts/bootstrap_openclaw.sh` remains as a backward-compatible wrapper.

Installer defaults to `full` unless you pass `--integration-level` (or `--no-backfill`) to `scripts/bootstrap_clawboard.sh`.

## Minimal connectivity checks

```bash
curl -sS http://localhost:8010/api/health
curl -sS http://localhost:8010/api/config
curl -sS 'http://localhost:8010/api/log?limit=5'
```

## OpenClaw logger plugin (high level)

OpenClaw should be configured with:
- `plugins.allow` includes `clawboard-logger` (if allowlist is present)
- `plugins.entries.clawboard-logger.config.baseUrl = http://localhost:8010`
- `plugins.entries.clawboard-logger.config.token = <token>` (when tokenRequired)
- restart the gateway
