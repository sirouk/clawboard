import unittest

from classifier import classifier as c


class StrictJsonTests(unittest.TestCase):
    def test_parse_strict_json_accepts_valid_json(self):
        self.assertEqual(c._parse_strict_json('{"a": 1}'), {"a": 1})

    def test_parse_strict_json_rejects_non_json_wrappers(self):
        with self.assertRaises(c._StrictJsonError):
            c._parse_strict_json("```json\n{\"a\":1}\n```")
        with self.assertRaises(c._StrictJsonError):
            c._parse_strict_json("note: {\"a\":1}")

    def test_validate_classifier_result_happy_path(self):
        pending = ["m1", "m2"]
        raw = {
            "topic": {"id": None, "name": "Docker Networking", "create": True},
            "task": None,
            "summaries": [
                {"id": "m1", "summary": "Investigate Docker port binding"},
                {"id": "m2", "summary": "Fix compose down/up ordering"},
            ],
        }
        out = c._validate_classifier_result(raw, pending)
        self.assertEqual(out["topic"]["name"], "Docker Networking")
        self.assertIsNone(out["task"])
        self.assertEqual([row["id"] for row in out["summaries"]], pending)

    def test_validate_classifier_result_rejects_missing_summary(self):
        pending = ["m1", "m2"]
        raw = {
            "topic": {"id": None, "name": "Docker", "create": True},
            "task": None,
            "summaries": [{"id": "m1", "summary": "One"}],
        }
        with self.assertRaises(c._StrictJsonError):
            c._validate_classifier_result(raw, pending)

    def test_validate_classifier_result_rejects_unknown_summary_id(self):
        pending = ["m1"]
        raw = {
            "topic": {"id": None, "name": "Docker", "create": True},
            "task": None,
            "summaries": [{"id": "m2", "summary": "Wrong id"}],
        }
        with self.assertRaises(c._StrictJsonError):
            c._validate_classifier_result(raw, pending)

    def test_validate_creation_gate_result_normalizes(self):
        raw = {"createTopic": False, "topicId": " topic-1 ", "createTask": True, "taskId": None}
        out = c._validate_creation_gate_result(raw)
        self.assertEqual(out, {"createTopic": False, "topicId": "topic-1", "createTask": True, "taskId": None})

    def test_validate_summary_repair_result_requires_all_ids(self):
        pending = ["m1", "m2"]
        raw = {"summaries": [{"id": "m1", "summary": "One"}]}
        with self.assertRaises(c._StrictJsonError):
            c._validate_summary_repair_result(raw, pending)

    def test_validate_summary_repair_result_happy_path(self):
        pending = ["m1", "m2"]
        raw = {
            "summaries": [
                {"id": "m1", "summary": "Investigate port binding"},
                {"id": "m2", "summary": "Restart gateway after purge"},
            ]
        }
        out = c._validate_summary_repair_result(raw, pending)
        self.assertEqual(set(out.keys()), {"m1", "m2"})
        self.assertTrue(all(isinstance(v, str) and v.strip() for v in out.values()))


if __name__ == "__main__":
    unittest.main()

