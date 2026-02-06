from __future__ import annotations

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP_DIR = os.path.join(ROOT, "app")
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

from eval_harness import run_eval  # noqa: E402


class EvalHarnessTests(unittest.TestCase):
    def test_run_eval_reports_retrieval_and_dedupe_metrics(self):
        payload = {
            "queries": [
                {
                    "query": "discord retries",
                    "relevant": {"topics": ["topic-ops"], "tasks": ["task-retry"], "logs": ["log-1"]},
                    "results": {
                        "topics": [{"id": "topic-ops"}, {"id": "topic-ui"}],
                        "tasks": [{"id": "task-retry"}, {"id": "task-style"}],
                        "logs": [{"id": "log-1"}, {"id": "log-2"}],
                    },
                },
                {
                    "query": "board spacing",
                    "relevant": {"topics": ["topic-ui"], "tasks": ["task-style"], "logs": ["log-2"]},
                    "results": {
                        "topics": [{"id": "topic-ui"}, {"id": "topic-ops"}],
                        "tasks": [{"id": "task-style"}, {"id": "task-retry"}],
                        "logs": [{"id": "log-2"}, {"id": "log-1"}],
                    },
                },
            ],
            "dedupe": {
                "topics": [
                    {"a": "topic-a", "b": "topic-a-dup", "shouldMatch": True, "predictedMatch": True},
                    {"a": "topic-b", "b": "topic-c", "shouldMatch": False, "predictedMatch": True},
                ],
                "tasks": [
                    {"a": "task-a", "b": "task-a-dup", "shouldMatch": True, "predictedMatch": True},
                    {"a": "task-b", "b": "task-c", "shouldMatch": False, "predictedMatch": False},
                ],
            },
        }

        report = run_eval(payload)
        metrics = report.get("metrics", {})

        self.assertEqual(report.get("queryCount"), 2)
        self.assertGreaterEqual(float(metrics.get("topic_recall@1", 0.0)), 1.0)
        self.assertGreaterEqual(float(metrics.get("task_mrr", 0.0)), 1.0)
        self.assertGreaterEqual(float(metrics.get("log_ndcg@3", 0.0)), 1.0)

        self.assertAlmostEqual(float(metrics.get("topic_dedupe_precision", 0.0)), 0.5, places=5)
        self.assertAlmostEqual(float(metrics.get("topic_dedupe_recall", 0.0)), 1.0, places=5)
        self.assertAlmostEqual(float(metrics.get("task_dedupe_precision", 0.0)), 1.0, places=5)
        self.assertAlmostEqual(float(metrics.get("task_dedupe_recall", 0.0)), 1.0, places=5)


if __name__ == "__main__":
    unittest.main()
