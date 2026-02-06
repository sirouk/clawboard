from __future__ import annotations

import os
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-access-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient

    from app.db import init_db  # noqa: E402
    from app.main import app  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class AccessPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    def test_localhost_read_without_token_allowed(self):
        res = self.client.get("/api/health", headers={"Host": "localhost:8010"})
        self.assertEqual(res.status_code, 200, res.text)

    def test_non_localhost_read_without_token_rejected(self):
        res = self.client.get("/api/health", headers={"Host": "100.91.119.30:8010"})
        self.assertEqual(res.status_code, 401, res.text)

    def test_non_localhost_read_with_token_allowed(self):
        res = self.client.get(
            "/api/health",
            headers={"Host": "100.91.119.30:8010", "X-Clawboard-Token": "test-token"},
        )
        self.assertEqual(res.status_code, 200, res.text)

    def test_write_requires_token_even_on_localhost(self):
        payload = {"name": "Access policy topic"}
        res = self.client.post("/api/topics", json=payload, headers={"Host": "localhost:8010"})
        self.assertEqual(res.status_code, 401, res.text)

        res_ok = self.client.post(
            "/api/topics",
            json=payload,
            headers={"Host": "localhost:8010", "X-Clawboard-Token": "test-token"},
        )
        self.assertEqual(res_ok.status_code, 200, res_ok.text)


if __name__ == "__main__":
    unittest.main()
