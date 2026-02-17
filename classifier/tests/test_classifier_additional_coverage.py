from __future__ import annotations

import unittest
from unittest.mock import patch

from classifier import classifier as c


def _log(
    *,
    session_key: str,
    log_id: str,
    created_at: str,
    agent_id: str,
    content: str,
    status: str = "pending",
    attempts: int = 0,
    topic_id: str | None = None,
    task_id: str | None = None,
) -> dict:
    return {
        "id": log_id,
        "type": "conversation",
        "agentId": agent_id,
        "content": content,
        "classificationStatus": status,
        "classificationAttempts": attempts,
        "createdAt": created_at,
        "topicId": topic_id,
        "taskId": task_id,
        "source": {"sessionKey": session_key},
    }


def _list_logs_side_effect(logs: list[dict]):
    def _inner(_session_key: str, **kwargs):
        if kwargs.get("classificationStatus") == "pending":
            return [item for item in logs if (item.get("classificationStatus") or "pending") == "pending"]
        return list(logs)

    return _inner


class ClassifierAdditionalCoverageTests(unittest.TestCase):
    def test_cls_003_oldest_pending_bundle_is_classified_first(self):
        session_key = "channel:cls-003"
        logs = [
            _log(
                session_key=session_key,
                log_id="log-old-user",
                created_at="2099-01-01T00:00:00.000Z",
                agent_id="user",
                content="First request: fix OAuth callback.",
            ),
            _log(
                session_key=session_key,
                log_id="log-old-assistant",
                created_at="2099-01-01T00:00:01.000Z",
                agent_id="assistant",
                content="Plan for OAuth fix.",
            ),
            _log(
                session_key=session_key,
                log_id="log-new-user",
                created_at="2099-01-01T00:00:02.000Z",
                agent_id="user",
                content="Second request: add dashboard filters.",
            ),
        ]
        patched: list[tuple[str, dict]] = []
        seen_pending_ids: list[list[str]] = []

        def _fake_call_classifier(_window, pending_ids, *_args, **_kwargs):
            seen_pending_ids.append(list(pending_ids))
            return {
                "topic": {"id": "topic-ops", "name": "Ops", "create": False},
                "task": None,
                "summaries": [{"id": sid, "summary": "Bundle summary"} for sid in pending_ids],
            }

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(c, "call_classifier", side_effect=_fake_call_classifier),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
            patch.object(
                c,
                "topic_candidates",
                return_value=[{"id": "topic-ops", "name": "Ops", "score": 0.9, "lexicalScore": 0.4}],
            ),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_topics", return_value=[{"id": "topic-ops", "name": "Ops"}]),
            patch.object(c, "list_tasks", return_value=[]),
            patch.object(c, "_window_has_task_intent", return_value=False),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
        ):
            c.classify_session(session_key)

        self.assertEqual(seen_pending_ids, [["log-old-user", "log-old-assistant"]])
        patched_ids = [item[0] for item in patched]
        self.assertIn("log-old-user", patched_ids)
        self.assertIn("log-old-assistant", patched_ids)
        self.assertNotIn("log-new-user", patched_ids)

    def test_cls_012_explicit_new_thread_suppresses_continuity_forcing(self):
        session_key = "channel:cls-012|thread:9"
        logs = [
            _log(
                session_key=session_key,
                log_id="log-prev",
                created_at="2099-01-01T00:00:00.000Z",
                agent_id="assistant",
                content="Previous thread context.",
                status="classified",
                topic_id="topic-old",
            ),
            _log(
                session_key=session_key,
                log_id="log-new",
                created_at="2099-01-01T00:00:01.000Z",
                agent_id="user",
                content="New topic: database sharding plan.",
            ),
        ]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(
                c,
                "get_session_routing_memory",
                return_value={
                    "sessionKey": session_key,
                    "items": [
                        {
                            "ts": "2099-01-01T00:00:00.000Z",
                            "topicId": "topic-old",
                            "topicName": "Old Topic",
                            "taskId": None,
                            "taskTitle": None,
                            "anchor": "Old anchor",
                        }
                    ],
                },
            ),
            patch.object(
                c,
                "call_classifier",
                return_value={
                    "topic": {"id": "topic-new", "name": "Database Sharding", "create": False},
                    "task": None,
                    "summaries": [{"id": "log-new", "summary": "Plan DB sharding thread"}],
                },
            ),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
            patch.object(
                c,
                "topic_candidates",
                return_value=[{"id": "topic-new", "name": "Database Sharding", "score": 0.94, "lexicalScore": 0.55}],
            ),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(
                c,
                "list_topics",
                return_value=[{"id": "topic-old", "name": "Old Topic"}, {"id": "topic-new", "name": "Database Sharding"}],
            ),
            patch.object(c, "list_tasks", return_value=[]),
            patch.object(c, "_window_has_task_intent", return_value=False),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
            patch.object(c, "append_session_routing_memory", return_value=None),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        self.assertEqual(patched[0][1].get("topicId"), "topic-new")

    def test_cls_013_small_talk_fast_path_uses_stable_small_talk_topic(self):
        session_key = "channel:cls-013"
        logs = [
            _log(
                session_key=session_key,
                log_id="log-smalltalk",
                created_at="2099-01-01T00:00:00.000Z",
                agent_id="user",
                content="How's your day going?",
            )
        ]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "list_topics", return_value=[{"id": "topic-small", "name": "Small Talk"}]),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "call_classifier", side_effect=AssertionError("small-talk fast path should not call LLM")),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        payload = patched[0][1]
        self.assertEqual(payload.get("topicId"), "topic-small")
        self.assertIsNone(payload.get("taskId"))
        self.assertEqual(payload.get("classificationStatus"), "classified")

    def test_cls_014_retrieval_text_prefers_user_turns(self):
        session_key = "channel:cls-014"
        logs = [
            _log(
                session_key=session_key,
                log_id="log-user",
                created_at="2099-01-01T00:00:00.000Z",
                agent_id="user",
                content="Deploy the API service to staging now.",
            ),
            _log(
                session_key=session_key,
                log_id="log-assistant",
                created_at="2099-01-01T00:00:01.000Z",
                agent_id="assistant",
                content="assistant contamination sentinel",
            ),
        ]
        patched: list[tuple[str, dict]] = []
        seen_query_text: list[str] = []

        def _capture_topic_candidates(query_text: str):
            seen_query_text.append(str(query_text))
            return [{"id": "topic-deploy", "name": "Deployments", "score": 0.7, "lexicalScore": 0.4}]

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=False),
            patch.object(c, "topic_candidates", side_effect=_capture_topic_candidates),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_topics", return_value=[{"id": "topic-deploy", "name": "Deployments"}]),
            patch.object(c, "list_tasks", return_value=[]),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
            patch.object(c, "_window_has_task_intent", return_value=False),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
            patch.object(
                c,
                "classify_without_llm",
                return_value={
                    "topic": {"id": "topic-deploy", "name": "Deployments", "create": False},
                    "task": None,
                    "summaries": [
                        {"id": "log-user", "summary": "Deploy API to staging"},
                        {"id": "log-assistant", "summary": "Assistant response"},
                    ],
                },
            ),
        ):
            c.classify_session(session_key)

        self.assertTrue(seen_query_text)
        self.assertIn("Deploy the API service to staging now.", seen_query_text[0])
        self.assertNotIn("assistant contamination sentinel", seen_query_text[0])
        self.assertTrue(patched)

    def test_cls_029_task_intent_low_confidence_reuses_continuity_task(self):
        session_key = "channel:cls-029"
        logs = [
            _log(
                session_key=session_key,
                log_id="log-prev",
                created_at="2099-01-01T00:00:00.000Z",
                agent_id="user",
                content="Keep shipping onboarding work",
                status="classified",
                topic_id="topic-ship",
                task_id="task-continuity",
            ),
            _log(
                session_key=session_key,
                log_id="log-pending",
                created_at="2099-01-01T00:00:01.000Z",
                agent_id="user",
                content="Please finish the release checklist task.",
            ),
        ]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(
                c,
                "call_classifier",
                return_value={
                    "topic": {"id": "topic-ship", "name": "Shipping", "create": False},
                    "task": None,
                    "summaries": [{"id": "log-pending", "summary": "Finish release checklist"}],
                },
            ),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
            patch.object(
                c,
                "topic_candidates",
                return_value=[{"id": "topic-ship", "name": "Shipping", "score": 0.92, "lexicalScore": 0.55}],
            ),
            patch.object(
                c,
                "task_candidates",
                return_value=[{"id": "task-continuity", "title": "Release Checklist", "score": 0.24}],
            ),
            patch.object(c, "list_topics", return_value=[{"id": "topic-ship", "name": "Shipping"}]),
            patch.object(
                c,
                "list_tasks",
                return_value=[{"id": "task-continuity", "topicId": "topic-ship", "title": "Release Checklist"}],
            ),
            patch.object(c, "_window_has_task_intent", return_value=True),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
            patch.object(c, "upsert_task", side_effect=AssertionError("continuity reuse should avoid task creation")),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        payload = patched[0][1]
        self.assertEqual(payload.get("topicId"), "topic-ship")
        self.assertEqual(payload.get("taskId"), "task-continuity")
        self.assertEqual(payload.get("classificationStatus"), "classified")

    def test_cls_032_classification_appends_session_routing_memory(self):
        session_key = "channel:cls-032"
        logs = [
            _log(
                session_key=session_key,
                log_id="log-routing",
                created_at="2099-01-01T00:00:00.000Z",
                agent_id="user",
                content="Ship the onboarding wizard this week.",
            )
        ]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(
                c,
                "call_classifier",
                return_value={
                    "topic": {"id": "topic-routing", "name": "Onboarding", "create": False},
                    "task": None,
                    "summaries": [{"id": "log-routing", "summary": "Ship onboarding wizard"}],
                },
            ),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
            patch.object(
                c,
                "topic_candidates",
                return_value=[{"id": "topic-routing", "name": "Onboarding", "score": 0.9, "lexicalScore": 0.5}],
            ),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_topics", return_value=[{"id": "topic-routing", "name": "Onboarding"}]),
            patch.object(c, "list_tasks", return_value=[]),
            patch.object(c, "_window_has_task_intent", return_value=False),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
            patch.object(c, "append_session_routing_memory", return_value=None) as append_memory,
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        self.assertTrue(append_memory.called)
        self.assertEqual(append_memory.call_args.args[0], session_key)
        self.assertEqual(append_memory.call_args.kwargs.get("topic_id"), "topic-routing")


if __name__ == "__main__":
    unittest.main()
