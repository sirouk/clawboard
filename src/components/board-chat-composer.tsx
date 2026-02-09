"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TextArea } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { apiFetch } from "@/lib/api";
import { useLocalStorageItem } from "@/lib/local-storage";
import { cn } from "@/lib/cn";
import { randomId } from "@/lib/id";

const LAST_AGENT_KEY = "clawboard.chat.agentId";

export function BoardChatComposer({
  sessionKey,
  disabled,
  placeholder,
  helperText,
  variant = "panel",
  className,
  onFocus,
  onBlur,
  autoFocus,
  onAutoFocusApplied,
  onSendUpdate,
  testId,
}: {
  sessionKey: string;
  disabled?: boolean;
  placeholder?: string;
  helperText?: string;
  variant?: "panel" | "seamless";
  className?: string;
  onFocus?: () => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  onAutoFocusApplied?: () => void;
  onSendUpdate?: (event:
    | { phase: "sending"; localId: string; sessionKey: string; message: string; createdAt: string }
    | { phase: "queued"; localId: string; requestId: string; sessionKey: string; message: string; createdAt: string }
    | { phase: "failed"; localId: string; sessionKey: string; message: string; createdAt: string; error: string }) => void;
  testId?: string;
}) {
  const { token, tokenRequired } = useAppConfig();
  const readOnly = tokenRequired && token.trim().length === 0;
  const storedAgentId = useLocalStorageItem(LAST_AGENT_KEY);
  const agentId = useMemo(() => (storedAgentId ?? "main").trim() || "main", [storedAgentId]);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    if (sending) return;
    textareaRef.current?.focus();
    onAutoFocusApplied?.();
  }, [autoFocus, onAutoFocusApplied, sending]);

  const sendMessage = async () => {
    const message = draft.trim();
    if (!message) return;
    if (readOnly) return;

    const localId = randomId();
    const createdAt = new Date().toISOString();
    onSendUpdate?.({ phase: "sending", localId, sessionKey, message, createdAt });
    setDraft("");
    setSending(true);
    try {
      const res = await apiFetch(
        "/api/openclaw/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionKey,
            message,
            agentId,
          }),
        },
        token
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const msg = typeof detail?.detail === "string" ? detail.detail : `Failed to send (${res.status}).`;
        setDraft(message);
        onSendUpdate?.({ phase: "failed", localId, sessionKey, message, createdAt, error: msg });
        return;
      }
      const payload = (await res.json().catch(() => null)) as { requestId?: string } | null;
      const requestId = String(payload?.requestId ?? "").trim();
      if (requestId) {
        onSendUpdate?.({ phase: "queued", localId, requestId, sessionKey, message, createdAt });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send.";
      setDraft(message);
      onSendUpdate?.({ phase: "failed", localId, sessionKey, message, createdAt, error: msg });
    } finally {
      setSending(false);
    }
  };

  const hardDisabled = Boolean(disabled || sending || readOnly);

  return (
    <div
      data-testid={testId}
      className={cn(
        variant === "seamless"
          ? "border-0 bg-transparent p-0"
          : "rounded-[var(--radius-md)] border border-[rgba(255,255,255,0.12)] bg-[rgba(10,12,16,0.22)] p-3",
        className
      )}
    >
      <div className="text-[10px] uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Message</div>
      <div className="mt-2">
        <TextArea
          ref={textareaRef}
          className={cn("min-h-[78px]", readOnly ? "cursor-not-allowed opacity-70" : "")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder ?? (readOnly ? "Add a token in Setup to send messages." : "Type a message…")}
          disabled={hardDisabled}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage();
            }
          }}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[rgb(var(--claw-muted))]">
          <span>{helperText ?? "Enter to send, Shift+Enter for newline."}</span>
          <div className="flex items-center gap-3">
            <span>{draft.trim().length > 0 ? `${draft.trim().length} chars` : null}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
