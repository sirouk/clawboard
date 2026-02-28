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

    def test_gateway_cfg_003_device_auth_defaults_off(self):
        with patch.dict(
            os.environ,
            {
                "OPENCLAW_BASE_URL": "http://127.0.0.1:18789",
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
            },
            clear=True,
        ), patch.object(gateway_module, "_read_json_file") as read_json:
            cfg = gateway_module.load_openclaw_gateway_config()
        self.assertIsNone(cfg.identity)
        read_json.assert_not_called()

    def test_gateway_cfg_004_device_auth_can_be_enabled_explicitly(self):
        with patch.dict(
            os.environ,
            {
                "OPENCLAW_BASE_URL": "http://127.0.0.1:18789",
                "OPENCLAW_GATEWAY_TOKEN": "test-token",
                "OPENCLAW_GATEWAY_USE_DEVICE_AUTH": "1",
            },
            clear=True,
        ), patch.object(
            gateway_module,
            "_read_json_file",
            side_effect=[
                {
                    "deviceId": "device-1",
                    "publicKeyPem": "public-key",
                    "privateKeyPem": "private-key",
                },
                {
                    "version": 1,
                    "deviceId": "device-1",
                    "tokens": {"operator": {"token": "operator-token"}},
                },
            ],
        ):
            cfg = gateway_module.load_openclaw_gateway_config()
        self.assertIsNotNone(cfg.identity)
        assert cfg.identity is not None
        self.assertEqual(cfg.identity.device_id, "device-1")


if __name__ == "__main__":
    unittest.main()
