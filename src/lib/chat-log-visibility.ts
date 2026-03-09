import type { LogEntry } from "@/lib/types";

const CHAT_TOOLING_LOG_TYPES = new Set(["action", "system", "import"]);
const CHAT_PERSISTENCE_PREFIXES = ["transcript write:", "tool result persisted:"];
const CHAT_ASSISTANT_CONTROL_MARKERS = new Set(["heartbeat_ok", "same recovery event already handled"]);

function normalizeChatVisibilityText(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function combinedChatVisibilityText(entry: LogEntry) {
  return normalizeChatVisibilityText(entry.summary || entry.content || entry.raw || "");
}

export function isToolingOrSystemChatLog(entry: LogEntry) {
  const type = String(entry.type ?? "").trim().toLowerCase();
  if (CHAT_TOOLING_LOG_TYPES.has(type)) return true;
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  return agentId === "system";
}

export function isAgentConversationChatLog(entry: LogEntry) {
  if (String(entry.type ?? "").trim().toLowerCase() !== "conversation") return false;
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  return Boolean(agentId) && agentId !== "user" && agentId !== "system";
}

export function isChatPersistenceNoiseLog(entry: LogEntry) {
  if (String(entry.type ?? "").trim().toLowerCase() !== "action") return false;
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  if (agentId === "toolresult") return true;
  const text = combinedChatVisibilityText(entry);
  return CHAT_PERSISTENCE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function isAssistantControlNoiseLog(entry: LogEntry) {
  if (String(entry.type ?? "").trim().toLowerCase() !== "conversation") return false;
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  if (agentId !== "assistant") return false;
  return CHAT_ASSISTANT_CONTROL_MARKERS.has(combinedChatVisibilityText(entry));
}

export function isChatNoiseLog(entry: LogEntry) {
  return isChatPersistenceNoiseLog(entry) || isAssistantControlNoiseLog(entry);
}

export function isMeaningfulToolingOrSystemChatLog(entry: LogEntry) {
  return isToolingOrSystemChatLog(entry) && !isChatNoiseLog(entry);
}
