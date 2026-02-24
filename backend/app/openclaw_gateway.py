from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import websockets


@dataclass(frozen=True)
class OpenClawDeviceAuth:
    device_id: str
    public_key: str
    private_key: str


@dataclass
class OpenClawGatewayConfig:
    ws_url: str
    token: str
    client_id: str
    client_version: str
    client_mode: str
    client_platform: str
    default_scopes: list[str]
    host_header: str | None
    identity: OpenClawDeviceAuth | None


def _derive_ws_url(http_base: str) -> str:
    base = (http_base or "").strip().rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base.removeprefix("https://")
    if base.startswith("http://"):
        return "ws://" + base.removeprefix("http://")
    if base.startswith("ws://") or base.startswith("wss://"):
        return base
    return "ws://" + base


def _normalize_scopes(raw_scopes: str) -> list[str]:
    values: list[str] = []
    for scope in (raw_scopes or "").split(","):
        value = scope.strip()
        if value:
            values.append(value)
    return values


def _dedupe_scopes(values: list[str]) -> list[str]:
    seen = set[str]()
    unique: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            unique.append(value)
    return unique


def _env_float(name: str, default: float, *, minimum: float, maximum: float) -> float:
    raw = str(os.getenv(name) or "").strip()
    if raw:
        try:
            value = float(raw)
        except Exception:
            value = default
    else:
        value = default
    return max(minimum, min(maximum, value))


def _gateway_ws_connect_timeout_seconds(request_timeout_seconds: float | None) -> float:
    default = 30.0
    if request_timeout_seconds is not None and request_timeout_seconds > 0:
        default = min(default, request_timeout_seconds)
    return _env_float("OPENCLAW_GATEWAY_WS_CONNECT_TIMEOUT_SECONDS", default, minimum=2.0, maximum=300.0)


def _gateway_ws_recv_timeout_seconds(request_timeout_seconds: float | None) -> float:
    default = 45.0
    if request_timeout_seconds is not None and request_timeout_seconds > 0:
        default = min(default, request_timeout_seconds)
    return _env_float("OPENCLAW_GATEWAY_WS_RECV_TIMEOUT_SECONDS", default, minimum=2.0, maximum=300.0)


def _gateway_ws_ping_interval_seconds() -> float | None:
    value = _env_float("OPENCLAW_GATEWAY_WS_PING_INTERVAL_SECONDS", 20.0, minimum=0.0, maximum=300.0)
    if value <= 0:
        return None
    return value


def _gateway_ws_ping_timeout_seconds() -> float | None:
    value = _env_float("OPENCLAW_GATEWAY_WS_PING_TIMEOUT_SECONDS", 20.0, minimum=0.0, maximum=300.0)
    if value <= 0:
        return None
    return value


def _gateway_ws_close_timeout_seconds() -> float:
    return _env_float("OPENCLAW_GATEWAY_WS_CLOSE_TIMEOUT_SECONDS", 8.0, minimum=1.0, maximum=120.0)


async def _recv_gateway_json(
    ws: websockets.WebSocketClientProtocol,
    *,
    timeout_seconds: float | None,
    context: str,
) -> dict[str, Any]:
    try:
        if timeout_seconds is not None and timeout_seconds > 0:
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout_seconds)
        else:
            raw = await ws.recv()
    except asyncio.TimeoutError as exc:
        raise RuntimeError(f"gateway timeout while waiting for {context}") from exc
    except Exception as exc:
        raise RuntimeError(f"gateway receive failed while waiting for {context}: {exc}") from exc

    try:
        payload = json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"invalid gateway message while waiting for {context}: {raw!r}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"invalid gateway message while waiting for {context}: {payload!r}")
    return payload


def _read_json_file(path: str) -> dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def _base64_url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _load_device_auth(*, enabled_override: bool | None = None) -> OpenClawDeviceAuth | None:
    enabled = enabled_override
    if enabled is None:
        enabled = os.getenv("OPENCLAW_GATEWAY_USE_DEVICE_AUTH", "1").strip().lower() not in {"0", "false", "no", "off"}
    if not enabled:
        return None

    identity_dir = (os.getenv("OPENCLAW_GATEWAY_IDENTITY_DIR") or os.path.expanduser("~")).strip()
    if not identity_dir:
        return None
    root = Path(identity_dir).expanduser()

    device_path = Path(
        os.getenv("OPENCLAW_DEVICE_PATH") or str(root / "identity" / "device.json")
    ).expanduser()
    auth_path = Path(
        os.getenv("OPENCLAW_DEVICE_AUTH_PATH") or str(root / "identity" / "device-auth.json")
    ).expanduser()

    device_payload = _read_json_file(str(device_path))
    auth_payload = _read_json_file(str(auth_path))
    if not isinstance(device_payload, dict) or not isinstance(auth_payload, dict):
        return None

    if auth_payload.get("version") != 1:
        return None
    device_id = str(device_payload.get("deviceId") or "").strip()
    public_key = str(device_payload.get("publicKeyPem") or device_payload.get("publicKey") or "").strip()
    private_key = str(device_payload.get("privateKeyPem") or device_payload.get("privateKey") or "").strip()
    if not (device_id and public_key and private_key):
        return None
    if auth_payload.get("deviceId") and str(auth_payload.get("deviceId")).strip() != device_id:
        return None

    operator_token = auth_payload.get("tokens", {}).get("operator") if isinstance(auth_payload.get("tokens"), dict) else None
    if not (isinstance(operator_token, dict) and str(operator_token.get("token") or "").strip()):
        return None

    return OpenClawDeviceAuth(device_id=device_id, public_key=public_key, private_key=private_key)


