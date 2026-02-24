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

    def test_semantic_search_multi_term_prefers_sparse_matches(self):
        topics = [
            {"id": "topic-insurance", "name": "Insurance", "description": "Coverage and plans"},
            {"id": "topic-office", "name": "Office", "description": "Facilities and operations"},
        ]
        tasks = [
            {"id": "task-insurance", "topicId": "topic-insurance", "title": "Review health insurance options", "status": "todo"},
            {"id": "task-office", "topicId": "topic-office", "title": "Order office snacks", "status": "todo"},
        ]
        logs = [
            {
                "id": "log-insurance",
                "topicId": "topic-insurance",
                "taskId": "task-insurance",
                "type": "conversation",
                "summary": "Weekly status",
                "content": "Need to compare health insurance deductible and copay plans.",
                "raw": "",
            },
            {
                "id": "log-office",
                "topicId": "topic-office",
                "taskId": "task-office",
                "type": "conversation",
                "summary": "Weekly status",
                "content": "Need to compare snack vendors for break room.",
                "raw": "",
            },
        ]

        result = vs.semantic_search(
            "health insurance",
            topics,
            tasks,
            logs,
            topic_limit=6,
            task_limit=6,
            log_limit=12,
        )

        self.assertTrue(result["topics"], "Expected topic matches")
        self.assertEqual(result["topics"][0]["id"], "topic-insurance")
        self.assertGreater(float(result["topics"][0].get("bm25Score") or 0.0), 0.0)

        self.assertTrue(result["tasks"], "Expected task matches")
        self.assertEqual(result["tasks"][0]["id"], "task-insurance")
        self.assertGreater(float(result["tasks"][0].get("bm25Score") or 0.0), 0.0)

        self.assertTrue(result["logs"], "Expected log matches")
        self.assertEqual(result["logs"][0]["id"], "log-insurance")
        self.assertGreater(float(result["logs"][0].get("bm25Score") or 0.0), 0.0)

    def test_semantic_search_multi_term_coverage_beats_single_token_repetition(self):
        topics = [
            {"id": "topic-repeat", "name": "Ops", "description": "docker docker docker backup backup backup"},
            {"id": "topic-full", "name": "Infra", "description": "docker postgres backup restore checklist"},
        ]
        tasks: list[dict] = []
        logs: list[dict] = []

        original_vector_topk = vs._vector_topk
        original_embed_query = vs._embed_query
        vs._vector_topk = lambda *_args, **_kwargs: ({}, "none")
        vs._embed_query = lambda _text: None
        try:
            result = vs.semantic_search(
                "docker postgres backup",
                topics,
                tasks,
                logs,
                topic_limit=6,
                task_limit=6,
                log_limit=6,
            )
        finally:
            vs._vector_topk = original_vector_topk
            vs._embed_query = original_embed_query

        self.assertTrue(result["topics"], "Expected topic matches")
        self.assertGreaterEqual(len(result["topics"]), 2)
        self.assertEqual(result["topics"][0]["id"], "topic-full")
        self.assertGreater(float(result["topics"][0].get("coverageScore") or 0.0), float(result["topics"][1].get("coverageScore") or 0.0))

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

    def test_semantic_search_excludes_tool_call_logs_by_default(self):
        topics = [{"id": "topic-ops", "name": "Discord Ops", "description": "Reliability"}]
        tasks: list[dict] = []
        logs = [
            {
                "id": "log-tool",
                "topicId": "topic-ops",
                "taskId": None,
                "type": "action",
                "summary": "Tool call: exec retry diagnostics",
                "content": "",
                "raw": "",
            },
            {
                "id": "log-real",
                "topicId": "topic-ops",
                "taskId": None,
                "type": "conversation",
                "summary": "Retry diagnostics for gateway outage",
                "content": "Investigate retry diagnostics output from gateway.",
                "raw": "",
            },
        ]

        original = vs.SEARCH_INCLUDE_TOOL_CALL_LOGS
        vs.SEARCH_INCLUDE_TOOL_CALL_LOGS = False
        try:
            result = vs.semantic_search(
                "retry diagnostics",
                topics,
                tasks,
                logs,
                topic_limit=3,
                task_limit=3,
                log_limit=10,
            )
        finally:
            vs.SEARCH_INCLUDE_TOOL_CALL_LOGS = original

        log_ids = [row["id"] for row in result["logs"]]
        self.assertIn("log-real", log_ids)
        self.assertNotIn("log-tool", log_ids)

    def test_semantic_search_excludes_system_and_import_logs_by_default(self):
        topics = [{"id": "topic-ops", "name": "Discord Ops", "description": "Reliability"}]
        tasks: list[dict] = []
        logs = [
            {
                "id": "log-system",
                "topicId": "topic-ops",
                "taskId": None,
                "type": "system",
                "summary": "system envelope",
                "content": "system envelope",
                "raw": "",
            },
            {
                "id": "log-import",
                "topicId": "topic-ops",
                "taskId": None,
                "type": "import",
                "summary": "import envelope",
                "content": "import envelope",
                "raw": "",
            },
            {
                "id": "log-real",
                "topicId": "topic-ops",
                "taskId": None,
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
        self.assertNotIn("log-system", log_ids)
        self.assertNotIn("log-import", log_ids)

    def test_semantic_search_excludes_memory_action_logs_by_default(self):
        topics = [{"id": "topic-ops", "name": "Discord Ops", "description": "Reliability"}]
        tasks: list[dict] = []
        logs = [
            {
                "id": "log-memory-tool",
                "topicId": "topic-ops",
                "taskId": None,
                "type": "action",
                "summary": "Tool result: memory_search",
                "content": "Tool result: memory_search retrieved 4 snippets",
                "raw": "",
            },
            {
                "id": "log-real",
                "topicId": "topic-ops",
                "taskId": None,
                "type": "conversation",
                "summary": "Investigate retry diagnostics output",
                "content": "Investigate retry diagnostics output from gateway.",
                "raw": "",
            },
        ]

        result = vs.semantic_search(
            "retry diagnostics",
            topics,
            tasks,
            logs,
            topic_limit=3,
            task_limit=3,
            log_limit=10,
        )

        log_ids = [row["id"] for row in result["logs"]]
        self.assertIn("log-real", log_ids)
        self.assertNotIn("log-memory-tool", log_ids)

    def test_semantic_search_can_include_tool_call_logs_with_flag(self):
        topics = [{"id": "topic-ops", "name": "Discord Ops", "description": "Reliability"}]
        tasks: list[dict] = []
        logs = [
            {
                "id": "log-tool",
                "topicId": "topic-ops",
                "taskId": None,
                "type": "action",
                "summary": "Tool call: exec florian diagnostics",
                "content": "",
                "raw": "",
            },
            {
                "id": "log-other",
                "topicId": "topic-ops",
                "taskId": None,
                "type": "conversation",
                "summary": "Unrelated activity",
                "content": "No overlap with the query tokens.",
                "raw": "",
            },
        ]

        original = vs.SEARCH_INCLUDE_TOOL_CALL_LOGS
        vs.SEARCH_INCLUDE_TOOL_CALL_LOGS = True
        try:
            result = vs.semantic_search(
                "florian diagnostics",
                topics,
                tasks,
                logs,
                topic_limit=3,
                task_limit=3,
                log_limit=10,
            )
        finally:
            vs.SEARCH_INCLUDE_TOOL_CALL_LOGS = original

        log_ids = [row["id"] for row in result["logs"]]
        self.assertIn("log-tool", log_ids)

    def test_vector_topk_retries_qdrant_seed_after_backoff(self):
        original_qdrant_url = vs.QDRANT_URL
        original_qdrant_topk = vs._qdrant_topk
        original_seed = vs._qdrant_seed_retry_hook
        original_time = vs.time.time
        original_retry_state = dict(vs._QDRANT_SEED_RETRY_STATE)
        original_base = vs.QDRANT_SEED_RETRY_BASE_SECONDS
        original_max = vs.QDRANT_SEED_RETRY_MAX_SECONDS

        seed_calls: list[int] = []
        times = iter([100.0, 105.0, 200.0])

        vs.QDRANT_URL = "http://qdrant.test"
        vs.QDRANT_SEED_RETRY_BASE_SECONDS = 20.0
        vs.QDRANT_SEED_RETRY_MAX_SECONDS = 300.0
        vs._QDRANT_SEED_RETRY_STATE.clear()
        vs._qdrant_topk = lambda *_args, **_kwargs: {}
        vs._qdrant_seed_retry_hook = lambda **_kwargs: (seed_calls.append(1) or False)
        vs.time.time = lambda: next(times)

        try:
            first_scores, first_backend = vs._vector_topk([0.1, 0.2], kind_exact="topic", limit=5)
            second_scores, second_backend = vs._vector_topk([0.1, 0.2], kind_exact="topic", limit=5)
            third_scores, third_backend = vs._vector_topk([0.1, 0.2], kind_exact="topic", limit=5)
        finally:
            vs.QDRANT_URL = original_qdrant_url
            vs._qdrant_topk = original_qdrant_topk
            vs._qdrant_seed_retry_hook = original_seed
            vs.time.time = original_time
            vs._QDRANT_SEED_RETRY_STATE.clear()
            vs._QDRANT_SEED_RETRY_STATE.update(original_retry_state)
            vs.QDRANT_SEED_RETRY_BASE_SECONDS = original_base
            vs.QDRANT_SEED_RETRY_MAX_SECONDS = original_max

        expected_backend = "qdrant-required" if vs.VECTOR_REQUIRE_QDRANT else "none"
        self.assertEqual(first_backend, expected_backend)
        self.assertEqual(second_backend, expected_backend)
        self.assertEqual(third_backend, expected_backend)
        self.assertEqual(first_scores, {})
        self.assertEqual(second_scores, {})
        self.assertEqual(third_scores, {})
        # First and third calls trigger seeding; second call is within backoff and skips it.
        self.assertEqual(len(seed_calls), 2)


if __name__ == "__main__":
    unittest.main()
