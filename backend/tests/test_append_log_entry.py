from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta

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
    from app.main import app  # noqa: E402
    from app.models import LogEntry, SessionRoutingMemory, Task, Topic  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
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
