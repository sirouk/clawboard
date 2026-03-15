import type { LogEntry } from "@/lib/types";

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
  const topicId = boardSessionTopicIdFromSessionKey(value);
  return topicId ? topicSessionKey(topicId) : "";
}

export function topicSessionKey(topicId: string) {
  return `${BOARD_TOPIC_SESSION_PREFIX}${topicId}`;
}

export function boardSessionTopicIdFromSessionKey(value: string | undefined | null) {
  const raw = normalizeRawSessionKey(value);
  if (!raw) return "";

  const withoutThread = stripBoardThreadSuffix(raw);
  const taskIdx = withoutThread.indexOf(BOARD_TASK_SESSION_PREFIX);
  const topicIdx = withoutThread.indexOf(BOARD_TOPIC_SESSION_PREFIX);
  const startIdx =
    taskIdx >= 0 && topicIdx >= 0 ? Math.min(taskIdx, topicIdx) : taskIdx >= 0 ? taskIdx : topicIdx;
  if (startIdx < 0) return "";

  const scoped = withoutThread.slice(startIdx);
  if (scoped.startsWith(BOARD_TASK_SESSION_PREFIX)) {
    const rest = scoped.slice(BOARD_TASK_SESSION_PREFIX.length).trim();
    return rest.split(":", 1)[0]?.trim() ?? "";
  }
  if (scoped.startsWith(BOARD_TOPIC_SESSION_PREFIX)) {
    const rest = scoped.slice(BOARD_TOPIC_SESSION_PREFIX.length).trim();
    return rest.split(":", 1)[0]?.trim() ?? "";
  }
  return "";
}

export function effectiveLogTopicId(entry: Pick<LogEntry, "topicId" | "source">) {
  const scopedTopicId = String(entry.source?.boardScopeTopicId ?? "").trim();
  if (scopedTopicId) return scopedTopicId;

  const fromSession = boardSessionTopicIdFromSessionKey(String(entry.source?.sessionKey ?? ""));
  if (fromSession) return fromSession;

  return String(entry.topicId ?? "").trim();
}

export function isBoardSessionKey(value: string | undefined | null) {
  return Boolean(normalizeBoardSessionKey(value));
}

/** @deprecated Use topicSessionKey. In the flat topology, only topicId is needed. */
export function taskSessionKey(topicId: string, taskId?: string) {
  const resolvedTopicId = String(topicId ?? "").trim() || String(taskId ?? "").trim();
  return resolvedTopicId ? topicSessionKey(resolvedTopicId) : "";
}
