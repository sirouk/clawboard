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
  const [previewImage, setPreviewImage] = useState<{ src: string; fileName: string; mimeType: string; downloadHref?: string } | null>(null);
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

  useEffect(() => {
    if (!previewImage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewImage(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewImage]);

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
        const href = fetchedUrl || att.previewUrl || "";
        const title = `${att.fileName || "attachment"} (${att.mimeType || "unknown"})`;
        const canPreviewImage = image && Boolean(previewSrc);

        return (
          <div
            key={`${att.id ?? "local"}:${idx}:${att.fileName}`}
            className="relative overflow-hidden rounded-[14px] border border-[rgba(255,255,255,0.12)] bg-[rgba(10,12,16,0.35)]"
            title={title}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
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
              canPreviewImage ? (
                <button
                  type="button"
                  aria-label={`Preview ${att.fileName || "attachment"}`}
                  className="block transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(77,171,158,0.42)]"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setPreviewImage({
                      src: previewSrc,
                      fileName: att.fileName || "attachment",
                      mimeType: att.mimeType || "image",
                      downloadHref: href || undefined,
                    });
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewSrc}
                    alt={att.fileName || "attachment"}
                    className="h-24 w-24 object-cover"
                    draggable={false}
                  />
                </button>
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
                  event.stopPropagation();
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

      {previewImage ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(4,6,10,0.82)] p-4 backdrop-blur-md"
          data-testid="attachment-preview-dialog"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewImage(null);
          }}
        >
          <div className="w-full max-w-5xl overflow-hidden rounded-[28px] border border-[rgba(255,255,255,0.14)] bg-[linear-gradient(180deg,rgba(16,19,25,0.98),rgba(8,10,14,0.96))] shadow-[0_28px_100px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-3 border-b border-[rgba(255,255,255,0.08)] px-4 py-4 sm:px-5">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-[rgb(var(--claw-text))]">{previewImage.fileName}</div>
                <div className="mt-1 text-xs uppercase tracking-[0.18em] text-[rgba(148,163,184,0.8)]">{previewImage.mimeType}</div>
              </div>
              <div className="flex items-center gap-2">
                {previewImage.downloadHref ? (
                  <a
                    href={previewImage.downloadHref}
                    download={previewImage.fileName}
                    className="inline-flex h-10 items-center justify-center rounded-full border border-[rgba(255,255,255,0.14)] px-4 text-sm font-medium text-[rgb(var(--claw-text))] transition hover:border-[rgba(77,171,158,0.32)] hover:text-[rgb(var(--claw-accent-2))]"
                  >
                    Download
                  </a>
                ) : null}
                <button
                  type="button"
                  aria-label="Close attachment preview"
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-[rgba(255,255,255,0.14)] text-[rgb(var(--claw-muted))] transition hover:border-[rgba(255,90,45,0.35)] hover:text-[rgb(var(--claw-text))]"
                  onClick={() => setPreviewImage(null)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="flex max-h-[calc(100vh-9rem)] items-center justify-center p-3 sm:p-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewImage.src}
                alt={previewImage.fileName}
                className="max-h-[calc(100vh-13rem)] w-auto max-w-full rounded-[20px] object-contain"
                draggable={false}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
