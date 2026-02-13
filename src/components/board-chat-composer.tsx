"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button, TextArea } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { apiFetch } from "@/lib/api";
import { useLocalStorageItem } from "@/lib/local-storage";
import { cn } from "@/lib/cn";
import { randomId } from "@/lib/id";
import { AttachmentStrip, type AttachmentLike } from "@/components/attachments";
import { usePersistentDraft } from "@/lib/drafts";

const LAST_AGENT_KEY = "clawboard.chat.agentId";

const DEFAULT_ALLOWED_MIME_TYPES = new Set([
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
]);
const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

type AttachmentPolicy = { allowedMimeTypes: string[]; maxFiles: number; maxBytes: number };
let attachmentPolicyCache: AttachmentPolicy | null = null;
let attachmentPolicyPromise: Promise<AttachmentPolicy | null> | null = null;

async function fetchAttachmentPolicy(): Promise<AttachmentPolicy | null> {
  if (attachmentPolicyCache) return attachmentPolicyCache;
  if (!attachmentPolicyPromise) {
    attachmentPolicyPromise = (async () => {
      try {
        const res = await apiFetch("/api/attachments/policy", { cache: "no-store" });
        if (!res.ok) return null;
        const payload = (await res.json().catch(() => null)) as
          | { allowedMimeTypes?: unknown; maxFiles?: unknown; maxBytes?: unknown }
          | null;
        if (!payload) return null;
        const allowed = Array.isArray(payload.allowedMimeTypes)
          ? payload.allowedMimeTypes.map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean)
          : [];
        const maxFiles = Number(payload.maxFiles);
        const maxBytes = Number(payload.maxBytes);
        if (allowed.length === 0) return null;
        if (!Number.isFinite(maxFiles) || maxFiles <= 0) return null;
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) return null;
        attachmentPolicyCache = { allowedMimeTypes: allowed, maxFiles, maxBytes };
        return attachmentPolicyCache;
      } catch {
        return null;
      }
    })();
  }
  return attachmentPolicyPromise;
}

function inferMimeTypeFromName(fileName: string) {
  const lower = (fileName ?? "").trim().toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop() ?? "" : "";
  const mapping: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    json: "application/json",
    csv: "text/csv",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    webm: "audio/webm",
    ogg: "audio/ogg",
  };
  return mapping[ext] ?? "";
}

export type BoardChatComposerHandle = {
  addFiles: (files: File[] | FileList) => void;
  focus: () => void;
};

export type BoardChatComposerSendEvent =
  | { phase: "sending"; localId: string; sessionKey: string; message: string; createdAt: string; attachments?: AttachmentLike[] }
  | { phase: "queued"; localId: string; requestId: string; sessionKey: string; message: string; createdAt: string; attachments?: AttachmentLike[] }
  | { phase: "failed"; localId: string; sessionKey: string; message: string; createdAt: string; error: string; attachments?: AttachmentLike[] };

type BoardChatComposerProps = {
  sessionKey: string;
  disabled?: boolean;
  placeholder?: string;
  helperText?: string;
  variant?: "panel" | "seamless";
  dense?: boolean;
  className?: string;
  onFocus?: () => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  onAutoFocusApplied?: () => void;
  onSendUpdate?: (event: BoardChatComposerSendEvent) => void;
  testId?: string;
};

type ComposerAttachment = AttachmentLike & { file: File };

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.48-8.49" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

