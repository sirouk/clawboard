export function computeEffectiveSessionKey(meta, ctx) {
  const channelId = typeof ctx?.channelId === "string" ? ctx.channelId.trim() : "";
  const conversationId = typeof ctx?.conversationId === "string" ? String(ctx.conversationId).trim() : "";

  const metaSession = typeof meta?.sessionKey === "string" ? String(meta.sessionKey).trim() : "";
  const ctxSession = typeof ctx?.sessionKey === "string" ? String(ctx.sessionKey).trim() : "";
  const threadId = typeof meta?.threadId === "string" ? String(meta.threadId).trim() : "";

  const isBoard = (value) => isBoardSessionKey(value);

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
    return channelId ? `channel:${channelId}` : void 0;
  }

  // Threading: if we have a distinct thread id, include it in the key so thread
  // conversations don't collide with the parent channel.
  if (threadId && !isBoard(base) && !base.includes(threadId)) {
    base = `${base}|thread:${threadId}`;
  }

  return base;
}

function isEntityId(prefix, value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.startsWith(`${prefix}-`)) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{2,200}$/.test(trimmed);
}

export function isBoardSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return false;
  return /clawboard:(topic|task):topic-/.test(sessionKey);
}

export function parseBoardSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  const trimmed = sessionKey.trim();
  if (!trimmed) return null;

  const base = trimmed.split("|", 1)[0] ?? trimmed;
  const taskMatch = base.match(/(?:^|:)clawboard:task:(topic-[a-zA-Z0-9-]+):(task-[a-zA-Z0-9-]+)$/);
  if (taskMatch && taskMatch[1] && taskMatch[2]) {
    if (!isEntityId("topic", taskMatch[1])) return null;
    if (!isEntityId("task", taskMatch[2])) return null;
    return { kind: "task", topicId: taskMatch[1], taskId: taskMatch[2] };
  }

  const topicMatch = base.match(/(?:^|:)clawboard:topic:(topic-[a-zA-Z0-9-]+)$/);
  if (topicMatch && topicMatch[1]) {
    if (!isEntityId("topic", topicMatch[1])) return null;
    return { kind: "topic", topicId: topicMatch[1] };
  }

  return null;
}
