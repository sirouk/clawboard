from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from classifier import classifier as c


def _pending_log(
    *,
    session_key: str,
    log_id: str = "log-1",
    content: str = "Fix OAuth redirect in login flow.",
    attempts: int = 0,
    agent_id: str = "user",
) -> dict:
    return {
        "id": log_id,
        "type": "conversation",
        "agentId": agent_id,
        "content": content,
        "classificationStatus": "pending",
        "classificationAttempts": attempts,
        "createdAt": "2099-01-01T00:00:00.000Z",
        "source": {"sessionKey": session_key},
    }


def _list_logs_side_effect(logs: list[dict]):
    def _inner(_session_key: str, **kwargs):
        if kwargs.get("classificationStatus") == "pending":
            return [item for item in logs if (item.get("classificationStatus") or "pending") == "pending"]
        return list(logs)

    return _inner


class _FakeCompletionsResponse:
    def __init__(self, content: str):
        self._content = content

    def raise_for_status(self):
        return None

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


@unittest.skipIf(c.requests is None, "requests dependency is required for classifier LLM-path tests")
class ClassifierFailurePathTests(unittest.TestCase):
    def test_cls_021_call_classifier_repairs_malformed_output_once(self):
        pending_ids = ["log-1"]
        window = [
            {
                "id": "log-1",
                "type": "conversation",
                "agentLabel": "User",
                "content": "Explain retry strategy.",
            }
        ]
        valid = json.dumps(
            {
                "topic": {"id": "topic-1", "name": "Retry Strategy", "create": False},
                "task": None,
                "summaries": [{"id": "log-1", "summary": "Explain retry strategy"}],
            }
        )

        with patch.object(c, "OPENCLAW_GATEWAY_TOKEN", "test-token"), patch.object(
            c.requests,
            "post",
            side_effect=[_FakeCompletionsResponse("not-json"), _FakeCompletionsResponse(valid)],
        ) as post_mock:
            out = c.call_classifier(
                window,
                pending_ids,
                candidate_topics=[],
                candidate_tasks=[],
                notes_index={},
                topic_contexts={},
                task_contexts={},
                memory_hits=[],
                continuity=None,
            )

        self.assertEqual(post_mock.call_count, 2)
        self.assertEqual((out.get("topic") or {}).get("id"), "topic-1")
        self.assertEqual((out.get("summaries") or [])[0].get("id"), "log-1")

    def test_cls_001_no_pending_conversations_uses_cleanup_only_path(self):
        session_key = "channel:cls-001"
        logs = [
            {
                "id": "noise-1",
                "type": "conversation",
                "agentId": "user",
                "content": '{"window":[],"candidateTopics":[],"candidateTasks":[],"summaries":[]}',
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2099-01-01T00:00:00.000Z",
                "source": {"sessionKey": session_key},
            }
        ]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "call_classifier", side_effect=AssertionError("LLM path should not run")),
        ):
            c.classify_session(session_key)

        self.assertEqual(len(patched), 1)
        self.assertEqual(patched[0][0], "noise-1")
        self.assertEqual(patched[0][1].get("classificationStatus"), "failed")
        self.assertEqual(patched[0][1].get("classificationError"), "classifier_payload_noise")

    def test_cls_016_max_attempts_guard_prevents_reprocessing(self):
        session_key = "channel:cls-016"
        logs = [_pending_log(session_key=session_key, attempts=c.MAX_ATTEMPTS)]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "call_classifier", side_effect=AssertionError("LLM path should not run")),
        ):
            c.classify_session(session_key)

        self.assertEqual(patched, [])

    def test_cls_022_llm_timeout_falls_back_to_heuristic_classifier(self):
        session_key = "channel:cls-022"
        logs = [_pending_log(session_key=session_key)]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(c, "call_classifier", side_effect=c.requests.exceptions.ReadTimeout()),
            patch.object(
                c,
                "classify_without_llm",
                return_value={
                    "topic": {"id": "topic-fallback", "name": "Fallback Topic", "create": False},
                    "task": None,
                    "summaries": [{"id": "log-1", "summary": "Fix OAuth redirect"}],
                },
            ) as heuristic_mock,
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
            patch.object(c, "topic_candidates", return_value=[]),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_topics", return_value=[{"id": "topic-fallback", "name": "Fallback Topic"}]),
            patch.object(c, "list_tasks", return_value=[]),
            patch.object(c, "_window_has_task_intent", return_value=False),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
        ):
            c.classify_session(session_key)

        self.assertTrue(heuristic_mock.called)
        self.assertTrue(patched)
        self.assertEqual(patched[0][1].get("topicId"), "topic-fallback")
        self.assertEqual(patched[0][1].get("classificationStatus"), "classified")
        self.assertIsNone(patched[0][1].get("classificationError"))

    def test_cls_023_forced_topic_stays_pinned_when_llm_times_out(self):
        session_key = "clawboard:topic:topic-forced"
        logs = [_pending_log(session_key=session_key)]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(c, "call_classifier", side_effect=c.requests.exceptions.ReadTimeout()),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_tasks", return_value=[]),
            patch.object(c, "_window_has_task_intent", return_value=False),
            patch.object(c, "list_topics", return_value=[{"id": "topic-forced", "name": "Forced"}]),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        self.assertEqual(patched[0][1].get("topicId"), "topic-forced")
        self.assertEqual(patched[0][1].get("classificationStatus"), "classified")

    def test_cls_025_guardrail_reuses_strong_candidate_over_new_topic(self):
        session_key = "channel:cls-025"
        logs = [_pending_log(session_key=session_key)]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(
                c,
                "call_classifier",
                return_value={
                    "topic": {"id": None, "name": "Docker Auth", "create": True},
                    "task": None,
                    "summaries": [{"id": "log-1", "summary": "Fix OAuth redirect"}],
                },
            ),
            patch.object(
                c,
                "topic_candidates",
                return_value=[
                    {
                        "id": "topic-existing",
                        "name": "Existing Topic",
                        "score": c.TOPIC_SIM_THRESHOLD + 0.08,
                        "lexicalScore": 0.41,
                    }
                ],
            ),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_topics", return_value=[{"id": "topic-existing", "name": "Existing Topic"}]),
            patch.object(c, "list_tasks", return_value=[]),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
            patch.object(c, "_window_has_task_intent", return_value=False),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
            patch.object(c, "upsert_topic", side_effect=AssertionError("new topic should be suppressed by anti-dup guardrail")),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        self.assertEqual(patched[0][1].get("topicId"), "topic-existing")

    def test_cls_026_creation_gate_block_reuses_existing_topic_id(self):
        session_key = "channel:cls-026"
        logs = [_pending_log(session_key=session_key)]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(
                c,
                "call_classifier",
                return_value={
                    "topic": {"id": None, "name": "Identity Workstream", "create": True},
                    "task": None,
                    "summaries": [{"id": "log-1", "summary": "Fix OAuth redirect"}],
                },
            ),
            patch.object(c, "topic_candidates", return_value=[]),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_topics", return_value=[{"id": "topic-reuse", "name": "Identity Workstream"}]),
            patch.object(c, "list_tasks", return_value=[]),
            patch.object(c, "_topic_creation_allowed", return_value=True),
            patch.object(
                c,
                "call_creation_gate",
                return_value={"createTopic": False, "topicId": "topic-reuse", "createTask": False, "taskId": None},
            ),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
            patch.object(c, "_window_has_task_intent", return_value=False),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
            patch.object(c, "upsert_topic", side_effect=AssertionError("gate block should avoid topic create")),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        self.assertEqual(patched[0][1].get("topicId"), "topic-reuse")

    def test_fil_008_fallback_route_sets_fallback_error_code(self):
        session_key = "channel:fil-008"
        logs = [_pending_log(session_key=session_key)]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(c, "call_classifier", side_effect=c.requests.exceptions.ReadTimeout()),
            patch.object(c, "classify_without_llm", side_effect=RuntimeError("heuristic path failed")),
            patch.object(c, "topic_candidates", return_value=[]),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_topics", return_value=[]),
            patch.object(c, "upsert_topic", return_value={"id": "topic-fallback", "name": "Fallback"}),
            patch.object(c, "list_tasks", return_value=[]),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        self.assertEqual(patched[0][1].get("classificationStatus"), "classified")
        self.assertEqual(patched[0][1].get("classificationError"), "fallback:llm_timeout")

    def test_cls_031_unrecoverable_path_marks_terminal_failure(self):
        session_key = "channel:cls-031"
        logs = [_pending_log(session_key=session_key, attempts=max(0, c.MAX_ATTEMPTS - 1))]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(c, "call_classifier", side_effect=c.requests.exceptions.ReadTimeout()),
            patch.object(c, "classify_without_llm", side_effect=RuntimeError("heuristic path failed")),
            patch.object(c, "topic_candidates", return_value=[]),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_topics", return_value=[]),
            patch.object(c, "upsert_topic", side_effect=RuntimeError("cannot create topic")),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        payload = patched[0][1]
        self.assertEqual(payload.get("classificationStatus"), "failed")
        self.assertEqual(int(payload.get("classificationAttempts") or 0), c.MAX_ATTEMPTS)
        self.assertEqual(payload.get("classificationError"), "llm_timeout")

    def test_fil_007_noise_error_code_defaults_to_conversation_noise(self):
        self.assertEqual(c._noise_error_code("totally unrelated free-form noise"), "conversation_noise")

    def test_fil_005_and_fil_006_noise_error_code_specific_branches(self):
        classifier_payload = '{"window":[],"candidateTopics":[],"candidateTasks":[],"summaries":[]}'
        context_payload = "[CLAWBOARD_CONTEXT_BEGIN]\nsecret\n[CLAWBOARD_CONTEXT_END]"
        self.assertEqual(c._noise_error_code(classifier_payload), "classifier_payload_noise")
        self.assertEqual(c._noise_error_code(context_payload), "context_injection_noise")


if __name__ == "__main__":
    unittest.main()
