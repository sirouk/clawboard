type MessageHookContext = {
  channelId?: string;
  conversationId?: string;
  sessionKey?: string;
};

export type BoardSessionRoute =
  | { kind: "topic"; topicId: string }
  | { kind: "task"; topicId: string; taskId: string };

const TOPIC_ID_RE = /^topic-[a-zA-Z0-9-]+$/;
const TASK_ID_RE = /^task-[a-zA-Z0-9-]+$/;

function normalizeBoardKey(sessionKey: string | undefined | null): string | null {
  if (typeof sessionKey !== "string") return null;
  const trimmed = sessionKey.trim();
  if (!trimmed) return null;
  return trimmed.split("|", 1)[0] ?? trimmed;
}

export function boardSessionRouteToSessionKey(route: BoardSessionRoute): string {
  return route.kind === "task"
    ? `clawboard:task:${route.topicId}:${route.taskId}`
    : `clawboard:topic:${route.topicId}`;
}

export function boardSessionRouteToSessionKeys(route: BoardSessionRoute): string[] {
  const canonical = boardSessionRouteToSessionKey(route);
  return route.kind === "task" ? [canonical, `clawboard:topic:${route.topicId}`] : [canonical];
}

/**
 * Returns true if the session key is an explicit ClawBoard board session.
 * Handles wrapped keys (e.g. agent:main:clawboard:topic:...).
 */
export function isBoardSessionKey(sessionKey: string | undefined | null): boolean {
  return parseBoardSessionKey(sessionKey) !== null;
}

export function parseBoardSessionKey(sessionKey: string | undefined | null): BoardSessionRoute | null {
  const base = normalizeBoardKey(sessionKey);
  if (!base) return null;

  const parts = base.split(":");
  const clawboardIndex = parts.indexOf("clawboard");
  if (clawboardIndex < 0 || clawboardIndex + 2 >= parts.length) return null;

  const scopeKind = parts[clawboardIndex + 1];
  const topicId = parts[clawboardIndex + 2];
  if (!TOPIC_ID_RE.test(topicId)) return null;

  if (scopeKind === "topic") {
    return { kind: "topic", topicId };
  }

  if (scopeKind === "task") {
    const taskId = parts[clawboardIndex + 3];
    if (!taskId || !TASK_ID_RE.test(taskId)) return null;
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

  const isBoard = (value: string) => isBoardSessionKey(value);

  // Board sessions are explicitly chosen by ClawBoard Topic Chat. When present, they must
  // win even if OpenClaw supplies an unrelated conversationId, otherwise logs get mis-attributed
  // (and ClawBoard can double-log user input).
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
