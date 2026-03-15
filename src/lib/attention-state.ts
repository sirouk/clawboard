import {
  boardSessionTopicIdFromSessionKey,
  effectiveLogTopicId,
} from "@/lib/board-session";
import type { LogEntry } from "@/lib/types";

export const UNSNOOZED_TOPICS_KEY = "clawboard.unified.unsnoozedTopics";
export const CHAT_SEEN_AT_KEY = "clawboard.unified.chatSeenAt";

export function chatKeyForTopic(topicId: string) {
  const id = String(topicId ?? "").trim();
  return id ? `topic:${id}` : "";
}

export function chatKeyFromSessionKey(sessionKey: string) {
  const topicId = boardSessionTopicIdFromSessionKey(sessionKey);
  return chatKeyForTopic(topicId);
}

export function chatKeyFromLogEntry(entry: Pick<LogEntry, "topicId" | "source">) {
  return chatKeyForTopic(effectiveLogTopicId(entry));
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

/** @deprecated Use UNSNOOZED_TOPICS_KEY */
export const UNSNOOZED_TASKS_KEY = UNSNOOZED_TOPICS_KEY;

/** @deprecated Use chatKeyForTopic */
export const chatKeyForTask = chatKeyForTopic;

export function isUnreadConversationCandidate(entry: LogEntry) {
  if (entry.type !== "conversation") return false;
  const chatKey = chatKeyFromLogEntry(entry);
  if (!chatKey) return false;
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  if (agentId) return agentId !== "user" && agentId !== "system";
  const speakerId = String(entry.source?.speakerId ?? "").trim().toLowerCase();
  if (speakerId) return speakerId !== "user" && speakerId !== "system";
  return false;
}
