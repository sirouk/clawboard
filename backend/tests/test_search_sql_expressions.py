from __future__ import annotations

import os
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TMP_DIR = tempfile.mkdtemp(prefix="clawboard-search-sql-tests-")
os.environ["CLAWBOARD_DB_URL"] = f"sqlite:///{os.path.join(TMP_DIR, 'clawboard-test.db')}"
os.environ["CLAWBOARD_TOKEN"] = "test-token"

try:
    from sqlalchemy import select, func
    from sqlalchemy.dialects import postgresql

    from app import main as main_module  # noqa: E402
    from app.models import LogEntry  # noqa: E402

    _API_TESTS_AVAILABLE = True
except Exception:
    _API_TESTS_AVAILABLE = False


@unittest.skipUnless(_API_TESTS_AVAILABLE, "SQLAlchemy/FastAPI test dependencies are not installed.")
class SearchSqlExpressionTests(unittest.TestCase):
    def test_postgres_lexical_rescue_expression_matches_indexable_shape(self):
        expr = main_module._postgres_logentry_search_vector_expr()
        stmt = select(LogEntry.id).where(expr.op("@@")(func.plainto_tsquery("simple", "chelsea")))
        sql = str(stmt.compile(dialect=postgresql.dialect())).lower()
        self.assertIn("|| ' ' ||", sql)
        self.assertNotIn("concat(", sql)


if __name__ == "__main__":
    unittest.main()
