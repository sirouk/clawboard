# Clawboard

Clawboard is a local-first companion for OpenClaw. It keeps topics, tasks, and an append-only activity log in one place so you can always resume where you left off.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Configuration

- `CLAWBOARD_TOKEN`: if set, write actions require the matching `X-Clawboard-Token` header.
- `CLAWBOARD_DATA_PATH`: JSON storage path (defaults to `./data/portal.json`).
- `NEXT_PUBLIC_CLAWBOARD_API_BASE`: base URL for the FastAPI backend (e.g. `http://localhost:8000`).
- `CLAWBOARD_DB_URL`: database URL for FastAPI (defaults to `sqlite:///./data/clawboard.db`).

## FastAPI backend (recommended)

The backend API now lives in FastAPI (Swagger docs at `http://localhost:8000/docs`).
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
To load fixtures locally into `data/portal.json`, run:

```bash
bash tests/load_or_remove_fixtures.sh load
```

To remove them:

```bash
bash tests/load_or_remove_fixtures.sh remove
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
