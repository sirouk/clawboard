from __future__ import annotations

import types
import unittest
from unittest.mock import patch

from classifier import classifier as c


class SpaceScopedSessionTests(unittest.TestCase):
    def test_classify_session_scoped_sets_scope_context_and_resets(self):
        observed_scopes: list[tuple[str | None, tuple[str, ...] | None]] = []

        def _capture_scope(session_key: str):
            observed_scopes.append((session_key, c._SPACE_SCOPE_ALLOWED_IDS.get()))

        with (
            patch.object(c, "_resolve_allowed_space_ids_for_session", return_value=("space-alpha", "space-beta")),
            patch.object(c, "classify_session", side_effect=_capture_scope),
        ):
            c._classify_session_scoped("clawboard:topic:topic-123")

        self.assertEqual(len(observed_scopes), 1)
        self.assertEqual(observed_scopes[0][0], "clawboard:topic:topic-123")
        self.assertEqual(observed_scopes[0][1], ("space-alpha", "space-beta"))
        self.assertIsNone(c._SPACE_SCOPE_ALLOWED_IDS.get())

    def test_classify_session_scoped_without_scope_calls_plain_classify(self):
        with (
            patch.object(c, "_resolve_allowed_space_ids_for_session", return_value=None),
            patch.object(c, "classify_session") as classify_mock,
        ):
            c._classify_session_scoped("channel:plain-session")

        classify_mock.assert_called_once_with("channel:plain-session")
        self.assertIsNone(c._SPACE_SCOPE_ALLOWED_IDS.get())

    def test_space_scope_params_appends_allowed_space_ids(self):
        token = c._SPACE_SCOPE_ALLOWED_IDS.set(("space-one", "space-two"))
        try:
            payload = c._space_scope_params({"limit": 25, "offset": 0})
        finally:
            c._SPACE_SCOPE_ALLOWED_IDS.reset(token)

        self.assertEqual(payload.get("limit"), 25)
        self.assertEqual(payload.get("offset"), 0)
        self.assertEqual(payload.get("allowedSpaceIds"), "space-one,space-two")


class SpaceScopedApiForwardingTests(unittest.TestCase):
    def test_list_logs_forwards_allowed_space_ids(self):
        captured: dict[str, object] = {}

        class _FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return []

        def _fake_get(url, params=None, headers=None, timeout=None):
            captured["url"] = url
            captured["params"] = params or {}
            captured["headers"] = headers or {}
            captured["timeout"] = timeout
            return _FakeResponse()

        token = c._SPACE_SCOPE_ALLOWED_IDS.set(("space-a", "space-b", "space-c"))
        try:
            fake_requests = types.SimpleNamespace(get=_fake_get)
            with patch.object(c, "requests", fake_requests):
                rows = c.list_logs({"sessionKey": "channel:test", "limit": 10, "offset": 0})
        finally:
            c._SPACE_SCOPE_ALLOWED_IDS.reset(token)

        self.assertEqual(rows, [])
        params = captured.get("params") or {}
        self.assertEqual(params.get("sessionKey"), "channel:test")
        self.assertEqual(params.get("allowedSpaceIds"), "space-a,space-b,space-c")


if __name__ == "__main__":
    unittest.main()
