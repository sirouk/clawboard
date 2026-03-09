import type { LogEntry } from "@/lib/types";

const CHAT_PERSISTENCE_PREFIXES = ["transcript write:", "tool result persisted:"];
const CHAT_ASSISTANT_CONTROL_MARKERS = new Set(["heartbeat_ok", "same recovery event already handled"]);
const CHAT_ASSISTANT_CONTROL_PREFIXES = [
  "task tracking updated.",
  "task updated with delegation state.",
  "task state updated",
];

function hasSuppressedWaitingStatus(entry: LogEntry) {
  const source = entry.source && typeof entry.source === "object"
    ? (entry.source as Record<string, unknown>)
    : null;
  const value = source?.suppressedWaitingStatus;
  return value === true || value === 1 || String(value ?? "").trim().toLowerCase() === "true";
}

function isLowSignalClosureText(text: string) {
  return (
    text.startsWith("task closed")
    || text.startsWith("done. task closed")
    || text.startsWith("done task closed")
    || text.startsWith("request complete")
    || text.startsWith("done. request complete")
    || text.startsWith("done request complete")
  );
}

function normalizeChatVisibilityText(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function combinedChatVisibilityText(entry: LogEntry) {
  return normalizeChatVisibilityText([entry.summary, entry.content, entry.raw].filter(Boolean).join(" "));
}

function isBriefParallelDispatchText(text: string) {
  return (
    (
      text.includes("dispatching ")
      && text.includes(" specialist")
      && text.includes(" in parallel")
      && text.includes(" now")
    )
    || (
      text.includes("dispatching to both ")
      && text.includes(" in parallel")
      && text.includes("combined answer shortly")
    )
  );
}

function isRedundantPartialSpecialistCompletionText(text: string) {
  return (
    text.includes("specialist ")
    && text.includes(" completed:")
    && (text.includes("still waiting on specialist ") || text.includes("waiting for specialist "))
    && (text.includes("will deliver the combined answer") || text.includes("delivering the combined answer"))
  );
}

export function isToolingOrSystemChatLog(entry: LogEntry) {
  const type = String(entry.type ?? "").trim().toLowerCase();
  if (type === "action" || type === "system" || type === "import") return true;
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
  const text = combinedChatVisibilityText(entry);
  if (text.includes("no_reply") || text.includes("no reply")) return true;
  if (text.includes("no additional action needed") && text.includes("will return results automatically")) return true;
  if (text.includes("will be announced back here when complete")) return true;
  if (text.includes("this is the same request") && text.includes("already dispatched")) return true;
  if (text.includes("both specialists are still running") && text.includes("query them directly")) return true;
  if (text.includes("visibility restrictions prevent cross-agent messaging")) return true;
  if (text.includes("re-spawning fresh specialists")) return true;
  if (text.includes("re-dispatched two fresh")) return true;
  if (text.includes("same request") && text.includes("checking if the two specialists")) return true;
  if (text.includes("let me spawn fresh specialists")) return true;
  if (isBriefParallelDispatchText(text)) return true;
  if (isLowSignalClosureText(text)) return true;
  if (text.startsWith("task updated with delegation state")) return true;
  if (text.startsWith("task tracking updated")) return true;
  if (text.includes("task state updated")) return true;
  if (text.includes("let me check if the ") && text.includes(" specialist has completed")) return true;
  for (const marker of CHAT_ASSISTANT_CONTROL_MARKERS) {
    if (text.includes(marker)) return true;
  }
  return CHAT_ASSISTANT_CONTROL_PREFIXES.some((prefix) => text.includes(prefix));
}

export function isSystemControlNoiseLog(entry: LogEntry) {
  const type = String(entry.type ?? "").trim().toLowerCase();
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  if (type !== "system" || agentId !== "system") return false;
  if (hasSuppressedWaitingStatus(entry)) return true;
  const text = combinedChatVisibilityText(entry);
  if (!text) return false;
  if (text.includes("all tracked work items reached terminal completion.")) return true;
  if (text.startsWith("monitoring active work:")) return true;
  if (text.includes("work item marked done for ")) return true;
  if (text.includes("spawned ") && text.includes(" subagent work item.")) return true;
  if (text.includes(" created. objective:")) return true;
  if (text.includes("dispatched to **")) return true;
  if (text.includes("dispatched two fresh") && text.includes("waiting for results to synthesize")) return true;
  if (isRedundantPartialSpecialistCompletionText(text)) return true;
  return false;
}

export function isChatNoiseLog(entry: LogEntry) {
  return isChatPersistenceNoiseLog(entry) || isAssistantControlNoiseLog(entry) || isSystemControlNoiseLog(entry);
}

export function isMeaningfulToolingOrSystemChatLog(entry: LogEntry) {
  return isToolingOrSystemChatLog(entry) && !isChatNoiseLog(entry);
}
