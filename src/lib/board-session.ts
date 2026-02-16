export const BOARD_TOPIC_SESSION_PREFIX = "clawboard:topic:" as const;
export const BOARD_TASK_SESSION_PREFIX = "clawboard:task:" as const;

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

  const taskIdx = withoutThread.indexOf(BOARD_TASK_SESSION_PREFIX);
  if (taskIdx >= 0) {
    return withoutThread.slice(taskIdx);
  }

  return "";
}

export function topicSessionKey(topicId: string) {
  return `${BOARD_TOPIC_SESSION_PREFIX}${topicId}`;
}

export function taskSessionKey(topicId: string, taskId: string) {
  return `${BOARD_TASK_SESSION_PREFIX}${topicId}:${taskId}`;
}

export function isBoardSessionKey(value: string | undefined | null) {
  return Boolean(normalizeBoardSessionKey(value));
}