def _resolve_connect_nonce(message: dict[str, Any]) -> str:
    if not isinstance(message, dict):
        return ""
    if message.get("type") != "event" or message.get("event") != "connect.challenge":
        return ""
    payload = message.get("payload")
    if isinstance(payload, dict):
        candidate = str(payload.get("nonce") or "").strip()
        if candidate:
            return candidate
    candidate = str(message.get("nonce") or "").strip()
    return candidate


def _normalize_device_public_key(value: str) -> str:
    value = (value or "").strip()
    return value


def _sign_device_payload(private_key_pem: str, payload: str) -> str:
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".pem", delete=False)
    payload_tmp = tempfile.NamedTemporaryFile(mode="wb", suffix=".bin", delete=False)
    key_path = Path(tmp.name)
    payload_path = Path(payload_tmp.name)
    process: subprocess.CompletedProcess[bytes]
    try:
        tmp.write(private_key_pem)
        tmp.flush()
        tmp.close()
        payload_tmp.write(payload.encode("utf-8"))
        payload_tmp.flush()
        payload_tmp.close()

        # Use file-based input for signing. On newer OpenSSL builds, streaming stdin with -rawin
        # can fail with ED25519 keys; `-in` is stable across environments.
        command = ["openssl", "pkeyutl", "-sign", "-inkey", str(key_path), "-in", str(payload_path), "-rawin"]
        process = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except Exception as exc:
        raise RuntimeError(f"openclaw signing failed: {exc}") from exc
    finally:
        try:
            key_path.unlink()
        except Exception:
            pass
        try:
            payload_path.unlink()
        except Exception:
            pass

    if process.returncode != 0:
        stderr_text = process.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"openclaw signing failed: {stderr_text or 'openssl sign failed'}")
    return _base64_url(process.stdout)


def _build_device_auth_payload(
    *,
    identity: OpenClawDeviceAuth,
    client_id: str,
    client_mode: str,
    role: str,
    scopes: list[str],
    signed_at_ms: int,
    token: str,
    nonce: str | None,
) -> dict[str, Any]:
    payload_parts = [
        "v2" if nonce else "v1",
        identity.device_id,
        client_id,
        client_mode,
        role,
        ",".join(scopes),
        str(signed_at_ms),
        token,
    ]
    if nonce:
        payload_parts.append(nonce)
    payload = "|".join(payload_parts)
    return {
        "id": identity.device_id,
        "publicKey": _normalize_device_public_key(identity.public_key),
        "signature": _sign_device_payload(identity.private_key, payload),
        "signedAt": signed_at_ms,
        "nonce": nonce,
    }


