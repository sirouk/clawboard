from __future__ import annotations

import unittest
from unittest.mock import patch

from classifier import classifier as c


def _list_logs_side_effect(logs: list[dict]):
    def _inner(_session_key: str, **kwargs):
        if kwargs.get("classificationStatus") == "pending":
            return [item for item in logs if (item.get("classificationStatus") or "pending") == "pending"]
        return list(logs)

    return _inner


class ControlPlaneAndToolFilteringTests(unittest.TestCase):
    def test_classify_session_filters_main_session_heartbeat_control_plane_conversation(self):
        session_key = "agent:main:main"
        logs = [
            {
                "id": "log-heartbeat-1",
                "type": "conversation",
                "agentId": "system",
                "content": "Heartbeat: heartbeat_ok",
                "summary": "heartbeat check",
                "raw": "[Cron:watchdog] Heartbeat and watchdog recovery check",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-24T10:00:00.000Z",
                "source": {"sessionKey": session_key, "channel": "openclaw"},
            }
        ]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
        ):
            c.classify_session(session_key)

        by_id = {log_id: payload for log_id, payload in patched}
        self.assertIn("log-heartbeat-1", by_id)
        payload = by_id["log-heartbeat-1"]
        self.assertEqual(payload.get("classificationStatus"), "failed")
        self.assertEqual(payload.get("classificationError"), "filtered_control_plane")
        self.assertEqual(payload.get("classificationAttempts"), 1)
        self.assertIsNone(payload.get("topicId"))
        self.assertIsNone(payload.get("taskId"))

    def test_classify_session_filters_subagent_scaffold_conversation(self):
        session_key = "agent:coding:subagent:47317cf1-ea8e-4956-a7e5-438daa29e65d"
        logs = [
            {
                "id": "log-subagent-scaffold-1",
                "type": "conversation",
                "agentId": "user",
                "content": "[Subagent Context] You are running as a subagent (depth 1/1).",
                "summary": None,
                "raw": None,
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-24T10:00:00.000Z",
                "source": {"sessionKey": session_key, "channel": "direct"},
            }
        ]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
        ):
            c.classify_session(session_key)

        by_id = {log_id: payload for log_id, payload in patched}
        self.assertIn("log-subagent-scaffold-1", by_id)
        payload = by_id["log-subagent-scaffold-1"]
        self.assertEqual(payload.get("classificationStatus"), "failed")
        self.assertEqual(payload.get("classificationError"), "filtered_subagent_scaffold")
        self.assertEqual(payload.get("classificationAttempts"), 1)
        self.assertIsNone(payload.get("topicId"))
        self.assertIsNone(payload.get("taskId"))

    def test_classify_session_marks_unanchored_tool_action_as_terminal_failed(self):
        session_key = "agent:main:main"
        logs = [
            {
                "id": "log-tool-unanchored-1",
                "type": "action",
                "agentId": "assistant",
                "content": "Tool result: shell.exec",
                "summary": "Tool result: shell.exec",
                "raw": "Tool result: shell.exec exit=0",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-24T10:00:00.000Z",
                "source": {"sessionKey": session_key, "channel": "openclaw"},
            }
        ]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
        ):
            c.classify_session(session_key)

        by_id = {log_id: payload for log_id, payload in patched}
        self.assertIn("log-tool-unanchored-1", by_id)
        payload = by_id["log-tool-unanchored-1"]
        self.assertEqual(payload.get("classificationStatus"), "failed")
        self.assertEqual(payload.get("classificationError"), "filtered_unanchored_tool_activity")
        self.assertEqual(payload.get("classificationAttempts"), 1)
        self.assertIsNone(payload.get("topicId"))
        self.assertIsNone(payload.get("taskId"))

    def test_classify_session_marks_scoped_tool_action_filtered_in_forced_task_scope(self):
        session_key = "clawboard:task:topic-abc:task-xyz"
        logs = [
            {
                "id": "log-req-1",
                "type": "conversation",
                "agentId": "user",
                "content": "Please implement this and run tests.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-24T10:00:00.000Z",
                "source": {"sessionKey": session_key, "channel": "openclaw"},
            },
            {
                "id": "log-tool-scoped-1",
                "type": "action",
                "agentId": "assistant",
                "content": "Tool call: shell.exec",
                "summary": "Tool call: shell.exec",
                "raw": "Tool call: shell.exec {\"cmd\":\"npm test\"}",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-24T10:00:01.000Z",
                "source": {"sessionKey": session_key, "channel": "openclaw"},
            },
        ]
        patched: list[tuple[str, dict]] = []

        with (
            patch.object(c, "list_logs_by_session", side_effect=_list_logs_side_effect(logs)),
            patch.object(c, "patch_log", side_effect=lambda log_id, payload: patched.append((log_id, payload))),
        ):
            c.classify_session(session_key)

        by_id = {log_id: payload for log_id, payload in patched}
        self.assertIn("log-tool-scoped-1", by_id)
        payload = by_id["log-tool-scoped-1"]
        self.assertEqual(payload.get("topicId"), "topic-abc")
        self.assertEqual(payload.get("taskId"), "task-xyz")
        self.assertEqual(payload.get("classificationStatus"), "classified")
        self.assertEqual(payload.get("classificationError"), "filtered_tool_activity")
        self.assertEqual(payload.get("classificationAttempts"), 1)


if __name__ == "__main__":
    unittest.main()
