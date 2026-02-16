export const DEFAULT_IGNORE_SESSION_PREFIXES = [
    "internal:clawboard-classifier:",
    "agent:main:cron:",
];
export function parseIgnoreSessionPrefixes(raw) {
    if (typeof raw !== "string" || raw.trim().length === 0)
        return [...DEFAULT_IGNORE_SESSION_PREFIXES];
    const parsed = raw
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    return parsed.length ? parsed : [...DEFAULT_IGNORE_SESSION_PREFIXES];
}
export function getIgnoreSessionPrefixesFromEnv(env) {
    return parseIgnoreSessionPrefixes(env.CLAWBOARD_LOGGER_IGNORE_SESSION_PREFIXES);
}
export function shouldIgnoreSessionKey(sessionKey, prefixes = [...DEFAULT_IGNORE_SESSION_PREFIXES]) {
    const key = (sessionKey ?? "").trim().toLowerCase();
    if (!key)
        return false;
    for (const prefix of prefixes) {
        const normalizedPrefix = String(prefix ?? "").trim().toLowerCase();
        if (!normalizedPrefix)
            continue;
        if (key.startsWith(normalizedPrefix))
            return true;
        // Some components may wrap the session key (e.g. `agent:main:<key>`).
        if (key.includes(`:${normalizedPrefix}`))
            return true;
    }
    return false;
}
