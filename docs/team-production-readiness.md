# Team-Production Readiness

This milestone is about team-production reliability, not public-launch polish.

## Scorecard

Run the baseline smoke:

```bash
node scripts/team_production_readiness_smoke.mjs
```

Required gates:

| Gate | Target | Source |
| --- | --- | --- |
| Warm `/u` load | `<= 3s` | `scripts/team_production_readiness_smoke.mjs` |
| Same-origin `resolve-board-send` | `<= 2s` | `scripts/team_production_readiness_smoke.mjs` |
| Same-origin chat queue accept | `<= 1s` | `scripts/team_production_readiness_smoke.mjs` |
| Direct backend chat queue accept | `<= 1s` | `scripts/team_production_readiness_smoke.mjs` |
| Canonical topic-thread read | `<= 1.5s` | `scripts/team_production_readiness_smoke.mjs` |
| Topic continuity after follow-up | both sends visible in one topic timeline | `scripts/team_production_readiness_smoke.mjs` |
| Same-origin proxy ownership | explicit FastAPI shims only | `node --test tests/scripts/api-ownership.test.mjs` |
| Type safety | clean | `pnpm exec tsc --noEmit` |
| Replay/reconnect repair | no stale UI after disconnect | `playwright test tests/e2e/sse-recovery.spec.ts` |

## Contract

- ClawBoard owns durable topic continuity, replay cursors, operator-visible provenance, and the canonical topic timeline.
- OpenClaw owns execution, delegation, tool use, and ephemeral reasoning.
- The top unified composer is topic-first:
  - no selection starts a topic
  - selecting a topic continues a topic
  - selecting a task match resolves to its parent topic
- Legacy task rows and `clawboard:task:*:*` session keys remain compatibility-only for replay, lower task-chat surfaces, and historical data.
- `sessionKey` remains the write/cancel lineage key for `POST` and `DELETE /api/openclaw/chat`.
- The operator read model is the canonical topic-thread endpoint: `GET /api/topics/{topicId}/thread`.

## Acceptance Criteria

- Same-origin sends no longer depend on bespoke proxy behavior; all OpenClaw proxy routes share the common proxy helper.
- Refresh/reconnect rebuilds the same operator-visible topic thread from the canonical topic-thread API plus SSE deltas.
- Main-agent materials and bootstrap/setup scripts teach topic-first delegation rails, while allowing explicit legacy task mirroring only as compatibility work.
- Tooling/config allow the main agent to use topic ledger tools directly: `clawboard_update_topic` and `clawboard_get_topic`.
- Specialist docs instruct repo resolution from configured workspaces and explicitly forbid guessing a bare home-directory checkout.

## Follow-On Work

- Promote the readiness smoke into CI once the live environment variables are standardized.
- Extend the smoke to measure indexing latency and retrieval quality once the QMD/Obsidian lane is observable enough to gate automatically.
- Add a dedicated replay-reset probe once the SSE contract exposes a stable invalid-cursor test hook outside internal endpoints.
