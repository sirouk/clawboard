from __future__ import annotations

import os
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-sanitize-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from app.main import _sanitize_log_text  # noqa: E402

    _TESTS_AVAILABLE = True
except Exception:
    _TESTS_AVAILABLE = False


@unittest.skipUnless(_TESTS_AVAILABLE, "FastAPI/SQLModel test dependencies are not installed.")
class SanitizeLogTextTests(unittest.TestCase):
    def test_strips_reply_directive_tags(self):
        raw = "[[reply_to_current]] test [[ reply_to: abc-123 ]] done"
        self.assertEqual(_sanitize_log_text(raw), "test done")

    def test_strips_single_bracket_reply_directive_tags(self):
        raw = "[reply_to_current] test [ reply_to: abc-123 ] done"
        self.assertEqual(_sanitize_log_text(raw), "test done")

    def test_preserves_non_directive_double_brackets(self):
        raw = "[[not_a_directive]] keep this"
        self.assertEqual(_sanitize_log_text(raw), "[[not_a_directive]] keep this")


if __name__ == "__main__":
    unittest.main()
