from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app import openclaw_gateway as gateway_module  # noqa: E402


class OpenClawGatewayConfigTests(unittest.TestCase):
    def test_gateway_cfg_001_host_header_defaults_to_none(self):
        with patch.dict(
            os.environ,
            {
                "OPENCLAW_BASE_URL": "http://host.docker.internal:18789",
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HOST_HEADER": "",
            },
            clear=False,
        ):
            cfg = gateway_module.load_openclaw_gateway_config()
        self.assertIsNone(cfg.host_header)

    def test_gateway_cfg_002_host_header_normalizes_ws_url_style_values(self):
        with patch.dict(
            os.environ,
            {
                "OPENCLAW_BASE_URL": "http://127.0.0.1:18789",
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_HOST_HEADER": "ws://example.internal:18789",
            },
            clear=False,
        ):
            cfg = gateway_module.load_openclaw_gateway_config()
        self.assertEqual(cfg.host_header, "example.internal:18789")


if __name__ == "__main__":
    unittest.main()
