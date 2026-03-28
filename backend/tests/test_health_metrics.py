from __future__ import annotations

import os
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-health-metrics-tests-")
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
class HealthMetricsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    def test_health_reports_additive_runtime_sections(self):
        res = self.client.get("/api/health")
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertEqual(payload.get("status"), "ok")
        self.assertIn("checks", payload)
        self.assertIn("queues", payload)
        self.assertIn("caches", payload)
        self.assertEqual(payload.get("checks", {}).get("database", {}).get("status"), "ok")
        self.assertIn("vector", payload.get("checks", {}))
        self.assertIn("historySync", payload.get("checks", {}))
        self.assertIn("ingest", payload.get("queues", {}))
        self.assertIn("dispatch", payload.get("queues", {}))
        self.assertIn("precompile", payload.get("caches", {}))
        self.assertIn("search", payload.get("caches", {}))

    def test_metrics_reports_queue_and_cache_runtime_details(self):
        res = self.client.get("/api/metrics")
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIn("logs", payload)
        self.assertIn("creation", payload)
        self.assertIn("openclaw", payload)
        self.assertIn("queues", payload)
        self.assertIn("runtime", payload)
        self.assertIn("dispatchQueue", payload.get("openclaw", {}))
        self.assertIn("historySync", payload.get("openclaw", {}))
        self.assertIn("ingest", payload.get("queues", {}))
        self.assertIn("dispatch", payload.get("queues", {}))
        self.assertIn("database", payload.get("runtime", {}))
        self.assertIn("vector", payload.get("runtime", {}))
        self.assertIn("caches", payload.get("runtime", {}))
        self.assertIn("search", payload.get("runtime", {}).get("caches", {}))
        self.assertIn("precompile", payload.get("runtime", {}).get("caches", {}))


if __name__ == "__main__":
    unittest.main()
