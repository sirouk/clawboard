import unittest
from unittest.mock import patch

from classifier import classifier as c


class SummaryRepairTests(unittest.TestCase):
    def test_classify_session_repairs_missing_summaries(self):
        session_key = "channel:classifier-tests:summary-repair"
        logs = [
            {
                "id": "log-1",
                "type": "conversation",
                "agentId": "user",
                "content": "GraphQL caching: explain entity-level caching in Apollo Federation.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2099-01-01T00:00:00.000Z",
                "source": {"sessionKey": session_key},
            },
            {
                "id": "log-2",
                "type": "conversation",
                "agentId": "assistant",
                "content": "Cache at entity/field boundaries and avoid leaking auth-scoped responses.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2099-01-01T00:00:01.000Z",
                "source": {"sessionKey": session_key},
            },
        ]

        patched: list[tuple[str, dict]] = []

        def fake_list_logs_by_session(_sk: str, **kwargs):
            self.assertEqual(_sk, session_key)
            if kwargs.get("classificationStatus") == "pending":
                return logs
            return logs

        def fake_patch_log(log_id: str, patch_payload: dict):
            patched.append((log_id, patch_payload))

        def fake_call_classifier(window, pending_ids, *_args, **_kwargs):
            # Missing the summary for log-2 to force repair.
            return {
                "topic": {"id": "topic-1", "name": "GraphQL caching", "create": False},
                "task": None,
                "summaries": [{"id": pending_ids[0], "summary": "Explain Apollo Federation caching"}],
            }

        def fake_call_summary_repair(_window, missing_ids, _notes_index):
            self.assertEqual(missing_ids, ["log-2"])
            return {"log-2": "Auth-scoped cache safety"}

        with (
            patch.object(c, "list_logs_by_session", side_effect=fake_list_logs_by_session),
            patch.object(c, "patch_log", side_effect=fake_patch_log),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(c, "call_classifier", side_effect=fake_call_classifier),
            patch.object(c, "call_summary_repair", side_effect=fake_call_summary_repair),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "topic_candidates", return_value=[]),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_topics", return_value=[]),
            patch.object(c, "upsert_topic", return_value={"id": "topic-1", "name": "GraphQL caching"}),
            patch.object(c, "list_tasks", return_value=[]),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
        ):
            c.classify_session(session_key)

        by_id = {lid: payload for lid, payload in patched}
        self.assertIn("log-1", by_id)
        self.assertIn("log-2", by_id)
        self.assertEqual(by_id["log-1"].get("summary"), "Explain Apollo Federation caching")
        self.assertEqual(by_id["log-2"].get("summary"), "Auth-scoped cache safety")

    def test_task_guardrail_ignores_task_id_from_other_topic(self):
        session_key = "channel:classifier-tests:task-guardrail"
        logs = [
            {
                "id": "log-1",
                "type": "conversation",
                "agentId": "user",
                "content": "Fix OAuth redirect loop in the portal login flow.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2099-01-01T00:00:00.000Z",
                "source": {"sessionKey": session_key},
            }
        ]

        patched: list[tuple[str, dict]] = []

        def fake_list_logs_by_session(_sk: str, **kwargs):
            self.assertEqual(_sk, session_key)
            if kwargs.get("classificationStatus") == "pending":
                return logs
            return logs

        def fake_patch_log(log_id: str, patch_payload: dict):
            patched.append((log_id, patch_payload))

        def fake_call_classifier(_window, pending_ids, *_args, **_kwargs):
            return {
                "topic": {"id": "topic-1", "name": "Portal auth", "create": False},
                "task": {"id": "task-other-topic", "title": "Fix OAuth redirect loop", "create": False},
                "summaries": [{"id": pending_ids[0], "summary": "Fix OAuth redirect loop"}],
            }

        with (
            patch.object(c, "list_logs_by_session", side_effect=fake_list_logs_by_session),
            patch.object(c, "patch_log", side_effect=fake_patch_log),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(c, "call_classifier", side_effect=fake_call_classifier),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "ensure_topic_index_seeded", return_value=None),
            patch.object(c, "ensure_task_index_seeded", return_value=None),
            patch.object(c, "topic_candidates", return_value=[]),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_topics", return_value=[]),
            patch.object(c, "upsert_topic", return_value={"id": "topic-1", "name": "Portal auth"}),
            patch.object(c, "list_tasks", return_value=[{"id": "task-valid", "title": "Valid", "status": "todo"}]),
            patch.object(c, "_window_has_task_intent", return_value=True),
            patch.object(c, "_looks_actionable", return_value=False),
            patch.object(c, "_latest_classified_task_for_topic", return_value=None),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        # The proposed task id is not in valid_task_ids, so it must not be applied.
        self.assertIsNone(patched[0][1].get("taskId"))


if __name__ == "__main__":
    unittest.main()

