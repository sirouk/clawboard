"""Unit tests for classifier/embeddings_store.py."""
from __future__ import annotations

import importlib
import os
import unittest
from unittest import mock


def reload_store(qdrant_url: str):
    with mock.patch.dict(
        os.environ,
        {
            "QDRANT_URL": qdrant_url,
            "QDRANT_COLLECTION": "clawboard_embeddings",
            "QDRANT_DIM": "384",
            "QDRANT_TIMEOUT": "8",
            "QDRANT_API_KEY": "",
        },
        clear=False,
    ):
        import classifier.embeddings_store as es

        importlib.reload(es)
        return es


class EmbeddingsStoreTests(unittest.TestCase):
    """Tests for Qdrant-backed embeddings store behavior."""

    def test_no_qdrant_degrades_to_noop_paths(self):
        es = reload_store("")

        # No-Qdrant mode should not crash classifier flow.
        es.upsert("topic", "test-id", [0.1, 0.2, 0.3])
        es.delete("topic", "test-id")
        es.delete_task_other_namespaces("test-id", keep_kind="task:alpha")

        self.assertEqual(es.get_all("topic"), [])
        self.assertEqual(es.topk("topic", [1.0, 0.0], k=3), [])

    def test_upsert_writes_qdrant_point_payload(self):
        es = reload_store("http://qdrant.test")

        requests_mock = mock.Mock()
        requests_mock.get.return_value = mock.Mock(status_code=200)
        points_put_response = mock.Mock()
        points_put_response.raise_for_status.return_value = None
        requests_mock.put.return_value = points_put_response
        es.requests = requests_mock

        es.upsert("task:ops", "task-123", [0.2, 0.4, 0.6])

        self.assertTrue(requests_mock.put.called)
        args, kwargs = requests_mock.put.call_args
        self.assertEqual(args[0], "http://qdrant.test/collections/clawboard_embeddings/points")
        payload = kwargs.get("json") or {}
        point = ((payload.get("points") or [None])[0]) or {}
        self.assertEqual(point.get("payload", {}).get("kind"), "task:ops")
        self.assertEqual(point.get("payload", {}).get("kindRoot"), "task")
        self.assertEqual(point.get("payload", {}).get("id"), "task-123")
        self.assertIsInstance(point.get("id"), str)

    def test_topk_reads_qdrant_scores_sorted_and_trimmed(self):
        es = reload_store("http://qdrant.test")

        requests_mock = mock.Mock()
        requests_mock.get.return_value = mock.Mock(status_code=200)
        search_response = mock.Mock()
        search_response.raise_for_status.return_value = None
        search_response.json.return_value = {
            "result": [
                {"score": 0.2, "payload": {"id": "topic-2"}},
                {"score": 0.9, "payload": {"id": "topic-1"}},
                {"score": 0.5, "payload": {"id": "topic-3"}},
            ]
        }
        requests_mock.post.return_value = search_response
        es.requests = requests_mock

        rows = es.topk("topic", [1.0, 0.0], k=2)

        self.assertEqual(rows, [("topic-1", 0.9), ("topic-3", 0.5)])
        post_args, post_kwargs = requests_mock.post.call_args
        self.assertEqual(post_args[0], "http://qdrant.test/collections/clawboard_embeddings/points/search")
        flt = (((post_kwargs.get("json") or {}).get("filter") or {}).get("must") or [])
        self.assertEqual(flt[0]["key"], "kind")
        self.assertEqual(flt[0]["match"]["value"], "topic")

    def test_delete_task_other_namespaces_builds_filter(self):
        es = reload_store("http://qdrant.test")

        requests_mock = mock.Mock()
        requests_mock.get.return_value = mock.Mock(status_code=200)
        delete_response = mock.Mock()
        delete_response.raise_for_status.return_value = None
        requests_mock.post.return_value = delete_response
        es.requests = requests_mock

        es.delete_task_other_namespaces("shared-id", keep_kind="task:namespace-b")

        args, kwargs = requests_mock.post.call_args
        self.assertEqual(args[0], "http://qdrant.test/collections/clawboard_embeddings/points/delete")
        payload = kwargs.get("json") or {}
        must = payload.get("filter", {}).get("must", [])
        must_not = payload.get("filter", {}).get("must_not", [])
        self.assertEqual(must[0]["key"], "kindRoot")
        self.assertEqual(must[0]["match"]["value"], "task")
        self.assertEqual(must[1]["key"], "id")
        self.assertEqual(must[1]["match"]["value"], "shared-id")
        self.assertEqual(must_not[0]["key"], "kind")
        self.assertEqual(must_not[0]["match"]["value"], "task:namespace-b")

    def test_qdrant_point_id_is_deterministic(self):
        es = reload_store("http://qdrant.test")

        id1 = es._qdrant_point_id("topic", "test-id")
        id2 = es._qdrant_point_id("topic", "test-id")
        self.assertEqual(id1, id2)
        self.assertNotEqual(id1, es._qdrant_point_id("task", "test-id"))


if __name__ == "__main__":
    unittest.main()
