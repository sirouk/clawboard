from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-delete-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.db import get_session, init_db  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import LogEntry, Task, Topic  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class DeleteEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    def setUp(self):
        with get_session() as session:
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

    def test_delete_topic_detaches_tasks_and_logs(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-1",
                    name="Delete topic",
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
                    id="task-1",
                    topicId="topic-1",
                    title="Task under topic",
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
                    classificationAttempts=1,
                    classificationError=None,
                    createdAt=ts,
                    updatedAt=ts,
                    agentId="user",
                    agentLabel="User",
                    source={"sessionKey": "channel:discord"},
                )
            )
            session.commit()

        res = self.client.delete("/api/topics/topic-1", headers=self.auth_headers)
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("deleted"))
        self.assertEqual(payload.get("detachedTasks"), 1)
        self.assertEqual(payload.get("detachedLogs"), 1)

        with get_session() as session:
            self.assertIsNone(session.get(Topic, "topic-1"))
            task = session.get(Task, "task-1")
            self.assertIsNotNone(task)
            self.assertIsNone(task.topicId)
            log = session.get(LogEntry, "log-1")
            self.assertIsNotNone(log)
            self.assertIsNone(log.topicId)
            self.assertEqual(log.taskId, "task-1")

    def test_delete_task_detaches_logs(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-1",
                    name="Delete task",
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
                    id="task-1",
                    topicId="topic-1",
                    title="Task to delete",
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
                LogEntry(
                    id="log-1",
                    topicId="topic-1",
                    taskId="task-1",
                    relatedLogId=None,
                    idempotencyKey=None,
                    type="conversation",
                    content="task thread",
                    summary="task thread",
                    raw=None,
                    classificationStatus="classified",
                    classificationAttempts=1,
                    classificationError=None,
                    createdAt=ts,
                    updatedAt=ts,
                    agentId="assistant",
                    agentLabel="OpenClaw",
                    source={"sessionKey": "channel:discord"},
                )
            )
            session.commit()

        res = self.client.delete("/api/tasks/task-1", headers=self.auth_headers)
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("deleted"))
        self.assertEqual(payload.get("detachedLogs"), 1)

        with get_session() as session:
            self.assertIsNone(session.get(Task, "task-1"))
            log = session.get(LogEntry, "log-1")
            self.assertIsNotNone(log)
            self.assertIsNone(log.taskId)
            self.assertEqual(log.topicId, "topic-1")

    def test_delete_log_cascades_related_notes(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-1",
                    name="Delete log",
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
                LogEntry(
                    id="log-1",
                    topicId="topic-1",
                    taskId=None,
                    relatedLogId=None,
                    idempotencyKey=None,
                    type="conversation",
                    content="root",
                    summary="root",
                    raw=None,
                    classificationStatus="classified",
                    classificationAttempts=1,
                    classificationError=None,
                    createdAt=ts,
                    updatedAt=ts,
                    agentId="assistant",
                    agentLabel="OpenClaw",
                    source={"sessionKey": "channel:discord"},
                )
            )
            session.commit()
            session.add(
                LogEntry(
                    id="note-1",
                    topicId="topic-1",
                    taskId=None,
                    relatedLogId="log-1",
                    idempotencyKey=None,
                    type="note",
                    content="curation",
                    summary="curation",
                    raw=None,
                    classificationStatus="classified",
                    classificationAttempts=1,
                    classificationError=None,
                    createdAt=ts,
                    updatedAt=ts,
                    agentId="user",
                    agentLabel="User",
                    source={"sessionKey": "channel:discord"},
                )
            )
            session.commit()

        res = self.client.delete("/api/log/log-1", headers=self.auth_headers)
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("deleted"))
        deleted_ids = set(payload.get("deletedIds") or [])
        self.assertIn("log-1", deleted_ids)
        self.assertIn("note-1", deleted_ids)

        with get_session() as session:
            self.assertIsNone(session.get(LogEntry, "log-1"))
            self.assertIsNone(session.get(LogEntry, "note-1"))


if __name__ == "__main__":
    unittest.main()
