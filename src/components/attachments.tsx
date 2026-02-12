"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";

export type AttachmentLike = {
  id?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
};

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isImageAttachment(att: AttachmentLike) {
  return IMAGE_MIME_TYPES.has((att.mimeType ?? "").toLowerCase());
}

function fileBadge(att: AttachmentLike) {
  const mime = (att.mimeType ?? "").toLowerCase();
  if (mime === "application/pdf") return "PDF";
  if (mime === "text/markdown") return "MD";
  if (mime === "text/csv") return "CSV";
  if (mime === "application/json") return "JSON";
  if (mime === "audio/mpeg") return "MP3";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "WAV";
  if (mime === "audio/mp4") return "M4A";
  if (mime === "audio/webm") return "WEBM";
  if (mime === "audio/ogg") return "OGG";
  if (mime.startsWith("audio/")) return "AUDIO";
  if (mime.startsWith("text/")) return "TXT";
  const ext = att.fileName?.split(".").pop() ?? "";
  if (ext && ext.length <= 6) return ext.toUpperCase();
  return "FILE";
}

export function AttachmentStrip({
  attachments,
  onRemove,
  className,
}: {
  attachments: AttachmentLike[];
  onRemove?: (index: number) => void;
  className?: string;
}) {
  const safeAttachments = useMemo(() => attachments ?? [], [attachments]);
  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({});
  const blobUrlsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    blobUrlsRef.current = blobUrls;
  }, [blobUrls]);

  useEffect(() => {
    return () => {
      for (const url of Object.values(blobUrlsRef.current)) {
        URL.revokeObjectURL(url);
      }
      blobUrlsRef.current = {};
    };
  }, []);

  const attachmentSignature = useMemo(
    () =>
      safeAttachments
        .map((att) => `${att.id ?? "local"}:${att.fileName}:${att.mimeType}:${att.sizeBytes}:${att.previewUrl ?? ""}`)
        .join("|"),
    [safeAttachments]
  );

  useEffect(() => {
    let cancelled = false;
    const controllers: AbortController[] = [];
    const previous = blobUrlsRef.current;
    const next: Record<string, string> = {};

    const downloadMissing = async () => {
      for (const att of safeAttachments) {
        if (!att.id || att.previewUrl) continue;
        const key = att.id;
        if (previous[key]) {
          next[key] = previous[key];
          continue;
        }
        const controller = new AbortController();
        controllers.push(controller);
        try {
          const res = await apiFetch(`/api/attachments/${encodeURIComponent(att.id)}`, { signal: controller.signal });
          if (!res.ok) continue;
          const blob = await res.blob();
          if (cancelled) {
            continue;
          }
          next[key] = URL.createObjectURL(blob);
        } catch {
          // Keep attachment visible even if secure fetch fails.
        }
      }
    };

    void downloadMissing().then(() => {
      if (cancelled) {
        for (const key of Object.keys(next)) {
          if (!previous[key]) URL.revokeObjectURL(next[key]);
        }
        return;
      }
      for (const key of Object.keys(previous)) {
        if (!next[key]) URL.revokeObjectURL(previous[key]);
      }
      blobUrlsRef.current = next;
      setBlobUrls(next);
    });

    return () => {
      cancelled = true;
      for (const controller of controllers) {
        controller.abort();
      }
    };
  }, [attachmentSignature, safeAttachments]);

  if (safeAttachments.length === 0) return null;

  return (
    <div className={cn("mt-3 flex flex-wrap gap-2", className)}>
      {safeAttachments.map((att, idx) => {
        const image = isImageAttachment(att);
        const fetchedUrl = att.id ? blobUrls[att.id] : "";
        const previewSrc = att.previewUrl || fetchedUrl || "";
        const href = fetchedUrl || "";
        const title = `${att.fileName || "attachment"} (${att.mimeType || "unknown"})`;

        return (
          <div
            key={`${att.id ?? "local"}:${idx}:${att.fileName}`}
            className="relative overflow-hidden rounded-[14px] border border-[rgba(255,255,255,0.12)] bg-[rgba(10,12,16,0.35)]"
            title={title}
          >
            {onRemove ? (
              <button
                type="button"
                aria-label={`Remove ${att.fileName || "attachment"}`}
                onClick={() => onRemove(idx)}
                className="absolute right-1 top-1 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(10,12,16,0.72)] text-xs text-[rgb(var(--claw-text))] hover:border-[rgba(255,90,45,0.32)]"
              >
                ×
              </button>
            ) : null}

            {image ? (
              previewSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewSrc}
                  alt={att.fileName || "attachment"}
                  className="h-24 w-24 object-cover"
                  draggable={false}
                />
              ) : (
                <div className="flex h-24 w-24 items-center justify-center text-xs text-[rgb(var(--claw-muted))]">
                  Image
                </div>
              )
            ) : (
              <a
                href={href || undefined}
                target={href ? "_blank" : undefined}
                rel={href ? "noreferrer" : undefined}
                download={href ? att.fileName || undefined : undefined}
                className={cn(
                  "flex h-24 w-40 flex-col justify-between p-3 text-left transition",
                  href ? "hover:bg-[rgba(255,255,255,0.04)]" : ""
                )}
                onClick={(event) => {
                  if (!href) event.preventDefault();
                }}
              >
                <div className="text-[10px] uppercase tracking-[0.2em] text-[rgba(148,163,184,0.9)]">
                  {fileBadge(att)}
                </div>
                <div className="min-w-0 text-xs text-[rgb(var(--claw-text))]">
                  <div className="truncate">{att.fileName || "attachment"}</div>
                </div>
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
