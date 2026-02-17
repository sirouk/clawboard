# Classification Coverage Matrix

This matrix maps every normative scenario in `CLASSIFICATION.md` section 14 to current automated evidence.

Snapshot date: `2026-02-17`

Trace-level companion:
- `CLASSIFICATION_TRACE_MATRIX.md` confirms path-level trace coverage for all scenarios: `77/77` (`100.0%`).

Status legend:
- `Covered`: deterministic automated assertion exists for the scenario outcome.
- `Partial`: automated tests touch the path but do not assert the full contract.
- `Gap`: no deterministic automated assertion found.

## Coverage Summary

| Family | Covered | Partial | Gap | Total |
|---|---:|---:|---:|---:|
| ING | 20 | 0 | 0 | 20 |
| CLS (Scheduling/Bundling) | 16 | 0 | 0 | 16 |
| CLS (Decision/Guardrails) | 13 | 0 | 0 | 13 |
| FIL | 8 | 0 | 0 | 8 |
| SRCH | 12 | 0 | 0 | 12 |
| CHAT | 8 | 0 | 0 | 8 |
| **Total** | **77** | **0** | **0** | **77** |

Automated behavior full-coverage gate status: `MET` (`77/77` covered).

## ING Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| ING-001 | `message_received` user conversation is appended with dedupe metadata | `extensions/clawboard-logger/behavior.test.mjs` `message_received logs user conversation with dedupe metadata (ING-001)` | Covered |
| ING-002 | `message_sending` assistant row appended; duplicate `message_sent` row avoided | `extensions/clawboard-logger/behavior.test.mjs` `message_sending logs assistant row; message_sent does not duplicate it (ING-002)` | Covered |
| ING-003 | tool call start emits `action` log (`Tool call:`) | `extensions/clawboard-logger/behavior.test.mjs` `before_tool_call emits action log with tool call summary (ING-003)` | Covered |
| ING-004 | tool result/error emits `action` log (`Tool result:`/`Tool error:`) | `extensions/clawboard-logger/behavior.test.mjs` `after_tool_call emits action log for result and error (ING-004)` | Covered |
| ING-005 | `agent_end` fallback captures assistant output when send hooks miss | `extensions/clawboard-logger/behavior.test.mjs` `agent_end fallback captures assistant output when send hooks are absent (ING-005)` | Covered |
| ING-006 | board-session user echo from OpenClaw is skipped (no double log) | `extensions/clawboard-logger/behavior.test.mjs` `board-session user message echo is skipped to avoid double logging (ING-006)` | Covered |
| ING-007 | ignore-session prefixes prevent writes | `extensions/clawboard-logger/behavior.test.mjs` `ignored internal session prefixes do not write logs (ING-007)` | Covered |
| ING-008 | classifier payload/control blobs are skipped in logger path | `extensions/clawboard-logger/behavior.test.mjs` `classifier/control payload text is suppressed in logging hooks (ING-008)` | Covered |
| ING-009 | injected context blocks are stripped before persistence | `extensions/clawboard-logger/behavior.test.mjs` `injected context blocks are stripped before persistence (ING-009)` | Covered |
| ING-010 | transient send failures retry, then durable local queue spill | `extensions/clawboard-logger/behavior.test.mjs` `send failures spill to durable queue and replay keeps idempotency key (ING-010, ING-011)` | Covered |
| ING-011 | durable queue replay reuses same idempotency key | `extensions/clawboard-logger/behavior.test.mjs` `send failures spill to durable queue and replay keeps idempotency key (ING-010, ING-011)` | Covered |
| ING-012 | idempotency key enforces exact-once append behavior | `backend/tests/test_idempotency.py::test_append_log_dedupes_on_x_idempotency_key` | Covered |
| ING-013 | fallback dedupe by source message/request id when key missing | `backend/tests/test_idempotency.py::test_append_log_dedupes_on_source_message_id_when_key_missing` | Covered |
| ING-014 | board scope metadata-only source is normalized into canonical scope fields | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_014_source_scope_metadata_is_normalized` | Covered |
| ING-015 | task/topic mismatch is corrected to task authority | `backend/tests/test_append_log_entry.py::test_append_log_aligns_topic_to_task` | Covered |
| ING-016 | cron-event ingest is terminal filtered + detached | `backend/tests/test_append_log_entry.py::test_append_log_filters_cron_event_logs` | Covered |
| ING-017 | conversation activity revives snoozed topic/task | `backend/tests/test_unsnooze_on_activity.py::test_conversation_revives_snoozed_topic_and_task` | Covered |
| ING-018 | queue ingest mode writes `IngestQueue` and worker drains statuses | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_018_queue_ingest_and_worker_drain` | Covered |
| ING-019 | SQLite lock during ingest follows bounded retry/backoff | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_019_append_retries_sqlite_lock_then_commits` | Covered |
| ING-020 | assistant append publishes `openclaw.typing=false` | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_ing_020_assistant_append_publishes_typing_false` | Covered |

