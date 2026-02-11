import unittest
from unittest.mock import patch

from classifier import classifier as c


class CronEventFilteringTests(unittest.TestCase):
    def test_classify_session_filters_cron_event_logs_without_routing(self):
        session_key = "agent:main:main"
        cron_log = {
            "id": "log-cron-1",
            "type": "conversation",
            "agentId": "user",
            "content": "System: [2026-02-10 16:13:30 EST] Cron: backup ran.\n\nPlease relay this reminder to the user.",
            "summary": None,
            "raw": None,
            "topicId": "topic-should-not-stick",
            "taskId": "task-should-not-stick",
            "classificationStatus": "pending",
            "classificationAttempts": 0,
            "createdAt": "2026-02-10T21:13:43.649Z",
            "source": {"channel": "cron-event", "sessionKey": session_key, "messageId": "oc:test"},
        }

        patched: list[tuple[str, dict]] = []

        def fake_list_logs_by_session(_sk: str, **kwargs):
            self.assertEqual(_sk, session_key)
            # classify_session calls list_logs_by_session twice; return the same single log for both.
            return [cron_log]

        def fake_patch_log(log_id: str, patch: dict):
            patched.append((log_id, patch))

        with (
            patch.object(c, "list_logs_by_session", side_effect=fake_list_logs_by_session),
            patch.object(c, "patch_log", side_effect=fake_patch_log),
        ):
            c.classify_session(session_key)

        self.assertTrue(patched)
        # Ensure the cron log was detached and marked terminal.
        updates = [p for lid, p in patched if lid == "log-cron-1"]
        self.assertTrue(updates)
        update = updates[0]
        self.assertEqual(update.get("classificationStatus"), "failed")
        self.assertEqual(update.get("classificationError"), "filtered_cron_event")
        self.assertIsNone(update.get("topicId"))
        self.assertIsNone(update.get("taskId"))
        self.assertEqual(update.get("classificationAttempts"), 1)


if __name__ == "__main__":
    unittest.main()

