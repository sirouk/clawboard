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
    def test_classify_session_keeps_board_scope(self):
        session_key = "clawboard:topic:topic-abc"
        logs = [
            {
                "id": "log-1",
                "type": "conversation",
                "agentId": "user",
                "content": "2",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-09T09:10:00.000Z",
                "source": {"sessionKey": session_key},
            },
            {
                "id": "log-2",
                "type": "conversation",
                "agentId": "assistant",
                "content": "What does “2” refer to?",
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

        with patch.object(c, "list_logs_by_session", side_effect=fake_list_logs_by_session), patch.object(
            c, "patch_log", side_effect=fake_patch_log
        ):
            c.classify_session(session_key)

        by_id = {lid: payload for lid, payload in patched}
        self.assertIn("log-1", by_id)
        self.assertIn("log-2", by_id)
        for payload in by_id.values():
            self.assertEqual(payload.get("topicId"), "topic-abc")
            self.assertIsNone(payload.get("taskId"))
            # Board sessions should still progress out of "pending".
            self.assertIn(payload.get("classificationStatus"), ("classified", "failed"))
            self.assertEqual(payload.get("classificationAttempts"), 1)


if __name__ == "__main__":
    unittest.main()

