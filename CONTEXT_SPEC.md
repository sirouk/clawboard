# Clawboard <-> OpenClaw Context Contract (Spec)

This document defines the **end-state contract** for how Clawboard provides **robust, efficient, bidirectional context** to the OpenClaw agent (and vice versa), at scale.

For "what exists today", see `CONTEXT.md`.

## Goals

- **Continuity without huge prompts**: handle ambiguity over long history without stuffing massive context into every run.
- **Cheap-by-default**: most turns should use a small, deterministic "working set" bundle; semantic recall is conditional.
- **Bidirectional improvement loop**:
  - OpenClaw emits conversation + tool activity into Clawboard (durable memory).
  - OpenClaw can *query and update* Clawboard through explicit tools (notes, task status, etc.).
- **Visibility-safe retrieval**: context/search must respect Space-tag membership and Space visibility policy when a source space is known.
- **Production-safe defaults**: no noisy auditing enabled by default; stable retention/rotation where logs are enabled.
- **No retrieval pollution**: system metadata and injected context must not poison embeddings/search.

## Non-Goals (for this layer)

- A full "agentic planner" inside Clawboard.
- Unlimited context windows (this design assumes context cost matters).
- Provider-specific memory features beyond the OpenClaw plugin contract.

## Space Scope Contract (Space Tags + Visibility)

### Source Space Resolution

- `spaceId` query param is authoritative when provided.
- If `spaceId` is omitted, server may infer source space from `sessionKey` (recent logs, board session key routing, session routing memory).
- If no source space can be resolved, requests are unscoped for backward compatibility.

### Allowed Space Set

- Baseline visibility set for a source space:
  - include source space itself
  - apply explicit `source.connectivity[target]` overrides
  - if no override exists, fallback to `target.defaultVisible`
- If both `spaceId` and `allowedSpaceIds` are provided, effective set is intersection: `allowedSpaceIds ∩ baseline`.
- If only `allowedSpaceIds` is provided, use it as-is.

### Space Tag Mapping Rules

- Topic membership is `topic.spaceId` union tag-derived spaces from `topic.tags`.
- Tag parsing:
  - accept `space:<label>` and plain non-`system:` tags
  - normalize label to `space-<slug>`
  - `default|global|all|all-spaces` normalize to default space
- Topic create/update without explicit `spaceId` may derive ownership from first tag-derived space.
- Task/log scope inheritance:
  - task visible if own `task.spaceId` matches, or parent topic matches
  - log visible if own `log.spaceId` matches, or linked task/topic matches

## Two-Layer Memory Contract

### Layer A: Always-On Continuity (Cheap)

Included on every turn (even very short user input) and designed to be stable and bounded:

- all Layer A candidates are pre-filtered to effective allowed spaces when a source space is resolved
- **Working set** (ranked, small):
  - pinned topics/tasks
  - tasks in `doing`/`blocked`
  - high priority / due-soon tasks
  - excludes archived/snoozed by default
- **Routing memory**:
  - the most recent topic/task matches for the current `sessionKey`
  - supports "marrying" new logs to the right topic/task even when the user is terse
  - filtered by effective allowed-space scope before emission
- **Session timeline**:
  - last N conversation lines in the session (clipped)

### Layer B: Conditional Recall (More Expensive)

Included only when useful:

- all Layer B recall candidates are pre-filtered to effective allowed spaces when a source space is resolved
- hybrid recall (semantic + lexical) across:
  - topics
  - tasks
  - conversation logs
  - curated notes (high weight)
- optional topic/task digests (see below)

Triggering rules (default):

- `mode=cheap`: Layer A only
- `mode=full`: Layer A + Layer B
- `mode=patient`: Layer A + Layer B, but the server may use larger bounded recall limits (slower; best for planning)
- `mode=auto`: Layer B when query has signal, or for low-signal board-session turns (`clawboard:topic|task`) where scoped semantic recall helps continuity

## Server Endpoint: `GET /api/context`

### Purpose

Return a **prompt-ready**, size-bounded context block plus structured data for agent tooling/UI debugging.

### Inputs

