# Clawboard SEED / Bootstrap Notes

This repo ships two pieces:

- **FastAPI backend** (port 8010 on host) — source of truth: topics, tasks, logs
- **Next.js web UI** (port 3010 on host)

## Token / Auth

If you set `CLAWBOARD_TOKEN`, **all write endpoints** require:

- Header: `X-Clawboard-Token: <token>`

Read endpoints (e.g. `/api/health`, `/api/config` GET, list endpoints) remain open.

### Docker Compose

The recommended setup is to store the token in `.env` and load it into the API container.

- Create `.env` (see `.env.example`)
- Compose loads it via `env_file:` in `docker-compose.yaml`

## Instance config

Set instance display name + integration level:

```bash
curl -X POST 'http://localhost:8010/api/config' \
  -H 'Content-Type: application/json' \
  -H 'X-Clawboard-Token: YOUR_TOKEN' \
  -d '{"title":"CK Claw","integrationLevel":"full"}'
```

`integrationLevel` values:
- `manual`
- `write`
- `full`

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
