import unittest
from unittest.mock import patch

from classifier import classifier as c


class BoardSessionKeyTests(unittest.TestCase):
    def test_parse_board_session_key_parses_topic(self):
        self.assertEqual(c._parse_board_session_key("clawboard:topic:topic-123"), ("topic-123", None))

    def test_parse_board_session_key_parses_task(self):
        self.assertEqual(
            c._parse_board_session_key("clawboard:task:topic-123:task-456"),
            ("topic-123", "task-456"),
        )

    def test_parse_board_session_key_strips_thread_suffix(self):
        self.assertEqual(
            c._parse_board_session_key("clawboard:topic:topic-123|thread:999"),
            ("topic-123", None),
        )
        self.assertEqual(
            c._parse_board_session_key("clawboard:task:topic-123:task-456|thread:999"),
            ("topic-123", "task-456"),
        )

    def test_parse_board_session_key_rejects_non_board_values(self):
        self.assertEqual(c._parse_board_session_key(""), (None, None))
        self.assertEqual(c._parse_board_session_key("channel:discord-123"), (None, None))
        self.assertEqual(c._parse_board_session_key("clawboard:topic:"), (None, None))
        self.assertEqual(c._parse_board_session_key("clawboard:task:topic-1"), (None, None))


class BoardSessionClassificationTests(unittest.TestCase):
    def test_classify_session_topic_scope_can_promote_to_task_without_moving_topic(self):
        session_key = "clawboard:topic:topic-abc"
        promoted_task_id = "task-xyz"
        logs = [
            {
                "id": "log-1",
                "type": "conversation",
                "agentId": "user",
                "content": "Fix the login redirect bug.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-09T09:10:00.000Z",
                "source": {"sessionKey": session_key},
            },
            {
                "id": "log-2",
                "type": "conversation",
                "agentId": "assistant",
                "content": "Plan: reproduce, patch, test.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-09T09:10:01.000Z",
                "source": {"sessionKey": session_key},
            },
        ]

        patched: list[tuple[str, dict]] = []

        def fake_list_logs_by_session(_sk: str, **kwargs):
            self.assertEqual(_sk, session_key)
            # classify_session calls list_logs_by_session twice (ctx + pending); both should return this window.
            if kwargs.get("classificationStatus") == "pending":
                return logs
            return logs

        def fake_patch_log(log_id: str, patch: dict):
            patched.append((log_id, patch))

        def fake_call_classifier(window, pending_ids, candidate_topics, candidate_tasks, *_args, **_kwargs):
            # Return a task suggestion, but attempt to move the topic (which must be ignored for board sessions).
            return {
                "topic": {"id": "topic-other", "name": "Other", "create": False},
                "task": {"id": promoted_task_id, "title": "Fix login redirect", "create": False},
                "summaries": [{"id": sid, "summary": "Fix login redirect"} for sid in pending_ids],
            }

        with (
            patch.object(c, "list_logs_by_session", side_effect=fake_list_logs_by_session),
            patch.object(c, "patch_log", side_effect=fake_patch_log),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(c, "call_classifier", side_effect=fake_call_classifier),
            patch.object(c, "_window_has_task_intent", return_value=True),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "list_topics", return_value=[{"id": "topic-abc", "name": "Topic ABC"}]),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "task_candidates", return_value=[{"id": promoted_task_id, "title": "Fix login redirect", "score": 0.9}]),
            patch.object(c, "list_tasks", return_value=[{"id": promoted_task_id, "title": "Fix login redirect", "status": "todo"}]),
        ):
            c.classify_session(session_key)

        by_id = {lid: payload for lid, payload in patched}
        self.assertIn("log-1", by_id)
        self.assertIn("log-2", by_id)
        for payload in by_id.values():
            self.assertEqual(payload.get("topicId"), "topic-abc")
            self.assertEqual(payload.get("taskId"), promoted_task_id)
            # Board sessions should still progress out of "pending".
            self.assertIn(payload.get("classificationStatus"), ("classified", "failed"))
            self.assertEqual(payload.get("classificationAttempts"), 1)

    def test_classify_session_task_scope_keeps_task_fixed(self):
        session_key = "clawboard:task:topic-abc:task-xyz"
        logs = [
            {
                "id": "log-1",
                "type": "conversation",
                "agentId": "user",
                "content": "Ship it.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-09T09:10:00.000Z",
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

        with patch.object(c, "list_logs_by_session", side_effect=fake_list_logs_by_session), patch.object(
            c, "patch_log", side_effect=fake_patch_log
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        for _lid, payload in patched:
            self.assertEqual(payload.get("topicId"), "topic-abc")
            self.assertEqual(payload.get("taskId"), "task-xyz")


if __name__ == "__main__":
    unittest.main()
