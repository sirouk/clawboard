from __future__ import annotations

import os
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-session-routing-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"
os.environ["CLAWBOARD_SESSION_ROUTING_MAX_ITEMS"] = "2"

try:
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.db import get_session, init_db  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import SessionRoutingMemory  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class SessionRoutingMemoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Clawboard-Token": "test-token"}

    def setUp(self):
        with get_session() as session:
            for row in session.exec(select(SessionRoutingMemory)).all():
                session.delete(row)
            session.commit()

    def test_get_returns_empty_when_missing(self):
        res = self.client.get(
            "/api/classifier/session-routing",
            headers=self.auth_headers,
            params={"sessionKey": "channel:test|thread:1"},
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertEqual(payload.get("sessionKey"), "channel:test|thread:1")
        self.assertEqual(payload.get("items"), [])

    def test_append_persists_and_bounds(self):
        session_key = "channel:test|thread:2"
        first = {
            "sessionKey": session_key,
            "topicId": "topic-1",
            "topicName": "Clawboard",
            "taskId": "task-1",
            "taskTitle": "Ship onboarding",
            "anchor": "Fix the login redirect bug.",
        }
        res1 = self.client.post("/api/classifier/session-routing", headers=self.auth_headers, json=first)
        self.assertEqual(res1.status_code, 200, res1.text)
        payload1 = res1.json()
        self.assertEqual(payload1.get("sessionKey"), session_key)
        self.assertEqual(len(payload1.get("items") or []), 1)

        second = {**first, "topicId": "topic-2", "topicName": "Infra", "taskId": None, "taskTitle": None, "anchor": "Docker networking"}
        res2 = self.client.post("/api/classifier/session-routing", headers=self.auth_headers, json=second)
        self.assertEqual(res2.status_code, 200, res2.text)
        payload2 = res2.json()
        self.assertEqual(len(payload2.get("items") or []), 2)

        third = {**first, "topicId": "topic-3", "topicName": "Ops"}
        res3 = self.client.post("/api/classifier/session-routing", headers=self.auth_headers, json=third)
        self.assertEqual(res3.status_code, 200, res3.text)
        payload3 = res3.json()
        items = payload3.get("items") or []
        # Bounded to 2 by env; should keep newest last.
        self.assertEqual(len(items), 2)
        self.assertEqual(items[-1].get("topicId"), "topic-3")

