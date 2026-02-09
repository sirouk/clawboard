from __future__ import annotations

import os
import sys
import unittest
import uuid


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP_DIR = os.path.join(ROOT, "app")
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

import vector_search as vs  # noqa: E402


class VectorSearchHybridTests(unittest.TestCase):
    def test_qdrant_point_id_is_uuid_and_stable(self):
        point_id_a = vs._qdrant_point_id("log", "abc-123")
        point_id_b = vs._qdrant_point_id("log", "abc-123")
        self.assertEqual(point_id_a, point_id_b)
        parsed = uuid.UUID(point_id_a)
        self.assertEqual(str(parsed), point_id_a)

    def test_semantic_search_uses_hybrid_scores_and_chunks(self):
        topics = [
            {"id": "topic-ops", "name": "Discord Operations", "description": "Retries, routing, and alerts"},
            {"id": "topic-ui", "name": "UI Polish", "description": "Board layout and styling"},
        ]
        tasks = [
            {"id": "task-retry", "topicId": "topic-ops", "title": "Fix discord retry storm", "status": "doing"},
            {"id": "task-style", "topicId": "topic-ui", "title": "Tune dashboard spacing", "status": "todo"},
        ]
        logs = [
            {
                "id": "log-1",
                "topicId": "topic-ops",
                "taskId": "task-retry",
                "type": "conversation",
                "summary": "Discord retries and gateway routing",
                "content": "Investigate why Discord retry loop keeps happening after gateway restart.",
                "raw": "",
            },
            {
                "id": "log-2",
                "topicId": "topic-ui",
                "taskId": "task-style",
                "type": "conversation",
                "summary": "UI spacing pass",
                "content": "Adjust gradients and panel padding in board view.",
                "raw": "",
            },
        ]

        result = vs.semantic_search(
            "discord retry gateway routing",
            topics,
            tasks,
            logs,
            topic_limit=4,
            task_limit=4,
            log_limit=8,
        )

        self.assertIn("bm25", result.get("mode", ""))
        self.assertIn("rrf", result.get("mode", ""))
        self.assertIn("rerank", result.get("mode", ""))

        self.assertTrue(result["topics"], "Expected topic matches")
        self.assertEqual(result["topics"][0]["id"], "topic-ops")
        self.assertIn("bm25Score", result["topics"][0])
        self.assertIn("bestChunk", result["topics"][0])
        self.assertTrue(result["topics"][0]["bestChunk"]["id"].startswith("topic:topic-ops:chunk:"))

        self.assertTrue(result["tasks"], "Expected task matches")
        self.assertEqual(result["tasks"][0]["id"], "task-retry")
        self.assertGreaterEqual(float(result["tasks"][0]["score"]), 0.05)

        self.assertTrue(result["logs"], "Expected log matches")
        self.assertEqual(result["logs"][0]["id"], "log-1")
        self.assertIn("rerankScore", result["logs"][0])

    def test_semantic_search_supports_partial_token_queries_without_vectors(self):
        topics = [
            {"id": "topic-sqlmodel", "name": "SQLModel Inserts", "description": "Insert patterns and troubleshooting"},
            {"id": "topic-docker", "name": "Docker Networking", "description": "Containers and DNS"},
        ]
        tasks: list[dict] = []
        logs: list[dict] = []

        result = vs.semantic_search(
            "sql",
            topics,
            tasks,
            logs,
            topic_limit=6,
            task_limit=6,
            log_limit=6,
        )

        topic_ids = [row["id"] for row in result.get("topics", [])]
        self.assertIn("topic-sqlmodel", topic_ids)

    def test_semantic_search_reports_qdrant_mode_when_qdrant_backend_serves_vectors(self):
        topics = [{"id": "topic-ops", "name": "Discord Operations", "description": "Retries"}]
        tasks = [{"id": "task-retry", "topicId": "topic-ops", "title": "Fix retry loop", "status": "doing"}]
        logs = [
            {
                "id": "log-1",
                "topicId": "topic-ops",
                "taskId": "task-retry",
                "type": "conversation",
                "summary": "discord retry",
                "content": "retry loop",
                "raw": "",
            }
        ]

        original_vector_topk = vs._vector_topk
        original_embed_query = vs._embed_query

        def fake_vector_topk(query_vec, *, kind_exact=None, kind_prefix=None, limit=120):
            if kind_exact == "topic":
                return {"topic-ops": 0.96}, "qdrant"
            if kind_prefix == "task:":
                return {"task-retry": 0.9}, "qdrant"
            if kind_exact == "log":
                return {"log-1": 0.93}, "qdrant"
            return {}, "none"

        vs._vector_topk = fake_vector_topk
        vs._embed_query = lambda _text: [0.11, 0.22, 0.33]
        try:
            result = vs.semantic_search(
                "discord retry",
                topics,
                tasks,
                logs,
                topic_limit=3,
                task_limit=3,
                log_limit=10,
            )
        finally:
            vs._vector_topk = original_vector_topk
            vs._embed_query = original_embed_query

        self.assertIn("qdrant", result.get("mode", ""))
        self.assertTrue(result["topics"])
        self.assertEqual(result["topics"][0]["id"], "topic-ops")

    def test_semantic_search_excludes_slash_command_logs(self):
        topics = [{"id": "topic-ops", "name": "Discord Ops", "description": "Reliability"}]
        tasks = [{"id": "task-retry", "topicId": "topic-ops", "title": "Fix retry loop", "status": "doing"}]
        logs = [
            {
                "id": "log-command",
                "topicId": "topic-ops",
                "taskId": None,
                "type": "conversation",
                "summary": "/new",
                "content": "/new",
                "raw": "",
            },
            {
                "id": "log-real",
                "topicId": "topic-ops",
                "taskId": "task-retry",
                "type": "conversation",
                "summary": "Investigate discord retry loop",
                "content": "Gateway retries after reconnect still spike.",
                "raw": "",
            },
        ]

        result = vs.semantic_search(
            "discord retry loop",
            topics,
            tasks,
            logs,
            topic_limit=3,
            task_limit=3,
            log_limit=10,
        )

        log_ids = [row["id"] for row in result["logs"]]
        self.assertIn("log-real", log_ids)
        self.assertNotIn("log-command", log_ids)


if __name__ == "__main__":
    unittest.main()
