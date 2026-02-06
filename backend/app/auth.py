from __future__ import annotations

import os
import secrets
import ipaddress
from fastapi import Header, HTTPException, Query, Request, status


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


def _request_host(request: Request) -> str:
    host = request.headers.get("host", "").strip()
    if not host:
        return ""
    return host.split(",")[0].strip().split(":")[0].strip()


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


def is_local_request(request: Request) -> bool:
    host = _request_host(request)
    if _is_loopback_address(host):
        return True
    return _is_loopback_address(_client_ip(request))


def ensure_read_access(request: Request, provided_token: str | None) -> None:
    """Allow local reads without token, but require token for non-localhost reads."""
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
    token: str | None = Query(default=None, alias="token"),
) -> None:
    _validate_token(x_clawboard_token or token)


def is_token_required() -> bool:
    # Token is always required for write operations.
    return True


def is_token_configured() -> bool:
    return _configured_token() is not None
