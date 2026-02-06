from __future__ import annotations

import os
import sys
import unittest
from types import SimpleNamespace


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP_DIR = os.path.join(ROOT, "app")
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

from clawgraph import build_clawgraph  # noqa: E402


class ClawgraphBuildTests(unittest.TestCase):
    def _sample_rows(self):
        topics = [
            SimpleNamespace(id="topic-1", name="Clawboard Memory", description="Memory work", pinned=True),
            SimpleNamespace(id="topic-2", name="Discord Ops", description="Discord bot quality", pinned=False),
        ]
        tasks = [
            SimpleNamespace(id="task-1", topicId="topic-1", title="Ship graph view", status="doing", pinned=True),
            SimpleNamespace(id="task-2", topicId="topic-2", title="Fix Discord routing", status="todo", pinned=False),
        ]
        logs = [
            SimpleNamespace(
                id="log-1",
                topicId="topic-1",
                taskId="task-1",
                type="conversation",
                summary="Build Clawgraph using OpenClaw and Discord context",
                content="Need relationships between Clawboard, OpenClaw, Discord, and Tasks.",
                raw="",
                agentId="assistant",
                agentLabel="OpenClaw",
                relatedLogId=None,
                classificationStatus="classified",
                createdAt="2026-02-06T00:00:00.000Z",
            ),
            SimpleNamespace(
                id="log-2",
                topicId="topic-1",
                taskId="task-1",
                type="note",
                summary="",
                content="User note: treat Discord as high-signal entity in this topic.",
                raw="",
                agentId="user",
                agentLabel="User",
                relatedLogId="log-1",
                classificationStatus="classified",
                createdAt="2026-02-06T00:01:00.000Z",
            ),
            SimpleNamespace(
                id="log-3",
                topicId="topic-2",
                taskId="task-2",
                type="conversation",
                summary="Discord retries + Tailscale checks",
                content="Main agent coordinates Discord and Tailscale reliability work.",
                raw="",
                agentId="assistant",
                agentLabel="OpenClaw",
                relatedLogId=None,
                classificationStatus="classified",
                createdAt="2026-02-06T00:02:00.000Z",
            ),
            SimpleNamespace(
                id="log-4",
                topicId="topic-2",
                taskId=None,
                type="conversation",
                summary="Ok do you remember Thomas",
                content="Ok do you remember Thomas",
                raw="",
                agentId="user",
                agentLabel="User",
                relatedLogId=None,
                classificationStatus="classified",
                createdAt="2026-02-06T00:03:00.000Z",
            ),
        ]
        return topics, tasks, logs

    def test_build_contains_core_node_types(self):
        topics, tasks, logs = self._sample_rows()
        graph = build_clawgraph(topics, tasks, logs, max_entities=40, max_nodes=120, min_edge_weight=0.0)

        node_types = {node["type"] for node in graph["nodes"]}
        self.assertIn("topic", node_types)
        self.assertIn("task", node_types)
        self.assertIn("entity", node_types)
        self.assertIn("agent", node_types)

        edge_types = {edge["type"] for edge in graph["edges"]}
        self.assertIn("has_task", edge_types)
        self.assertIn("mentions", edge_types)

    def test_curated_note_strengthens_mentions(self):
        topics, tasks, logs = self._sample_rows()
        graph = build_clawgraph(topics, tasks, logs, max_entities=40, max_nodes=120, min_edge_weight=0.0)

        discord_entities = [node for node in graph["nodes"] if node["type"] == "entity" and "discord" in node["label"].lower()]
        self.assertTrue(discord_entities, "Expected Discord entity node in graph")
        discord_node_id = discord_entities[0]["id"]

        mention_weights = [
            edge["weight"]
            for edge in graph["edges"]
            if edge["type"] == "mentions" and edge["target"] == discord_node_id
        ]
        self.assertTrue(mention_weights, "Expected at least one mention edge to Discord entity")
        self.assertGreater(max(mention_weights), 0.8)

    def test_entity_normalization_avoids_thomas_ok_duplicate(self):
        topics, tasks, logs = self._sample_rows()
        graph = build_clawgraph(topics, tasks, logs, max_entities=60, max_nodes=140, min_edge_weight=0.0)

        entity_nodes = [node for node in graph["nodes"] if node["type"] == "entity"]
        entity_keys = [str(node.get("meta", {}).get("entityKey", "")) for node in entity_nodes]
        self.assertNotIn("thomas ok", entity_keys)
        self.assertNotIn("thomas\nok", entity_keys)

        thomas_entities = [node for node in entity_nodes if str(node.get("meta", {}).get("entityKey")) == "thomas"]
        self.assertEqual(len(thomas_entities), 1)


if __name__ == "__main__":
    unittest.main()
