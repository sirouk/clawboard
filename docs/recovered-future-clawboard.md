# Recovered: Future ClawBoard

Recovered on 2026-03-13 from the live ClawBoard Postgres database and local OpenClaw session context.

## What Was Recoverable

Topic:

- `Future ClawBoard`
- topic id: `topic-dd635861-1668-48b8-a251-6c4a69fe197b`
- space: `space-openclaw`
- created: `2026-03-10T04:27:57.362Z`

Linked legacy task:

- `Future ClawBoard`
- task id: `task-05f1b774-29ef-4299-a057-8c9a16048a23`

## Direct User-Authored Content

Only one clearly user-authored seed note was recoverable from the thread:

> Future of ClawBoard

Timestamp:

- `2026-03-10T04:27:57.805Z`

## Recovered Associated Idea Content

The main substantive content tied to that seed was a follow-up assistant message that appears to be expanding the idea into an architecture direction. The recovered substance is below.

### Core Problem

- Specialists have no durable, project-scoped learning store.
- They either start fresh every spawn or accumulate memory globally without isolation.

### Current Layers

- `Space`: highest-level container such as Work or Personal.
- `Topic`: project boundary such as Future ClawBoard.
- `Task`: atomic unit of work.
- `Specialist Session`: ephemeral execution context.
- `OpenClaw Memory`: long-term global semantic store.
- `workspace files / qmd`: persistent documents accessed manually.

### Proposed Architecture: Project-Scoped Specialist Memory

#### 1. Specialist Memory Scope Hierarchy

- `Project Memory`
  - topic-scoped
  - always injected when a specialist works on that topic
  - includes:
    - design decisions
    - patterns that worked
    - patterns that failed
    - project-specific conventions
    - key file/module maps

- `Cross-Project Pattern Memory`
  - global
  - queried on demand
  - includes:
    - abstracted patterns with no raw project context
    - "when X, try Y" heuristics
    - general problem-solving moves

- `Session Memory`
  - ephemeral
  - current task context
  - recent tool calls
  - scratchpad state

#### 2. Recall Flow

When a specialist works on a task in a topic:

1. Auto-inject the Project Memory for that topic.
2. On encountering a problem, allow a query to Cross-Project Pattern Memory.
3. Return abstracted patterns without irrelevant project details.

Key insight:

- Learning transfers.
- Distraction does not.

#### 3. Storage Mapping

- `Project Memory`
  - storage: ClawBoard topic-level records
  - scope: topic
  - access: auto-inject on spawn

- `Cross-Project Pattern Memory`
  - storage: ClawBoard pattern-indexed records
  - scope: global
  - access: query on demand

- `Session Memory`
  - storage: OpenClaw session state
  - scope: session
  - access: always in context

ClawBoard was framed here as the durable specialist memory layer, not just task tracking.

Suggested per-topic structured memory fields:

- `decision_log`
- `pattern_success`
- `pattern_failure`
- `convention_index`

#### 4. Workspace Integration

The recovered note also proposed a shared topic workspace folder used by spawned agents, with a hybrid model:

- file-based memory in docs such as:
  - `DECISIONS.md`
  - `PATTERNS.md`
  - `CONVENTIONS.md`
- tool-mediated structured memory stored in ClawBoard
- structured recall hitting ClawBoard
- exploratory / human-readable context living in the workspace

Framing:

- workspace = scratchpad and document layer
- ClawBoard = structured recall layer

#### 5. Open Questions Captured

- Who writes Project Memory: the specialist, a supervisor, or both?
- How should raw events be abstracted into reusable patterns?
- Does Project Memory decay or get pruned/compressed over time?
- Should cross-topic visibility be fully blocked, or allow an explicit "break glass" override?

## Important Caveat

I did not recover a longer user-written bullet list of ideas beyond the seed line `Future of ClawBoard`.

What survived was:

- the seed title / note
- one substantial architecture response associated with it
- later system / retrieval chatter mentioning the topic by name

So this file is a faithful recovery of what was actually recoverable, not a claim that the original full note set was preserved.
