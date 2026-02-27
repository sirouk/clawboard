from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-append-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.db import get_session, init_db  # noqa: E402
    import app.main as main_module  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import LogEntry, OpenClawRequestRoute, SessionRoutingMemory, Task, Topic  # noqa: E402
    from app.schemas import LogAppend  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    main_module = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class AppendLogEntryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    def setUp(self):
        with get_session() as session:
            for row in session.exec(select(OpenClawRequestRoute)).all():
                session.delete(row)
            for row in session.exec(select(SessionRoutingMemory)).all():
                session.delete(row)
            for row in session.exec(select(LogEntry)).all():
                session.delete(row)
            for row in session.exec(select(Task)).all():
                session.delete(row)
            for row in session.exec(select(Topic)).all():
                session.delete(row)
            session.commit()

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Clawboard-Token": "test-token"}

    def test_append_log_aligns_topic_to_task(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.add(
                Topic(
                    id="topic-b",
                    name="Topic B",
                    color="#4DA39E",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        # Send a log that incorrectly claims topic-b while referencing task-a (which belongs to topic-a).
        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": "topic-b",
                "taskId": "task-a",
                "content": "hello",
                "summary": "hello",
                "raw": "hello",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {"channel": "tests", "sessionKey": "clawboard:topic:topic-b", "messageId": "m1"},
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertEqual(payload.get("taskId"), "task-a")
        # Task implies its real topic.
        self.assertEqual(payload.get("topicId"), "topic-a")

    def test_append_log_filters_cron_event_logs(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": "topic-a",
                "taskId": "task-a",
                "content": "System: Cron: backup ran.",
                "summary": "Cron backup ran",
                "raw": "System: Cron: backup ran.",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {"channel": "cron-event", "sessionKey": "agent:main:main", "messageId": "oc:test"},
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIsNone(payload.get("topicId"))
        self.assertIsNone(payload.get("taskId"))
        self.assertEqual(payload.get("classificationStatus"), "failed")
        self.assertEqual(payload.get("classificationError"), "filtered_cron_event")
        self.assertEqual(payload.get("classificationAttempts"), 1)

    def test_append_log_filters_main_session_heartbeat_control_plane_conversation(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": "topic-a",
                "taskId": "task-a",
                "content": "Heartbeat: heartbeat_ok",
                "summary": "Heartbeat check",
                "raw": "[Cron:watchdog] Heartbeat and watchdog recovery check",
                "createdAt": ts,
                "agentId": "system",
                "agentLabel": "System",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "agent:main:main",
                    "messageId": "oc:heartbeat-1",
                    "boardScopeTopicId": "topic-a",
                    "boardScopeTaskId": "task-a",
                    "boardScopeKind": "task",
                    "boardScopeLock": True,
                },
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIsNone(payload.get("topicId"))
        self.assertIsNone(payload.get("taskId"))
        self.assertEqual(payload.get("classificationStatus"), "failed")
        self.assertEqual(payload.get("classificationError"), "filtered_control_plane")
        self.assertEqual(payload.get("classificationAttempts"), 1)
        source = payload.get("source") or {}
        self.assertNotIn("boardScopeTopicId", source)
        self.assertNotIn("boardScopeTaskId", source)
        self.assertNotIn("boardScopeKind", source)
        self.assertNotIn("boardScopeLock", source)

    def test_append_log_filters_subagent_scaffold_conversation(self):
        ts = now_iso()
        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "[Subagent Context] You are running as a subagent (depth 1/1).",
                "summary": "subagent context preface",
                "raw": None,
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {
                    "channel": "direct",
                    "sessionKey": "agent:coding:subagent:abc123",
                    "messageId": "oc:subagent-scaffold-1",
                },
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIsNone(payload.get("topicId"))
        self.assertIsNone(payload.get("taskId"))
        self.assertEqual(payload.get("classificationStatus"), "failed")
        self.assertEqual(payload.get("classificationError"), "filtered_subagent_scaffold")
        self.assertEqual(payload.get("classificationAttempts"), 1)

    def test_append_log_marks_scoped_tool_trace_action_as_terminal_classified(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "action",
                "topicId": "topic-a",
                "taskId": "task-a",
                "content": "Tool call: shell.exec",
                "summary": "Tool call: shell.exec",
                "raw": "Tool call: shell.exec {\"cmd\":\"echo hi\"}",
                "createdAt": ts,
                "agentId": "main",
                "agentLabel": "Main Agent",
                "source": {"channel": "openclaw", "sessionKey": "clawboard:task:topic-a:task-a", "messageId": "oc:tool-1"},
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertEqual(payload.get("topicId"), "topic-a")
        self.assertEqual(payload.get("taskId"), "task-a")
        self.assertEqual(payload.get("classificationStatus"), "classified")
        self.assertEqual(payload.get("classificationError"), "filtered_tool_activity")
        self.assertEqual(payload.get("classificationAttempts"), 1)

    def test_append_log_marks_unanchored_tool_trace_action_as_terminal_failed(self):
        ts = now_iso()
        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "action",
                "content": "Tool result: shell.exec",
                "summary": "Tool result: shell.exec",
                "raw": "Tool result: shell.exec exit=0",
                "createdAt": ts,
                "agentId": "main",
                "agentLabel": "Main Agent",
                "source": {"channel": "openclaw", "sessionKey": "agent:main:main", "messageId": "oc:tool-2"},
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIsNone(payload.get("topicId"))
        self.assertIsNone(payload.get("taskId"))
        self.assertEqual(payload.get("classificationStatus"), "failed")
        self.assertEqual(payload.get("classificationError"), "filtered_unanchored_tool_activity")
        self.assertEqual(payload.get("classificationAttempts"), 1)

    def test_append_log_defers_unanchored_channel_tool_trace_action_for_bundle_scoping(self):
        ts = now_iso()
        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "action",
                "content": "Tool call: web.search",
                "summary": "Tool call: web.search",
                "raw": "Tool call: web.search {\"q\":\"sqlmodel inserts\"}",
                "createdAt": ts,
                "agentId": "assistant",
                "agentLabel": "Assistant",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "channel:openclaw:test-bundle-scope",
                    "messageId": "oc:tool-3",
                },
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIsNone(payload.get("topicId"))
        self.assertIsNone(payload.get("taskId"))
        self.assertEqual(payload.get("classificationStatus"), "pending")
        self.assertIsNone(payload.get("classificationError"))
        self.assertEqual(payload.get("classificationAttempts"), 0)

    def test_append_log_classifies_unanchored_channel_memory_tool_action_immediately(self):
        ts = now_iso()
        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "action",
                "content": "Tool call: memory_search",
                "summary": "Tool call: memory_search",
                "raw": "Tool call: memory_search {\"query\":\"idempotency\"}",
                "createdAt": ts,
                "agentId": "assistant",
                "agentLabel": "Assistant",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "channel:openclaw:test-memory-action",
                    "messageId": "oc:tool-memory-1",
                },
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIsNone(payload.get("topicId"))
        self.assertIsNone(payload.get("taskId"))
        self.assertEqual(payload.get("classificationStatus"), "classified")
        self.assertEqual(payload.get("classificationError"), "filtered_memory_action")
        self.assertEqual(payload.get("classificationAttempts"), 1)

    def test_append_log_recovers_subagent_scope_from_parent_handoff_action(self):
        base_dt = datetime.now(timezone.utc)
        anchor_ts = base_dt.isoformat()
        child_ts = (base_dt + timedelta(seconds=2)).isoformat()
        child_session_key = "agent:coding:subagent:scope-recover-1"

        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=anchor_ts,
                    updatedAt=anchor_ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=anchor_ts,
                    updatedAt=anchor_ts,
                )
            )
            session.commit()

        anchor_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "action",
                "topicId": "topic-a",
                "taskId": "task-a",
                "content": "Tool call: clawboard_update_task",
                "summary": "Tool call: clawboard_update_task",
                "raw": (
                    '{"id":"task-a","status":"doing","tags":["delegating","agent:coding",'
                    '"session:agent:coding:subagent:scope-recover-1"]}'
                ),
                "createdAt": anchor_ts,
                "agentId": "main",
                "agentLabel": "OpenClaw",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "agent:main:clawboard:task:topic-a:task-a",
                    "messageId": "oc:handoff-anchor-1",
                },
            },
        )
        self.assertEqual(anchor_res.status_code, 200, anchor_res.text)

        child_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "action",
                "content": "Tool call: exec",
                "summary": "Tool call: exec",
                "raw": '{"cmd":"pwd"}',
                "createdAt": child_ts,
                "agentId": "coding",
                "agentLabel": "Agent coding",
                "source": {
                    "channel": "direct",
                    "sessionKey": child_session_key,
                    "boardScopeSpaceId": "space-default",
                    "messageId": "oc:subagent-tool-1",
                },
            },
        )
        self.assertEqual(child_res.status_code, 200, child_res.text)
        payload = child_res.json()
        self.assertEqual(payload.get("topicId"), "topic-a")
        self.assertEqual(payload.get("taskId"), "task-a")
        self.assertEqual(payload.get("classificationStatus"), "classified")
        self.assertEqual(payload.get("classificationError"), "filtered_tool_activity")
        source = payload.get("source") or {}
        self.assertEqual(source.get("boardScopeTopicId"), "topic-a")
        self.assertEqual(source.get("boardScopeTaskId"), "task-a")
        self.assertTrue(bool(source.get("boardScopeLock")))

    def test_append_log_backfills_earlier_unanchored_subagent_tool_activity(self):
        base_dt = datetime.now(timezone.utc)
        topic_ts = base_dt.isoformat()
        unanchored_ts = (base_dt + timedelta(seconds=1)).isoformat()
        scoped_ts = (base_dt + timedelta(seconds=3)).isoformat()
        child_session_key = "agent:web:subagent:retro-scope-1"

        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=topic_ts,
                    updatedAt=topic_ts,
                )
            )
            session.commit()

        first_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "action",
                "content": "Tool call: web_search",
                "summary": "Tool call: web_search",
                "raw": '{"query":"snow forecast"}',
                "createdAt": unanchored_ts,
                "agentId": "web",
                "agentLabel": "Agent web",
                "source": {
                    "channel": "direct",
                    "sessionKey": child_session_key,
                    "boardScopeSpaceId": "space-default",
                    "messageId": "oc:subagent-unanchored-1",
                },
            },
        )
        self.assertEqual(first_res.status_code, 200, first_res.text)
        first_payload = first_res.json()
        first_id = str(first_payload.get("id") or "")
        self.assertTrue(first_id)
        self.assertEqual(first_payload.get("classificationStatus"), "failed")
        self.assertEqual(first_payload.get("classificationError"), "filtered_unanchored_tool_activity")
        self.assertIsNone(first_payload.get("topicId"))
        self.assertIsNone(first_payload.get("taskId"))

        scoped_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "I found the forecast details.",
                "summary": "forecast details",
                "raw": "I found the forecast details.",
                "createdAt": scoped_ts,
                "agentId": "assistant",
                "agentLabel": "Agent web",
                "source": {
                    "channel": "direct",
                    "sessionKey": child_session_key,
                    "boardScopeTopicId": "topic-a",
                    "boardScopeSpaceId": "space-default",
                    "messageId": "oc:subagent-scoped-1",
                },
            },
        )
        self.assertEqual(scoped_res.status_code, 200, scoped_res.text)
        scoped_payload = scoped_res.json()
        self.assertEqual(scoped_payload.get("topicId"), "topic-a")
        self.assertIsNone(scoped_payload.get("taskId"))

        with get_session() as session:
            patched = session.get(LogEntry, first_id)
            self.assertIsNotNone(patched)
            assert patched is not None
            self.assertEqual(patched.topicId, "topic-a")
            self.assertIsNone(patched.taskId)
            self.assertEqual(patched.classificationStatus, "classified")
            self.assertEqual(patched.classificationError, "filtered_tool_activity")
            source = patched.source if isinstance(patched.source, dict) else {}
            self.assertEqual(source.get("boardScopeTopicId"), "topic-a")
            self.assertEqual(source.get("boardScopeKind"), "topic")

    def test_append_log_recovers_subagent_scope_from_routing_memory_with_stale_task(self):
        base_dt = datetime.now(timezone.utc)
        topic_ts = base_dt.isoformat()
        child_ts = (base_dt + timedelta(seconds=2)).isoformat()
        child_session_key = "agent:web:subagent:routing-recover-1"

        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=topic_ts,
                    updatedAt=topic_ts,
                )
            )
            session.add(
                SessionRoutingMemory(
                    sessionKey=child_session_key,
                    items=[
                        {
                            "ts": topic_ts,
                            "anchor": None,
                            "topicId": "topic-a",
                            "taskId": "task-does-not-exist",
                            "topicName": "Topic A",
                            "taskTitle": None,
                        }
                    ],
                    createdAt=topic_ts,
                    updatedAt=topic_ts,
                )
            )
            session.commit()

        child_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "action",
                "content": "Tool call: web_fetch",
                "summary": "Tool call: web_fetch",
                "raw": '{"url":"https://example.com"}',
                "createdAt": child_ts,
                "agentId": "web",
                "agentLabel": "Agent web",
                "source": {
                    "channel": "direct",
                    "sessionKey": child_session_key,
                    "boardScopeSpaceId": "space-default",
                    "messageId": "oc:subagent-routing-1",
                },
            },
        )
        self.assertEqual(child_res.status_code, 200, child_res.text)
        payload = child_res.json()
        self.assertEqual(payload.get("topicId"), "topic-a")
        self.assertIsNone(payload.get("taskId"))
        self.assertEqual(payload.get("classificationStatus"), "classified")
        self.assertEqual(payload.get("classificationError"), "filtered_tool_activity")

    def test_append_log_infers_task_scope_from_canonical_routing_memory_for_wrapped_board_topic_session(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.add(
                SessionRoutingMemory(
                    sessionKey="clawboard:topic:topic-a",
                    items=[
                        {
                            "ts": ts,
                            "anchor": "promoted",
                            "topicId": "topic-a",
                            "taskId": "task-a",
                            "topicName": "Topic A",
                            "taskTitle": "Task A",
                        }
                    ],
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "Assistant follow-up from wrapped board session.",
                "summary": "assistant follow-up",
                "raw": "Assistant follow-up from wrapped board session.",
                "createdAt": ts,
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {
                    "channel": "webchat",
                    "sessionKey": "agent:main:clawboard:topic:topic-a",
                    "messageId": "oc:wrapped-memory-infer-1",
                },
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json() or {}
        self.assertEqual(payload.get("topicId"), "topic-a")
        self.assertEqual(payload.get("taskId"), "task-a")
        source = payload.get("source") or {}
        self.assertEqual(source.get("boardScopeTopicId"), "topic-a")
        self.assertEqual(source.get("boardScopeTaskId"), "task-a")

    def test_patch_log_promotion_backfills_request_rows_across_wrapped_and_canonical_board_topic_sessions(self):
        base_dt = datetime.now(timezone.utc)
        user_ts = base_dt.isoformat()
        assistant_ts = (base_dt + timedelta(seconds=1)).isoformat()

        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=user_ts,
                    updatedAt=user_ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=user_ts,
                    updatedAt=user_ts,
                )
            )
            session.commit()

        user_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": "topic-a",
                "content": "User request",
                "summary": "User request",
                "raw": "User request",
                "createdAt": user_ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "clawboard:topic:topic-a",
                    "requestId": "occhat-promote-bridge-1",
                    "messageId": "occhat-promote-bridge-1",
                },
            },
        )
        self.assertEqual(user_res.status_code, 200, user_res.text)
        user_payload = user_res.json() or {}
        user_id = str(user_payload.get("id") or "")
        self.assertTrue(user_id)

        assistant_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": "topic-a",
                "content": "Assistant response",
                "summary": "Assistant response",
                "raw": "Assistant response",
                "createdAt": assistant_ts,
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {
                    "channel": "webchat",
                    "sessionKey": "agent:main:clawboard:topic:topic-a",
                    "requestId": "occhat-promote-bridge-1",
                    "messageId": "oc:assistant-promote-bridge-1",
                },
                "classificationStatus": "pending",
            },
        )
        self.assertEqual(assistant_res.status_code, 200, assistant_res.text)
        assistant_payload = assistant_res.json() or {}
        assistant_id = str(assistant_payload.get("id") or "")
        self.assertTrue(assistant_id)

        patch_res = self.client.patch(
            f"/api/log/{assistant_id}",
            headers=self.auth_headers,
            json={
                "topicId": "topic-a",
                "taskId": "task-a",
                "classificationStatus": "classified",
                "classificationAttempts": 1,
            },
        )
        self.assertEqual(patch_res.status_code, 200, patch_res.text)
        patched_payload = patch_res.json() or {}
        self.assertEqual(patched_payload.get("taskId"), "task-a")

        with get_session() as session:
            user_row = session.get(LogEntry, user_id)
            self.assertIsNotNone(user_row)
            assert user_row is not None
            self.assertEqual(user_row.topicId, "topic-a")
            self.assertEqual(user_row.taskId, "task-a")
            source = user_row.source if isinstance(user_row.source, dict) else {}
            self.assertEqual(source.get("boardScopeTaskId"), "task-a")
            self.assertEqual(source.get("boardScopeKind"), "task")

    def test_append_log_dedupes_user_request_across_wrapped_and_canonical_board_topic_sessions(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        first_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": "topic-a",
                "content": "same request",
                "summary": "same request",
                "raw": "same request",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "clawboard:topic:topic-a",
                    "requestId": "occhat-dedupe-wrap-1",
                    "messageId": "occhat-dedupe-wrap-1",
                },
            },
        )
        self.assertEqual(first_res.status_code, 200, first_res.text)
        first_payload = first_res.json() or {}
        first_id = str(first_payload.get("id") or "")
        self.assertTrue(first_id)

        second_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": "topic-a",
                "content": "same request",
                "summary": "same request",
                "raw": "same request",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {
                    "channel": "webchat",
                    "sessionKey": "agent:main:clawboard:topic:topic-a",
                    "requestId": "occhat-dedupe-wrap-1",
                    "messageId": "occhat-dedupe-wrap-1:replay",
                },
            },
        )
        self.assertEqual(second_res.status_code, 200, second_res.text)
        second_payload = second_res.json() or {}
        self.assertEqual(str(second_payload.get("id") or ""), first_id)

        with get_session() as session:
            rows = session.exec(select(LogEntry).where(LogEntry.id == first_id)).all()
            self.assertEqual(len(rows), 1)

    def test_append_log_dedupes_non_user_replay_across_wrapped_direct_and_canonical_board_topic_sessions(self):
        base_dt = datetime.now(timezone.utc)
        first_ts = base_dt.isoformat()
        replay_ts = first_ts
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=first_ts,
                    updatedAt=first_ts,
                )
            )
            session.commit()

        first_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": "topic-a",
                "content": "status update alpha beta",
                "summary": "status update alpha beta",
                "raw": "status update alpha beta",
                "createdAt": first_ts,
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {
                    "channel": "clawboard",
                    "sessionKey": "clawboard:topic:topic-a",
                },
            },
        )
        self.assertEqual(first_res.status_code, 200, first_res.text)
        first_payload = first_res.json() or {}
        first_id = str(first_payload.get("id") or "")
        self.assertTrue(first_id)

        replay_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": "topic-a",
                "content": "### Status update\n- alpha\n- beta",
                "summary": "status update alpha beta",
                "raw": "### Status update\n- alpha\n- beta",
                "createdAt": replay_ts,
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {
                    "channel": "direct",
                    "sessionKey": "agent:main:clawboard:topic:topic-a",
                    "messageId": "oc:assistant-wrap-vs-board-1",
                },
            },
        )
        self.assertEqual(replay_res.status_code, 200, replay_res.text)
        replay_payload = replay_res.json() or {}
        self.assertEqual(str(replay_payload.get("id") or ""), first_id)

        with get_session() as session:
            row = session.get(LogEntry, first_id)
            self.assertIsNotNone(row)
            assert row is not None
            self.assertIn("### Status update", str(row.content or ""))
            self.assertTrue(str(row.sourceIdentityKey or "").startswith("srcid:conversation:assistant:openclaw:"))
            source = row.source if isinstance(row.source, dict) else {}
            self.assertEqual(str(source.get("messageId") or ""), "oc:assistant-wrap-vs-board-1")

    def test_append_log_dedupes_subagent_non_user_replay_and_prefers_markdown_variant(self):
        base_dt = datetime.now(timezone.utc)
        first_ts = base_dt.isoformat()
        replay_ts = first_ts
        child_session_key = "agent:web:subagent:dedupe-md-1"

        first_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "investigating endpoint checked logs verified retry",
                "summary": "investigating endpoint checked logs verified retry",
                "raw": "investigating endpoint checked logs verified retry",
                "createdAt": first_ts,
                "agentId": "web",
                "agentLabel": "Agent web",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": child_session_key,
                },
            },
        )
        self.assertEqual(first_res.status_code, 200, first_res.text)
        first_payload = first_res.json() or {}
        first_id = str(first_payload.get("id") or "")
        self.assertTrue(first_id)

        replay_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "Investigating endpoint:\n- checked logs\n- verified retry",
                "summary": "investigating endpoint checked logs verified retry",
                "raw": "Investigating endpoint:\n- checked logs\n- verified retry",
                "createdAt": replay_ts,
                "agentId": "web",
                "agentLabel": "Agent web",
                "source": {
                    "channel": "direct",
                    "sessionKey": child_session_key,
                    "messageId": "oc:subagent-dedupe-md-1",
                },
            },
        )
        self.assertEqual(replay_res.status_code, 200, replay_res.text)
        replay_payload = replay_res.json() or {}
        self.assertEqual(str(replay_payload.get("id") or ""), first_id)

        with get_session() as session:
            row = session.get(LogEntry, first_id)
            self.assertIsNotNone(row)
            assert row is not None
            self.assertIn("- checked logs", str(row.content or ""))
            self.assertTrue(str(row.sourceIdentityKey or "").startswith("srcid:conversation:web:openclaw:"))
            source = row.source if isinstance(row.source, dict) else {}
            self.assertEqual(str(source.get("messageId") or ""), "oc:subagent-dedupe-md-1")

    def test_append_log_concurrent_wrapped_user_replay_uses_source_identity_and_avoids_route_race_500(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-race-a",
                    name="Topic Race A",
                    color="#D7792B",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        payload_a = LogAppend(
            type="conversation",
            topicId="topic-race-a",
            content="same request payload",
            summary="same request payload",
            raw="same request payload",
            createdAt=ts,
            agentId="user",
            agentLabel="User",
            source={
                "channel": "openclaw",
                "sessionKey": "clawboard:topic:topic-race-a",
                "requestId": "occhat-race-append-1",
                "messageId": "occhat-race-append-1",
            },
        )
        payload_b = LogAppend(
            type="conversation",
            topicId="topic-race-a",
            content="same request payload",
            summary="same request payload",
            raw="same request payload",
            createdAt=ts,
            agentId="user",
            agentLabel="User",
            source={
                "channel": "webchat",
                "sessionKey": "agent:main:clawboard:topic:topic-race-a",
                "requestId": "occhat-race-append-1",
                "messageId": "occhat-race-append-1:replay",
            },
        )

        barrier = threading.Barrier(2)
        row_ids: list[str] = []
        errors: list[str] = []

        def _run(payload: LogAppend) -> None:
            try:
                with get_session() as session:
                    barrier.wait()
                    idem = main_module._idempotency_key(payload, None)
                    row = main_module.append_log_entry(session, payload, idem)
                    row_ids.append(str(row.id or ""))
            except Exception as exc:
                errors.append(str(exc))

        thread_a = threading.Thread(target=_run, args=(payload_a,))
        thread_b = threading.Thread(target=_run, args=(payload_b,))
        thread_a.start()
        thread_b.start()
        thread_a.join()
        thread_b.join()

        self.assertFalse(errors, f"unexpected concurrency errors: {errors}")
        self.assertEqual(len(row_ids), 2)
        self.assertEqual(len(set(row_ids)), 1)

        with get_session() as session:
            rows = session.exec(select(LogEntry)).all()
            self.assertEqual(len(rows), 1)
            row = rows[0]
            self.assertEqual(str(row.sourceIdentityKey or ""), "srcid:conversation:user:openclaw:clawboard:topic:topic-race-a:req:occhat-race-append-1")

    def test_append_log_creates_request_route_from_board_user_send(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "route seed",
                "summary": "route seed",
                "raw": "route seed",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "clawboard:topic:topic-a",
                    "requestId": "occhat-route-seed-1",
                    "messageId": "occhat-route-seed-1",
                },
            },
        )
        self.assertEqual(res.status_code, 200, res.text)

        with get_session() as session:
            route = session.get(OpenClawRequestRoute, "occhat-route-seed-1")
            self.assertIsNotNone(route)
            assert route is not None
            self.assertEqual(route.topicId, "topic-a")
            self.assertIsNone(route.taskId)
            self.assertEqual(route.routeKind, "topic")
            self.assertFalse(route.routeLocked)

    def test_append_log_creates_request_route_from_occhat_message_id_when_request_id_is_non_occhat(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "route seed from message id",
                "summary": "route seed from message id",
                "raw": "route seed from message id",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "clawboard:topic:topic-a",
                    "requestId": "run-not-occhat-route-seed-1",
                    "messageId": "occhat-route-seed-message-1",
                },
            },
        )
        self.assertEqual(res.status_code, 200, res.text)

        with get_session() as session:
            route = session.get(OpenClawRequestRoute, "occhat-route-seed-message-1")
            self.assertIsNotNone(route)
            assert route is not None
            self.assertEqual(route.topicId, "topic-a")
            self.assertIsNone(route.taskId)
            self.assertEqual(route.routeKind, "topic")

    def test_append_log_request_route_overrides_mismatched_scope_for_same_request(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.add(
                Topic(
                    id="topic-b",
                    name="Topic B",
                    color="#4DA39E",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                OpenClawRequestRoute(
                    requestId="occhat-route-lock-1",
                    sessionKey="clawboard:task:topic-a:task-a",
                    baseSessionKey="clawboard:task:topic-a:task-a",
                    spaceId="space-default",
                    topicId="topic-a",
                    taskId="task-a",
                    routeKind="task",
                    routeLocked=True,
                    sourceLogId=None,
                    promotedAt=ts,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": "topic-b",
                "content": "assistant follow-up",
                "summary": "assistant follow-up",
                "raw": "assistant follow-up",
                "createdAt": ts,
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {
                    "channel": "webchat",
                    "sessionKey": "agent:main:clawboard:topic:topic-b",
                    "requestId": "occhat-route-lock-1",
                    "messageId": "oc:route-lock-1-assistant",
                    "boardScopeTopicId": "topic-b",
                },
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json() or {}
        self.assertEqual(payload.get("topicId"), "topic-a")
        self.assertEqual(payload.get("taskId"), "task-a")
        source = payload.get("source") or {}
        self.assertEqual(source.get("boardScopeTopicId"), "topic-a")
        self.assertEqual(source.get("boardScopeTaskId"), "task-a")
        self.assertEqual(source.get("boardScopeKind"), "task")

    def test_append_log_request_route_uses_occhat_message_id_when_request_id_is_non_occhat(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.add(
                Topic(
                    id="topic-b",
                    name="Topic B",
                    color="#4DA39E",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                OpenClawRequestRoute(
                    requestId="occhat-route-by-messageid-1",
                    sessionKey="clawboard:task:topic-a:task-a",
                    baseSessionKey="clawboard:task:topic-a:task-a",
                    spaceId="space-default",
                    topicId="topic-a",
                    taskId="task-a",
                    routeKind="task",
                    routeLocked=True,
                    sourceLogId=None,
                    promotedAt=ts,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "action",
                "topicId": "topic-b",
                "content": "tool call",
                "summary": "tool call",
                "raw": "{}",
                "createdAt": ts,
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "agent:main:clawboard:topic:topic-b",
                    "requestId": "run-route-by-messageid-1",
                    "messageId": "occhat-route-by-messageid-1",
                    "boardScopeTopicId": "topic-b",
                },
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json() or {}
        self.assertEqual(payload.get("topicId"), "topic-a")
        self.assertEqual(payload.get("taskId"), "task-a")
        source = payload.get("source") or {}
        self.assertEqual(source.get("boardScopeTopicId"), "topic-a")
        self.assertEqual(source.get("boardScopeTaskId"), "task-a")
        self.assertEqual(source.get("boardScopeKind"), "task")

    def test_patch_log_promotion_updates_request_route_to_task(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        create_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "promote this",
                "summary": "promote this",
                "raw": "promote this",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "clawboard:topic:topic-a",
                    "requestId": "occhat-promote-route-1",
                    "messageId": "occhat-promote-route-1",
                },
            },
        )
        self.assertEqual(create_res.status_code, 200, create_res.text)
        row_id = str((create_res.json() or {}).get("id") or "")
        self.assertTrue(row_id)

        patch_res = self.client.patch(
            f"/api/log/{row_id}",
            headers=self.auth_headers,
            json={
                "topicId": "topic-a",
                "taskId": "task-a",
                "classificationStatus": "classified",
                "classificationAttempts": 1,
            },
        )
        self.assertEqual(patch_res.status_code, 200, patch_res.text)

        with get_session() as session:
            route = session.get(OpenClawRequestRoute, "occhat-promote-route-1")
            self.assertIsNotNone(route)
            assert route is not None
            self.assertEqual(route.topicId, "topic-a")
            self.assertEqual(route.taskId, "task-a")
            self.assertEqual(route.routeKind, "task")
            self.assertTrue(route.routeLocked)
            self.assertTrue(bool(str(route.promotedAt or "").strip()))

    def test_append_log_route_promotion_retro_scopes_prior_topic_rows(self):
        ts = now_iso()
        request_id = "occhat-promote-append-route-1"
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        first_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "Kick this off.",
                "summary": "Kick this off.",
                "raw": "Kick this off.",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {
                    "channel": "openclaw",
                    "sessionKey": "clawboard:topic:topic-a",
                    "requestId": request_id,
                    "messageId": request_id,
                },
            },
        )
        self.assertEqual(first_res.status_code, 200, first_res.text)
        first_payload = first_res.json() or {}
        first_log_id = str(first_payload.get("id") or "")
        self.assertTrue(first_log_id)
        self.assertIsNone(first_payload.get("taskId"))

        published: list[dict] = []
        with patch.object(main_module.event_hub, "publish", side_effect=lambda event: published.append(event)):
            promote_res = self.client.post(
                "/api/log",
                headers=self.auth_headers,
                json={
                    "type": "conversation",
                    "topicId": "topic-a",
                    "taskId": "task-a",
                    "content": "Promote this request into task scope.",
                    "summary": "Promote this request into task scope.",
                    "raw": "Promote this request into task scope.",
                    "createdAt": now_iso(),
                    "agentId": "assistant",
                    "agentLabel": "OpenClaw",
                    "source": {
                        "channel": "clawboard",
                        "sessionKey": "clawboard:topic:topic-a",
                        "requestId": request_id,
                        "boardScopeTopicId": "topic-a",
                        "boardScopeTaskId": "task-a",
                        "boardScopeLock": True,
                    },
                },
            )
        self.assertEqual(promote_res.status_code, 200, promote_res.text)

        with get_session() as session:
            first_row = session.get(LogEntry, first_log_id)
            self.assertIsNotNone(first_row)
            assert first_row is not None
            self.assertEqual(first_row.topicId, "topic-a")
            self.assertEqual(first_row.taskId, "task-a")
            first_source = first_row.source or {}
            self.assertEqual(first_source.get("boardScopeTopicId"), "topic-a")
            self.assertEqual(first_source.get("boardScopeTaskId"), "task-a")
            self.assertEqual(first_source.get("boardScopeKind"), "task")
            self.assertTrue(bool(first_source.get("boardScopeLock")))

            route = session.get(OpenClawRequestRoute, request_id)
            self.assertIsNotNone(route)
            assert route is not None
            self.assertEqual(route.topicId, "topic-a")
            self.assertEqual(route.taskId, "task-a")
            self.assertEqual(route.routeKind, "task")
            self.assertTrue(route.routeLocked)

        patched_events = [
            event
            for event in published
            if isinstance(event, dict)
            and str(event.get("type") or "").strip() == "log.patched"
            and isinstance(event.get("data"), dict)
            and str(event.get("data", {}).get("id") or "").strip() == first_log_id
        ]
        self.assertTrue(patched_events, "Expected log.patched event for retro-scoped topic row promotion.")

    def test_patch_log_classifier_aligns_stale_topic_to_task(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-a",
                    name="Topic A",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.add(
                Topic(
                    id="topic-b",
                    name="Topic B",
                    color="#4DA39E",
                    description="test",
                    priority="medium",
                    status="active",
                    tags=[],
                    parentId=None,
                    pinned=False,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()
            session.add(
                Task(
                    id="task-a",
                    topicId="topic-a",
                    title="Task A",
                    color="#4EA1FF",
                    status="todo",
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        create_res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "hello",
                "summary": "hello",
                "raw": "hello",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {"channel": "tests", "sessionKey": "channel:tests", "messageId": "m2"},
                "classificationStatus": "pending",
            },
        )
        self.assertEqual(create_res.status_code, 200, create_res.text)
        log_id = (create_res.json() or {}).get("id")
        self.assertTrue(log_id)

        patch_res = self.client.patch(
            f"/api/log/{log_id}",
            headers=self.auth_headers,
            json={
                # Simulates stale scoped topic ID from retries; task is canonical.
                "topicId": "topic-b",
                "taskId": "task-a",
                "classificationStatus": "classified",
                "classificationAttempts": 1,
            },
        )
        self.assertEqual(patch_res.status_code, 200, patch_res.text)
        patched = patch_res.json() or {}
        self.assertEqual(patched.get("taskId"), "task-a")
        self.assertEqual(patched.get("topicId"), "topic-a")
