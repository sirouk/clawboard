from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-context-tests-")
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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class ContextEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    def test_context_cheap_includes_working_set_and_routing(self):
        headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        session_key = "channel:testcontext"

        # Create topic + task.
        topic = self.client.post("/api/topics", json={"name": "ContextTest Topic", "pinned": True}, headers=headers).json()
        task = self.client.post(
            "/api/tasks",
            json={
                "topicId": topic["id"],
                "title": "ContextTest Task",
                "status": "doing",
                "pinned": True,
                "priority": "high",
                "dueDate": now_iso(),
            },
            headers=headers,
        ).json()

        # Create one conversation log in this session.
        log = self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "taskId": task["id"],
                "type": "conversation",
                "content": "ContextTest: ship /api/context and agent tools.",
                "summary": "ContextTest: ship /api/context + tools.",
                "createdAt": now_iso(),
                "agentId": "user",
                "agentLabel": "User",
                "source": {"sessionKey": session_key},
            },
            headers=headers,
        ).json()

        # Create a curated note attached to that log.
        self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "taskId": task["id"],
                "type": "note",
                "relatedLogId": log["id"],
                "content": "High-signal: /api/context should return working set + routing memory for short turns.",
                "summary": "Note: /api/context short-turn working set + routing memory.",
                "createdAt": now_iso(),
                "agentId": "assistant",
                "agentLabel": "OpenClaw",
                "source": {"sessionKey": session_key},
            },
            headers=headers,
        )

        # Seed routing memory so "ok" turns still get continuity.
        self.client.post(
            "/api/classifier/session-routing",
            json={
                "sessionKey": session_key,
                "topicId": topic["id"],
                "topicName": topic["name"],
                "taskId": task["id"],
                "taskTitle": task["title"],
                "anchor": "Ship /api/context and agent tools.",
                "ts": now_iso(),
            },
            headers=headers,
        )

        res = self.client.get(
            "/api/context",
            params={"q": "ok", "sessionKey": session_key, "mode": "cheap"},
            headers={"Host": "localhost:8010"},
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("ok"), payload)
        self.assertIn("A:working_set", payload.get("layers", []))
        self.assertIn("A:routing_memory", payload.get("layers", []))
        self.assertIn("Working set tasks:", payload.get("block", ""))
        self.assertIn("Session routing memory", payload.get("block", ""))

    def test_context_board_session_surfaces_active_task(self):
        headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}

        topic = self.client.post("/api/topics", json={"name": "BoardContext Topic", "pinned": True}, headers=headers).json()
        other = self.client.post(
            "/api/tasks",
            json={
                "topicId": topic["id"],
                "title": "Other Task (pinned)",
                "status": "doing",
                "pinned": True,
                "priority": "high",
            },
            headers=headers,
        ).json()
        board_task = self.client.post(
            "/api/tasks",
            json={
                "topicId": topic["id"],
                "title": "Board Task Context",
                "status": "todo",
                "pinned": False,
                "priority": "low",
            },
            headers=headers,
        ).json()

        # Create one conversation log in this board task session so timeline has continuity.
        board_session_key = f"clawboard:task:{topic['id']}:{board_task['id']}"
        self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "taskId": board_task["id"],
                "type": "conversation",
                "content": "BoardContext: prior message in this task chat.",
                "summary": "BoardContext: prior message.",
                "createdAt": now_iso(),
                "agentId": "user",
                "agentLabel": "User",
                "source": {"sessionKey": board_session_key},
            },
            headers=headers,
        )

        res = self.client.get(
            "/api/context",
            params={
                "q": "let's resume",
                "sessionKey": board_session_key,
                "mode": "cheap",
                "workingSetLimit": 1,
                "timelineLimit": 3,
            },
            headers={"Host": "localhost:8010"},
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("ok"), payload)
        block = payload.get("block") or ""
        # Board location should be explicit so the agent knows "where" the user is speaking from.
        self.assertIn("Active board location:", block)
        self.assertIn("Task Chat:", block)
        # With workingSetLimit=1, the active board task should still be surfaced (promoted above other ranks).
        self.assertIn("Board Task Context", block)
        self.assertNotIn("Other Task (pinned)", block)

    def test_context_full_includes_semantic(self):
        session_key = "channel:testcontext"
        res = self.client.get(
            "/api/context",
            params={"q": "ContextTest tools", "sessionKey": session_key, "mode": "full"},
            headers={"Host": "localhost:8010"},
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertIn("B:semantic", payload.get("layers", []))
        self.assertIn("semantic", (payload.get("data") or {}))

    def test_context_patient_includes_semantic(self):
        session_key = "channel:testcontext"
        res = self.client.get(
            "/api/context",
            params={"q": "ok", "sessionKey": session_key, "mode": "patient"},
            headers={"Host": "localhost:8010"},
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertEqual(payload.get("mode"), "patient")
        self.assertIn("B:semantic", payload.get("layers", []))
        self.assertIn("semantic", (payload.get("data") or {}))

    def test_context_auto_low_signal_skips_semantic_layer(self):
        session_key = "channel:testcontext"
        with patch("app.main._search_impl") as search_mock:
            res = self.client.get(
                "/api/context",
                params={"q": "ok", "sessionKey": session_key, "mode": "auto"},
                headers={"Host": "localhost:8010"},
            )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertEqual(payload.get("mode"), "auto")
        self.assertNotIn("B:semantic", payload.get("layers", []))
        self.assertNotIn("semantic", (payload.get("data") or {}))
        search_mock.assert_not_called()

    def test_patch_task_without_title(self):
        headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        topic = self.client.post("/api/topics", json={"name": "ContextPatch Topic"}, headers=headers).json()
        task = self.client.post(
            "/api/tasks",
            json={"topicId": topic["id"], "title": "ContextPatch Task", "status": "todo"},
            headers=headers,
        ).json()

        res = self.client.patch(
            f"/api/tasks/{task['id']}",
            json={"status": "done"},
            headers=headers,
        )
        self.assertEqual(res.status_code, 200, res.text)
        patched = res.json()
        self.assertEqual(patched.get("status"), "done")

    def test_patch_topic_digest_does_not_bump_updated_at(self):
        headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        topic = self.client.post("/api/topics", json={"name": "Digest Topic"}, headers=headers).json()

        before = self.client.get(f"/api/topics/{topic['id']}", headers={"Host": "localhost:8010"}).json()
        before_updated = before.get("updatedAt")

        res = self.client.patch(
            f"/api/topics/{topic['id']}",
            json={"digest": "Digest: hello", "digestUpdatedAt": now_iso()},
            headers=headers,
        )
        self.assertEqual(res.status_code, 200, res.text)
        after = res.json()
        self.assertEqual(after.get("digest"), "Digest: hello")
        self.assertEqual(after.get("updatedAt"), before_updated)


if __name__ == "__main__":
    unittest.main()
