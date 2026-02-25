# Classification Test Matrix

This doc maps **classifier behavior** to the tests that cover it, so we can expand coverage without duplicating tests.

Snapshot date: `2026-02-25`

Canonical comprehensive matrix lives in `CLASSIFICATION.md` sections 16 and 17.
This file is a quick-lookup companion.

## End-State Spec

When a log enters Clawboard as `classificationStatus=pending`, the classifier must eventually transition it to one of:

- `classified`: log is usable in UI lists and is associated to a `topicId` (and optionally `taskId`) when semantic.
- `failed`: log is not semantically classifiable and should not stay pending forever.

For user-visible conversation logs, the classifier must also maintain:

- Stable ordering (we rely on `createdAt`, with deterministic tie-breaks server-side).
- A concise, non-empty `summary` suitable for list chips (`<= 56` chars).

## Acceptance Criteria

- `./tests.sh --skip-e2e` passes locally.
- `scripts/classifier_e2e_check.py` exercises:
  - Offworld sessions (sessionKey starts with `channel:` or includes `source.channel`).
  - Clawboard board sessions:
    - Topic scope: `clawboard:topic:<topicId>`
    - Task scope: `clawboard:task:<topicId>:<taskId>`
  - Mixed log scopes where actions/system/import appear between conversations and are patched in-scope.
- Filtering behaviors (commands, injected noise, memory tool noise) do not strand rows in `pending`.
- Filtering behaviors for control-plane and tool traces remain deterministic:
  - anchored tool traces => `classified` + `filtered_tool_activity`
  - unanchored tool traces => `failed` + `filtered_unanchored_tool_activity`
  - heartbeat/subagent scaffold control-plane payloads => terminal detached filters
- Unit tests cover the strict JSON contract and summary repair logic used when the LLM path is enabled.

## Defaults Assumed By Tests

- Board chat session keys are always in the form `clawboard:topic:<topicId>` or `clawboard:task:<topicId>:<taskId>`.
- Topic/task IDs referenced by Clawboard UI exist when using Task Chat.
- Non-board (“offworld”) threads may legitimately include `|thread:` suffixes.
- Classifier E2E runs in deterministic heuristic mode by default (`CLASSIFIER_LLM_MODE=off` in `tests.sh`).

## Edge Cases Covered

- If a Task Chat sessionKey references a task that was deleted, classifier patching should not crash the service.
- Classifier payload noise and context injection artifacts are detected and not treated as user intent.
- Slash-command style logs (e.g. `/new`) are filtered out as non-semantic.

## Agentic Runtime Coverage (Orchestration + Ingest)

These scenarios are exercised in backend runtime tests and included automatically in `./tests.sh` via backend unit discovery:

- Main-only direct completion closes run cleanly without subagent artifacts:
  - `backend/tests/test_orchestration_runtime.py::test_orch_007_main_only_assistant_reply_closes_run_without_subagents`
- Single-subagent supervision keeps `main.response` open until final main synthesis:
  - `backend/tests/test_orchestration_runtime.py::test_orch_003_main_response_does_not_close_while_subagent_still_active`
- Multi-subagent convergence requires all delegated items terminal before main completion:
  - `backend/tests/test_orchestration_runtime.py::test_orch_008_multi_subagent_run_requires_all_children_and_main_final`
- Duplicate spawn tool logs remain idempotent at orchestration item level:
  - `backend/tests/test_orchestration_runtime.py::test_orch_009_duplicate_spawn_actions_do_not_duplicate_subagent_items`
- Assistant replay dedupe across request-id collisions prefers payload match (prevents wrong cross-agent collapse):
  - `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_020h3_assistant_identifier_dedupe_prefers_content_match_over_first_candidate`
- Gateway history ingest skips both tagged and legacy context wrapper artifacts and advances cursor:
  - `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_020h4_history_ingest_skips_injected_context_artifacts_and_advances_cursor`
  - `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_020h5_history_ingest_skips_legacy_context_wrapper_artifacts_and_advances_cursor`

## Scenario Coverage

### Unit Tests (fast, no docker)

- Heuristics and bundling:
  - `classifier/tests/test_classifier_heuristics.py`
- Strict JSON schema validation for model responses:
  - `classifier/tests/test_strict_json.py`
- Board session routing invariants:
  - `classifier/tests/test_board_sessions.py`
- Summary repair path (LLM returns missing/low-signal summaries):
  - `classifier/tests/test_summary_repair.py`

### End-to-End Classifier Checks (docker services + real API)

Executed by `tests.sh` via `python3 scripts/classifier_e2e_check.py`.

- Small talk routes to a stable “Small Talk” topic (no task):
  - `scripts/classifier_e2e_check.py` scenario `small-talk`
- Topical conversation creates/chooses a high-signal topic (no task):
  - `scripts/classifier_e2e_check.py` scenario `topical-no-tasks`
- Task-oriented conversation creates/chooses a topic and a task:
  - `scripts/classifier_e2e_check.py` scenario `task-oriented`
- Assistant contamination does not hijack topic selection:
  - `scripts/classifier_e2e_check.py` scenario `assistant-contamination`
- Multi-bundle sessions can split into distinct topics:
  - `scripts/classifier_e2e_check.py` scenario `multi-bundle`
- Clawboard Topic Chat can be promoted into a Task (topic pinned, task inferred/created):
  - `scripts/classifier_e2e_check.py` scenario `board-topic-promote-task`
- Clawboard Topic Chat small-talk stays pinned to the selected topic (not rerouted to “Small Talk”):
  - `scripts/classifier_e2e_check.py` scenario `board-topic-smalltalk`
- Clawboard Task Chat stays fixed (classifier cannot reroute away from pinned task):
  - `scripts/classifier_e2e_check.py` scenario `board-task-fixed-scope`
- Filtering in-scope for mixed logs:
  - Command logs (`filtered_command`)
  - Noise logs (`classifier_payload_noise`, `context_injection_noise`)
  - Memory tool actions (`filtered_memory_action`)
  - System/import logs (`filtered_non_semantic`)
  - `scripts/classifier_e2e_check.py` scenario `filtering-mixed`