## CLS Scheduling and Bundling Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| CLS-001 | no pending conversations -> cleanup-only path | `classifier/tests/test_classifier_failure_paths.py::test_cls_001_no_pending_conversations_uses_cleanup_only_path` | Covered |
| CLS-002 | cron events in pending set are terminal-filtered without routing | `classifier/tests/test_cron_event_filtering.py::test_classify_session_filters_cron_event_logs_without_routing` | Covered |
| CLS-003 | oldest pending conversation anchor selected first | `classifier/tests/test_classifier_additional_coverage.py::test_cls_003_oldest_pending_bundle_is_classified_first` | Covered |
| CLS-004 | assistant anchor backtracks to nearest prior user turn | `classifier/tests/test_classifier_heuristics.py::test_bundle_range_backtracks_from_assistant_to_prior_user_turn` | Covered |
| CLS-005 | affirmation anchor backtracks to prior non-affirmation intent | `classifier/tests/test_classifier_heuristics.py::test_bundle_range_backtracks_from_affirmation_to_prior_user_intent` | Covered |
| CLS-006 | boundary split when assistant responded and new user intent begins | `classifier/tests/test_classifier_heuristics.py::test_bundle_range_splits_on_new_user_request_after_assistant` | Covered |
| CLS-007 | interleaved rows are patched in-scope consistently | `scripts/classifier_e2e_check.py` scenarios `multi-bundle`, `board-task-fixed-scope` | Covered |
| CLS-008 | task-scoped board session is hard-pinned | `classifier/tests/test_board_sessions.py::test_classify_session_task_scope_keeps_task_fixed`; `scripts/classifier_e2e_check.py` `board-task-fixed-scope` | Covered |
| CLS-009 | topic-scoped board session pins topic while allowing task inference | `classifier/tests/test_board_sessions.py::test_classify_session_topic_scope_can_promote_to_task_without_moving_topic`; `scripts/classifier_e2e_check.py` `board-topic-promote-task` | Covered |
| CLS-010 | subagent session inherits latest classified scope | `classifier/tests/test_board_sessions.py::test_subagent_session_with_existing_task_scope_stays_pinned` | Covered |
| CLS-011 | low-signal follow-up can force continuity scope | `classifier/tests/test_session_routing_continuity.py::test_low_signal_followup_forces_continuity_topic_in_llm_mode` | Covered |
| CLS-012 | explicit "new thread/topic" cue suppresses continuity forcing | `classifier/tests/test_classifier_additional_coverage.py::test_cls_012_explicit_new_thread_suppresses_continuity_forcing` | Covered |
| CLS-013 | small-talk fast path routes to stable small-talk scope | `classifier/tests/test_classifier_additional_coverage.py::test_cls_013_small_talk_fast_path_uses_stable_small_talk_topic` | Covered |
| CLS-014 | user-only retrieval text used to avoid assistant contamination | `classifier/tests/test_classifier_additional_coverage.py::test_cls_014_retrieval_text_prefers_user_turns` | Covered |
| CLS-015 | ambiguous low-signal bundle can use continuity anchor augmentation | `classifier/tests/test_session_routing_continuity.py::test_low_signal_followup_forces_continuity_topic_in_llm_mode` | Covered |
| CLS-016 | max-attempts guard prevents endless retries | `classifier/tests/test_classifier_failure_paths.py::test_cls_016_max_attempts_guard_prevents_reprocessing` | Covered |

