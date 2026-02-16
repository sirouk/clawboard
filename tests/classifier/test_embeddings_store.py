"""Unit tests for classifier/embeddings_store.py."""
from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import numpy as np


class EmbeddingsStoreTests(unittest.TestCase):
    """Tests for embeddings_store module."""

    def setUp(self):
        """Set up temp database for each test."""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "test_embeddings.db")
        self.env_patcher = mock.patch.dict(
            os.environ,
            {
                "CLASSIFIER_EMBED_DB": self.db_path,
                "QDRANT_URL": "",  # Disable Qdrant for tests
            },
        )
        self.env_patcher.start()
        # Re-import to pick up new env vars
        import importlib
        import classifier.embeddings_store as es

        importlib.reload(es)
        self.es = es

    def tearDown(self):
        """Clean up temp directory."""
        self.env_patcher.stop()
        import shutil

        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_upsert_stores_vector_in_sqlite(self):
        """Test that upsert stores a vector in SQLite."""
        vector = [0.1, 0.2, 0.3, 0.4]
        self.es.upsert("topic", "test-id-1", vector)

        # Retrieve and verify
        all_items = self.es.get_all("topic")
        self.assertEqual(len(all_items), 1)
        item_id, stored_vec = all_items[0]
        self.assertEqual(item_id, "test-id-1")
        np.testing.assert_array_almost_equal(stored_vec, vector, decimal=5)

    def test_upsert_updates_existing_vector(self):
        """Test that upsert updates an existing vector."""
        vector_v1 = [0.1, 0.2, 0.3]
        vector_v2 = [0.4, 0.5, 0.6]

        self.es.upsert("task", "test-id-2", vector_v1)
        self.es.upsert("task", "test-id-2", vector_v2)

        all_items = self.es.get_all("task")
        self.assertEqual(len(all_items), 1)  # Still only one item
        _, stored_vec = all_items[0]
        np.testing.assert_array_almost_equal(stored_vec, vector_v2, decimal=5)

    def test_delete_removes_vector(self):
        """Test that delete removes a vector."""
        self.es.upsert("topic", "to-delete", [0.1, 0.2])
        self.es.delete("topic", "to-delete")

        all_items = self.es.get_all("topic")
        self.assertEqual(len(all_items), 0)

    def test_get_all_returns_empty_for_nonexistent_kind(self):
        """Test get_all returns empty list for unknown kind."""
        all_items = self.es.get_all("nonexistent")
        self.assertEqual(all_items, [])

    def test_cosine_sim_returns_1_for_identical_vectors(self):
        """Test cosine similarity of identical vectors is 1."""
        vec = np.array([1.0, 2.0, 3.0])
        sim = self.es.cosine_sim(vec, vec)
        self.assertAlmostEqual(sim, 1.0, places=5)

    def test_cosine_sim_returns_0_for_orthogonal_vectors(self):
        """Test cosine similarity of orthogonal vectors is 0."""
        vec1 = np.array([1.0, 0.0])
        vec2 = np.array([0.0, 1.0])
        sim = self.es.cosine_sim(vec1, vec2)
        self.assertAlmostEqual(sim, 0.0, places=5)

    def test_cosine_sim_returns_0_for_zero_vector(self):
        """Test cosine similarity with zero vector is 0."""
        vec1 = np.array([0.0, 0.0, 0.0])
        vec2 = np.array([1.0, 2.0, 3.0])
        sim = self.es.cosine_sim(vec1, vec2)
        self.assertAlmostEqual(sim, 0.0, places=5)

    def test_topk_returns_top_matches(self):
        """Test topk returns most similar vectors."""
        # Store several vectors
        self.es.upsert("topic", "vec1", [1.0, 0.0])
        self.es.upsert("topic", "vec2", [0.9, 0.1])  # Similar to vec1
        self.es.upsert("topic", "vec3", [0.0, 1.0])  # Orthogonal

        # Query similar to vec1
        results = self.es.topk("topic", [1.0, 0.0], k=2)

        self.assertEqual(len(results), 2)
        # Most similar should be vec1 (exact match)
        self.assertEqual(results[0][0], "vec1")
        self.assertAlmostEqual(results[0][1], 1.0, places=4)
        # Second should be vec2
        self.assertEqual(results[1][0], "vec2")

    def test_topk_respects_k_parameter(self):
        """Test topk returns at most k results."""
        for i in range(10):
            self.es.upsert("task", f"vec{i}", [float(i), 0.0])

        results = self.es.topk("task", [5.0, 0.0], k=3)
        self.assertEqual(len(results), 3)

    def test_delete_task_other_namespaces_removes_correct_entries(self):
        """Test delete_task_other_namespaces removes matching entries."""
        # Add entries with same ID but different kinds
        self.es.upsert("task:namespace-a", "shared-id", [0.1, 0.2])
        self.es.upsert("task:namespace-b", "shared-id", [0.3, 0.4])
        self.es.upsert("task:namespace-c", "shared-id", [0.5, 0.6])
        self.es.upsert("topic", "shared-id", [0.7, 0.8])  # Different kind root

        # Delete all task namespaces except namespace-b
        self.es.delete_task_other_namespaces("shared-id", keep_kind="task:namespace-b")

        # Check that only namespace-b remains for task
        task_items = self.es.get_all("task:namespace-b")
        self.assertEqual(len(task_items), 1)

        # Other task namespaces should be gone
        self.assertEqual(len(self.es.get_all("task:namespace-a")), 0)
        self.assertEqual(len(self.es.get_all("task:namespace-c")), 0)

        # Topic should be unaffected
        topic_items = self.es.get_all("topic")
        self.assertEqual(len(topic_items), 1)

    def test_qdrant_point_id_is_deterministic(self):
        """Test that Qdrant point IDs are deterministic UUIDs."""
        id1 = self.es._qdrant_point_id("topic", "test-id")
        id2 = self.es._qdrant_point_id("topic", "test-id")
        self.assertEqual(id1, id2)

        # Different kind should give different ID
        id3 = self.es._qdrant_point_id("task", "test-id")
        self.assertNotEqual(id1, id3)


if __name__ == "__main__":
    unittest.main()
