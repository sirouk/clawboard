from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-openclaw-workspaces-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient

    from app.main import app  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class OpenClawWorkspaceEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Clawboard-Token": "test-token"}

    def test_openclaw_workspaces_are_config_driven_and_generate_code_server_urls(self):
        with tempfile.TemporaryDirectory(prefix="clawboard-openclaw-home-") as openclaw_home:
            config_path = Path(openclaw_home) / "openclaw.json"
            config_path.write_text(
                json.dumps(
                    {
                        "agents": {
                            "defaults": {"workspace": f"{openclaw_home}/workspace"},
                            "list": [
                                {"id": "main", "name": "Main", "workspace": f"{openclaw_home}/workspace"},
                                {"id": "coding", "name": "Coding", "workspace": f"{openclaw_home}/workspace-coding"},
                                {"id": "docs", "name": "Docs"},
                            ],
                        }
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "OPENCLAW_GATEWAY_IDENTITY_DIR": openclaw_home,
                    "OPENCLAW_CONFIG_PATH": str(config_path),
                    "CLAWBOARD_WORKSPACE_IDE_BASE_URL": "http://127.0.0.1:13337",
                    "CLAWBOARD_WORKSPACE_IDE_PROVIDER": "code-server",
                },
                clear=False,
            ):
                res = self.client.get("/api/openclaw/workspaces", headers=self.auth_headers)
                self.assertEqual(res.status_code, 200, res.text)
                payload = res.json()

                self.assertTrue(payload.get("configured"))
                self.assertEqual(payload.get("provider"), "code-server")
                self.assertEqual(payload.get("baseUrl"), "http://127.0.0.1:13337")

                rows = payload.get("workspaces") or []
                by_id = {row["agentId"]: row for row in rows}
                self.assertEqual(by_id["main"]["agentName"], "main")
                self.assertEqual(by_id["coding"]["agentName"], "Coding")
                self.assertEqual(by_id["main"]["workspaceDir"], f"{openclaw_home}/workspace")
                self.assertEqual(by_id["coding"]["workspaceDir"], f"{openclaw_home}/workspace-coding")
                self.assertEqual(by_id["docs"]["workspaceDir"], f"{openclaw_home}/workspace-docs")
                self.assertTrue(by_id["coding"]["preferred"])
                self.assertEqual(
                    by_id["coding"]["ideUrl"],
                    f"http://127.0.0.1:13337/?folder={openclaw_home}/workspace-coding",
                )

    def test_openclaw_workspaces_support_agent_filter(self):
        with tempfile.TemporaryDirectory(prefix="clawboard-openclaw-home-filter-") as openclaw_home:
            config_path = Path(openclaw_home) / "openclaw.json"
            config_path.write_text(
                json.dumps(
                    {
                        "agents": {
                            "defaults": {"workspace": f"{openclaw_home}/workspace"},
                            "list": [
                                {"id": "main", "workspace": f"{openclaw_home}/workspace"},
                                {"id": "coding", "workspace": f"{openclaw_home}/workspace-coding"},
                            ],
                        }
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "OPENCLAW_GATEWAY_IDENTITY_DIR": openclaw_home,
                    "OPENCLAW_CONFIG_PATH": str(config_path),
                    "CLAWBOARD_WORKSPACE_IDE_BASE_URL": "http://127.0.0.1:13337",
                },
                clear=False,
            ):
                res = self.client.get("/api/openclaw/workspaces?agentId=coding", headers=self.auth_headers)
                self.assertEqual(res.status_code, 200, res.text)
                payload = res.json()
                rows = payload.get("workspaces") or []
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["agentId"], "coding")
