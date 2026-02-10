from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-unsnooze-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.db import get_session, init_db  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import Task, Topic  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class UnsnoozeOnActivityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Clawboard-Token": "test-token"}

    def setUp(self):
        with get_session() as session:
            for row in session.exec(select(Task)).all():
                session.delete(row)
            for row in session.exec(select(Topic)).all():
                session.delete(row)
            session.commit()

    def test_conversation_revives_snoozed_topic_and_task(self):
        ts = now_iso()
        future = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        with get_session() as session:
            session.add(
                Topic(
                    id="topic-1",
                    name="Topic One",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="snoozed",
                    snoozedUntil=future,
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
                    title="Task One",
                    color="#4EA1FF",
                    status="todo",
                    tags=[],
                    snoozedUntil=future,
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
                "topicId": "topic-1",
                "taskId": "task-1",
                "content": "new message",
                "summary": "new message",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {"channel": "tests", "sessionKey": "clawboard:topic:topic-1", "messageId": "m1"},
                "classificationStatus": "classified",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)

        with get_session() as session:
            topic = session.get(Topic, "topic-1")
            self.assertIsNotNone(topic)
            self.assertEqual(topic.status, "active")
            self.assertIsNone(topic.snoozedUntil)

            task = session.get(Task, "task-1")
            self.assertIsNotNone(task)
            self.assertIsNone(task.snoozedUntil)

    def test_patch_log_revives_snoozed_topic_and_task(self):
        ts = now_iso()
        future = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        with get_session() as session:
            session.add(
                Topic(
                    id="topic-1",
                    name="Topic One",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="snoozed",
                    snoozedUntil=future,
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
                    title="Task One",
                    color="#4EA1FF",
                    status="todo",
                    tags=[],
                    snoozedUntil=future,
                    pinned=False,
                    priority="medium",
                    dueDate=None,
                    createdAt=ts,
                    updatedAt=ts,
                )
            )
            session.commit()

        # Create a conversation log with no initial routing (simulates pre-classifier ingest).
        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "topicId": None,
                "taskId": None,
                "content": "unrouted message",
                "summary": "unrouted message",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {"channel": "tests", "sessionKey": "channel:tests", "messageId": "m2"},
                "classificationStatus": "pending",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        log_id = (res.json() or {}).get("id")
        self.assertTrue(log_id)

        # Classifier patches routing after the fact -> should revive both.
        pres = self.client.patch(
            f"/api/log/{log_id}",
            headers=self.auth_headers,
            json={
                "topicId": "topic-1",
                "taskId": "task-1",
                "classificationStatus": "classified",
                "classificationAttempts": 1,
                "classificationError": None,
            },
        )
        self.assertEqual(pres.status_code, 200, pres.text)

        with get_session() as session:
            topic = session.get(Topic, "topic-1")
            self.assertIsNotNone(topic)
            self.assertEqual(topic.status, "active")
            self.assertIsNone(topic.snoozedUntil)

            task = session.get(Task, "task-1")
            self.assertIsNotNone(task)
            self.assertIsNone(task.snoozedUntil)

    def test_patch_log_task_only_revives_snoozed_task_and_topic(self):
        ts = now_iso()
        future = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        with get_session() as session:
            session.add(
                Topic(
                    id="topic-1",
                    name="Topic One",
                    color="#FF8A4A",
                    description="test",
                    priority="medium",
                    status="snoozed",
                    snoozedUntil=future,
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
                    title="Task One",
                    color="#4EA1FF",
                    status="todo",
                    tags=[],
                    snoozedUntil=future,
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
                "content": "unrouted message",
                "summary": "unrouted message",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {"channel": "tests", "sessionKey": "channel:tests", "messageId": "m3"},
                "classificationStatus": "pending",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        log_id = (res.json() or {}).get("id")
        self.assertTrue(log_id)

        pres = self.client.patch(
            f"/api/log/{log_id}",
            headers=self.auth_headers,
            json={
                # Important: omit topicId entirely so the API aligns it from the task.
                "taskId": "task-1",
                "classificationStatus": "classified",
                "classificationAttempts": 1,
            },
        )
        self.assertEqual(pres.status_code, 200, pres.text)

        with get_session() as session:
            topic = session.get(Topic, "topic-1")
            self.assertIsNotNone(topic)
            self.assertEqual(topic.status, "active")
            self.assertIsNone(topic.snoozedUntil)

            task = session.get(Task, "task-1")
            self.assertIsNotNone(task)
            self.assertIsNone(task.snoozedUntil)
