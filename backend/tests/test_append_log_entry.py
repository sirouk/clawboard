from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

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
    from app.models import LogEntry, Task, Topic  # noqa: E402

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
