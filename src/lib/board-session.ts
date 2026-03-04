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
  const taskIdx = withoutThread.indexOf(BOARD_TASK_SESSION_PREFIX);
  if (taskIdx >= 0) {
    return withoutThread.slice(taskIdx);
  }

  return "";
}

export function taskSessionKey(topicId: string, taskId: string) {
  return `${BOARD_TASK_SESSION_PREFIX}${topicId}:${taskId}`;
}

// Topic Chat is removed in hard-cut mode; this helper is kept as a no-op for
// dead-code compatibility until all guarded UI branches are deleted.
export function topicSessionKey(_topicId: string) {
  return "";
}

export function isBoardSessionKey(value: string | undefined | null) {
  return Boolean(normalizeBoardSessionKey(value));
}
