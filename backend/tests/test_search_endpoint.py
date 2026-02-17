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

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-search-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from fastapi.testclient import TestClient

    from app.db import init_db  # noqa: E402
    from app import main as main_module  # noqa: E402
    from app.main import app  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    TestClient = None  # type: ignore[assignment]
    _API_TESTS_AVAILABLE = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@unittest.skipUnless(_API_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class SearchEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.client = TestClient(app)

    def test_search_busy_falls_back_to_degraded_mode(self):
        read_headers = {"Host": "localhost:8010"}
        mocked_result = {
            "query": "florian",
            "mode": "mock",
            "topics": [],
            "tasks": [],
            "logs": [],
            "notes": [],
            "matchedTopicIds": [],
            "matchedTaskIds": [],
            "matchedLogIds": [],
        }
        fake_gate = unittest.mock.Mock()
        fake_gate.acquire.return_value = False
        fake_gate.release.return_value = None

        with patch("app.main._SEARCH_QUERY_GATE", fake_gate), patch("app.main._search_impl", return_value=mocked_result) as patched_impl:
            res = self.client.get(
                "/api/search",
                params={"q": "Florian", "limitTopics": 300, "limitTasks": 500, "limitLogs": 700},
                headers=read_headers,
            )

        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("degraded"))
        self.assertEqual(payload.get("mode"), "mock+busy-fallback")
        kwargs = patched_impl.call_args.kwargs
        self.assertFalse(kwargs["allow_deep_content_scan"])
        self.assertEqual(kwargs["limit_topics"], main_module.SEARCH_BUSY_FALLBACK_LIMIT_TOPICS)
        self.assertEqual(kwargs["limit_tasks"], main_module.SEARCH_BUSY_FALLBACK_LIMIT_TASKS)
        self.assertEqual(kwargs["limit_logs"], main_module.SEARCH_BUSY_FALLBACK_LIMIT_LOGS)
        fake_gate.release.assert_not_called()

    def test_search_caps_log_propagation_for_topics(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        topic_a = self.client.post("/api/topics", json={"name": "Dense Topic"}, headers=write_headers).json()
        topic_b = self.client.post("/api/topics", json={"name": "Florian Topic"}, headers=write_headers).json()

        log_ids_a: list[str] = []
        log_ids_b: list[str] = []
        for idx in range(20):
            row = self.client.post(
                "/api/log",
                json={
                    "topicId": topic_a["id"],
                    "type": "conversation",
                    "summary": f"dense generic match {idx}",
                    "content": f"dense generic match {idx}",
                    "createdAt": now_iso(),
                    "agentId": "user",
                    "agentLabel": "User",
                },
                headers=write_headers,
            ).json()
            log_ids_a.append(row["id"])
        for idx in range(3):
            row = self.client.post(
                "/api/log",
                json={
                    "topicId": topic_b["id"],
                    "type": "conversation",
                    "summary": f"florian specific match {idx}",
                    "content": f"florian specific match {idx}",
                    "createdAt": now_iso(),
                    "agentId": "user",
                    "agentLabel": "User",
                },
                headers=write_headers,
            ).json()
            log_ids_b.append(row["id"])

        mocked_result = {
            "query": "florian",
            "mode": "mock",
            "topics": [
                {
                    "id": topic_a["id"],
                    "score": 0.45,
                    "vectorScore": 0.45,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                },
                {
                    "id": topic_b["id"],
                    "score": 0.58,
                    "vectorScore": 0.58,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                },
            ],
            "tasks": [],
            "logs": [
                *[
                    {"id": log_id, "score": 0.25, "vectorScore": 0.25, "bm25Score": 0.0, "lexicalScore": 0.0, "rrfScore": 0.0, "rerankScore": 0.0}
                    for log_id in log_ids_a
                ],
                *[
                    {"id": log_id, "score": 0.35, "vectorScore": 0.35, "bm25Score": 0.0, "lexicalScore": 0.0, "rrfScore": 0.0, "rerankScore": 0.0}
                    for log_id in log_ids_b
                ],
            ],
        }

        with patch("app.main.semantic_search", return_value=mocked_result):
            res = self.client.get(
                "/api/search",
                params={"q": "Florian", "limitTopics": 10, "limitTasks": 10, "limitLogs": 200},
                headers=read_headers,
            )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        rows = {item["id"]: item for item in payload.get("topics", [])}

        self.assertIn(topic_a["id"], rows)
        self.assertIn(topic_b["id"], rows)

        score_a = float(rows[topic_a["id"]]["score"])
        score_b = float(rows[topic_b["id"]]["score"])
        propagation_a = float(rows[topic_a["id"]].get("logPropagationWeight") or 0.0)
        propagation_b = float(rows[topic_b["id"]].get("logPropagationWeight") or 0.0)
        direct_a = float(rows[topic_a["id"]].get("directMatchBoost") or 0.0)
        direct_b = float(rows[topic_b["id"]].get("directMatchBoost") or 0.0)

        # Single-token long-name queries require lexical/sparse support before parent propagation.
        self.assertAlmostEqual(propagation_a, 0.0, places=6)
        self.assertAlmostEqual(propagation_b, 0.0, places=6)
        self.assertAlmostEqual(direct_a, 0.0, places=6)
        self.assertGreater(direct_b, 0.3)
        self.assertAlmostEqual(score_a, 0.45, places=6)
        self.assertAlmostEqual(score_b, 0.96, places=6)
        self.assertGreater(score_b, score_a)

    def test_search_uses_task_signal_to_lift_parent_topic(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        topic_a = self.client.post("/api/topics", json={"name": "Generic Topic"}, headers=write_headers).json()
        topic_b = self.client.post("/api/topics", json={"name": "Florian Topic"}, headers=write_headers).json()
        task_a = self.client.post(
            "/api/tasks",
            json={"topicId": topic_a["id"], "title": "Generic planning task", "status": "todo"},
            headers=write_headers,
        ).json()
        task_b = self.client.post(
            "/api/tasks",
            json={"topicId": topic_b["id"], "title": "Review Florian package", "status": "todo"},
            headers=write_headers,
        ).json()

        mocked_result = {
            "query": "florian",
            "mode": "mock",
            "topics": [
                {
                    "id": topic_a["id"],
                    "score": 0.9,
                    "vectorScore": 0.9,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                },
                {
                    "id": topic_b["id"],
                    "score": 0.5,
                    "vectorScore": 0.5,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                },
            ],
            "tasks": [
                {
                    "id": task_a["id"],
                    "topicId": topic_a["id"],
                    "title": task_a["title"],
                    "status": task_a["status"],
                    "score": 0.45,
                    "vectorScore": 0.45,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                    "bestChunk": {"text": "generic planning task"},
                },
                {
                    "id": task_b["id"],
                    "topicId": topic_b["id"],
                    "title": task_b["title"],
                    "status": task_b["status"],
                    "score": 1.1,
                    "vectorScore": 1.1,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.12,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                    "bestChunk": {"text": "Review Florian package"},
                },
            ],
            "logs": [],
        }

        with patch("app.main.semantic_search", return_value=mocked_result):
            res = self.client.get(
                "/api/search",
                params={"q": "Florian", "limitTopics": 10, "limitTasks": 10, "limitLogs": 200},
                headers=read_headers,
            )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        rows = payload.get("topics", [])
        by_id = {item["id"]: item for item in rows}

        self.assertIn(topic_a["id"], by_id)
        self.assertIn(topic_b["id"], by_id)
        self.assertAlmostEqual(float(by_id[topic_a["id"]].get("taskPropagationWeight") or 0.0), 0.0, places=6)
        self.assertAlmostEqual(float(by_id[topic_b["id"]].get("taskPropagationWeight") or 0.0), 0.4464, places=6)
        self.assertGreater(float(by_id[topic_b["id"]].get("directMatchBoost") or 0.0), 0.3)
        self.assertGreater(float(by_id[topic_b["id"]]["score"]), float(by_id[topic_a["id"]]["score"]))
        self.assertEqual(rows[0]["id"], topic_b["id"])

    def test_search_multi_term_requires_sparse_signal_for_parent_propagation(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        topic_a = self.client.post("/api/topics", json={"name": "Broad Topic"}, headers=write_headers).json()
        topic_b = self.client.post("/api/topics", json={"name": "Specific Topic"}, headers=write_headers).json()
        task_a = self.client.post(
            "/api/tasks",
            json={"topicId": topic_a["id"], "title": "Broad task", "status": "todo"},
            headers=write_headers,
        ).json()
        task_b = self.client.post(
            "/api/tasks",
            json={"topicId": topic_b["id"], "title": "Specific task", "status": "todo"},
            headers=write_headers,
        ).json()
        log_a = self.client.post(
            "/api/log",
            json={
                "topicId": topic_a["id"],
                "taskId": task_a["id"],
                "type": "conversation",
                "summary": "generic summary",
                "content": "generic content",
                "createdAt": now_iso(),
                "agentId": "user",
                "agentLabel": "User",
            },
            headers=write_headers,
        ).json()
        log_b = self.client.post(
            "/api/log",
            json={
                "topicId": topic_b["id"],
                "taskId": task_b["id"],
                "type": "conversation",
                "summary": "generic summary",
                "content": "generic content",
                "createdAt": now_iso(),
                "agentId": "user",
                "agentLabel": "User",
            },
            headers=write_headers,
        ).json()

        mocked_result = {
            "query": "health insurance",
            "mode": "mock",
            "topics": [
                {"id": topic_a["id"], "score": 0.6, "vectorScore": 0.6, "bm25Score": 0.0, "lexicalScore": 0.0, "rrfScore": 0.0, "rerankScore": 0.0},
                {"id": topic_b["id"], "score": 0.65, "vectorScore": 0.65, "bm25Score": 0.0, "lexicalScore": 0.0, "rrfScore": 0.0, "rerankScore": 0.0},
            ],
            "tasks": [
                {
                    "id": task_a["id"],
                    "topicId": topic_a["id"],
                    "title": task_a["title"],
                    "status": task_a["status"],
                    "score": 1.4,
                    "vectorScore": 1.4,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "chunkScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                    "bestChunk": {"text": "broad task"},
                },
                {
                    "id": task_b["id"],
                    "topicId": topic_b["id"],
                    "title": task_b["title"],
                    "status": task_b["status"],
                    "score": 0.8,
                    "vectorScore": 0.8,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "chunkScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                    "bestChunk": {"text": "specific task"},
                },
            ],
            "logs": [
                {
                    "id": log_a["id"],
                    "score": 0.92,
                    "vectorScore": 0.92,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "chunkScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                    "bestChunk": {"text": "generic summary"},
                },
                {
                    "id": log_b["id"],
                    "score": 0.51,
                    "vectorScore": 0.51,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "chunkScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                    "bestChunk": {"text": "generic summary"},
                },
            ],
        }

        with patch("app.main.semantic_search", return_value=mocked_result):
            res = self.client.get(
                "/api/search",
                params={"q": "health insurance", "limitTopics": 10, "limitTasks": 10, "limitLogs": 200},
                headers=read_headers,
            )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        by_id = {item["id"]: item for item in payload.get("topics", [])}
        self.assertIn(topic_a["id"], by_id)
        self.assertIn(topic_b["id"], by_id)
        self.assertAlmostEqual(float(by_id[topic_a["id"]].get("logPropagationWeight") or 0.0), 0.0, places=6)
        self.assertAlmostEqual(float(by_id[topic_b["id"]].get("logPropagationWeight") or 0.0), 0.0, places=6)
        self.assertAlmostEqual(float(by_id[topic_a["id"]].get("taskPropagationWeight") or 0.0), 0.0, places=6)
        self.assertAlmostEqual(float(by_id[topic_b["id"]].get("taskPropagationWeight") or 0.0), 0.0, places=6)

    def test_search_topic_hints_ignore_tool_call_logs_when_disabled(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        topic = self.client.post("/api/topics", json={"name": "Hint Topic"}, headers=write_headers).json()
        self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "type": "action",
                "summary": "Tool call: exec Florian diagnostics",
                "content": "",
                "createdAt": now_iso(),
                "agentId": "assistant",
                "agentLabel": "Assistant",
            },
            headers=write_headers,
        )

        captured_topics: list[list[dict]] = []

        def fake_semantic_search(query, topics, tasks, logs, **kwargs):
            captured_topics.append(topics)
            return {"query": query, "mode": "mock", "topics": [], "tasks": [], "logs": []}

        original = main_module.SEARCH_INCLUDE_TOOL_CALL_LOGS
        main_module.SEARCH_INCLUDE_TOOL_CALL_LOGS = False
        try:
            with patch("app.main.semantic_search", side_effect=fake_semantic_search):
                res = self.client.get(
                    "/api/search",
                    params={"q": "Florian", "limitTopics": 10, "limitTasks": 10, "limitLogs": 100},
                    headers=read_headers,
                )
        finally:
            main_module.SEARCH_INCLUDE_TOOL_CALL_LOGS = original

        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(captured_topics, "Expected semantic_search to be called")
        row = next((item for item in captured_topics[0] if item.get("id") == topic["id"]), None)
        self.assertIsNotNone(row)
        self.assertNotIn("florian", str((row or {}).get("searchText") or "").lower())

    def test_search_response_content_prefers_content_preview_not_summary(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        topic = self.client.post("/api/topics", json={"name": "Preview Topic"}, headers=write_headers).json()
        conversation = self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "type": "conversation",
                "summary": "generic summary",
                "content": "Need help comparing health insurance deductible and copay options.",
                "createdAt": now_iso(),
                "agentId": "user",
                "agentLabel": "User",
            },
            headers=write_headers,
        ).json()
        self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "type": "note",
                "relatedLogId": conversation["id"],
                "summary": "short note summary",
                "content": "NOTE SENTINEL: detailed note content from user curation.",
                "createdAt": now_iso(),
                "agentId": "assistant",
                "agentLabel": "Assistant",
            },
            headers=write_headers,
        ).json()

        mocked_result = {
            "query": "health insurance",
            "mode": "mock",
            "topics": [],
            "tasks": [],
            "logs": [
                {
                    "id": conversation["id"],
                    "score": 0.9,
                    "vectorScore": 0.9,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                }
            ],
        }

        with patch("app.main.semantic_search", return_value=mocked_result):
            res = self.client.get(
                "/api/search",
                params={"q": "health insurance", "limitTopics": 10, "limitTasks": 10, "limitLogs": 50},
                headers=read_headers,
            )

        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        logs = payload.get("logs") or []
        self.assertTrue(logs, "Expected at least one log result")
        self.assertIn("health insurance", str(logs[0].get("content") or "").lower())
        self.assertNotEqual(str(logs[0].get("content") or "").strip().lower(), "generic summary")

        notes = payload.get("notes") or []
        self.assertTrue(notes, "Expected curated notes for the matched log")
        self.assertIn("note sentinel", str(notes[0].get("content") or "").lower())

    def test_search_linked_notes_are_emitted_and_weight_scores(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        topic = self.client.post("/api/topics", json={"name": "Notes Weight Topic"}, headers=write_headers).json()
        task = self.client.post(
            "/api/tasks",
            json={"topicId": topic["id"], "title": "Notes Weight Task", "status": "todo"},
            headers=write_headers,
        ).json()
        conversation = self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "taskId": task["id"],
                "type": "conversation",
                "summary": "review retirement plan options",
                "content": "Compare retirement plan options and contribution limits this quarter.",
                "createdAt": now_iso(),
                "agentId": "user",
                "agentLabel": "User",
            },
            headers=write_headers,
        ).json()
        note = self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "taskId": task["id"],
                "type": "note",
                "relatedLogId": conversation["id"],
                "summary": "curated follow-up note",
                "content": "Track employer match thresholds in this workstream.",
                "createdAt": now_iso(),
                "agentId": "assistant",
                "agentLabel": "Assistant",
            },
            headers=write_headers,
        ).json()

        mocked_result = {
            "query": "retirement plan options",
            "mode": "mock",
            "topics": [
                {
                    "id": topic["id"],
                    "score": 0.5,
                    "vectorScore": 0.5,
                    "bm25Score": 0.1,
                    "lexicalScore": 0.1,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                }
            ],
            "tasks": [
                {
                    "id": task["id"],
                    "score": 0.45,
                    "vectorScore": 0.45,
                    "bm25Score": 0.1,
                    "lexicalScore": 0.1,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                }
            ],
            "logs": [
                {
                    "id": conversation["id"],
                    "score": 0.6,
                    "vectorScore": 0.6,
                    "bm25Score": 0.1,
                    "lexicalScore": 0.1,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                }
            ],
        }

        with patch("app.main.semantic_search", return_value=mocked_result):
            res = self.client.get(
                "/api/search",
                params={"q": "retirement plan options", "limitTopics": 10, "limitTasks": 10, "limitLogs": 50},
                headers=read_headers,
            )

        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()

        notes = payload.get("notes") or []
        self.assertTrue(any(str(item.get("id") or "") == note["id"] for item in notes), "Expected linked note row in output")

        topics = payload.get("topics") or []
        tasks = payload.get("tasks") or []
        logs = payload.get("logs") or []
        self.assertTrue(topics)
        self.assertTrue(tasks)
        self.assertTrue(logs)
        self.assertGreater(float(topics[0].get("noteWeight") or 0.0), 0.0)
        self.assertGreater(float(tasks[0].get("noteWeight") or 0.0), 0.0)
        self.assertGreater(float(logs[0].get("noteWeight") or 0.0), 0.0)
        self.assertEqual(int(logs[0].get("noteCount") or 0), 1)

    def test_search_passes_content_snippets_into_semantic_payload(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        topic = self.client.post("/api/topics", json={"name": "Insurance Topic"}, headers=write_headers).json()
        self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "type": "conversation",
                "summary": "generic summary",
                "content": "Need help with health insurance deductible and copay options.",
                "createdAt": now_iso(),
                "agentId": "user",
                "agentLabel": "User",
            },
            headers=write_headers,
        )

        captured_payloads: list[dict] = []

        def fake_semantic_search(query, topics, tasks, logs, **kwargs):
            captured_payloads.append({"query": query, "logs": logs})
            return {
                "query": query,
                "mode": "mock",
                "topics": [],
                "tasks": [],
                "logs": [],
            }

        with patch("app.main.semantic_search", side_effect=fake_semantic_search):
            res = self.client.get(
                "/api/search",
                params={"q": "health insurance", "limitTopics": 10, "limitTasks": 10, "limitLogs": 100},
                headers=read_headers,
            )

        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(captured_payloads, "Expected semantic_search to be called")
        logs_payload = captured_payloads[0]["logs"]
        self.assertTrue(logs_payload, "Expected logs in semantic payload")
        joined = " ".join(str(item.get("content") or "") for item in logs_payload).lower()
        self.assertIn("health", joined)
        self.assertIn("insurance", joined)

    def test_search_adds_query_aware_topic_hints(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        topic = self.client.post("/api/topics", json={"name": "KorBon"}, headers=write_headers).json()
        task = self.client.post(
            "/api/tasks",
            json={"topicId": topic["id"], "title": "Update billing address", "status": "todo"},
            headers=write_headers,
        ).json()
        self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "taskId": task["id"],
                "type": "conversation",
                "summary": "generic summary",
                "content": "Need help comparing health insurance deductible choices.",
                "createdAt": now_iso(),
                "agentId": "user",
                "agentLabel": "User",
            },
            headers=write_headers,
        )

        captured_topics: list[list[dict]] = []

        def fake_semantic_search(query, topics, tasks, logs, **kwargs):
            captured_topics.append(topics)
            return {"query": query, "mode": "mock", "topics": [], "tasks": [], "logs": []}

        with patch("app.main.semantic_search", side_effect=fake_semantic_search):
            res = self.client.get(
                "/api/search",
                params={"q": "health insurance", "limitTopics": 10, "limitTasks": 10, "limitLogs": 100},
                headers=read_headers,
            )
        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(captured_topics, "Expected semantic_search to be called")
        topics_payload = captured_topics[0]
        row = next((item for item in topics_payload if item.get("id") == topic["id"]), None)
        self.assertIsNotNone(row)
        search_text = str((row or {}).get("searchText") or "").lower()
        self.assertIn("health", search_text)
        self.assertIn("insurance", search_text)

    def test_search_low_signal_board_session_expands_semantic_query(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        topic = self.client.post("/api/topics", json={"name": "Scoped Semantic Topic"}, headers=write_headers).json()
        task = self.client.post(
            "/api/tasks",
            json={"topicId": topic["id"], "title": "Scoped Semantic Task", "status": "doing"},
            headers=write_headers,
        ).json()

        board_session_key = f"clawboard:task:{topic['id']}:{task['id']}"
        self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "taskId": task["id"],
                "type": "conversation",
                "summary": "Board semantic history mentions deductible planning details.",
                "content": "Board semantic history mentions deductible planning details.",
                "createdAt": now_iso(),
                "agentId": "user",
                "agentLabel": "User",
                "source": {"sessionKey": board_session_key},
            },
            headers=write_headers,
        )

        captured_calls: list[dict] = []

        def fake_semantic_search(query, topics, tasks, logs, **kwargs):
            captured_calls.append({"query": query, "topics": topics, "logs": logs, "kwargs": kwargs})
            return {"query": query, "mode": "mock", "topics": [], "tasks": [], "logs": []}

        with patch("app.main.semantic_search", side_effect=fake_semantic_search):
            res = self.client.get(
                "/api/search",
                params={"q": "resume", "sessionKey": board_session_key, "limitTopics": 10, "limitTasks": 10, "limitLogs": 100},
                headers=read_headers,
            )
        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(captured_calls, "Expected semantic_search to be called")

        semantic_query = str((captured_calls[0] or {}).get("query") or "").lower()
        self.assertIn("resume", semantic_query)
        self.assertIn("scoped semantic topic", semantic_query)
        self.assertIn("scoped semantic task", semantic_query)
        self.assertIn("deductible", semantic_query)
        self.assertNotEqual(semantic_query.strip(), "resume")

        payload = res.json()
        meta = payload.get("searchMeta") or {}
        self.assertEqual(meta.get("semanticQuerySource"), "auto_scoped_low_signal")
        self.assertTrue(bool(meta.get("semanticQueryExpanded")))
        self.assertIn("scoped semantic task", str(meta.get("semanticQuery") or "").lower())

    def test_search_caps_effective_semantic_limits_for_stability(self):
        read_headers = {"Host": "localhost:8010"}
        captured_calls: list[dict] = []

        def fake_semantic_search(query, topics, tasks, logs, **kwargs):
            captured_calls.append(kwargs)
            return {"query": query, "mode": "mock", "topics": [], "tasks": [], "logs": []}

        with patch("app.main.semantic_search", side_effect=fake_semantic_search):
            res = self.client.get(
                "/api/search",
                params={"q": "air tires", "limitTopics": 800, "limitTasks": 2000, "limitLogs": 5000},
                headers=read_headers,
            )

        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(captured_calls, "Expected semantic_search to be called")
        kwargs = captured_calls[0]
        self.assertEqual(int(kwargs.get("topic_limit") or 0), 120)
        self.assertEqual(int(kwargs.get("task_limit") or 0), 240)
        self.assertEqual(int(kwargs.get("log_limit") or 0), 320)

    def test_search_uses_degraded_fallback_when_gate_is_busy(self):
        read_headers = {"Host": "localhost:8010"}

        class BusyGate:
            def acquire(self, timeout=None):
                return False

            def release(self):
                raise AssertionError("release should not be called for an unacquired gate")

        with patch.object(main_module, "_SEARCH_QUERY_GATE", BusyGate()):
            with patch(
                "app.main._search_impl",
                return_value={
                    "query": "health insurance",
                    "mode": "mock",
                    "topics": [],
                    "tasks": [],
                    "logs": [],
                    "notes": [],
                    "matchedTopicIds": [],
                    "matchedTaskIds": [],
                    "matchedLogIds": [],
                },
            ) as mock_impl:
                res = self.client.get(
                    "/api/search",
                    params={"q": "health insurance", "limitTopics": 24, "limitTasks": 48, "limitLogs": 999},
                    headers=read_headers,
                )

        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        self.assertTrue(payload.get("degraded"))
        self.assertEqual(payload.get("mode"), "mock+busy-fallback")
        self.assertTrue(mock_impl.called, "Expected _search_impl degraded pass when gate is busy")
        self.assertTrue((payload.get("searchMeta") or {}).get("degraded"))

    def test_search_includes_diagnostics_meta(self):
        read_headers = {"Host": "localhost:8010"}

        with patch(
            "app.main.semantic_search",
            return_value={"query": "health insurance", "mode": "mock", "topics": [], "tasks": [], "logs": []},
        ):
            res = self.client.get(
                "/api/search",
                params={"q": "health insurance", "limitTopics": 24, "limitTasks": 48, "limitLogs": 360},
                headers=read_headers,
            )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        meta = payload.get("searchMeta") or {}
        self.assertIn("durationMs", meta)
        self.assertIn("gateWaitMs", meta)
        self.assertIn("effectiveLimits", meta)
        self.assertIn("queryTokenCount", meta)

    def test_search_session_boost_matches_base_and_suffixed_session_keys(self):
        write_headers = {"Host": "localhost:8010", "X-Clawboard-Token": "test-token"}
        read_headers = {"Host": "localhost:8010"}

        topic = self.client.post("/api/topics", json={"name": "Session Topic"}, headers=write_headers).json()
        self.client.post(
            "/api/log",
            json={
                "topicId": topic["id"],
                "type": "conversation",
                "summary": "session continuity signal",
                "content": "session continuity signal",
                "createdAt": now_iso(),
                "agentId": "user",
                "agentLabel": "User",
                "source": {"sessionKey": "channel:session-base|thread:42"},
            },
            headers=write_headers,
        ).json()

        mocked_result = {
            "query": "session continuity",
            "mode": "mock",
            "topics": [
                {
                    "id": topic["id"],
                    "score": 0.5,
                    "vectorScore": 0.5,
                    "bm25Score": 0.0,
                    "lexicalScore": 0.0,
                    "rrfScore": 0.0,
                    "rerankScore": 0.0,
                }
            ],
            "tasks": [],
            "logs": [],
        }

        with patch("app.main.semantic_search", return_value=mocked_result):
            res = self.client.get(
                "/api/search",
                params={"q": "session continuity", "sessionKey": "channel:session-base"},
                headers=read_headers,
            )
        self.assertEqual(res.status_code, 200, res.text)
        payload = res.json()
        topics = payload.get("topics") or []
        self.assertTrue(topics, "Expected topic result")
        self.assertTrue(bool(topics[0].get("sessionBoosted")))
        self.assertAlmostEqual(float(topics[0].get("score") or 0.0), 0.62, places=6)


if __name__ == "__main__":
    unittest.main()
