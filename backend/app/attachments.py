from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, List
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .auth import require_token
from .db import get_session
from .models import Attachment
from .schemas import AttachmentOut

__all__ = [
    "ATTACHMENTS_DIR",
    "ATTACHMENT_MAX_FILES",
    "ATTACHMENT_MAX_BYTES",
    "ATTACHMENT_ALLOWED_MIME_TYPES",
    "ATTACHMENT_IMAGE_MIME_TYPES",
    "ATTACHMENT_TEXT_MIME_TYPES",
    "OPENCLAW_EXTRACTED_TEXT_LIMIT",
    "OPENCLAW_RESPONSES_MAX_BODY_BYTES",
    "OPENCLAW_RESPONSES_INPUT_FILE_MAX_BYTES",
    "OPENCLAW_RESPONSES_INPUT_IMAGE_MAX_BYTES",
    "OPENCLAW_RESPONSES_FILE_MIME_TYPES",
    "_sanitize_attachment_filename",
    "_normalize_mime_type",
    "_infer_mime_type_from_filename",
    "_decode_text_attachment",
    "_extract_pdf_text",
    "_verify_attachment_magic",
    "_validate_attachment_mime_type",
    "_attachments_root",
    "enqueue_reindex_request",
    "register_attachment_routes",
]

# ---------------------------------------------------------------------------
# Helpers (duplicated locally to avoid circular imports from main)
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _create_id(prefix: str) -> str:
    return f"{prefix}-{uuid4()}"


