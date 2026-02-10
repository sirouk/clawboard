import unittest
from unittest.mock import patch

from classifier import classifier as c


class SessionRoutingContinuityTests(unittest.TestCase):
    def test_low_signal_followup_forces_continuity_topic_in_llm_mode(self):
        session_key = "channel:test|thread:42"
        continuity_topic_id = "topic-cont"
        continuity_task_id = "task-cont"

        logs = [
            {
                "id": "log-1",
                "type": "conversation",
                "agentId": "user",
                "content": "Yes, do it.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-10T10:00:00.000Z",
                "source": {"sessionKey": session_key},
            }
        ]

        patched: list[tuple[str, dict]] = []

        def fake_list_logs_by_session(_sk: str, **kwargs):
            self.assertEqual(_sk, session_key)
            if kwargs.get("classificationStatus") == "pending":
                return logs
            return logs

        def fake_patch_log(log_id: str, patch: dict):
            patched.append((log_id, patch))

        def fake_call_classifier(window, pending_ids, candidate_topics, candidate_tasks, *_args, **_kwargs):
            # Even if the model tries to move the topic, continuity forcing should keep it pinned.
            return {
                "topic": {"id": "topic-other", "name": "Other", "create": False},
                "task": None,
                "summaries": [{"id": sid, "summary": "Do it"} for sid in pending_ids],
            }

        with (
            patch.object(c, "get_session_routing_memory", return_value={"sessionKey": session_key, "items": [{"ts": "2026-02-10T09:00:00.000Z", "topicId": continuity_topic_id, "topicName": "Continuity", "taskId": continuity_task_id, "taskTitle": "Continue task", "anchor": "Fix the login redirect bug."}]}),
            patch.object(c, "append_session_routing_memory", return_value=None),
            patch.object(c, "list_logs_by_session", side_effect=fake_list_logs_by_session),
            patch.object(c, "patch_log", side_effect=fake_patch_log),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(c, "call_classifier", side_effect=fake_call_classifier),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "list_topics", return_value=[{"id": continuity_topic_id, "name": "Continuity"}]),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "_window_has_task_intent", return_value=False),
            patch.object(c, "list_tasks", return_value=[{"id": continuity_task_id, "title": "Continue task", "status": "todo"}]),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        by_id = {lid: payload for lid, payload in patched}
        self.assertIn("log-1", by_id)
        payload = by_id["log-1"]
        self.assertEqual(payload.get("topicId"), continuity_topic_id)
        self.assertEqual(payload.get("taskId"), continuity_task_id)
        self.assertEqual(payload.get("classificationStatus"), "classified")


if __name__ == "__main__":
    unittest.main()