export const BoardChatComposer = forwardRef<BoardChatComposerHandle, BoardChatComposerProps>(function BoardChatComposer(
  {
    sessionKey,
    disabled,
    placeholder,
    helperText,
    variant = "panel",
    dense = false,
    className,
    onFocus,
    onBlur,
    autoFocus,
    onAutoFocusApplied,
    onSendUpdate,
    testId,
  },
  ref
) {
  const { token, tokenRequired } = useAppConfig();
  const readOnly = tokenRequired && token.trim().length === 0;
  const storedAgentId = useLocalStorageItem(LAST_AGENT_KEY);
  const agentId = useMemo(() => (storedAgentId ?? "main").trim() || "main", [storedAgentId]);

  const [attachmentPolicy, setAttachmentPolicy] = useState<AttachmentPolicy | null>(attachmentPolicyCache);
  const { value: draft, setValue: setDraft } = usePersistentDraft(`draft:chat:${sessionKey}`, { fallback: "" });
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const maxHeight = dense ? 172 : 280;
    // Reset height so shrinking works when deleting text.
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [dense]);

  useEffect(() => {
    if (!autoFocus) return;
    if (sending) return;
    textareaRef.current?.focus();
    onAutoFocusApplied?.();
  }, [autoFocus, onAutoFocusApplied, sending]);

  useEffect(() => {
    let alive = true;
    if (attachmentPolicy) return () => undefined;
    void fetchAttachmentPolicy().then((next) => {
      if (!alive) return;
      if (next) setAttachmentPolicy(next);
    });
    return () => {
      alive = false;
    };
  }, [attachmentPolicy]);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [draft, resizeTextarea]);

  const allowedMimeTypes = useMemo(() => {
    const list = attachmentPolicy?.allowedMimeTypes ?? Array.from(DEFAULT_ALLOWED_MIME_TYPES);
    return new Set(list.map((mt) => String(mt ?? "").trim().toLowerCase()).filter(Boolean));
  }, [attachmentPolicy]);
  const maxFiles = attachmentPolicy?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = attachmentPolicy?.maxBytes ?? DEFAULT_MAX_BYTES;

  const addFiles = useCallback((incoming: File[] | FileList) => {
    const files = Array.from(incoming ?? []);
    if (files.length === 0) return;
    setAttachError(null);

    setAttachments((prev) => {
      const next = [...prev];
      const existingKeys = new Set(next.map((att) => `${att.fileName}:${att.sizeBytes}:${att.mimeType}`));

      for (const file of files) {
        const fileName = (file.name || "attachment").trim() || "attachment";
        let mimeType = (file.type || "").toLowerCase();
        if (!mimeType || mimeType === "application/octet-stream") {
          mimeType = inferMimeTypeFromName(fileName);
        }
        const sizeBytes = file.size ?? 0;

        if (!mimeType || !allowedMimeTypes.has(mimeType)) {
          setAttachError(`File type not allowed: ${fileName} (${mimeType || "unknown"}).`);
          continue;
        }
        if (sizeBytes <= 0) {
          setAttachError(`File was empty: ${fileName}.`);
          continue;
        }
        if (sizeBytes > maxBytes) {
          setAttachError(`File too large: ${fileName}. Max is ${Math.round(maxBytes / (1024 * 1024))}MB.`);
          continue;
        }
        if (next.length >= maxFiles) {
          setAttachError(`Too many files. Max is ${maxFiles}.`);
          break;
        }

        const key = `${fileName}:${sizeBytes}:${mimeType}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);

        const previewUrl =
          mimeType.startsWith("image/") && typeof window !== "undefined" ? URL.createObjectURL(file) : undefined;
        next.push({ fileName, mimeType, sizeBytes, previewUrl, file });
      }

      return next;
    });
  }, [allowedMimeTypes, maxBytes, maxFiles]);

  useImperativeHandle(
    ref,
    () => ({
      addFiles: (files) => addFiles(files),
      focus: () => textareaRef.current?.focus(),
    }),
    [addFiles]
  );

  const sendMessage = async () => {
    const message = draft.trim();
    if (!message) return;
    if (readOnly) return;

    const localId = randomId();
    const createdAt = new Date().toISOString();
    const pendingAttachments = attachments.map((att) => ({
      id: att.id,
      fileName: att.fileName,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes,
      previewUrl: att.previewUrl,
    }));
    onSendUpdate?.({ phase: "sending", localId, sessionKey, message, createdAt, attachments: pendingAttachments });
    setDraft("");
    setSending(true);
    setAttachError(null);

    const attachmentsSnapshot = attachments;
    setAttachments([]);
    try {
      let attachmentIds: string[] | undefined;
      if (attachmentsSnapshot.length > 0) {
        const form = new FormData();
        for (const att of attachmentsSnapshot) {
          form.append("files", att.file, att.fileName);
        }

        const uploadRes = await apiFetch(
          "/api/attachments",
          {
            method: "POST",
            body: form,
          },
          token
        );
        if (!uploadRes.ok) {
          const detail = await uploadRes.json().catch(() => null);
          const msg = typeof detail?.detail === "string" ? detail.detail : `Failed to upload (${uploadRes.status}).`;
          setDraft(message);
          setAttachments(attachmentsSnapshot);
          onSendUpdate?.({
            phase: "failed",
            localId,
            sessionKey,
            message,
            createdAt,
            error: msg,
            attachments: pendingAttachments,
          });
          setAttachError(msg);
          return;
        }

        const uploaded = (await uploadRes.json().catch(() => null)) as Array<{ id: string }> | null;
        attachmentIds = Array.isArray(uploaded) ? uploaded.map((row) => String(row?.id ?? "").trim()).filter(Boolean) : [];
      }

      const res = await apiFetch(
        "/api/openclaw/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionKey,
            message,
            agentId,
            attachmentIds,
          }),
        },
        token
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const msg = typeof detail?.detail === "string" ? detail.detail : `Failed to send (${res.status}).`;
        setDraft(message);
        setAttachments(attachmentsSnapshot);
        onSendUpdate?.({ phase: "failed", localId, sessionKey, message, createdAt, error: msg, attachments: pendingAttachments });
        setAttachError(msg);
        return;
      }
      const payload = (await res.json().catch(() => null)) as { requestId?: string } | null;
      const requestId = String(payload?.requestId ?? "").trim();
      if (requestId) {
        onSendUpdate?.({ phase: "queued", localId, requestId, sessionKey, message, createdAt, attachments: pendingAttachments });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send.";
      setDraft(message);
      setAttachments(attachmentsSnapshot);
      onSendUpdate?.({ phase: "failed", localId, sessionKey, message, createdAt, error: msg, attachments: pendingAttachments });
      setAttachError(msg);
    } finally {
      setSending(false);
    }
  };

  const hardDisabled = Boolean(disabled || sending || readOnly);
  const sendDisabled = hardDisabled || draft.trim().length === 0;
  const wordCount = useMemo(() => {
    const text = draft.trim();
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
  }, [draft]);
  const handleDensePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLTextAreaElement>) => {
      if (!dense) return;
      const el = textareaRef.current;
      if (!el) return;
      if (document.activeElement === el) return;
      // iOS Safari can auto-scroll focused inputs off-screen; force focus without scrolling.
      event.preventDefault();
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    },
    [dense]
  );

  return (
    <div
      data-testid={testId}
      className={cn(
        variant === "seamless"
          ? "border-0 bg-transparent p-0"
          : "rounded-[var(--radius-md)] border border-[rgba(255,255,255,0.12)] bg-[rgba(10,12,16,0.22)] p-3",
        dragActive ? "ring-2 ring-[rgba(226,86,64,0.35)]" : "",
        className
      )}
      onDragEnter={(event) => {
        if (hardDisabled) return;
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (hardDisabled) return;
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        if (hardDisabled) return;
        event.preventDefault();
        setDragActive(false);
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        addFiles(files);
        textareaRef.current?.focus();
      }}
    >
      <div className={cn("text-[10px] uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]", dense ? "max-md:hidden" : "")}>
        Message
      </div>
      <div className={cn("mt-2", dense ? "max-md:mt-1.5" : "")}>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          accept={Array.from(allowedMimeTypes).join(",")}
          onChange={(event) => {
            const files = event.target.files;
            if (files && files.length > 0) addFiles(files);
            // Allow re-selecting the same file.
            event.target.value = "";
          }}
        />
        <div className={cn(dense ? "relative" : "")}>
          <TextArea
            ref={textareaRef}
            className={cn(
              "resize-none",
              dense
                ? "min-h-[58px] max-md:max-h-[172px] max-md:pb-11 max-md:pr-24 md:min-h-[70px]"
                : "min-h-[78px] overflow-hidden"
            )}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder ?? (readOnly ? "Add a token in Setup to send messages." : "Type a message…")}
            disabled={hardDisabled}
            onPointerDown={handleDensePointerDown}
            onFocus={() => {
              if (dense && typeof window !== "undefined") {
                window.requestAnimationFrame(() => {
                  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
                });
              }
              onFocus?.();
            }}
            onBlur={onBlur}
            onPaste={(event) => {
              if (hardDisabled) return;
              const items = event.clipboardData?.items;
              if (!items) return;
              const files: File[] = [];
              for (const item of Array.from(items)) {
                if (item.kind !== "file") continue;
                const file = item.getAsFile();
                if (file) files.push(file);
              }
              if (files.length === 0) return;
              event.preventDefault();
              addFiles(files);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
          />
          {dense ? (
            <div className="absolute bottom-2.5 right-2.5 z-10 flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={hardDisabled}
                aria-label="Attach files"
                title="Attach files"
                className={cn(
                  "inline-flex h-8 w-8 items-center justify-center rounded-full border text-[rgb(var(--claw-muted))] transition",
                  "border-[rgba(255,255,255,0.14)] bg-[rgba(12,14,18,0.86)] backdrop-blur",
                  "hover:border-[rgba(255,90,45,0.4)] hover:text-[rgb(var(--claw-text))]",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
              >
                <PaperclipIcon />
              </button>
              <button
                type="button"
                onClick={() => {
                  void sendMessage();
                }}
                disabled={sendDisabled}
                aria-label="Send message"
                title="Send message"
                className={cn(
                  "inline-flex h-8 w-8 items-center justify-center rounded-full border text-[rgb(var(--claw-text))] transition",
                  "border-[rgba(255,90,45,0.6)] bg-[rgba(255,90,45,0.2)] backdrop-blur",
                  "hover:bg-[rgba(255,90,45,0.3)]",
                  "disabled:cursor-not-allowed disabled:border-[rgba(255,255,255,0.14)] disabled:bg-[rgba(255,255,255,0.06)] disabled:text-[rgb(var(--claw-muted))]"
                )}
              >
                <SendIcon />
              </button>
            </div>
          ) : null}
        </div>
        {attachments.length > 0 ? (
          <AttachmentStrip
            attachments={attachments}
            onRemove={(idx) => {
              setAttachments((prev) => {
                const target = prev[idx];
                if (target?.previewUrl) {
                  try {
                    URL.revokeObjectURL(target.previewUrl);
                  } catch {
                    // ignore
                  }
                }
                return prev.filter((_, i) => i !== idx);
              });
            }}
          />
        ) : null}
        {attachError ? <div className="mt-2 text-xs text-[rgb(var(--claw-warning))]">{attachError}</div> : null}
        {dense ? null : (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[rgb(var(--claw-muted))]">
            <span>
            {helperText ?? "Enter to send, Shift+Enter for newline."}
            </span>
            <div className="flex items-center gap-3">
              <span>{wordCount > 0 ? `${wordCount} word${wordCount === 1 ? "" : "s"}` : null}</span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={hardDisabled}
                aria-label="Attach files"
                title="Attach files"
              >
                <PaperclipIcon />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() => {
                  void sendMessage();
                }}
                disabled={sendDisabled}
              >
                Send
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

BoardChatComposer.displayName = "BoardChatComposer";