## CLS Decision and Guardrail Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| CLS-020 | valid strict JSON LLM output is accepted | `classifier/tests/test_strict_json.py::test_validate_classifier_result_happy_path`; `classifier/tests/test_board_sessions.py` LLM-path tests | Covered |
| CLS-021 | malformed LLM output triggers deterministic repair pass | `classifier/tests/test_classifier_failure_paths.py::test_cls_021_call_classifier_repairs_malformed_output_once` | Covered |
| CLS-022 | LLM timeout/error falls back to heuristic classification | `classifier/tests/test_classifier_failure_paths.py::test_cls_022_llm_timeout_falls_back_to_heuristic_classifier` | Covered |
| CLS-023 | forced-topic fallback stays pinned when LLM fails | `classifier/tests/test_classifier_failure_paths.py::test_cls_023_forced_topic_stays_pinned_when_llm_times_out` | Covered |
| CLS-024 | clear topical intent can create/reuse non-generic topic correctly | `classifier/tests/test_classifier_heuristics.py::test_topical_conversation_no_tasks_allows_topic_creation`; `scripts/classifier_e2e_check.py` `topical-no-tasks` | Covered |
| CLS-025 | anti-dup guardrail reuses strong lexical candidate over weak create | `classifier/tests/test_classifier_failure_paths.py::test_cls_025_guardrail_reuses_strong_candidate_over_new_topic` | Covered |
| CLS-026 | creation gate block suppresses create or reuses existing id | `classifier/tests/test_classifier_failure_paths.py::test_cls_026_creation_gate_block_reuses_existing_topic_id` | Covered |
| CLS-027 | task id from foreign topic is rejected | `classifier/tests/test_summary_repair.py::test_task_guardrail_ignores_task_id_from_other_topic` | Covered |
| CLS-028 | no task intent -> task cleared/null | `classifier/tests/test_classifier_heuristics.py::test_small_talk_has_no_task_intent`; `scripts/classifier_e2e_check.py` `small-talk` | Covered |
| CLS-029 | task intent with low confidence uses continuity/controlled create | `classifier/tests/test_classifier_additional_coverage.py::test_cls_029_task_intent_low_confidence_reuses_continuity_task` | Covered |
| CLS-030 | missing summaries repaired, then concise fallback if needed | `classifier/tests/test_summary_repair.py::test_classify_session_repairs_missing_summaries` | Covered |
| CLS-031 | unrecoverable path increments attempts and progresses terminally | `classifier/tests/test_classifier_failure_paths.py::test_cls_031_unrecoverable_path_marks_terminal_failure` | Covered |
| CLS-032 | continuity decisions are appended to session routing memory | `classifier/tests/test_classifier_additional_coverage.py::test_cls_032_classification_appends_session_routing_memory` | Covered |

## FIL Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| FIL-001 | command conversation -> `classified` + `filtered_command` | `classifier/tests/test_board_sessions.py::test_unlocked_command_logs_do_not_inherit_topic_scope`; `scripts/classifier_e2e_check.py` `filtering-mixed` | Covered |
| FIL-002 | system/import row -> `classified` + `filtered_non_semantic` | `scripts/classifier_e2e_check.py` scenarios `filtering-mixed`, `board-task-fixed-scope` | Covered |
| FIL-003 | memory action row -> `classified` + `filtered_memory_action` | `scripts/classifier_e2e_check.py` scenarios `filtering-mixed`, `board-task-fixed-scope` | Covered |
| FIL-004 | cron row -> `failed` + `filtered_cron_event` detached | `classifier/tests/test_cron_event_filtering.py`; `backend/tests/test_append_log_entry.py::test_append_log_filters_cron_event_logs` | Covered |
| FIL-005 | classifier payload artifact -> `failed` + `classifier_payload_noise` | `classifier/tests/test_classifier_failure_paths.py::test_fil_005_and_fil_006_noise_error_code_specific_branches` | Covered |
| FIL-006 | context injection artifact -> `failed` + `context_injection_noise` | `classifier/tests/test_classifier_failure_paths.py::test_fil_005_and_fil_006_noise_error_code_specific_branches` | Covered |
| FIL-007 | other conversation noise -> `failed` + `conversation_noise` | `classifier/tests/test_classifier_failure_paths.py::test_fil_007_noise_error_code_defaults_to_conversation_noise` | Covered |
| FIL-008 | fallback semantic route -> `classified` + `fallback:<reason>` | `classifier/tests/test_classifier_failure_paths.py::test_fil_008_fallback_route_sets_fallback_error_code` | Covered |

