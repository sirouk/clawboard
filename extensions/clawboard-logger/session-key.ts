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

/**
 * Returns true if the session key is an explicit Clawboard UI session (Topic or Task chat).
 * Handles wrapped keys (e.g. agent:main:clawboard:topic:...).
 */
export function isBoardSessionKey(sessionKey: string | undefined | null): boolean {
  if (typeof sessionKey !== "string") return false;
  return /clawboard:(topic|task):topic-/.test(sessionKey);
}

export function parseBoardSessionKey(sessionKey: string | undefined | null): BoardSessionRoute | null {
  if (typeof sessionKey !== "string") return null;
  const trimmed = sessionKey.trim();
  if (!trimmed) return null;

  // Strip OpenClaw's optional thread suffix (`|thread:...`) if present.
  const base = trimmed.split("|", 1)[0] ?? trimmed;
  
  // Robust matching: handles agent: prefixes and other wrappers.
  // Task format: clawboard:task:<topic-id>:<task-id>
  const taskMatch = base.match(/clawboard:task:(topic-[a-zA-Z0-9-]+):(task-[a-zA-Z0-9-]+)/);
  if (taskMatch && taskMatch[1] && taskMatch[2]) {
    return { kind: "task", topicId: taskMatch[1], taskId: taskMatch[2] };
  }

  // Topic format: clawboard:topic:<topic-id>
  const topicMatch = base.match(/clawboard:topic:(topic-[a-zA-Z0-9-]+)/);
  if (topicMatch && topicMatch[1]) {
    return { kind: "topic", topicId: topicMatch[1] };
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

  const isBoard = (value: string) => isBoardSessionKey(value);

  // Board sessions are explicitly chosen by Clawboard (Topic/Task chat). When present, they must
  // win even if OpenClaw supplies an unrelated conversationId, otherwise logs get mis-attributed
  // (and Clawboard can double-log user input).
  let base =
    (metaSession && isBoard(metaSession) ? metaSession : "") ||
    (ctxSession && isBoard(ctxSession) ? ctxSession : "") ||
    (conversationId && isBoard(conversationId) ? conversationId : "") ||
    // Prefer the conversation identifier provided by OpenClaw. `channelId` is the
    // provider/plugin id (e.g. "discord"), and is too broad to be a session bucket.
    conversationId ||
    ctxSession ||
    metaSession;

  // Guard: some upstreams may pass `channel:${channelId}` which is still too broad.
  if (base && channelId && base === `channel:${channelId}` && conversationId) {
    base = conversationId;
  }

  if (!base) {
    return channelId ? `channel:${channelId}` : undefined;
  }

  // Threading: if we have a distinct thread id, include it in the key so thread
  // conversations don't collide with the parent channel.
  if (threadId && !isBoard(base) && !base.includes(threadId)) {
    base = `${base}|thread:${threadId}`;
  }

  return base;
}
