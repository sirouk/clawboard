import {
  BOARD_TASK_SESSION_PREFIX,
  BOARD_TOPIC_SESSION_PREFIX,
  normalizeBoardSessionKey,
} from "@/lib/board-session";
import type { LogEntry } from "@/lib/types";

export const UNSNOOZED_TOPICS_KEY = "clawboard.unified.unsnoozedTopics";
export const UNSNOOZED_TASKS_KEY = "clawboard.unified.unsnoozedTasks";
export const CHAT_SEEN_AT_KEY = "clawboard.unified.chatSeenAt";

export function chatKeyForTopic(topicId: string) {
  const id = String(topicId ?? "").trim();
  return id ? `topic:${id}` : "";
}

export function chatKeyForTask(taskId: string) {
  const id = String(taskId ?? "").trim();
  return id ? `task:${id}` : "";
}

export function chatKeyFromSessionKey(sessionKey: string) {
  const key = normalizeBoardSessionKey(sessionKey);
  if (!key) return "";
  if (key.startsWith(BOARD_TOPIC_SESSION_PREFIX)) {
    const topicId = key.slice(BOARD_TOPIC_SESSION_PREFIX.length).trim();
    return chatKeyForTopic(topicId);
  }
  if (key.startsWith(BOARD_TASK_SESSION_PREFIX)) {
    const rest = key.slice(BOARD_TASK_SESSION_PREFIX.length).trim();
    const parts = rest.split(":", 2);
    const taskId = parts.length === 2 ? parts[1].trim() : "";
    return chatKeyForTask(taskId);
  }
  return "";
}

export function chatKeyFromLogEntry(entry: Pick<LogEntry, "taskId" | "topicId" | "source">) {
  const fromSession = chatKeyFromSessionKey(String(entry.source?.sessionKey ?? ""));
  if (fromSession) return fromSession;
  const taskId = String(entry.taskId ?? "").trim();
  if (taskId) return chatKeyForTask(taskId);
  const topicId = String(entry.topicId ?? "").trim();
  if (topicId) return chatKeyForTopic(topicId);
  return "";
}

export function parseNumberMap(rawValue: string | null | undefined): Record<string, number> {
  try {
    const parsed = JSON.parse(String(rawValue ?? "{}")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = String(key ?? "").trim();
      if (!id) continue;
      const numberValue = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numberValue) || numberValue <= 0) continue;
      out[id] = numberValue;
    }
    return out;
  } catch {
    return {};
  }
}

export function parseStringMap(rawValue: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(String(rawValue ?? "{}")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = String(key ?? "").trim();
      if (!id) continue;
      const stamp = String(value ?? "").trim();
      if (!stamp) continue;
      const parsedMs = Date.parse(stamp);
      if (!Number.isFinite(parsedMs)) continue;
      out[id] = stamp;
    }
    return out;
  } catch {
    return {};
  }
}

export function isUnreadConversationCandidate(entry: LogEntry) {
  if (entry.type !== "conversation") return false;
  const chatKey = chatKeyFromLogEntry(entry);
  if (!chatKey) return false;
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  return agentId !== "user";
}
