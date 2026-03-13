export const BOARD_TOPIC_SESSION_PREFIX = "clawboard:topic:" as const;

function normalizeRawSessionKey(value: string | undefined | null) {
  return String(value ?? "").trim();
}

function stripBoardThreadSuffix(value: string) {
  const idx = value.indexOf("|");
  return idx >= 0 ? value.slice(0, idx).trim() : value;
}

export function normalizeBoardSessionKey(value: string | undefined | null) {
  const raw = normalizeRawSessionKey(value);
  if (!raw) return "";

  const withoutThread = stripBoardThreadSuffix(raw);
  const topicIdx = withoutThread.indexOf(BOARD_TOPIC_SESSION_PREFIX);
  if (topicIdx >= 0) {
    return withoutThread.slice(topicIdx);
  }

  return "";
}

export function topicSessionKey(topicId: string) {
  return `${BOARD_TOPIC_SESSION_PREFIX}${topicId}`;
}

export function isBoardSessionKey(value: string | undefined | null) {
  return Boolean(normalizeBoardSessionKey(value));
}

/** @deprecated Use topicSessionKey. In the flat topology, only topicId is needed. */
export function taskSessionKey(topicId: string, taskId?: string) {
  const resolvedTopicId = String(taskId ?? "").trim() || String(topicId ?? "").trim();
  return resolvedTopicId ? topicSessionKey(resolvedTopicId) : "";
}
