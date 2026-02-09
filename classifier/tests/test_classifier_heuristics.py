import json
import unittest
from pathlib import Path


from classifier import classifier as c


FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def load_window(name: str) -> list[dict]:
    path = FIXTURES_DIR / name
    return json.loads(path.read_text())


class ClassifierHeuristicsTests(unittest.TestCase):
    def test_normalize_score_map_does_not_inflate_single_value(self):
        self.assertEqual(c._normalize_score_map({"x": 0.2})["x"], 0.2)
        self.assertEqual(c._normalize_score_map({"x": 0.0})["x"], 0.0)
        # Squash values > 1 into (0,1) so they don't look like perfect confidence.
        self.assertAlmostEqual(c._normalize_score_map({"x": 5.0})["x"], 5.0 / 6.0)

    def test_is_affirmation_handles_punctuation(self):
        self.assertTrue(c._is_affirmation("Yes, do it."))
        self.assertTrue(c._is_affirmation("Okay!"))
        self.assertFalse(c._is_affirmation("Yes, but not yet."))

    def test_small_talk_has_no_task_intent(self):
        window = load_window("small_talk_window.json")
        self.assertIsNone(c._derive_task_title(window))
        self.assertFalse(c._window_has_task_intent(window))

    def test_topical_conversation_no_tasks_allows_topic_creation(self):
        window = load_window("topical_no_tasks_window.json")
        text = c.window_text(window, notes_index={})
        derived = c._derive_topic_name(window)

        # Simulate an existing, unrelated topic so we exercise the "topics exist" branch.
        topics = [{"id": "topic-old", "name": "Unrelated Archive"}]
        allowed = c._topic_creation_allowed(window, derived, topic_cands=[], text=text, topics=topics)

        self.assertNotIn(derived.strip().lower(), c.GENERIC_TOPIC_NAMES)
        self.assertNotEqual(derived.strip(), "General")
        self.assertTrue(allowed, msg=f"expected topic creation allowed; derived={derived!r}")

    def test_task_oriented_conversation_detects_task_intent(self):
        window = load_window("task_oriented_window.json")
        title = c._derive_task_title(window)
        self.assertIsNotNone(title)
        self.assertTrue(c._window_has_task_intent(window))

    def test_bundle_range_splits_on_new_user_request_after_assistant(self):
        convs = [
            {"id": "1", "type": "conversation", "agentId": "user", "content": "Explain SQLModel inserts."},
            {"id": "2", "type": "conversation", "agentId": "assistant", "content": "Here is how inserts work..."},
            {"id": "3", "type": "conversation", "agentId": "user", "content": "Now help with Docker networking."},
            {"id": "4", "type": "conversation", "agentId": "assistant", "content": "Docker networking basics..."},
        ]
        self.assertEqual(c._bundle_range(convs, 0), (0, 2))
        self.assertEqual(c._bundle_range(convs, 2), (2, 4))

    def test_bundle_range_keeps_multiple_user_turns_before_assistant(self):
        convs = [
            {"id": "1", "type": "conversation", "agentId": "user", "content": "I have two issues: A."},
            {"id": "2", "type": "conversation", "agentId": "user", "content": "Also B, same request."},
            {"id": "3", "type": "conversation", "agentId": "assistant", "content": "Got it, here's a plan..."},
            {"id": "4", "type": "conversation", "agentId": "user", "content": "Unrelated: new request C."},
        ]
        self.assertEqual(c._bundle_range(convs, 0), (0, 3))

    def test_bundle_range_backtracks_from_affirmation_to_prior_user_intent(self):
        convs = [
            {
                "id": "1",
                "type": "conversation",
                "agentId": "user",
                "content": "Fix the login redirect bug in NIMBUS.",
            },
            {"id": "2", "type": "conversation", "agentId": "assistant", "content": "Plan: reproduce, patch, test."},
            {"id": "3", "type": "conversation", "agentId": "user", "content": "Yes, do it."},
            {"id": "4", "type": "conversation", "agentId": "user", "content": "New topic: Qdrant indexing."},
        ]
        # Anchoring on "Yes, do it" should still pull the original user intent into the bundle.
        self.assertEqual(c._bundle_range(convs, 2), (0, 3))

    def test_bundle_range_backtracks_from_assistant_to_prior_user_turn(self):
        convs = [
            {"id": "1", "type": "conversation", "agentId": "user", "content": "Please implement retries."},
            {"id": "2", "type": "conversation", "agentId": "assistant", "content": "Plan: exponential backoff."},
        ]
        self.assertEqual(c._bundle_range(convs, 1), (0, 2))

    def test_bundle_range_allows_assistant_only_bundle_when_no_prior_user(self):
        convs = [
            {"id": "1", "type": "conversation", "agentId": "assistant", "content": "System note: doing maintenance."},
            {"id": "2", "type": "conversation", "agentId": "user", "content": "Now a real request."},
        ]
        self.assertEqual(c._bundle_range(convs, 0), (0, 1))


if __name__ == "__main__":
    unittest.main()
