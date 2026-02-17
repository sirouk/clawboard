from __future__ import annotations

import os
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-space-visibility-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.db import get_session, init_db  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import LogEntry, Space, Task, Topic  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class SpaceVisibilityPolicyTests(unittest.TestCase):
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
            for row in session.exec(select(Space)).all():
                session.delete(row)
            session.commit()

    def _create_space(self, space_id: str, name: str):
        res = self.client.post(
            "/api/spaces",
            json={"id": space_id, "name": name},
            headers=self.auth_headers,
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertEqual(payload["id"], space_id)

    def _allowed(self, source_space_id: str) -> list[str]:
        res = self.client.get("/api/spaces/allowed", params={"spaceId": source_space_id})
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertEqual(payload["spaceId"], source_space_id)
        return payload["allowedSpaceIds"]

    def test_hidden_default_policy_is_persisted_and_independent_from_explicit_toggle(self):
        self._create_space("space-alpha", "Alpha")
        self._create_space("space-beta", "Beta")

        baseline = self._allowed("space-beta")
        self.assertIn("space-alpha", baseline)

        res = self.client.patch(
            "/api/spaces/space-alpha/connectivity",
            json={"defaultVisible": False},
            headers=self.auth_headers,
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertFalse(payload.get("defaultVisible", True))

        after_policy_hidden = self._allowed("space-beta")
        self.assertNotIn("space-alpha", after_policy_hidden)

        self._create_space("space-gamma", "Gamma")
        after_new_space = self._allowed("space-gamma")
        self.assertNotIn("space-alpha", after_new_space)

        res = self.client.patch(
            "/api/spaces/space-beta/connectivity",
            json={"connectivity": {"space-alpha": True}},
            headers=self.auth_headers,
        )
        self.assertEqual(res.status_code, 200, res.text)

        after_explicit_visible = self._allowed("space-beta")
        self.assertIn("space-alpha", after_explicit_visible)

        spaces_res = self.client.get("/api/spaces")
        self.assertEqual(spaces_res.status_code, 200, spaces_res.text)
        spaces = spaces_res.json()
        alpha = next((item for item in spaces if item.get("id") == "space-alpha"), None)
        self.assertIsNotNone(alpha)
        self.assertFalse((alpha or {}).get("defaultVisible", True))


if __name__ == "__main__":
    unittest.main()