- `sessionKey` (optional): continuity bucket
- `q` (optional): retrieval hint; may be empty for cheap continuity
- `spaceId` (optional): explicit source space for visibility resolution
- `allowedSpaceIds` (optional): explicit allowed space ids (comma-separated)
- `mode` (optional): `auto|cheap|full|patient` (default `auto`)
- `includePending` (optional): include unclassified logs when building context
- `maxChars` (optional): hard cap for returned `block`
- `workingSetLimit` (optional): bound Layer A working set
- `timelineLimit` (optional): bound Layer A timeline

### Outputs (response JSON)

- `ok: boolean`
- `sessionKey?: string`
- `q?: string`
- `mode: "auto"|"cheap"|"full"|"patient"`
- `layers: string[]` (emitted sections; examples: `A:working_set`, `A:routing_memory`, `A:timeline`, `A:board_session`, `B:semantic`)
- `block: string` (prompt-ready, clipped to `maxChars`)
- `data: object` (structured result: working set items, timeline rows, recall shortlist)

### Invariants

- `block.length <= maxChars` always
- bounded query execution (no unbounded scans)
- cacheable-by-key on the server side (implementation detail): `(sessionKey, q, mode, includePending, limits)`
- when source space is resolved, response content is restricted to the effective allowed-space set
- topic/task/log scope checks must include tag-derived topic spaces (not only primary `spaceId`)

## Agent Tools (OpenClaw plugin)

Expose explicit, auditable tools so context is not a one-way street:

- `clawboard_search(q, ...)` -> `/api/search`
- `clawboard_context(q?, mode?, ...)` -> `/api/context`
- `clawboard_get_topic(id)` -> `/api/topics/{id}`
- `clawboard_get_task(id)` -> `/api/tasks/{id}`
- `clawboard_get_log(id, includeRaw?)` -> `/api/log/{id}`
- `clawboard_create_note(relatedLogId, text, topicId?, taskId?)` -> `POST /api/log` (type=`note`)
- `clawboard_update_task(id, ...)` -> `PATCH /api/tasks/{id}`

Tool design constraints:

- strong parameter validation and safe defaults
- tools should return small JSON by default (avoid dumping giant raw payloads)
- current plugin tool wrappers may rely on `sessionKey`-based space inference rather than explicit `spaceId/allowedSpaceIds` controls

## Digests (Topic/Task "Compressed Memory")

### Concept

Each topic/task can hold a short **digest** that compresses long history into stable facts and current status.

### Requirements

- digest writes are **system-managed**:
  - `createdBy="classifier"` metadata (or equivalent internal field)
  - optional hidden UI tag `system:classified` is allowed, but **must be excluded** from embedding/index text
- digest-only updates must **not** bump user-facing `updatedAt` (avoid reordering lists)
- digest should be updated opportunistically:
  - minimum interval (default 15 minutes)
  - per-cycle budget to avoid churn
  - LLM path when available; heuristic fallback otherwise

## Safety / Quality

- Injected context blocks must be sanitized out of logs before re-ingestion.
- Reserved/system tags must not pollute embeddings or search ranking.
- Audit logging:
  - disabled by default in production
  - if enabled, must have rotation/retention to prevent unbounded growth

## Acceptance Criteria

### Functional

1. `GET /api/context` returns a non-empty `block` for normal usage and never exceeds `maxChars`.
2. `mode=cheap` includes Layer A (working set + routing memory + timeline) even for short `q`.
3. `mode=full` includes Layer B recall results (topics/tasks/logs/notes) when available.
4. OpenClaw plugin `before_agent_start` uses `/api/context` as the retrieval path (no legacy client-side reconstruction fallback).
5. Agent tools are available to the main agent:
   - read tools: search/context/get_*
   - write tools: create_note/update_task
6. Topic/task digests can be updated by the classifier without reordering user lists (digest-only updates do not change `updatedAt`).
7. When a source space is resolved (`spaceId` or inferable `sessionKey`), `/api/context` and `/api/search` exclude topics/tasks/logs outside the effective allowed-space set.
8. Topic scope evaluation includes both primary `topic.spaceId` and tag-derived spaces from `topic.tags`.

### Performance / Robustness

9. `/api/context` is bounded and does not perform unbounded scans proportional to total log count.
10. Very short turns do not stampede semantic recall by default (`mode=auto` stays cheap unless needed), except scoped board-session continuity turns where semantic recall is intentionally enabled.

### Regression Safety

11. Existing `/api/search` behavior remains stable; `/api/context` is additive.
12. No feedback loop: injected prompt context is not re-logged or embedded as if it were user content.
