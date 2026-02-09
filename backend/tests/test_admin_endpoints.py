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

    def test_start_fresh_replay_clears_derived_state_and_resets_logs(self):
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
            json={"integrationLevel": "full"},
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("ok"))
        self.assertEqual(payload.get("integrationLevel"), "full")

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

