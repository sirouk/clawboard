# Clawboard <-> OpenClaw Context Contract (Spec)

This document defines the **end-state contract** for how Clawboard provides **robust, efficient, bidirectional context** to the OpenClaw agent (and vice versa), at scale.

For "what exists today", see `CONTEXT.md`.

## Goals

- **Continuity without huge prompts**: handle ambiguity over long history without stuffing massive context into every run.
- **Cheap-by-default**: most turns should use a small, deterministic "working set" bundle; semantic recall is conditional.
- **Bidirectional improvement loop**:
  - OpenClaw emits conversation + tool activity into Clawboard (durable memory).
  - OpenClaw can *query and update* Clawboard through explicit tools (notes, task status, etc.).
- **Visibility-safe retrieval**: when a source space can be resolved, context/search is filtered to effective allowed spaces.
- **Production-safe defaults**: no noisy auditing enabled by default; stable retention/rotation where logs are enabled.
- **No retrieval pollution**: system metadata and injected context must not poison embeddings/search.

## Non-Goals (for this layer)

- A full "agentic planner" inside Clawboard.
- Unlimited context windows (this design assumes context cost matters).
- Provider-specific memory features beyond the OpenClaw plugin contract.

## Two-Layer Memory Contract

### Layer A: Always-On Continuity (Cheap)

Included on every turn (even very short user input) and designed to be stable and bounded:

- **Working set** (ranked, small):
  - pinned topics/tasks
  - tasks in `doing`/`blocked`
  - high priority / due-soon tasks
  - excludes archived/snoozed by default
- **Routing memory**:
  - the most recent topic/task matches for the current `sessionKey`
  - supports "marrying" new logs to the right topic/task even when the user is terse
- **Session timeline**:
  - last N conversation lines in the session (clipped)

### Layer B: Conditional Recall (More Expensive)

Included only when useful:

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
- `mode=auto`: Layer B only if the query has signal, plus low-signal board-session turns (`clawboard:topic|task`) where scoped continuity recall is intentionally enabled

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
- when source space is resolved, context and recall content are restricted to effective allowed spaces
- topic/task/log scope checks include tag-derived topic spaces, not only primary `spaceId`

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
- Tool trace actions and control-plane scaffolding must stay filtered from semantic continuity by default.
- Audit logging:
  - disabled by default in production
  - if enabled, must have rotation/retention to prevent unbounded growth

## Acceptance Criteria

### Functional

1. `GET /api/context` returns a non-empty `block` for normal usage and never exceeds `maxChars`.
2. `mode=cheap` includes Layer A (working set + routing memory + timeline) even for short `q`.
3. `mode=full` includes Layer B recall results (topics/tasks/logs/notes) when available.
4. OpenClaw plugin `before_agent_start` uses `/api/context` as the primary retrieval path and falls back safely when unavailable.
5. Agent tools are available to the main agent:
   - read tools: search/context/get_*
   - write tools: create_note/update_task
6. Topic/task digests can be updated by the classifier without reordering user lists (digest-only updates do not change `updatedAt`).

### Performance / Robustness

7. `/api/context` is bounded and does not perform unbounded scans proportional to total log count.
8. Very short turns do not stampede semantic recall by default (`mode=auto` stays cheap unless needed).

### Regression Safety

9. Existing `/api/search` behavior remains stable; `/api/context` is additive.
10. No feedback loop: injected prompt context is not re-logged or embedded as if it were user content.
