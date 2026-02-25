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
                "source": {
                    "sessionKey": session_key,
                    "boardScopeTopicId": "topic-abc",
                    "boardScopeKind": "topic",
                    "boardScopeLock": True,
                },
            },
            {
                "id": "log-2",
                "type": "conversation",
                "agentId": "assistant",
                "content": "Plan: reproduce, patch, test.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-09T09:10:01.000Z",
                "source": {
                    "sessionKey": session_key,
                    "boardScopeTopicId": "topic-abc",
                    "boardScopeKind": "topic",
                    "boardScopeLock": True,
                },
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
                "content": "Ship portal hotfix Z4FF462D9. Also include the requested copy fix on the login form.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-09T09:10:00.000Z",
                "source": {"sessionKey": session_key},
            },
            {
                "id": "log-2",
                "type": "conversation",
                "agentId": "user",
                "content": "/new",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-09T09:10:01.000Z",
                "source": {"sessionKey": session_key},
            },
            {
                "id": "log-3",
                "type": "action",
                "agentId": "assistant",
                "content": "Tool call: memory_search login copy",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-09T09:10:02.000Z",
                "source": {"sessionKey": session_key},
            },
            {
                "id": "log-4",
                "type": "system",
                "agentId": "system",
                "content": "System: heartbeat",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-09T09:10:03.000Z",
                "source": {"sessionKey": session_key},
            },
            {
                "id": "log-5",
                "type": "action",
                "agentId": "assistant",
                "content": "Tool call: memory_search login copy",
                "classificationStatus": "classified",
                "classificationAttempts": 1,
                "classificationError": "filtered_tool_activity",
                "topicId": "topic-abc",
                "taskId": "task-old",
                "createdAt": "2026-02-09T09:10:04.000Z",
                "source": {"sessionKey": session_key},
            },
        ]

        patched: list[tuple[str, dict]] = []

        def fake_list_logs_by_session(_sk: str, **kwargs):
            self.assertEqual(_sk, session_key)
            if kwargs.get("classificationStatus") == "pending":
                return [item for item in logs if item.get("classificationStatus") == "pending"]
            return logs

        def fake_patch_log(log_id: str, patch: dict):
            patched.append((log_id, patch))

        with patch.object(c, "list_logs_by_session", side_effect=fake_list_logs_by_session), patch.object(
            c, "patch_log", side_effect=fake_patch_log
        ):
            c.classify_session(session_key)

        by_id = {lid: payload for lid, payload in patched}
        self.assertEqual(by_id["log-1"].get("topicId"), "topic-abc")
        self.assertEqual(by_id["log-1"].get("taskId"), "task-xyz")

        self.assertEqual(by_id["log-2"].get("classificationError"), "filtered_command")
        self.assertEqual(by_id["log-2"].get("topicId"), "topic-abc")
        self.assertEqual(by_id["log-2"].get("taskId"), "task-xyz")

        self.assertEqual(by_id["log-3"].get("classificationError"), "filtered_memory_action")
        self.assertEqual(by_id["log-3"].get("topicId"), "topic-abc")
        self.assertEqual(by_id["log-3"].get("taskId"), "task-xyz")

        self.assertEqual(by_id["log-4"].get("classificationError"), "filtered_non_semantic")
        self.assertEqual(by_id["log-4"].get("topicId"), "topic-abc")
        self.assertEqual(by_id["log-4"].get("taskId"), "task-xyz")

        # Backfill previously-classified action traces that drifted to the wrong task.
        self.assertEqual(by_id["log-5"].get("classificationError"), "filtered_memory_action")
        self.assertEqual(by_id["log-5"].get("topicId"), "topic-abc")
        self.assertEqual(by_id["log-5"].get("taskId"), "task-xyz")

    def test_subagent_session_with_existing_task_scope_stays_pinned(self):
        session_key = "agent:main:subagent:abc-123"
        logs = [
            {
                "id": "log-prev",
                "type": "conversation",
                "agentId": "assistant",
                "content": "Prior scoped response.",
                "classificationStatus": "classified",
                "classificationAttempts": 1,
                "topicId": "topic-abc",
                "taskId": "task-xyz",
                "createdAt": "2026-02-11T03:19:19.000Z",
                "source": {"sessionKey": session_key},
            },
            {
                "id": "log-1",
                "type": "conversation",
                "agentId": "user",
                "content": "Give me your current best summary now.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-11T03:19:46.000Z",
                "source": {"sessionKey": session_key},
            },
            {
                "id": "log-2",
                "type": "conversation",
                "agentId": "assistant",
                "content": "Here is my summary.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-11T03:19:46.100Z",
                "source": {"sessionKey": session_key},
            },
        ]

        patched: list[tuple[str, dict]] = []

        def fake_list_logs_by_session(_sk: str, **kwargs):
            self.assertEqual(_sk, session_key)
            if kwargs.get("classificationStatus") == "pending":
                return [item for item in logs if item.get("classificationStatus") == "pending"]
            return logs

        def fake_patch_log(log_id: str, patch: dict):
            patched.append((log_id, patch))

        with (
            patch.object(c, "list_logs_by_session", side_effect=fake_list_logs_by_session),
            patch.object(c, "patch_log", side_effect=fake_patch_log),
        ):
            c.classify_session(session_key)

        by_id = {lid: payload for lid, payload in patched}
        self.assertIn("log-1", by_id)
        self.assertIn("log-2", by_id)
        self.assertEqual(by_id["log-1"].get("topicId"), "topic-abc")
        self.assertEqual(by_id["log-1"].get("taskId"), "task-xyz")
        self.assertEqual(by_id["log-2"].get("topicId"), "topic-abc")
        self.assertEqual(by_id["log-2"].get("taskId"), "task-xyz")

    def test_unlocked_command_logs_do_not_inherit_topic_scope(self):
        session_key = "channel:classifier-test:commands"
        logs = [
            {
                "id": "log-1",
                "type": "conversation",
                "agentId": "user",
                "content": "Fix the OAuth callback in login flow.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-11T10:00:00.000Z",
                "source": {"sessionKey": session_key, "channel": "classifier-test"},
            },
            {
                "id": "log-2",
                "type": "conversation",
                "agentId": "assistant",
                "content": "I'll patch and test it.",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-11T10:00:01.000Z",
                "source": {"sessionKey": session_key, "channel": "classifier-test"},
            },
            {
                "id": "log-3",
                "type": "conversation",
                "agentId": "user",
                "content": "/new",
                "classificationStatus": "pending",
                "classificationAttempts": 0,
                "createdAt": "2026-02-11T10:00:02.000Z",
                "source": {"sessionKey": session_key, "channel": "classifier-test"},
            },
        ]

        patched: list[tuple[str, dict]] = []

        def fake_list_logs_by_session(_sk: str, **kwargs):
            self.assertEqual(_sk, session_key)
            if kwargs.get("classificationStatus") == "pending":
                return logs
            return logs

        def fake_patch_log(log_id: str, payload: dict):
            patched.append((log_id, payload))

        def fake_call_classifier(window, pending_ids, candidate_topics, candidate_tasks, *_args, **_kwargs):
            return {
                "topic": {"id": "topic-abc", "name": "Auth", "create": False},
                "task": None,
                "summaries": [{"id": sid, "summary": "Fix OAuth callback"} for sid in pending_ids],
            }

        with (
            patch.object(c, "list_logs_by_session", side_effect=fake_list_logs_by_session),
            patch.object(c, "patch_log", side_effect=fake_patch_log),
            patch.object(c, "_llm_enabled", return_value=True),
            patch.object(c, "call_classifier", side_effect=fake_call_classifier),
            patch.object(c, "_window_has_task_intent", return_value=False),
            patch.object(c, "build_notes_index", return_value={}),
            patch.object(c, "list_topics", return_value=[{"id": "topic-abc", "name": "Auth"}]),
            patch.object(c, "list_logs_by_topic", return_value=[]),
            patch.object(c, "list_logs_by_task", return_value=[]),
            patch.object(c, "memory_snippets", return_value=[]),
            patch.object(c, "task_candidates", return_value=[]),
            patch.object(c, "list_tasks", return_value=[]),
        ):
            c.classify_session(session_key)

        by_id = {lid: payload for lid, payload in patched}
        self.assertIn("log-3", by_id)
        command_payload = by_id["log-3"]
        self.assertEqual(command_payload.get("classificationStatus"), "classified")
        self.assertEqual(command_payload.get("classificationError"), "filtered_command")
        self.assertIsNone(command_payload.get("topicId"))
        self.assertIsNone(command_payload.get("taskId"))


if __name__ == "__main__":
    unittest.main()
