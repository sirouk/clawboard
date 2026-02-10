from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-classifier-replay-tests-")
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


def iso_at(base: datetime, offset_seconds: int) -> str:
    return (base + timedelta(seconds=offset_seconds)).astimezone(timezone.utc).isoformat()


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class ClassifierReplayTests(unittest.TestCase):
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
            session.commit()

        ts = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc).isoformat()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-1",
                    name="Topic One",
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
                Task(
                    id="task-1",
                    topicId="topic-1",
                    title="Task One",
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

    def _append(self, *, type: str, content: str, agent_id: str, created_at: str, message_id: str) -> str:
        session_key = "clawboard:topic:topic-1"
        res = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": type,
                "content": content,
                "summary": content[:160],
                "createdAt": created_at,
                "agentId": agent_id,
                "agentLabel": agent_id,
                "topicId": "topic-1",
                "taskId": "task-1",
                "classificationStatus": "classified",
                "source": {"channel": "tests", "sessionKey": session_key, "messageId": message_id},
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        return str(payload.get("id") or "")

    def test_replay_marks_bundle_pending_and_clears_task(self):
        base = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

        # Bundle 1 (should be replayed).
        user1 = self._append(type="conversation", content="Please implement feature X.", agent_id="user", created_at=iso_at(base, 0), message_id="m1")
        assistant1 = self._append(type="conversation", content="Sure, here is the plan.", agent_id="assistant", created_at=iso_at(base, 1), message_id="m2")
        action1 = self._append(type="action", content="Tool call: rg", agent_id="assistant", created_at=iso_at(base, 2), message_id="m3")
        action2 = self._append(type="action", content="Tool result: rg", agent_id="assistant", created_at=iso_at(base, 3), message_id="m4")
        assistant2 = self._append(type="conversation", content="Implemented.", agent_id="assistant", created_at=iso_at(base, 4), message_id="m5")
        user2 = self._append(type="conversation", content="ok", agent_id="user", created_at=iso_at(base, 5), message_id="m6")
        assistant3 = self._append(type="conversation", content="Done.", agent_id="assistant", created_at=iso_at(base, 6), message_id="m7")

        # Bundle 2 (boundary; should remain untouched).
        user3 = self._append(type="conversation", content="Now implement feature Y.", agent_id="user", created_at=iso_at(base, 7), message_id="m8")
        assistant4 = self._append(type="conversation", content="On it.", agent_id="assistant", created_at=iso_at(base, 8), message_id="m9")

        with get_session() as session:
            for lid in (user1, assistant1, action1, action2, assistant2, user2, assistant3, user3, assistant4):
                row = session.get(LogEntry, lid)
                self.assertIsNotNone(row)
                row.classificationAttempts = 2
                row.classificationError = "prior"
                session.add(row)
            session.commit()

        res = self.client.post(
            "/api/classifier/replay",
            headers=self.auth_headers,
            json={"anchorLogId": user1, "mode": "bundle"},
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("ok"))
        self.assertEqual(payload.get("anchorLogId"), user1)
        self.assertEqual(payload.get("sessionKey"), "clawboard:topic:topic-1")
        self.assertEqual(payload.get("topicId"), "topic-1")
        self.assertEqual(payload.get("logCount"), 7)
        self.assertEqual(len(payload.get("logIds") or []), 7)

        replayed = {user1, assistant1, action1, action2, assistant2, user2, assistant3}
        untouched = {user3, assistant4}

        with get_session() as session:
            for lid in replayed:
                row = session.get(LogEntry, lid)
                self.assertIsNotNone(row)
                self.assertEqual(row.classificationStatus, "pending")
                self.assertEqual(row.classificationAttempts, 0)
                self.assertIsNone(row.classificationError)
                self.assertIsNone(row.taskId)

            for lid in untouched:
                row = session.get(LogEntry, lid)
                self.assertIsNotNone(row)
                self.assertEqual(row.classificationStatus, "classified")
                self.assertEqual(row.classificationAttempts, 2)
                self.assertEqual(row.classificationError, "prior")
                self.assertEqual(row.taskId, "task-1")

