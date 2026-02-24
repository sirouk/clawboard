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
import { ChatSuggestions, type SlashCommand } from "@/components/chat/chat-suggestions";

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
  | { phase: "sending"; localId: string; sessionKey: string; message: string; createdAt: string; attachments?: AttachmentLike[]; debugHint?: string }
  | { phase: "queued"; localId: string; requestId: string; sessionKey: string; message: string; createdAt: string; attachments?: AttachmentLike[]; debugHint?: string }
  | { phase: "failed"; localId: string; sessionKey: string; message: string; createdAt: string; error: string; attachments?: AttachmentLike[]; debugHint?: string };

type BoardChatComposerProps = {
  sessionKey: string;
  topicId?: string | null;
  spaceId?: string;
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
  /** True while the agent is processing a response (tracked by parent via stream/logs). */
  waiting?: boolean;
  /** The requestId the parent knows is in-flight; used by Stop when the composer's own pendingRequestId is gone (e.g. after a re-render). */
  waitingRequestId?: string;
  /** Called when the user clicks Stop so the parent can clear its awaiting state. */
  onCancel?: () => void;
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

function StopIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
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
    topicId,
    spaceId,
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
    waiting = false,
    waitingRequestId,
    onCancel,
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
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const sendingGuardRef = useRef(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const BUILTIN_SLASH_COMMANDS = useMemo(
    () =>
      [
        { name: "help", description: "Show available commands", kind: "cmd" },
        { name: "h", description: "Alias for /help", kind: "cmd" },
        { name: "commands", description: "List all slash commands", kind: "cmd" },
        { name: "cmds", description: "Alias for /commands", kind: "cmd" },
        { name: "status", description: "Show current status", kind: "cmd" },
        { name: "s", description: "Alias for /status", kind: "cmd" },
        { name: "whoami", description: "Show your sender id", kind: "cmd" },
        { name: "who-am-i", description: "Alias for /whoami", kind: "cmd" },
        { name: "me", description: "Alias for /whoami", kind: "cmd" },
        { name: "id", description: "Alias for /whoami", kind: "cmd" },
        { name: "context", description: "Explain how context is built and used", kind: "cmd" },
        { name: "ctx", description: "Alias for /context", kind: "cmd" },
        { name: "subagents", description: "List/stop/log/info subagent runs", kind: "cmd" },
        { name: "subs", description: "Alias for /subagents", kind: "cmd" },
        { name: "subagent", description: "Alias for /subagents", kind: "cmd" },
        { name: "usage", description: "Usage footer or cost summary", kind: "cmd" },
        { name: "u", description: "Alias for /usage", kind: "cmd" },
        { name: "model", description: "Show or set the model", kind: "cmd" },
        { name: "m", description: "Alias for /model", kind: "cmd" },
        { name: "models", description: "List models/providers", kind: "cmd" },
        { name: "providers", description: "Alias for /models", kind: "cmd" },
        { name: "provider", description: "Alias for /models", kind: "cmd" },
        { name: "think", description: "Set thinking level", kind: "cmd" },
        { name: "thinking", description: "Alias for /think", kind: "cmd" },
        { name: "thinklevel", description: "Alias for /think", kind: "cmd" },
        { name: "think-level", description: "Alias for /think", kind: "cmd" },
        { name: "t", description: "Alias for /think", kind: "cmd" },
        { name: "thought", description: "Alias for /reasoning", kind: "cmd" },
        { name: "reason", description: "Alias for /reasoning", kind: "cmd" },
        { name: "th", description: "Alias for /thought", kind: "cmd" },
        { name: "reasoning", description: "Toggle reasoning visibility", kind: "cmd" },
        { name: "r", description: "Alias for /reasoning", kind: "cmd" },
        { name: "verbose", description: "Toggle verbose mode", kind: "cmd" },
        { name: "v", description: "Alias for /verbose", kind: "cmd" },
        { name: "elevated", description: "Toggle elevated mode", kind: "cmd" },
        { name: "e", description: "Alias for /elevated", kind: "cmd" },
        { name: "exec", description: "Execute a command", kind: "cmd" },
        { name: "read", description: "Read a file", kind: "cmd" },
        { name: "write", description: "Write a file", kind: "cmd" },
        { name: "reset", description: "Reset the current session", kind: "cmd" },
        { name: "clear", description: "Alias for /reset", kind: "cmd" },
        { name: "new", description: "Start a new session", kind: "cmd" },
        { name: "stop", description: "Stop the current run", kind: "cmd" },
        { name: "abort", description: "Alias for /stop", kind: "cmd" },
        { name: "skill", description: "Invoke a skill explicitly", kind: "cmd" },
        { name: "sk", description: "Alias for /skill", kind: "cmd" },
        { name: "topic", description: "Update current topic", kind: "cmd" },
        { name: "top", description: "Alias for /topic", kind: "cmd" },
        { name: "topics", description: "List or update topics", kind: "cmd" },
        { name: "task", description: "Update current task", kind: "cmd" },
        { name: "tk", description: "Alias for /task", kind: "cmd" },
        { name: "tasks", description: "List or update tasks", kind: "cmd" },
        { name: "log", description: "Update current log", kind: "cmd" },
        { name: "l", description: "Alias for /log", kind: "cmd" },
        { name: "logs", description: "List or update logs", kind: "cmd" },
        { name: "board", description: "Refresh board view", kind: "cmd" },
        { name: "b", description: "Alias for /board", kind: "cmd" },
        { name: "graph", description: "Show relationship graph", kind: "cmd" },
        { name: "g", description: "Alias for /graph", kind: "cmd" },
        { name: "voice", description: "Convert text to speech", kind: "cmd" },
        { name: "tts", description: "Alias for /voice", kind: "cmd" },
        { name: "bash", description: "Execute a shell command", kind: "cmd" },
        { name: "sh", description: "Alias for /bash", kind: "cmd" },
        { name: "config", description: "Show or update configuration", kind: "cmd" },
        { name: "settings", description: "Alias for /config", kind: "cmd" },
        { name: "debug", description: "Toggle debug mode", kind: "cmd" },
        { name: "d", description: "Alias for /debug", kind: "cmd" },
        { name: "restart", description: "Restart the gateway", kind: "cmd" },
        { name: "scripts", description: "List available scripts", kind: "cmd" },
        { name: "edit", description: "Edit a log/topic/task", kind: "cmd" },
        { name: "delete", description: "Delete a log/topic/task", kind: "cmd" },
        { name: "browser", description: "Control the browser", kind: "cmd" },
        { name: "message", description: "Send a message", kind: "cmd" },
        // Note: /bash, /config, /debug, /restart are config-gated in OpenClaw.
      ] as Array<SlashCommand>,
    []
  );

  const [slashCommands, setSlashCommands] = useState<Array<SlashCommand>>(
    () => BUILTIN_SLASH_COMMANDS
  );
  const [slashCommandsLoadedAt, setSlashCommandsLoadedAt] = useState<number>(() => Date.now());
  const [selectedIndex, setSelectedIndex] = useState(0);

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

  useEffect(() => {
    let alive = true;
    const now = Date.now();
    // Refresh at most every 60s (good enough for local dev where skills change).
    if (now - slashCommandsLoadedAt < 60_000) return () => undefined;
    if (readOnly) return () => undefined;

    void apiFetch(
      `/api/openclaw/skills?agentId=${encodeURIComponent(agentId)}`,
      { cache: "no-store" },
      token
    )
      .then(async (res) => {
        if (!alive) return;
        if (!res.ok) return;
        const payload = (await res.json().catch(() => null)) as { skills?: unknown } | null;
        const skills = Array.isArray(payload?.skills) ? payload?.skills : [];
        const normalized: SlashCommand[] = skills
          .flatMap((entry) => {
            const skill = entry as { name?: string; description?: string; commands?: string[] };
            const skillName = (skill.name || "").trim();
            if (!skillName) return [];
            
            const results: SlashCommand[] = [{ name: skillName, description: skill.description || "", kind: "skill" }];
            
            if (Array.isArray(skill.commands)) {
              for (const cmd of skill.commands) {
                const cmdName = (cmd || "").trim();
                if (cmdName && cmdName !== skillName) {
                  results.push({ name: cmdName, description: `Command for ${skillName}`, kind: "skill" });
                }
              }
            }
            
            return results;
          });
        // Merge built-ins + skills (skills win on name collisions).
        const merged = new Map<string, SlashCommand>();
        for (const cmd of BUILTIN_SLASH_COMMANDS) merged.set(cmd.name.toLowerCase(), cmd);
        for (const cmd of normalized) merged.set(cmd.name.toLowerCase(), cmd);
        setSlashCommands(Array.from(merged.values()));
        setSlashCommandsLoadedAt(Date.now());
      })
      .catch(() => null);

    return () => {
      alive = false;
    };
  }, [agentId, readOnly, slashCommands.length, slashCommandsLoadedAt, token, BUILTIN_SLASH_COMMANDS]);

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
    if (sendingGuardRef.current) return;
    const message = draft.trim();
    if (!message) return;
    if (readOnly) return;
    sendingGuardRef.current = true;

    const localId = randomId();
    const createdAt = new Date().toISOString();
    const pendingAttachments = attachments.map((att) => ({
      id: att.id,
      fileName: att.fileName,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes,
      previewUrl: att.previewUrl,
    }));
    const isDev = process.env.NODE_ENV !== "production";
    const debugHint = isDev ? "Sent via OpenClaw Gateway WS (chat.send)" : undefined;
    onSendUpdate?.({ phase: "sending", localId, sessionKey, message, createdAt, attachments: pendingAttachments, debugHint });
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
            debugHint,
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
            spaceId: String(spaceId ?? "").trim() || undefined,
            message,
            topicId: String(topicId ?? "").trim() || null,
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
        onSendUpdate?.({ phase: "failed", localId, sessionKey, message, createdAt, error: msg, attachments: pendingAttachments, debugHint });
        setAttachError(msg);
        return;
      }
      const payload = (await res.json().catch(() => null)) as { requestId?: string } | null;
      const requestId = String(payload?.requestId ?? "").trim();
      if (requestId) {
        setPendingRequestId(requestId);
        onSendUpdate?.({ phase: "queued", localId, requestId, sessionKey, message, createdAt, attachments: pendingAttachments, debugHint });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send.";
      setDraft(message);
      setAttachments(attachmentsSnapshot);
      onSendUpdate?.({ phase: "failed", localId, sessionKey, message, createdAt, error: msg, attachments: pendingAttachments, debugHint });
      setAttachError(msg);
    } finally {
      sendingGuardRef.current = false;
      setSending(false);
      setPendingRequestId(null);
    }
  };

  const stopSending = useCallback(async () => {
    if (!sending && !waiting) return;
    sendingGuardRef.current = false;
    setSending(false);
    const rid = pendingRequestId ?? waitingRequestId ?? undefined;
    setPendingRequestId(null);
    onCancel?.();
    try {
      await apiFetch(
        "/api/openclaw/chat",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionKey, ...(rid ? { requestId: rid } : {}) }),
        },
        token
      );
    } catch {
      // best-effort; UI state is already cleared
    }
  }, [sending, waiting, pendingRequestId, waitingRequestId, sessionKey, token, onCancel]);

  const isInFlight = sending || waiting;
  // Keep the composer interactive while a prior response is in-flight so users can continue
  // the conversation without waiting for Stop/typing to clear.
  const hardDisabled = Boolean(disabled || readOnly);
  const sendDisabled = hardDisabled || sending || draft.trim().length === 0;
  const wordCount = useMemo(() => {
    const text = draft.trim();
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
  }, [draft]);

  const applyCommand = useCallback(
    (cmd: SlashCommand) => {
      const message = cmd.kind === "skill" ? `/skill ${cmd.name} ` : `/${cmd.name} `;
      setDraft(message);
      setSelectedIndex(0);
      textareaRef.current?.focus();
      resizeTextarea();
    },
    [resizeTextarea, setDraft]
  );

  const slashMenu = useMemo(() => {
    const trimmed = draft.trimStart();
    if (!trimmed.startsWith("/")) return null;
    // Only show for first-line command entry.
    const firstLine = trimmed.split("\n")[0] ?? "";
    
    // If there is space after the first token, it's likely args.
    const parts = firstLine.split(/\s+/);
    if (parts.length > 1 && parts[1] !== "") return null;

    const tokenPart = firstLine.slice(1);
    const namePrefix = tokenPart.split(/\s+/)[0] ?? "";
    const prefix = namePrefix.toLowerCase();
    const matches = slashCommands
      .filter((cmd) => {
        const matchesName = !prefix || cmd.name.toLowerCase().startsWith(prefix);
        if (matchesName) return true;
        // Also match description for better discoverability
        if (prefix && cmd.description && cmd.description.toLowerCase().includes(prefix)) return true;
        return false;
      })
      .sort((a, b) => {
        // Exact name matches first
        const aExact = a.name.toLowerCase() === prefix;
        const bExact = b.name.toLowerCase() === prefix;
        if (aExact !== bExact) return aExact ? -1 : 1;
        // Built-ins first, then alpha
        if (a.kind !== b.kind) return a.kind === "cmd" ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 10);
    if (matches.length === 0) return null;
    return { prefix: namePrefix, matches };
  }, [draft, slashCommands]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [slashMenu?.matches.length]);

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
        <div className={cn("relative", dense ? "" : "")}>
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
              if (slashMenu) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedIndex((prev) => (prev + 1) % slashMenu.matches.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedIndex((prev) => (prev - 1 + slashMenu.matches.length) % slashMenu.matches.length);
                  return;
                }
                if (event.key === "Tab" || event.key === "Enter") {
                  event.preventDefault();
                  const cmd = slashMenu.matches[selectedIndex];
                  if (cmd) applyCommand(cmd);
                  return;
                }
                if (event.key === " ") {
                  const cmd = slashMenu.matches[selectedIndex];
                  if (cmd && draft.trim() === `/${cmd.name}`) {
                    event.preventDefault();
                    applyCommand(cmd);
                    return;
                  }
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(draft.replace(/^\//, " /"));
                  return;
                }
              }

              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
          />
          <ChatSuggestions
            suggestions={slashMenu?.matches ?? []}
            selectedIndex={selectedIndex}
            onSelect={(idx) => {
              const cmd = slashMenu?.matches[idx];
              if (cmd) applyCommand(cmd);
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
              {isInFlight ? (
                <button
                  type="button"
                  onClick={() => { void stopSending(); }}
                  aria-label="Stop"
                  title="Stop generation"
                  className={cn(
                    "inline-flex h-8 w-8 items-center justify-center rounded-full border text-[rgb(var(--claw-text))] transition",
                    "border-[rgba(220,38,38,0.7)] bg-[rgba(220,38,38,0.25)] backdrop-blur",
                    "hover:bg-[rgba(220,38,38,0.4)]"
                  )}
                >
                  <StopIcon />
                </button>
              ) : null}
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
              {isInFlight ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => { void stopSending(); }}
                  aria-label="Stop"
                  title="Stop generation"
                  className="border-red-500/60 text-red-400 hover:border-red-500 hover:text-red-300"
                >
                  <StopIcon className="mr-1" />
                  Stop
                </Button>
              ) : null}
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
