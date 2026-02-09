type MessageHookContext = {
  channelId?: string;
  conversationId?: string;
  sessionKey?: string;
};

export type BoardSessionRoute =
  | { kind: "topic"; topicId: string }
  | { kind: "task"; topicId: string; taskId: string };

function isEntityId(prefix: "topic" | "task", value: string) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.startsWith(`${prefix}-`)) return false;
  // IDs are UUID-ish (`topic-<uuid>`, `task-<uuid>`). Keep it permissive but URL-safe.
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{2,200}$/.test(trimmed);
}

export function parseBoardSessionKey(sessionKey: string | undefined | null): BoardSessionRoute | null {
  if (typeof sessionKey !== "string") return null;
  const trimmed = sessionKey.trim();
  if (!trimmed) return null;

  // Strip OpenClaw's optional thread suffix (`|thread:...`) if present.
  const base = trimmed.split("|", 1)[0] ?? trimmed;
  const parts = base.split(":");
  if (parts.length < 3) return null;
  if (parts[0] !== "clawboard") return null;
  const kind = parts[1];
  if (kind === "topic" && parts.length === 3) {
    const topicId = parts[2] ?? "";
    if (!isEntityId("topic", topicId)) return null;
    return { kind: "topic", topicId };
  }
  if (kind === "task" && parts.length === 4) {
    const topicId = parts[2] ?? "";
    const taskId = parts[3] ?? "";
    if (!isEntityId("topic", topicId)) return null;
    if (!isEntityId("task", taskId)) return null;
    return { kind: "task", topicId, taskId };
  }
  return null;
}

export function computeEffectiveSessionKey(
  meta: Record<string, unknown> | undefined,
  ctx: MessageHookContext,
): string | undefined {
  const channelId = typeof ctx?.channelId === "string" ? ctx.channelId.trim() : "";
  const conversationId =
    typeof ctx?.conversationId === "string" ? String(ctx.conversationId).trim() : "";

  const metaSession =
    typeof (meta as { sessionKey?: unknown } | undefined)?.sessionKey === "string"
      ? String((meta as { sessionKey?: unknown }).sessionKey).trim()
      : "";
  const ctxSession = typeof ctx?.sessionKey === "string" ? String(ctx.sessionKey).trim() : "";
  const threadId =
    typeof (meta as { threadId?: unknown } | undefined)?.threadId === "string"
      ? String((meta as { threadId?: unknown }).threadId).trim()
      : "";

  // Prefer the conversation identifier provided by OpenClaw. `channelId` is the
  // provider/plugin id (e.g. "discord"), and is too broad to be a session bucket.
  let base = conversationId || ctxSession || metaSession;

  // Guard: some upstreams may pass `channel:${channelId}` which is still too broad.
  if (base && channelId && base === `channel:${channelId}` && conversationId) {
    base = conversationId;
  }

  if (!base) {
    return channelId ? `channel:${channelId}` : undefined;
  }

  // Threading: if we have a distinct thread id, include it in the key so thread
  // conversations don't collide with the parent channel.
  if (threadId && !base.includes(threadId)) {
    base = `${base}|thread:${threadId}`;
  }

  return base;
}