## SRCH and Context Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| SRCH-001 | `/api/context` auto + low-signal query skips semantic layer | `backend/tests/test_context_endpoint.py::test_context_auto_low_signal_skips_semantic_layer` | Covered |
| SRCH-002 | `/api/context` full/patient force semantic layer | `backend/tests/test_context_endpoint.py::test_context_full_includes_semantic`; `backend/tests/test_context_endpoint.py::test_context_patient_includes_semantic` | Covered |
| SRCH-003 | board-session context surfaces active board scope first | `backend/tests/test_context_endpoint.py::test_context_board_session_surfaces_active_task` | Covered |
| SRCH-004 | `/api/search` gate saturation returns degraded busy fallback | `backend/tests/test_search_endpoint.py::test_search_busy_falls_back_to_degraded_mode`; `backend/tests/test_search_endpoint.py::test_search_uses_degraded_fallback_when_gate_is_busy` | Covered |
| SRCH-005 | degraded fallback disables deep scans and tightens limits | `backend/tests/test_search_endpoint.py::test_search_busy_falls_back_to_degraded_mode` | Covered |
| SRCH-006 | default semantic filters exclude command/tool/non-semantic noise | `backend/tests/test_vector_search.py::test_semantic_search_excludes_slash_command_logs`; `backend/tests/test_vector_search.py::test_semantic_search_excludes_tool_call_logs_by_default`; `backend/tests/test_vector_search.py::test_semantic_search_excludes_system_and_import_logs_by_default`; `backend/tests/test_vector_search.py::test_semantic_search_excludes_memory_action_logs_by_default` | Covered |
| SRCH-007 | parent propagation boosts topic/task scores from matched children | `backend/tests/test_search_endpoint.py::test_search_caps_log_propagation_for_topics`; `backend/tests/test_search_endpoint.py::test_search_uses_task_signal_to_lift_parent_topic` | Covered |
| SRCH-008 | linked notes are emitted and weighted in retrieval output | `backend/tests/test_search_endpoint.py::test_search_linked_notes_are_emitted_and_weight_scores` | Covered |
| SRCH-009 | SSE drop/stall recovers with reconnect + `/api/changes` reconciliation | `backend/tests/test_stream_replay.py::test_reconnect_plus_changes_reconcile_recovers_topic_updates`; `backend/tests/test_stream_replay.py::test_reconnect_replays_only_new_events_after_cursor`; `tests/e2e/sse.spec.ts` | Covered |
| SRCH-010 | stale replay cursor emits `stream.reset` | `backend/tests/test_stream_replay.py::test_stale_cursor_returns_stream_reset` | Covered |
| SRCH-011 | unified default view hides non-classified rows | `tests/e2e/classification.spec.ts` (pending row invisible until classified) | Covered |
| SRCH-012 | `?raw=1` shows pending/failed/non-semantic logs in unified view | `tests/e2e/classification.spec.ts` `raw=1 shows pending logs that default unified view hides` | Covered |

## CHAT Scenarios

| ID | Expected Behavior | Automated Evidence | Status |
|---|---|---|---|
| CHAT-001 | board chat persists user log before/with gateway dispatch | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_001_persists_user_log_before_background_dispatch` | Covered |
| CHAT-002 | attachment upload/validation + binding into chat payload | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_002_attachment_payload_is_bound_into_gateway_call`; `backend/tests/test_attachments.py::test_upload_and_download_roundtrip` | Covered |
| CHAT-003 | gateway in-flight publishes `openclaw.typing=true` | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_003_and_004_run_openclaw_chat_typing_lifecycle` | Covered |
| CHAT-004 | gateway return/fail always publishes `openclaw.typing=false` | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_003_and_004_run_openclaw_chat_typing_lifecycle`; `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_004_gateway_failure_still_emits_typing_false` | Covered |
| CHAT-005 | assistant logs arriving in grace window => watchdog no-op | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_005_watchdog_noop_when_assistant_log_arrives` | Covered |
| CHAT-006 | missing assistant logs => watchdog warning log appended | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_006_watchdog_logs_when_assistant_is_missing` | Covered |
| CHAT-007 | user-log persist failure fail-closes (no dispatch) | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_007_openclaw_chat_fail_closes_when_persist_fails` | Covered |
| CHAT-008 | gateway/attachment read failure persists system error log | `backend/tests/test_openclaw_chat_watchdog_and_ingest.py::test_chat_008_missing_attachment_persists_error_and_skips_gateway` | Covered |

## Required Work to Reach Full Coverage

No remaining gaps. All scenario IDs in section 14 are now backed by deterministic automated assertions.
