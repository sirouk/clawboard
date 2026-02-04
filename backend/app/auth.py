from __future__ import annotations

import os
from fastapi import Header, HTTPException, status


def require_token(
    x_clawboard_token: str | None = Header(
        default=None,
        alias="X-Clawboard-Token",
        description="Write token (required when CLAWBOARD_TOKEN is set).",
        example="your-token-here",
    )
) -> None:
    token = os.getenv("CLAWBOARD_TOKEN")
    if not token:
        return
    if x_clawboard_token != token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


def is_token_required() -> bool:
    return bool(os.getenv("CLAWBOARD_TOKEN"))
