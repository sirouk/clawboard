function boundedRemember(set, key, maxEntries, ttlMs) {
    set.add(key);
    if (set.size > maxEntries) {
        const first = set.values().next().value;
        if (first)
            set.delete(first);
    }
    setTimeout(() => set.delete(key), ttlMs)?.unref?.();
}
export const RECENT_OUTGOING_SESSION_WINDOW_MS = 5 * 60_000;
export function outgoingMessageIdDedupeKey(channelId, sessionKey, messageId) {
    const mid = String(messageId ?? "").trim();
    if (!mid)
        return "";
    return `sending:${channelId ?? "nochannel"}:${sessionKey ?? ""}:${mid}`;
}
export function outgoingFingerprintDedupeKey(channelId, sessionKey, content, dedupeFingerprint) {
    return `sending:${channelId ?? "nochannel"}:${sessionKey ?? ""}:fp:${dedupeFingerprint(content)}`;
}
export function incomingFingerprintDedupeKey(channelId, sessionKey, content, dedupeFingerprint) {
    return `incoming-fp:${channelId ?? "nochannel"}:${sessionKey ?? ""}:${dedupeFingerprint(content)}`;
}
export function transcriptWriteDedupeKey(params, dedupeFingerprint) {
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
export function toolResultPersistDedupeKey(params, dedupeFingerprint) {
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
export function createDedupeState(deps) {
    const nowMs = deps.nowMs ?? Date.now;
    const recentOutgoing = new Set();
    const recentIncoming = new Set();
    const recentTranscriptWrites = new Set();
    const recentToolResultPersist = new Set();
    const recentOutgoingBySession = new Map();
    function dedupeSessionKey(sessionKey) {
        const raw = String(sessionKey ?? "").trim();
        if (!raw)
            return "";
        return raw.split("|", 1)[0] ?? raw;
    }
    function rememberOutgoing(key) {
        boundedRemember(recentOutgoing, key, 200, 30_000);
    }
    function rememberIncoming(key, ttlMs = 30_000) {
        boundedRemember(recentIncoming, key, 200, ttlMs);
    }
    function rememberTranscriptWrite(key, ttlMs = 60_000) {
        boundedRemember(recentTranscriptWrites, key, 400, ttlMs);
    }
    function rememberToolResultPersist(key, ttlMs = 90_000) {
        boundedRemember(recentToolResultPersist, key, 500, ttlMs);
    }
    function rememberOutgoingSession(sessionKey, content) {
        const key = dedupeSessionKey(sessionKey);
        if (!key)
            return;
        const now = nowMs();
        recentOutgoingBySession.set(key, { ts: now, content: deps.sanitizeMessageContent(content ?? "") });
        for (const [known, row] of recentOutgoingBySession) {
            if (now - row.ts > RECENT_OUTGOING_SESSION_WINDOW_MS)
                recentOutgoingBySession.delete(known);
        }
    }
    function recentOutgoingSession(sessionKey) {
        const key = dedupeSessionKey(sessionKey);
        if (!key)
            return undefined;
        const row = recentOutgoingBySession.get(key);
        if (!row)
            return undefined;
        const now = nowMs();
        if (now - row.ts > RECENT_OUTGOING_SESSION_WINDOW_MS) {
            recentOutgoingBySession.delete(key);
            return undefined;
        }
        return row;
    }
    function looksLikeRecentBoardAssistantEcho(sessionKey, content) {
        const recent = recentOutgoingSession(sessionKey);
        if (!recent?.content)
            return false;
        const clean = deps.sanitizeMessageContent(content);
        if (!clean)
            return false;
        if (clean === recent.content)
            return true;
        if (clean.includes(recent.content) || recent.content.includes(clean))
            return true;
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
        outgoingFingerprintDedupeKey: (channelId, sessionKey, content) => outgoingFingerprintDedupeKey(channelId, sessionKey, content, deps.dedupeFingerprint),
        incomingFingerprintDedupeKey: (channelId, sessionKey, content) => incomingFingerprintDedupeKey(channelId, sessionKey, content, deps.dedupeFingerprint),
        transcriptWriteDedupeKey: (params) => transcriptWriteDedupeKey(params, deps.dedupeFingerprint),
        toolResultPersistDedupeKey: (params) => toolResultPersistDedupeKey(params, deps.dedupeFingerprint),
    };
}