def _clip(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "\u2026"


# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

ATTACHMENTS_DIR = os.getenv("CLAWBOARD_ATTACHMENTS_DIR", "./data/attachments").strip() or "./data/attachments"
ATTACHMENT_MAX_FILES = int(os.getenv("CLAWBOARD_ATTACHMENT_MAX_FILES", "8") or "8")
ATTACHMENT_MAX_BYTES = int(os.getenv("CLAWBOARD_ATTACHMENT_MAX_BYTES", str(10 * 1024 * 1024)) or str(10 * 1024 * 1024))
ATTACHMENT_ALLOWED_MIME_TYPES = {
    mt.strip().lower()
    for mt in (
        os.getenv(
            "CLAWBOARD_ATTACHMENT_ALLOWED_MIME_TYPES",
            ",".join(
                [
                    "image/png",
                    "image/jpeg",
                    "image/gif",
                    "image/webp",
                    "application/pdf",
                    "text/plain",
                    "text/markdown",
                    "application/json",
                    "text/csv",
                    "audio/mpeg",
                    "audio/wav",
                    "audio/x-wav",
                    "audio/mp4",
                    "audio/webm",
                    "audio/ogg",
                ]
            ),
        )
        or ""
    ).split(",")
    if mt.strip()
}
ATTACHMENT_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
ATTACHMENT_TEXT_MIME_TYPES = {"text/plain", "text/markdown", "text/csv", "application/json"}
OPENCLAW_EXTRACTED_TEXT_LIMIT = int(os.getenv("OPENCLAW_EXTRACTED_TEXT_LIMIT", "15000") or "15000")
OPENCLAW_RESPONSES_MAX_BODY_BYTES = int(
    os.getenv("OPENCLAW_RESPONSES_MAX_BODY_BYTES", str(20 * 1024 * 1024)) or str(20 * 1024 * 1024)
)
OPENCLAW_RESPONSES_INPUT_FILE_MAX_BYTES = int(
    os.getenv("OPENCLAW_RESPONSES_INPUT_FILE_MAX_BYTES", str(5 * 1024 * 1024)) or str(5 * 1024 * 1024)
)
OPENCLAW_RESPONSES_INPUT_IMAGE_MAX_BYTES = int(
    os.getenv("OPENCLAW_RESPONSES_INPUT_IMAGE_MAX_BYTES", str(10 * 1024 * 1024)) or str(10 * 1024 * 1024)
)
OPENCLAW_RESPONSES_FILE_MIME_TYPES = {
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/pdf",
}

REINDEX_QUEUE_PATH = os.getenv("CLAWBOARD_REINDEX_QUEUE_PATH", "./data/reindex-queue.jsonl")

# ---------------------------------------------------------------------------
# Attachment processing functions
# ---------------------------------------------------------------------------


def _sanitize_attachment_filename(name: str) -> str:
    # Prevent path traversal + keep filenames readable.
    text = (name or "").replace("\\", "/").split("/")[-1].strip()
    text = re.sub(r"[\x00-\x1f\x7f]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return "attachment"
    if len(text) > 180:
        root, dot, ext = text.rpartition(".")
        if dot and ext and len(ext) <= 12:
            root = root[: 180 - (len(ext) + 1)].rstrip()
            text = f"{root}.{ext}"
        else:
            text = text[:180].rstrip()
    return text


def _normalize_mime_type(value: str | None) -> str:
    raw = (value or "").strip().lower()
    if raw == "image/jpg":
        return "image/jpeg"
    return raw


def _infer_mime_type_from_filename(filename: str) -> str:
    name = (filename or "").strip().lower()
    _, dot, ext = name.rpartition(".")
    if not dot or not ext:
        return ""
    ext = f".{ext}"
    mapping = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".json": "application/json",
        ".csv": "text/csv",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".webm": "audio/webm",
        ".ogg": "audio/ogg",
    }
    return mapping.get(ext, "")


def _decode_text_attachment(data: bytes, *, limit: int = OPENCLAW_EXTRACTED_TEXT_LIMIT) -> str:
    if not data:
        return ""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("utf-8", errors="replace")
    return _clip(text.strip(), limit)


def _extract_pdf_text(data: bytes, *, limit: int = OPENCLAW_EXTRACTED_TEXT_LIMIT) -> str:
    """Best-effort PDF text extraction. Returns empty string if unavailable/failed."""
    if not data:
        return ""
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception:
        return ""
    try:
        reader = PdfReader(BytesIO(data))
        parts: list[str] = []
        used = 0
        for page in reader.pages:
            if used >= limit:
                break
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            text = text.strip()
            if not text:
                continue
            remaining = limit - used
            if remaining <= 0:
                break
            if len(text) > remaining:
                text = text[:remaining]
            parts.append(text)
            used += len(text)
        return _clip("\n\n".join(parts).strip(), limit)
    except Exception:
        return ""


def _verify_attachment_magic(path: Path, mime_type: str, filename: str) -> None:
    """Best-effort content sniffing to catch obvious MIME spoofing."""
    mt = _normalize_mime_type(mime_type)
    try:
        head = path.read_bytes()[:64]
    except Exception:
        return

    if mt == "application/pdf":
        if not head.startswith(b"%PDF-"):
            raise HTTPException(status_code=400, detail=f"Attachment is not a valid PDF: {filename}.")
        return

    if mt == "image/png":
        if not head.startswith(b"\x89PNG\r\n\x1a\n"):
            raise HTTPException(status_code=400, detail=f"Attachment is not a valid PNG: {filename}.")
        return

    if mt == "image/jpeg":
        if not head.startswith(b"\xff\xd8\xff"):
            raise HTTPException(status_code=400, detail=f"Attachment is not a valid JPEG: {filename}.")
        return

    if mt == "image/gif":
        if not (head.startswith(b"GIF87a") or head.startswith(b"GIF89a")):
            raise HTTPException(status_code=400, detail=f"Attachment is not a valid GIF: {filename}.")
        return

    if mt == "image/webp":
        if not (head.startswith(b"RIFF") and len(head) >= 12 and head[8:12] == b"WEBP"):
            raise HTTPException(status_code=400, detail=f"Attachment is not a valid WebP: {filename}.")
        return

    if mt.startswith("text/") or mt == "application/json":
        # Keep this permissive: allow UTF-8 text and reject obvious binary blobs.
        if b"\x00" in head:
            raise HTTPException(status_code=400, detail=f"Attachment appears to be binary: {filename}.")
        return


def _validate_attachment_mime_type(mime_type: str) -> None:
    if not mime_type:
        raise HTTPException(status_code=400, detail="Attachment MIME type missing.")
    if mime_type not in ATTACHMENT_ALLOWED_MIME_TYPES:
        allowed = ", ".join(sorted(ATTACHMENT_ALLOWED_MIME_TYPES))
        raise HTTPException(status_code=400, detail=f"Attachment type not allowed: {mime_type}. Allowed: {allowed}")


def _attachments_root() -> Path:
    root = Path(ATTACHMENTS_DIR).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return root


def enqueue_reindex_request(payload: dict) -> None:
    try:
        queue_path = os.path.abspath(REINDEX_QUEUE_PATH)
        queue_dir = os.path.dirname(queue_path)
        if queue_dir:
            os.makedirs(queue_dir, exist_ok=True)
        with open(queue_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({**payload, "requestedAt": _now_iso()}) + "\n")
    except Exception:
        # Non-fatal: classifier can still reseed embeddings during normal runs.
        pass


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------


def register_attachment_routes(app: FastAPI) -> None:
    """Register all attachment-related HTTP routes on the given FastAPI app."""

    @app.get("/api/attachments/policy", tags=["attachments"])
    def get_attachment_policy():
        """Return attachment allowlist + limits so clients can validate before upload."""
        return {
            "allowedMimeTypes": sorted(ATTACHMENT_ALLOWED_MIME_TYPES),
            "maxFiles": ATTACHMENT_MAX_FILES,
            "maxBytes": ATTACHMENT_MAX_BYTES,
        }

    @app.post(
        "/api/attachments",
        dependencies=[Depends(require_token)],
        response_model=List[AttachmentOut],
        tags=["attachments"],
    )
    async def upload_attachments(files: List[UploadFile] = File(..., description="Files to attach (multipart).")):
        if not files:
            raise HTTPException(status_code=400, detail="No files provided.")
        if len(files) > ATTACHMENT_MAX_FILES:
            raise HTTPException(status_code=400, detail=f"Too many files. Max is {ATTACHMENT_MAX_FILES}.")

        root = _attachments_root()
        tmp_dir = root / ".tmp" / _create_id("upload")
        tmp_dir.mkdir(parents=True, exist_ok=True)

        staged: list[dict[str, Any]] = []
        moved: list[Path] = []
        try:
            # Stage all files first; if any fails validation we do not persist partial uploads.
            for upload in files:
                filename = _sanitize_attachment_filename(upload.filename or "")
                mime_type = _normalize_mime_type(getattr(upload, "content_type", None))
                if not mime_type or mime_type == "application/octet-stream":
                    mime_type = _infer_mime_type_from_filename(filename)
                _validate_attachment_mime_type(mime_type)

                attachment_id = _create_id("att")
                tmp_path = tmp_dir / attachment_id
                sha = hashlib.sha256()
                size = 0

                try:
                    with tmp_path.open("wb") as out:
                        while True:
                            chunk = await upload.read(1024 * 256)
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > ATTACHMENT_MAX_BYTES:
                                raise HTTPException(
                                    status_code=413,
                                    detail=f"Attachment too large: {filename}. Max is {ATTACHMENT_MAX_BYTES} bytes.",
                                )
                            sha.update(chunk)
                            out.write(chunk)
                finally:
                    try:
                        await upload.close()
                    except Exception:
                        pass

                if size <= 0:
                    raise HTTPException(status_code=400, detail=f"Attachment was empty: {filename}.")

                _verify_attachment_magic(tmp_path, mime_type, filename)

                staged.append(
                    {
                        "id": attachment_id,
                        "fileName": filename,
                        "mimeType": mime_type,
                        "sizeBytes": size,
                        "sha256": sha.hexdigest(),
                        "tmpPath": tmp_path,
                    }
                )

            stored_at = _now_iso()
            persisted: list[Attachment] = []
            with get_session() as session:
                try:
                    for item in staged:
                        final_path = root / item["id"]
                        # Atomic move into the stable path.
                        os.replace(str(item["tmpPath"]), str(final_path))
                        moved.append(final_path)

                        row = Attachment(
                            id=item["id"],
                            logId=None,
                            fileName=item["fileName"],
                            mimeType=item["mimeType"],
                            sizeBytes=item["sizeBytes"],
                            sha256=item["sha256"],
                            storagePath=item["id"],
                            createdAt=stored_at,
                            updatedAt=stored_at,
                        )
                        session.add(row)
                        persisted.append(row)

                    session.commit()
                    for row in persisted:
                        session.refresh(row)
                    return persisted
                except Exception:
                    session.rollback()
                    # Best-effort cleanup: avoid leaving orphaned files when DB write fails.
                    for path in moved:
                        try:
                            if path.exists():
                                path.unlink()
                        except Exception:
                            pass
                    raise
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Failed to upload attachments.") from exc
        finally:
            # Clean up any remaining staged files.
            try:
                for item in staged:
                    path = item.get("tmpPath")
                    if path and isinstance(path, Path) and path.exists():
                        try:
                            path.unlink()
                        except Exception:
                            pass
            finally:
                try:
                    if tmp_dir.exists():
                        for child in tmp_dir.iterdir():
                            try:
                                child.unlink()
                            except Exception:
                                pass
                        try:
                            tmp_dir.rmdir()
                        except Exception:
                            pass
                except Exception:
                    pass

    @app.get("/api/attachments/{attachment_id}", tags=["attachments"])
    def download_attachment(attachment_id: str):
        """Serve a stored attachment by ID."""
        att_id = (attachment_id or "").strip()
        if not att_id:
            raise HTTPException(status_code=404, detail="Attachment not found")
        with get_session() as session:
            row = session.get(Attachment, att_id)
            if not row:
                raise HTTPException(status_code=404, detail="Attachment not found")

        root = _attachments_root()
        path = root / str(row.storagePath or row.id)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Attachment file missing on disk")

        filename = _sanitize_attachment_filename(row.fileName)
        disposition = f'inline; filename="{filename}"'
        return FileResponse(
            str(path),
            media_type=row.mimeType or "application/octet-stream",
            filename=filename,
            headers={"Content-Disposition": disposition},
        )