def load_openclaw_gateway_config(
    *,
    token_override: str | None = None,
    use_device_auth_override: bool | None = None,
) -> OpenClawGatewayConfig:
    http_base = os.getenv("OPENCLAW_BASE_URL", "http://127.0.0.1:18789").strip()
    if token_override is not None:
        token = str(token_override).strip()
    else:
        token = (os.getenv("OPENCLAW_GATEWAY_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("OPENCLAW_GATEWAY_TOKEN is required")

    ws_url = os.getenv("OPENCLAW_WS_URL", "").strip() or _derive_ws_url(http_base)
    scopes = _dedupe_scopes(_normalize_scopes(os.getenv("OPENCLAW_GATEWAY_SCOPES", "operator.read,operator.write")))
    if not scopes:
        scopes = ["operator.read", "operator.write"]
    host_header_raw = str(os.getenv("OPENCLAW_GATEWAY_HOST_HEADER") or "").strip()
    host_header = host_header_raw or None
    if host_header is not None:
        # Allow values like "ws://host:port" in env without breaking Host header.
        try:
            parsed = urlparse(host_header if "://" in host_header else f"ws://{host_header}")
            if parsed.hostname:
                if parsed.port and parsed.port not in {80, 443}:
                    host_header = f"{parsed.hostname}:{parsed.port}"
                else:
                    host_header = str(parsed.hostname)
        except Exception:
            pass

    return OpenClawGatewayConfig(
        ws_url=ws_url,
        token=token,
        client_id=(os.getenv("OPENCLAW_GATEWAY_CLIENT_ID") or "gateway-client").strip() or "gateway-client",
        client_version=(os.getenv("OPENCLAW_GATEWAY_CLIENT_VERSION") or "0.1.0").strip() or "0.1.0",
        client_mode=(os.getenv("OPENCLAW_GATEWAY_CLIENT_MODE") or "backend").strip() or "backend",
        client_platform=(os.getenv("OPENCLAW_GATEWAY_CLIENT_PLATFORM") or "server").strip() or "server",
        default_scopes=scopes,
        host_header=host_header,
        identity=_load_device_auth(enabled_override=use_device_auth_override),
    )


async def gateway_rpc(
    method: str,
    params: Optional[Dict[str, Any]] = None,
    *,
    scopes: Optional[list[str]] = None,
    token_override: str | None = None,
    use_device_auth_override: bool | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    request_timeout_seconds: float | None = None
    if timeout_seconds is not None:
        try:
            parsed = float(timeout_seconds)
        except Exception:
            parsed = 0.0
        if parsed > 0:
            request_timeout_seconds = parsed

    async def _call_once() -> Any:
        cfg = load_openclaw_gateway_config(
            token_override=token_override,
            use_device_auth_override=use_device_auth_override,
        )

        effective_scopes = _dedupe_scopes(list(scopes) if scopes is not None else list(cfg.default_scopes))
        if not effective_scopes:
            effective_scopes = ["operator.read", "operator.write"]

        headers = {"Host": cfg.host_header} if cfg.host_header else None
        open_timeout = _gateway_ws_connect_timeout_seconds(request_timeout_seconds)
        recv_timeout = _gateway_ws_recv_timeout_seconds(request_timeout_seconds)

        async with websockets.connect(
            cfg.ws_url,
            max_size=8_000_000,
            extra_headers=headers,
            open_timeout=open_timeout,
            ping_interval=_gateway_ws_ping_interval_seconds(),
            ping_timeout=_gateway_ws_ping_timeout_seconds(),
            close_timeout=_gateway_ws_close_timeout_seconds(),
        ) as ws:
            first = await _recv_gateway_json(ws, timeout_seconds=recv_timeout, context="connect.challenge")
            if first.get("type") != "event" or first.get("event") != "connect.challenge":
                raise RuntimeError(f"expected connect.challenge, got: {first}")

            challenge_nonce = _resolve_connect_nonce(first)

            device = None
            if cfg.identity is not None:
                try:
                    device = _build_device_auth_payload(
                        identity=cfg.identity,
                        client_id=cfg.client_id,
                        client_mode=cfg.client_mode,
                        role="operator",
                        scopes=effective_scopes,
                        signed_at_ms=int(time.time() * 1000),
                        token=cfg.token,
                        nonce=challenge_nonce or None,
                    )
                except Exception:
                    device = None

            connect_id = str(uuid.uuid4())
            connect_params = {
                "type": "req",
                "id": connect_id,
                "method": "connect",
                "params": {
                    "minProtocol": 3,
                    "maxProtocol": 3,
                    "client": {
                        "id": cfg.client_id,
                        "version": cfg.client_version,
                        "platform": cfg.client_platform,
                        "mode": cfg.client_mode,
                    },
                    "role": "operator",
                    "scopes": effective_scopes,
                    "caps": [],
                    "commands": [],
                    "permissions": {},
                    "auth": {"token": cfg.token},
                    "locale": "en-US",
                    "userAgent": "clawboard/0.1.0",
                },
            }
            if device is not None:
                connect_params["params"]["device"] = device
            await ws.send(json.dumps(connect_params))

            while True:
                connect_response = await _recv_gateway_json(ws, timeout_seconds=recv_timeout, context="connect response")
                if connect_response.get("type") != "res" or connect_response.get("id") != connect_id:
                    continue
                if not connect_response.get("ok"):
                    raise RuntimeError(f"gateway connect failed: {connect_response.get('error')}")
                break

            req_id = str(uuid.uuid4())
            await ws.send(
                json.dumps(
                    {
                        "type": "req",
                        "id": req_id,
                        "method": method,
                        "params": params or {},
                    }
                )
            )

            while True:
                response = await _recv_gateway_json(ws, timeout_seconds=recv_timeout, context=f"{method} response")
                if response.get("type") != "res" or response.get("id") != req_id:
                    continue
                if not response.get("ok"):
                    error = response.get("error")
                    if isinstance(error, dict):
                        message = error.get("message") or "Gateway request failed"
                    else:
                        message = str(error or "Gateway request failed")
                    raise RuntimeError(message)
                return response.get("payload")

    if request_timeout_seconds is not None:
        return await asyncio.wait_for(_call_once(), timeout=request_timeout_seconds)
    return await _call_once()
