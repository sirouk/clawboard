from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-reorder-tests-")
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
    return datetime.now(timezone.utc).isoformat()


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class ReorderEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    def setUp(self):
        with get_session() as session:
            for row in session.exec(select(Task)).all():
                session.delete(row)
            for row in session.exec(select(Topic)).all():
                session.delete(row)
            session.commit()

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Clawboard-Token": "test-token"}

    def test_topics_reorder_updates_sort_index(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-1",
                    name="One",
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
                Topic(
                    id="topic-2",
                    name="Two",
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
                Topic(
                    id="topic-3",
                    name="Three",
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
            session.commit()

        res = self.client.post(
            "/api/topics/reorder",
            json={"orderedIds": ["topic-2", "topic-3", "topic-1"]},
            headers=self.auth_headers,
        )
        self.assertEqual(res.status_code, 200, res.text)

        with get_session() as session:
            t1 = session.get(Topic, "topic-1")
            t2 = session.get(Topic, "topic-2")
            t3 = session.get(Topic, "topic-3")
            self.assertIsNotNone(t1)
            self.assertIsNotNone(t2)
            self.assertIsNotNone(t3)
            self.assertEqual(int(getattr(t2, "sortIndex", -1)), 0)
            self.assertEqual(int(getattr(t3, "sortIndex", -1)), 1)
            self.assertEqual(int(getattr(t1, "sortIndex", -1)), 2)

        res_missing = self.client.post(
            "/api/topics/reorder",
            json={"orderedIds": ["topic-1", "topic-2"]},
            headers=self.auth_headers,
        )
        self.assertEqual(res_missing.status_code, 400, res_missing.text)

    def test_tasks_reorder_updates_sort_index_in_scope(self):
        ts = now_iso()
        with get_session() as session:
            session.add(
                Topic(
                    id="topic-1",
                    name="Tasks topic",
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
            session.commit()
            session.add(
                Task(
                    id="task-1",
                    topicId="topic-1",
                    title="One",
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
                Task(
                    id="task-2",
                    topicId="topic-1",
                    title="Two",
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
                Task(
                    id="task-3",
                    topicId="topic-1",
                    title="Three",
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
            "/api/tasks/reorder",
            json={"topicId": "topic-1", "orderedIds": ["task-3", "task-1", "task-2"]},
            headers=self.auth_headers,
        )
        self.assertEqual(res.status_code, 200, res.text)

        with get_session() as session:
            t1 = session.get(Task, "task-1")
            t2 = session.get(Task, "task-2")
            t3 = session.get(Task, "task-3")
            self.assertIsNotNone(t1)
            self.assertIsNotNone(t2)
            self.assertIsNotNone(t3)
            self.assertEqual(int(getattr(t3, "sortIndex", -1)), 0)
            self.assertEqual(int(getattr(t1, "sortIndex", -1)), 1)
            self.assertEqual(int(getattr(t2, "sortIndex", -1)), 2)

        res_missing = self.client.post(
            "/api/tasks/reorder",
            json={"topicId": "topic-1", "orderedIds": ["task-1", "task-2"]},
            headers=self.auth_headers,
        )
        self.assertEqual(res_missing.status_code, 400, res_missing.text)


if __name__ == "__main__":
    unittest.main()

