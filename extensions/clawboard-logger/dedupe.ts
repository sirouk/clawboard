type DedupeDeps = {
  sanitizeMessageContent: (value: string) => string;
  lexicalSimilarity: (a: string, b: string) => number;
  dedupeFingerprint: (value: string) => string;
  nowMs?: () => number;
};

function boundedRemember(set: Set<string>, key: string, maxEntries: number, ttlMs: number) {
  set.add(key);
  if (set.size > maxEntries) {
    const first = set.values().next().value;
    if (first) set.delete(first);
  }
  (setTimeout(() => set.delete(key), ttlMs) as unknown as { unref?: () => void })?.unref?.();
}

export const RECENT_OUTGOING_SESSION_WINDOW_MS = 5 * 60_000;

export function outgoingMessageIdDedupeKey(
  channelId: string | undefined,
  sessionKey: string | undefined | null,
  messageId: string | undefined,
) {
  const mid = String(messageId ?? "").trim();
  if (!mid) return "";
  return `sending:${channelId ?? "nochannel"}:${sessionKey ?? ""}:${mid}`;
}

export function outgoingFingerprintDedupeKey(
  channelId: string | undefined,
  sessionKey: string | undefined | null,
  content: string,
  dedupeFingerprint: (value: string) => string,
) {
  return `sending:${channelId ?? "nochannel"}:${sessionKey ?? ""}:fp:${dedupeFingerprint(content)}`;
}

export function incomingFingerprintDedupeKey(
  channelId: string | undefined,
  sessionKey: string | undefined | null,
  content: string,
  dedupeFingerprint: (value: string) => string,
) {
  return `incoming-fp:${channelId ?? "nochannel"}:${sessionKey ?? ""}:${dedupeFingerprint(content)}`;
}

export function transcriptWriteDedupeKey(
  params: {
    channelId?: string;
    sessionKey?: string;
    messageId?: string;
    role?: string;
    toolCallId?: string;
    contentSeed?: string;
  },
  dedupeFingerprint: (value: string) => string,
) {
  if (params.messageId) {
    return `before-write:${params.channelId ?? "nochannel"}:${params.sessionKey ?? ""}:${params.messageId}`;
  }
  const seed = [
    params.channelId ?? "nochannel",
    params.sessionKey ?? "",
    params.role ?? "",
    params.toolCallId ?? "",
    dedupeFingerprint(params.contentSeed ?? ""),
  ].join("|");
  return `before-write:fp:${seed}`;
}

export function toolResultPersistDedupeKey(
  params: {
    channelId?: string;
    sessionKey?: string;
    toolCallId?: string;
    messageId?: string;
    toolName?: string;
    contentSeed?: string;
  },
  dedupeFingerprint: (value: string) => string,
) {
  if (params.toolCallId) {
    return `tool-persist:${params.channelId ?? "nochannel"}:${params.sessionKey ?? ""}:${params.toolCallId}`;
  }
  if (params.messageId) {
    return `tool-persist:${params.channelId ?? "nochannel"}:${params.sessionKey ?? ""}:${params.messageId}`;
  }
  const seed = [
    params.channelId ?? "nochannel",
    params.sessionKey ?? "",
    params.toolName ?? "",
    dedupeFingerprint(params.contentSeed ?? ""),
  ].join("|");
  return `tool-persist:fp:${seed}`;
}

export function createDedupeState(deps: DedupeDeps) {
  const nowMs = deps.nowMs ?? Date.now;
  const recentOutgoing = new Set<string>();
  const recentIncoming = new Set<string>();
  const recentTranscriptWrites = new Set<string>();
  const recentToolResultPersist = new Set<string>();
  const recentOutgoingBySession = new Map<string, { ts: number; content: string }>();

  function dedupeSessionKey(sessionKey: string | undefined | null) {
    const raw = String(sessionKey ?? "").trim();
    if (!raw) return "";
    return raw.split("|", 1)[0] ?? raw;
  }

  function rememberOutgoing(key: string) {
    boundedRemember(recentOutgoing, key, 200, 30_000);
  }

  function rememberIncoming(key: string, ttlMs = 30_000) {
    boundedRemember(recentIncoming, key, 200, ttlMs);
  }

  function rememberTranscriptWrite(key: string, ttlMs = 60_000) {
    boundedRemember(recentTranscriptWrites, key, 400, ttlMs);
  }

  function rememberToolResultPersist(key: string, ttlMs = 90_000) {
    boundedRemember(recentToolResultPersist, key, 500, ttlMs);
  }

  function rememberOutgoingSession(sessionKey: string | undefined | null, content?: string) {
    const key = dedupeSessionKey(sessionKey);
    if (!key) return;
    const now = nowMs();
    recentOutgoingBySession.set(key, { ts: now, content: deps.sanitizeMessageContent(content ?? "") });
    for (const [known, row] of recentOutgoingBySession) {
      if (now - row.ts > RECENT_OUTGOING_SESSION_WINDOW_MS) recentOutgoingBySession.delete(known);
    }
  }

  function recentOutgoingSession(sessionKey: string | undefined | null) {
    const key = dedupeSessionKey(sessionKey);
    if (!key) return undefined;
    const row = recentOutgoingBySession.get(key);
    if (!row) return undefined;
    const now = nowMs();
    if (now - row.ts > RECENT_OUTGOING_SESSION_WINDOW_MS) {
      recentOutgoingBySession.delete(key);
      return undefined;
    }
    return row;
  }

  function looksLikeRecentBoardAssistantEcho(sessionKey: string | undefined | null, content: string) {
    const recent = recentOutgoingSession(sessionKey);
    if (!recent?.content) return false;
    const clean = deps.sanitizeMessageContent(content);
    if (!clean) return false;
    if (clean === recent.content) return true;
    if (clean.includes(recent.content) || recent.content.includes(clean)) return true;
    return deps.lexicalSimilarity(clean, recent.content) >= 0.6;
  }

  return {
    recentOutgoing,
    recentIncoming,
    recentTranscriptWrites,
    recentToolResultPersist,
    dedupeSessionKey,
    rememberOutgoing,
    rememberIncoming,
    rememberTranscriptWrite,
    rememberToolResultPersist,
    rememberOutgoingSession,
    recentOutgoingSession,
    looksLikeRecentBoardAssistantEcho,
    outgoingFingerprintDedupeKey: (
      channelId: string | undefined,
      sessionKey: string | undefined | null,
      content: string,
    ) => outgoingFingerprintDedupeKey(channelId, sessionKey, content, deps.dedupeFingerprint),
    incomingFingerprintDedupeKey: (
      channelId: string | undefined,
      sessionKey: string | undefined | null,
      content: string,
    ) => incomingFingerprintDedupeKey(channelId, sessionKey, content, deps.dedupeFingerprint),
    transcriptWriteDedupeKey: (params: Parameters<typeof transcriptWriteDedupeKey>[0]) =>
      transcriptWriteDedupeKey(params, deps.dedupeFingerprint),
    toolResultPersistDedupeKey: (params: Parameters<typeof toolResultPersistDedupeKey>[0]) =>
      toolResultPersistDedupeKey(params, deps.dedupeFingerprint),
  };
}
