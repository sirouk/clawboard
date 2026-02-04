# Clawboard

Clawboard is a local-first companion for OpenClaw. It keeps topics, tasks, and an append-only activity log in one place so you can always resume where you left off.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000` (or `http://localhost:3010` if running via Docker Compose).

## Configuration

- `CLAWBOARD_TOKEN`: if set, write actions require the matching `X-Clawboard-Token` header.
- `NEXT_PUBLIC_CLAWBOARD_API_BASE`: base URL for the FastAPI backend (e.g. `http://localhost:8010`).
- `CLAWBOARD_DB_URL`: database URL for FastAPI (defaults to `sqlite:///./data/clawboard.db`).

Clawboard does not read local JSON for runtime data. All UI data is fetched from the FastAPI-backed SQLite database.
Live updates use an SSE stream (`/api/stream`) so OpenClaw writes are reflected instantly without manual refresh.
The UI will reconcile on reconnect using `/api/changes?since=...` to avoid missing events if the stream blips.

## FastAPI backend (recommended)

The backend API now lives in FastAPI (Swagger docs at `http://localhost:8010/docs`).
By default it uses SQLite at `./data/clawboard.db` and supports the same schema as the UI.
The Next.js API routes have been removed; set `NEXT_PUBLIC_CLAWBOARD_API_BASE` for the UI to function.

## Tests (Playwright)

Install browsers once:

```bash
npx playwright install
```

Run the full suite (auto-starts the dev server on port 3050):

```bash
npm run test
```

Playwright uses `tests/fixtures/portal.json` as its data source for deterministic UI assertions.
To load demo data into the SQLite database:

```bash
bash deploy.sh demo-load
```

To clear demo data:

```bash
bash deploy.sh demo-clear
```

## OpenClaw skill

This repo ships a `skills/clawboard` folder for OpenClaw.

```bash
mkdir -p ~/.openclaw/skills
cp -R skills/clawboard ~/.openclaw/skills/clawboard
```

Then point your OpenClaw instance at the Clawboard base URL and token (if required).

## Docker compose (web + api)

```bash
docker compose up -d --build
```

Compose maps the web UI to `http://localhost:3010` and the API to `http://localhost:8010`.

Or use the helper:

```bash
bash deploy.sh
```

## Chutes provider bootstrap (optional)

Self-contained installer (no repo cloning):

```bash
curl -fsSL https://raw.githubusercontent.com/sirouk/Clawboard/main/inference-providers/add_chutes.sh | bash
```

PowerShell (requires Git Bash or WSL):

```powershell
iwr -useb https://raw.githubusercontent.com/sirouk/Clawboard/main/inference-providers/add_chutes.sh | bash
```

Model list refresh:
- The installer creates `~/.openclaw/update_chutes_models.sh`.
- A cron job runs it every 4 hours (if `crontab` is available).
- You can run it manually at any time to refresh Chutes models.

## OpenClaw logger plugin (always-on)

Install the plugin to capture every turn (user input, assistant reply, tool calls):

```bash
openclaw plugins install -l /path/to/clawboard/extensions/clawboard-logger
openclaw plugins enable clawboard-logger
```

Set plugin config in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "clawboard-logger": {
        "enabled": true,
        "config": {
          "baseUrl": "http://clawboard:3000",
          "token": "YOUR_TOKEN"
        }
      }
    }
  }
}
```

## API quick test

```bash
curl -X POST http://localhost:3000/api/topics \
  -H 'Content-Type: application/json' \
  -H 'X-Clawboard-Token: YOUR_TOKEN' \
  -d '{"name":"Clawboard"}'
```
