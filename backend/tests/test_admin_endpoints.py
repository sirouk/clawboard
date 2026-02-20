from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-admin-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.db import get_session, init_db  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import InstanceConfig, IngestQueue, LogEntry, Task, Topic  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class AdminEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Clawboard-Token": "test-token"}

    def setUp(self):
        with get_session() as session:
            for row in session.exec(select(LogEntry)).all():
                session.delete(row)
            for row in session.exec(select(Task)).all():
                session.delete(row)
            for row in session.exec(select(Topic)).all():
                session.delete(row)
            for row in session.exec(select(IngestQueue)).all():
                session.delete(row)
            instance = session.get(InstanceConfig, 1)
            if instance:
                session.delete(instance)
            session.commit()

    def test_start_fresh_replay_defaults_to_non_destructive_reclassify(self):
        ts = now_iso()
        with get_session() as session:
            session.add(InstanceConfig(id=1, title="Clawboard", integrationLevel="write", updatedAt=ts))
            session.add(
                Topic(
                    id="topic-1",
                    name="Topic",
                    sortIndex=0,
                    color="#FF8A4A",
                    description=None,
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
                Task(
                    id="task-1",
                    topicId="topic-1",
                    title="Task",
                    sortIndex=0,
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
                LogEntry(
                    id="log-1",
                    topicId="topic-1",
                    taskId="task-1",
                    relatedLogId=None,
                    idempotencyKey=None,
                    type="conversation",
                    content="hello",
                    summary="hello",
                    raw=None,
                    classificationStatus="classified",
                    classificationAttempts=2,
                    classificationError="previous error",
                    createdAt=ts,
                    updatedAt=ts,
                    agentId="user",
                    agentLabel="User",
                    source={"sessionKey": "channel:test"},
                )
            )
            session.add(
                LogEntry(
                    id="log-2",
                    topicId="topic-1",
                    taskId=None,
                    relatedLogId=None,
                    idempotencyKey=None,
                    type="conversation",
                    content="topic-linked only",
                    summary="topic-linked only",
                    raw=None,
                    classificationStatus="classified",
                    classificationAttempts=1,
                    classificationError=None,
                    createdAt=ts,
                    updatedAt=ts,
                    agentId="user",
                    agentLabel="User",
                    source={"sessionKey": "channel:test"},
                )
            )
            session.add(
                LogEntry(
                    id="log-3",
                    topicId=None,
                    taskId=None,
                    relatedLogId=None,
                    idempotencyKey=None,
                    type="conversation",
                    content="unassigned",
                    summary="unassigned",
                    raw=None,
                    classificationStatus="classified",
                    classificationAttempts=3,
                    classificationError="older error",
                    createdAt=ts,
                    updatedAt=ts,
                    agentId="assistant",
                    agentLabel="Assistant",
                    source={"sessionKey": "channel:test"},
                )
            )
            session.add(
                LogEntry(
                    id="log-4",
                    topicId="topic-1",
                    taskId="task-1",
                    relatedLogId=None,
                    idempotencyKey=None,
                    type="conversation",
                    content="failed assignment",
                    summary="failed assignment",
                    raw=None,
                    classificationStatus="failed",
                    classificationAttempts=2,
                    classificationError="timeout",
                    createdAt=ts,
                    updatedAt=ts,
                    agentId="user",
                    agentLabel="User",
                    source={"sessionKey": "channel:test"},
                )
            )
            session.add(
                IngestQueue(
                    payload={"type": "conversation", "content": "queued"},
                    status="pending",
                    attempts=0,
                    lastError=None,
                    createdAt=ts,
                )
            )
            session.commit()

        res = self.client.post(
            "/api/admin/start-fresh-replay",
            headers=self.auth_headers,
            json={"integrationLevel": "full"},
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("ok"))
        self.assertEqual(payload.get("integrationLevel"), "full")
        self.assertEqual(payload.get("replayMode"), "reclassify")

        with get_session() as session:
            self.assertEqual(len(session.exec(select(Topic)).all()), 1)
            self.assertEqual(len(session.exec(select(Task)).all()), 1)
            self.assertEqual(len(session.exec(select(IngestQueue)).all()), 1)

            log = session.get(LogEntry, "log-1")
            self.assertIsNotNone(log)
            self.assertEqual(log.topicId, "topic-1")
            self.assertEqual(log.taskId, "task-1")
            self.assertEqual(log.classificationStatus, "classified")
            self.assertEqual(log.classificationAttempts, 2)
            self.assertEqual(log.classificationError, "previous error")

            topic_only = session.get(LogEntry, "log-2")
            self.assertIsNotNone(topic_only)
            self.assertEqual(topic_only.topicId, "topic-1")
            self.assertIsNone(topic_only.taskId)
            self.assertEqual(topic_only.classificationStatus, "pending")
            self.assertEqual(topic_only.classificationAttempts, 0)
            self.assertIsNone(topic_only.classificationError)

            unassigned = session.get(LogEntry, "log-3")
            self.assertIsNotNone(unassigned)
            self.assertIsNone(unassigned.topicId)
            self.assertIsNone(unassigned.taskId)
            self.assertEqual(unassigned.classificationStatus, "pending")
            self.assertEqual(unassigned.classificationAttempts, 0)
            self.assertIsNone(unassigned.classificationError)

            failed = session.get(LogEntry, "log-4")
            self.assertIsNotNone(failed)
            self.assertEqual(failed.topicId, "topic-1")
            self.assertEqual(failed.taskId, "task-1")
            self.assertEqual(failed.classificationStatus, "pending")
            self.assertEqual(failed.classificationAttempts, 0)
            self.assertIsNone(failed.classificationError)

            instance = session.get(InstanceConfig, 1)
            self.assertIsNotNone(instance)
            self.assertEqual(instance.integrationLevel, "full")

    def test_start_fresh_replay_fresh_mode_clears_derived_state(self):
        ts = now_iso()
        with get_session() as session:
            session.add(InstanceConfig(id=1, title="Clawboard", integrationLevel="write", updatedAt=ts))
            session.add(
                Topic(
                    id="topic-1",
                    name="Topic",
                    sortIndex=0,
                    color="#FF8A4A",
                    description=None,
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
                Task(
                    id="task-1",
                    topicId="topic-1",
                    title="Task",
                    sortIndex=0,
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
                LogEntry(
                    id="log-1",
                    topicId="topic-1",
                    taskId="task-1",
                    relatedLogId=None,
                    idempotencyKey=None,
                    type="conversation",
                    content="hello",
                    summary="hello",
                    raw=None,
                    classificationStatus="classified",
                    classificationAttempts=2,
                    classificationError="previous error",
                    createdAt=ts,
                    updatedAt=ts,
                    agentId="user",
                    agentLabel="User",
                    source={"sessionKey": "channel:test"},
                )
            )
            session.add(
                IngestQueue(
                    payload={"type": "conversation", "content": "queued"},
                    status="pending",
                    attempts=0,
                    lastError=None,
                    createdAt=ts,
                )
            )
            session.commit()

        res = self.client.post(
            "/api/admin/start-fresh-replay",
            headers=self.auth_headers,
            json={"integrationLevel": "full", "replayMode": "fresh"},
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("ok"))
        self.assertEqual(payload.get("integrationLevel"), "full")
        self.assertEqual(payload.get("replayMode"), "fresh")

        with get_session() as session:
            self.assertEqual(session.exec(select(Topic)).all(), [])
            self.assertEqual(session.exec(select(Task)).all(), [])
            self.assertEqual(session.exec(select(IngestQueue)).all(), [])

            log = session.get(LogEntry, "log-1")
            self.assertIsNotNone(log)
            self.assertIsNone(log.topicId)
            self.assertIsNone(log.taskId)
            self.assertEqual(log.classificationStatus, "pending")
            self.assertEqual(log.classificationAttempts, 0)
            self.assertIsNone(log.classificationError)

            instance = session.get(InstanceConfig, 1)
            self.assertIsNotNone(instance)
            self.assertEqual(instance.integrationLevel, "full")
