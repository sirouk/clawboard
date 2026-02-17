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

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-visibility-scope-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient
    from sqlmodel import select

    from app.db import get_session, init_db  # noqa: E402
    from app import main as main_module  # noqa: E402
    from app.main import app  # noqa: E402
    from app.models import LogEntry, SessionRoutingMemory, Space, Task, Topic  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    select = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class VisibilityScopeEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Clawboard-Token": "test-token"}

    @property
    def write_headers(self) -> dict[str, str]:
        return {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}

    @property
    def read_headers(self) -> dict[str, str]:
        return {"Host": "localhost:8010"}

    def setUp(self):
        with get_session() as session:
            for row in session.exec(select(LogEntry)).all():
                session.delete(row)
            for row in session.exec(select(Task)).all():
                session.delete(row)
            for row in session.exec(select(Topic)).all():
                session.delete(row)
            for row in session.exec(select(SessionRoutingMemory)).all():
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
        return res.json()

    def _create_topic(self, name: str, space_id: str):
        res = self.client.post(
            "/api/topics",
            json={"name": name, "spaceId": space_id},
            headers=self.write_headers,
        )
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def _create_task(self, topic_id: str, title: str):
        res = self.client.post(
            "/api/tasks",
            json={"topicId": topic_id, "title": title, "status": "doing"},
            headers=self.write_headers,
        )
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def _create_conversation_log(
        self,
        *,
        topic_id: str,
        task_id: str,
        summary: str,
        session_key: str | None = None,
    ):
        payload = {
            "topicId": topic_id,
            "taskId": task_id,
            "type": "conversation",
            "summary": summary,
            "content": summary,
            "classificationStatus": "classified",
            "agentId": "user",
            "agentLabel": "User",
            "createdAt": now_iso(),
        }
        if session_key:
            payload["source"] = {"sessionKey": session_key}
        res = self.client.post("/api/log", json=payload, headers=self.write_headers)
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def test_context_filters_working_set_and_routing_memory_by_allowed_spaces(self):
        session_key = "channel:scope-context"
        allowed_space = self._create_space("space-scope-allowed", "Scope Allowed")
        blocked_space = self._create_space("space-scope-blocked", "Scope Blocked")

        allowed_topic = self._create_topic("Scope Allowed Topic", allowed_space["id"])
        blocked_topic = self._create_topic("Scope Blocked Topic", blocked_space["id"])
        allowed_task = self._create_task(allowed_topic["id"], "Scope Allowed Task")
        blocked_task = self._create_task(blocked_topic["id"], "Scope Blocked Task")

        self.client.post(
            "/api/classifier/session-routing",
            json={
                "sessionKey": session_key,
                "topicId": allowed_topic["id"],
                "topicName": allowed_topic["name"],
                "taskId": allowed_task["id"],
                "taskTitle": allowed_task["title"],
                "anchor": "allowed anchor",
                "ts": now_iso(),
            },
            headers=self.write_headers,
        )
        self.client.post(
            "/api/classifier/session-routing",
            json={
                "sessionKey": session_key,
                "topicId": blocked_topic["id"],
                "topicName": blocked_topic["name"],
                "taskId": blocked_task["id"],
                "taskTitle": blocked_task["title"],
                "anchor": "blocked anchor",
                "ts": now_iso(),
            },
            headers=self.write_headers,
        )

        res = self.client.get(
            "/api/context",
            params={
                "q": "resume",
                "sessionKey": session_key,
                "mode": "cheap",
                "allowedSpaceIds": allowed_space["id"],
                "workingSetLimit": 6,
                "timelineLimit": 6,
            },
            headers=self.read_headers,
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("ok"), payload)

        working_set = payload.get("data", {}).get("workingSet", {})
        topic_ids = {str(item.get("id") or "") for item in working_set.get("topics") or []}
        task_ids = {str(item.get("id") or "") for item in working_set.get("tasks") or []}
        self.assertIn(allowed_topic["id"], topic_ids)
        self.assertIn(allowed_task["id"], task_ids)
        self.assertNotIn(blocked_topic["id"], topic_ids)
        self.assertNotIn(blocked_task["id"], task_ids)

        routing_items = ((payload.get("data") or {}).get("routingMemory") or {}).get("items") or []
        self.assertEqual(len(routing_items), 1, routing_items)
        self.assertEqual(str(routing_items[0].get("topicId") or ""), allowed_topic["id"])
        self.assertEqual(str(routing_items[0].get("taskId") or ""), allowed_task["id"])

        block = str(payload.get("block") or "")
        self.assertIn("Scope Allowed Topic", block)
        self.assertNotIn("Scope Blocked Topic", block)

    def test_search_drops_out_of_scope_semantic_hits(self):
        allowed_space = self._create_space("space-search-allowed", "Search Allowed")
        blocked_space = self._create_space("space-search-blocked", "Search Blocked")

        allowed_topic = self._create_topic("Search Allowed Topic", allowed_space["id"])
        blocked_topic = self._create_topic("Search Blocked Topic", blocked_space["id"])
        allowed_task = self._create_task(allowed_topic["id"], "Search Allowed Task")
        blocked_task = self._create_task(blocked_topic["id"], "Search Blocked Task")
        allowed_log = self._create_conversation_log(
            topic_id=allowed_topic["id"],
            task_id=allowed_task["id"],
            summary="scope-search allowed log",
        )
        blocked_log = self._create_conversation_log(
            topic_id=blocked_topic["id"],
            task_id=blocked_task["id"],
            summary="scope-search blocked log",
        )

        mocked_semantic = {
            "query": "scope-search",
            "mode": "mock",
            "topics": [
                {"id": allowed_topic["id"], "score": 0.8, "vectorScore": 0.8, "bm25Score": 0.0, "lexicalScore": 0.0},
                {"id": blocked_topic["id"], "score": 1.2, "vectorScore": 1.2, "bm25Score": 0.0, "lexicalScore": 0.0},
            ],
            "tasks": [
                {
                    "id": allowed_task["id"],
                    "topicId": allowed_topic["id"],
                    "title": allowed_task["title"],
                    "status": allowed_task["status"],
                    "score": 0.7,
                    "vectorScore": 0.7,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                },
                {
                    "id": blocked_task["id"],
                    "topicId": blocked_topic["id"],
                    "title": blocked_task["title"],
                    "status": blocked_task["status"],
                    "score": 1.1,
                    "vectorScore": 1.1,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                },
            ],
            "logs": [
                {
                    "id": allowed_log["id"],
                    "score": 0.6,
                    "vectorScore": 0.6,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                },
                {
                    "id": blocked_log["id"],
                    "score": 1.0,
                    "vectorScore": 1.0,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                },
            ],
            "notes": [],
        }

        with patch.object(main_module, "semantic_search", return_value=mocked_semantic):
            res = self.client.get(
                "/api/search",
                params={
                    "q": "scope-search",
                    "allowedSpaceIds": allowed_space["id"],
                    "limitTopics": 20,
                    "limitTasks": 20,
                    "limitLogs": 100,
                },
                headers=self.read_headers,
            )

        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()

        self.assertEqual({item["id"] for item in payload.get("topics") or []}, {allowed_topic["id"]})
        self.assertEqual({item["id"] for item in payload.get("tasks") or []}, {allowed_task["id"]})
        self.assertEqual({item["id"] for item in payload.get("logs") or []}, {allowed_log["id"]})
        self.assertNotIn(blocked_topic["id"], payload.get("matchedTopicIds") or [])
        self.assertNotIn(blocked_task["id"], payload.get("matchedTaskIds") or [])
        self.assertNotIn(blocked_log["id"], payload.get("matchedLogIds") or [])

    def test_clawgraph_respects_source_space_visibility_scope(self):
        source_space = self._create_space("space-graph-source", "Graph Source")
        blocked_space = self._create_space("space-graph-blocked", "Graph Blocked")

        patch_res = self.client.patch(
            f"/api/spaces/{source_space['id']}/connectivity",
            json={"connectivity": {blocked_space["id"]: False}},
            headers=self.auth_headers,
        )
        self.assertEqual(patch_res.status_code, 200, patch_res.text)

        source_topic = self._create_topic("Graph Source Topic", source_space["id"])
        blocked_topic = self._create_topic("Graph Blocked Topic", blocked_space["id"])
        source_task = self._create_task(source_topic["id"], "Graph Source Task")
        blocked_task = self._create_task(blocked_topic["id"], "Graph Blocked Task")
        self._create_conversation_log(
            topic_id=source_topic["id"],
            task_id=source_task["id"],
            summary="Graph source log mentions OpenClaw and Discord.",
        )
        self._create_conversation_log(
            topic_id=blocked_topic["id"],
            task_id=blocked_task["id"],
            summary="Graph blocked log mentions Kubernetes and Grafana.",
        )

        res = self.client.get(
            "/api/clawgraph",
            params={
                "spaceId": source_space["id"],
                "maxEntities": 120,
                "maxNodes": 260,
                "minEdgeWeight": 0.0,
                "limitLogs": 800,
                "includePending": True,
            },
            headers=self.read_headers,
        )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()

        node_ids = {str(node.get("id") or "") for node in payload.get("nodes") or []}
        self.assertIn(f"topic:{source_topic['id']}", node_ids)
        self.assertIn(f"task:{source_task['id']}", node_ids)
        self.assertNotIn(f"topic:{blocked_topic['id']}", node_ids)
        self.assertNotIn(f"task:{blocked_task['id']}", node_ids)


if __name__ == "__main__":
    unittest.main()
