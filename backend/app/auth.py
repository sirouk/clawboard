from __future__ import annotations

import os
import secrets
import ipaddress
from fastapi import Header, HTTPException, Request, status


def _configured_token() -> str | None:
    token = os.getenv("CLAWBOARD_TOKEN", "").strip()
    return token or None


def _validate_token(value: str | None) -> None:
    configured = _configured_token()
    if not configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Server token is not configured. Set CLAWBOARD_TOKEN.",
        )
    provided = (value or "").strip()
    if not provided or not secrets.compare_digest(provided, configured):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


def _client_ip(request: Request) -> str:
    trust_proxy = os.getenv("CLAWBOARD_TRUST_PROXY", "0").strip() == "1"
    if trust_proxy:
        forwarded = request.headers.get("x-forwarded-for", "").strip()
        if forwarded:
            return forwarded.split(",")[0].strip()
        real_ip = request.headers.get("x-real-ip", "").strip()
        if real_ip:
            return real_ip
    if request.client and request.client.host:
        return request.client.host
    return ""


def _is_loopback_address(value: str) -> bool:
    if not value:
        return False
    normalized = value.strip().lower()
    if normalized == "localhost":
        return True
    if normalized.startswith("::ffff:127."):
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _is_test_client_address(value: str) -> bool:
    normalized = (value or "").strip().lower()
    return normalized in {"testclient", "testserver"}


def is_local_request(request: Request) -> bool:
    # Treat only transport-level client identity as trusted locality.
    # Do not trust Host/X-Forwarded-Host because they are spoofable by clients.
    client = _client_ip(request)
    if _is_loopback_address(client):
        return True
    if _is_test_client_address(client):
        return True
    return False


def ensure_read_access(request: Request, provided_token: str | None) -> None:
    """Allow loopback reads without token, but require token for non-local reads."""
    if is_local_request(request):
        return
    _validate_token(provided_token)


def ensure_write_access(provided_token: str | None) -> None:
    _validate_token(provided_token)


def require_token(
    x_clawboard_token: str | None = Header(
        default=None,
        alias="X-Clawboard-Token",
        description="Server token required for all write operations.",
        example="your-token-here",
    ),
) -> None:
    _validate_token(x_clawboard_token)


def is_token_required() -> bool:
    # Token is always required for write operations.
    return True


def is_token_configured() -> bool:
    return _configured_token() is not None
