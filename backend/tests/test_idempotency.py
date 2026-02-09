from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-idempotency-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.db import get_session, init_db  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import LogEntry  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class IdempotencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    def setUp(self):
        with get_session() as session:
            for row in session.exec(select(LogEntry)).all():
                session.delete(row)
            session.commit()

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Clawboard-Token": "test-token"}

    def test_append_log_dedupes_on_x_idempotency_key(self):
        ts = now_iso()

        first = self.client.post(
            "/api/log",
            headers={**self.auth_headers, "X-Idempotency-Key": "idem-1"},
            json={
                "type": "conversation",
                "content": "hello",
                "summary": "hello",
                "raw": "hello",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {"channel": "tests", "sessionKey": "channel:test", "messageId": "m1"},
            },
        )
        self.assertEqual(first.status_code, 200, first.text)
        payload1 = first.json()
        self.assertTrue(payload1.get("id"))
        self.assertEqual(payload1.get("content"), "hello")

        second = self.client.post(
            "/api/log",
            headers={**self.auth_headers, "X-Idempotency-Key": "idem-1"},
            json={
                "type": "conversation",
                "content": "should-not-overwrite",
                "summary": "should-not-overwrite",
                "raw": "should-not-overwrite",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {"channel": "tests", "sessionKey": "channel:test", "messageId": "m1b"},
            },
        )
        self.assertEqual(second.status_code, 200, second.text)
        payload2 = second.json()
        self.assertEqual(payload2.get("id"), payload1.get("id"))
        # Idempotent returns existing row, without overwriting content.
        self.assertEqual(payload2.get("content"), "hello")

        with get_session() as session:
            rows = session.exec(select(LogEntry)).all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].idempotencyKey, "idem-1")

    def test_append_log_dedupes_on_source_message_id_when_key_missing(self):
        ts = now_iso()

        first = self.client.post(
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
                "source": {"channel": "discord", "sessionKey": "channel:test", "messageId": "discord-1"},
            },
        )
        self.assertEqual(first.status_code, 200, first.text)
        payload1 = first.json()

        second = self.client.post(
            "/api/log",
            headers=self.auth_headers,
            json={
                "type": "conversation",
                "content": "duplicate",
                "summary": "duplicate",
                "raw": "duplicate",
                "createdAt": ts,
                "agentId": "user",
                "agentLabel": "User",
                "source": {"channel": "discord", "sessionKey": "channel:test", "messageId": "discord-1"},
            },
        )
        self.assertEqual(second.status_code, 200, second.text)
        payload2 = second.json()

        self.assertEqual(payload2.get("id"), payload1.get("id"))

        with get_session() as session:
            rows = session.exec(select(LogEntry)).all()
            self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()

