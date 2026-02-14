from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional

import websockets


@dataclass
class OpenClawGatewayConfig:
    ws_url: str
    token: str


def _derive_ws_url(http_base: str) -> str:
    base = (http_base or "").strip().rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base.removeprefix("https://")
    if base.startswith("http://"):
        return "ws://" + base.removeprefix("http://")
    if base.startswith("ws://") or base.startswith("wss://"):
        return base
    # Best effort.
    return "ws://" + base


def load_openclaw_gateway_config() -> OpenClawGatewayConfig:
    http_base = os.getenv("OPENCLAW_BASE_URL", "http://127.0.0.1:18789").strip()
    token = (os.getenv("OPENCLAW_GATEWAY_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("OPENCLAW_GATEWAY_TOKEN is required")
    ws_url = os.getenv("OPENCLAW_WS_URL", "").strip() or _derive_ws_url(http_base)
    return OpenClawGatewayConfig(ws_url=ws_url, token=token)


async def gateway_rpc(
    method: str,
    params: Optional[Dict[str, Any]] = None,
    *,
    scopes: Optional[list[str]] = None,
) -> Any:
    cfg = load_openclaw_gateway_config()

    async with websockets.connect(cfg.ws_url, max_size=8_000_000) as ws:
        # 1) Wait for connect.challenge event.
        first = await ws.recv()
        try:
            msg = json.loads(first)
        except Exception as exc:  # pragma: no cover
            raise RuntimeError(f"invalid gateway message: {first!r}") from exc
        if msg.get("type") != "event" or msg.get("event") != "connect.challenge":
            raise RuntimeError(f"expected connect.challenge, got: {msg}")

        # 2) Send connect req.
        connect_id = str(uuid.uuid4())
        connect_req = {
            "type": "req",
            "id": connect_id,
            "method": "connect",
            "params": {
                "minProtocol": 3,
                "maxProtocol": 3,
                "client": {
                    "id": "clawboard",
                    "version": "0.0.0",
                    "platform": "server",
                    "mode": "operator",
                },
                "role": "operator",
                "scopes": scopes or ["operator.read"],
                "caps": [],
                "commands": [],
                "permissions": {},
                "auth": {"token": cfg.token},
                "locale": "en-US",
                "userAgent": "clawboard/0.0.0",
            },
        }
        await ws.send(json.dumps(connect_req))

        # 3) Await connect response.
        while True:
            raw = await ws.recv()
            res = json.loads(raw)
            if res.get("type") != "res" or res.get("id") != connect_id:
                continue
            if not res.get("ok"):
                raise RuntimeError(f"gateway connect failed: {res.get('error')}")
            break

        # 4) Send RPC request.
        req_id = str(uuid.uuid4())
        req = {
            "type": "req",
            "id": req_id,
            "method": method,
            "params": params or {},
        }
        await ws.send(json.dumps(req))

        # 5) Await response.
        while True:
            raw = await ws.recv()
            res = json.loads(raw)
            if res.get("type") != "res" or res.get("id") != req_id:
                continue
            if not res.get("ok"):
                raise RuntimeError(str(res.get("error") or "Gateway request failed"))
            return res.get("payload")
