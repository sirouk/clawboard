import type { LogEntry, OpenClawWorkspace } from "@/lib/types";
import { normalizeBoardSessionKey, taskSessionKey } from "@/lib/board-session";
import { isChatNoiseLog, isMeaningfulToolingOrSystemChatLog } from "@/lib/chat-log-visibility";

export const ORCHESTRATION_TERMINAL_RUN_STATUSES = new Set(["done", "failed", "cancelled"]);
export const ORCHESTRATION_KNOWN_RUN_STATUSES = new Set(["running", "stalled", "done", "failed", "cancelled"]);

export type SessionOrchestrationWork = {
  active: boolean;
  requestId?: string;
  reason?: string;
  activeItems?: number;
  waitingItemKeys?: string[];
  lastActivityAt?: string;
  updatedAt: string;
};

export type SessionThreadWorkSignal = {
  active: boolean;
  requestId?: string;
  reason?: string;
  runId?: string;
  activeItems?: number;
  waitingItemKeys?: string[];
  lastActivityAt?: string;
  updatedAt: string;
};

export type SessionNonUserActivity = {
  updatedAt: string;
  requestId?: string;
};

export type SessionWorkTtls = {
  orchestrationActiveTtlMs: number;
  nonUserActivityTtlMs: number;
  threadWorkActiveTtlMs: number;
  threadWorkInactiveOverrideTtlMs: number;
};

function isTruthyFlag(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function isFalseFlag(value: unknown) {
  return value === false || value === "false" || value === 0 || value === "0";
}

export function parseIsoMs(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function normalizeOpenClawRequestId(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!text.toLowerCase().startsWith("occhat-")) return text;
  const base = text.split(":", 1)[0]?.trim() ?? "";
  return base || text;
}

export function isTerminalSystemRequestEvent(entry: LogEntry) {
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  if (agentId !== "system") return false;
  const type = String(entry.type ?? "").trim().toLowerCase();
  if (type !== "system") return false;
  const source = (entry.source && typeof entry.source === "object" ? entry.source : {}) as Record<string, unknown>;
  if (isTruthyFlag(source.watchdogMissingAssistant)) return false;
  if (isFalseFlag(source.requestTerminal)) return false;
  return true;
}

export function compareLogCreatedAtAsc(a: LogEntry, b: LogEntry) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  const aKey = a.idempotencyKey ?? a.id;
  const bKey = b.idempotencyKey ?? b.id;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

export function compareLogCreatedAtDesc(a: LogEntry, b: LogEntry) {
  return compareLogCreatedAtAsc(b, a);
}

export function requestIdForLogEntry(entry: LogEntry) {
  const source = (entry.source && typeof entry.source === "object" ? entry.source : {}) as Record<string, unknown>;
  const requestId = normalizeOpenClawRequestId(source.requestId);
  if (requestId) return requestId;
  return normalizeOpenClawRequestId(source.messageId);
}

function isNonUserActivityChatLog(entry: LogEntry) {
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  if (!agentId || agentId === "user" || agentId === "assistant") return false;
  if (isTerminalSystemRequestEvent(entry)) return false;
  if (isChatNoiseLog(entry)) return false;
  if (isMeaningfulToolingOrSystemChatLog(entry)) return true;
  return String(entry.type ?? "").trim().toLowerCase() === "conversation";
}

function parseOrchestrationActiveItems(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function parseOrchestrationWaitingItemKeys(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 6);
  }

  const text = String(value ?? "").trim();
  if (!text) return [];

  const quoted = Array.from(text.matchAll(/['"]([^'"]+)['"]/g))
    .map((match) => String(match[1] ?? "").trim())
    .filter(Boolean);
  if (quoted.length > 0) return quoted.slice(0, 6);

  if (text.startsWith("[") && text.endsWith("]")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((part) => part.replace(/^['"]|['"]$/g, "").trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  return [text];
}

export function buildRecentNonUserActivityIndex(logs: LogEntry[]): Record<string, SessionNonUserActivity> {
  const out: Record<string, SessionNonUserActivity> = {};
  for (const entry of logs) {
    if (!isNonUserActivityChatLog(entry)) continue;
    const sessionKey = normalizeBoardSessionKey(entry.source?.sessionKey);
    if (!sessionKey) continue;
    const stamp = String(entry.createdAt ?? "").trim();
    if (!stamp) continue;
    const stampMs = parseIsoMs(stamp);
    const current = out[sessionKey];
    const currentMs = parseIsoMs(current?.updatedAt);
    if (Number.isFinite(currentMs) && Number.isFinite(stampMs) && stampMs < currentMs) continue;
    if (Number.isFinite(currentMs) && !Number.isFinite(stampMs)) continue;
    const requestId = requestIdForLogEntry(entry);
    out[sessionKey] = {
      updatedAt: stamp,
      requestId: requestId || current?.requestId || undefined,
    };
  }
  return out;
}

function normalizeOrchestrationRunStatus(value: unknown) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!status) return "";
  return ORCHESTRATION_KNOWN_RUN_STATUSES.has(status) ? status : "";
}

function inferOrchestrationRunStatus(entry: LogEntry, source: Record<string, unknown>, previousStatus: string) {
  const direct = normalizeOrchestrationRunStatus(source.runStatus);
  if (direct) return direct;

  const eventType = String(source.eventType ?? "").trim().toLowerCase();
  if (eventType === "run_created") return "running";
  if (eventType !== "run_status_changed") return previousStatus || "running";

  const haystack = `${String(entry.summary ?? "")} ${String(entry.content ?? "")}`.toLowerCase();
  if (haystack.includes("cancelled")) return "cancelled";
  if (haystack.includes("failed")) return "failed";
  if (haystack.includes("stalled")) return "stalled";
  if (haystack.includes("done")) return "done";
  return previousStatus || "running";
}

export function buildOrchestrationThreadWorkIndex(logs: LogEntry[]): Record<string, SessionOrchestrationWork> {
  const byRun = new Map<
    string,
    {
      status: string;
      requestId?: string;
      reason?: string;
      activeItems?: number;
      waitingItemKeys: string[];
      lastActivityAt?: string;
      updatedAt: string;
      updatedAtMs: number;
      sessionKeys: Set<string>;
      activeItemKeys: Set<string>;
    }
  >();
  const ascending = [...logs].sort(compareLogCreatedAtAsc);

  for (const entry of ascending) {
    const source = (entry.source && typeof entry.source === "object" ? entry.source : {}) as Record<string, unknown>;
    if (!isTruthyFlag(source.orchestration)) continue;
    const runId = String(source.runId ?? "").trim();
    if (!runId) continue;

    const next = byRun.get(runId) ?? {
      status: "running",
      requestId: undefined,
      reason: "orchestration_running",
      activeItems: undefined,
      waitingItemKeys: [],
      lastActivityAt: undefined,
      updatedAt: "",
      updatedAtMs: Number.NEGATIVE_INFINITY,
      sessionKeys: new Set<string>(),
      activeItemKeys: new Set<string>(),
    };

    const sourceSessionKey = normalizeBoardSessionKey(String(source.sessionKey ?? ""));
    if (sourceSessionKey) next.sessionKeys.add(sourceSessionKey);
    const scopedBoardSessionKey = normalizeBoardSessionKey(String(source.boardScopeSessionKey ?? ""));
    if (scopedBoardSessionKey) next.sessionKeys.add(scopedBoardSessionKey);

    const boardTopicId = String(source.boardScopeTopicId ?? entry.topicId ?? "").trim();
    const boardTaskId = String(source.boardScopeTaskId ?? "").trim();
    if (boardTopicId) {
      next.sessionKeys.add(taskSessionKey(boardTopicId, boardTaskId || boardTopicId));
    }

    const requestId = normalizeOpenClawRequestId(source.requestId ?? source.messageId);
    if (requestId) next.requestId = requestId;

    next.status = inferOrchestrationRunStatus(entry, source, next.status);
    next.reason = next.status === "stalled" ? "orchestration_stalled" : "orchestration_running";
    const eventType = String(source.eventType ?? "").trim().toLowerCase();
    const itemKey = String(source.itemKey ?? "").trim();
    const tracksItem = itemKey && itemKey.toLowerCase() !== "main.response";
    if (tracksItem && (eventType === "item_created" || eventType === "item_stalled" || eventType === "item_resumed")) {
      next.activeItemKeys.add(itemKey);
    }
    if (tracksItem && (eventType === "item_done" || eventType === "item_failed" || eventType === "item_cancelled")) {
      next.activeItemKeys.delete(itemKey);
    }

    const eventPayload =
      source.eventPayload && typeof source.eventPayload === "object"
        ? (source.eventPayload as Record<string, unknown>)
        : {};
    const payloadWaitingKeys = parseOrchestrationWaitingItemKeys(eventPayload.waitingItemKeys);
    const payloadActiveItems = parseOrchestrationActiveItems(eventPayload.activeItems);
    if (payloadWaitingKeys.length > 0) {
      next.waitingItemKeys = payloadWaitingKeys;
      next.activeItemKeys = new Set(payloadWaitingKeys);
      next.activeItems = payloadActiveItems ?? payloadWaitingKeys.length;
    } else {
      next.waitingItemKeys = Array.from(next.activeItemKeys).slice(0, 6);
      if (payloadActiveItems !== undefined) {
        next.activeItems = payloadActiveItems;
      } else if (next.activeItemKeys.size > 0 || tracksItem || eventType.startsWith("item_")) {
        next.activeItems = next.activeItemKeys.size;
      }
    }

    const stamp = String(entry.createdAt ?? "").trim();
    const stampMs = Date.parse(stamp);
    const normalizedStampMs = Number.isFinite(stampMs) ? stampMs : Number.NEGATIVE_INFINITY;
    if (!next.updatedAt || normalizedStampMs >= next.updatedAtMs) {
      next.updatedAt = stamp;
      next.updatedAtMs = normalizedStampMs;
    }
    if (stamp) next.lastActivityAt = stamp;

    byRun.set(runId, next);
  }

  type SessionAgg = {
    active: boolean;
    latestAnyAt: string;
    latestAnyMs: number;
    latestAnyRequestId?: string;
    latestActiveMs: number;
    latestActiveRequestId?: string;
    latestActiveReason?: string;
    latestActiveItems?: number;
    latestActiveWaitingItemKeys?: string[];
    latestActiveAt?: string;
  };

  const bySession = new Map<string, SessionAgg>();
  for (const runState of byRun.values()) {
    const active = !ORCHESTRATION_TERMINAL_RUN_STATUSES.has(runState.status);
    for (const sessionKey of runState.sessionKeys) {
      const key = normalizeBoardSessionKey(sessionKey);
      if (!key) continue;
      const agg = bySession.get(key) ?? {
        active: false,
        latestAnyAt: "",
        latestAnyMs: Number.NEGATIVE_INFINITY,
        latestAnyRequestId: undefined,
        latestActiveMs: Number.NEGATIVE_INFINITY,
        latestActiveRequestId: undefined,
        latestActiveReason: undefined,
        latestActiveItems: undefined,
        latestActiveWaitingItemKeys: undefined,
        latestActiveAt: undefined,
      };

      agg.active = agg.active || active;
      if (runState.updatedAtMs >= agg.latestAnyMs) {
        agg.latestAnyMs = runState.updatedAtMs;
        agg.latestAnyAt = runState.updatedAt;
        agg.latestAnyRequestId = runState.requestId || agg.latestAnyRequestId;
      }
      if (active && runState.updatedAtMs >= agg.latestActiveMs) {
        agg.latestActiveMs = runState.updatedAtMs;
        agg.latestActiveRequestId = runState.requestId || agg.latestActiveRequestId;
        agg.latestActiveReason = runState.reason || agg.latestActiveReason;
        agg.latestActiveItems = runState.activeItems;
        agg.latestActiveWaitingItemKeys = runState.waitingItemKeys;
        agg.latestActiveAt = runState.lastActivityAt || runState.updatedAt;
      }
      bySession.set(key, agg);
    }
  }

  const out: Record<string, SessionOrchestrationWork> = {};
  for (const [sessionKey, agg] of bySession.entries()) {
    out[sessionKey] = {
      active: agg.active,
      requestId: agg.latestActiveRequestId || agg.latestAnyRequestId,
      reason: agg.latestActiveReason,
      activeItems: agg.latestActiveItems,
      waitingItemKeys: agg.latestActiveWaitingItemKeys,
      lastActivityAt: agg.latestActiveAt,
      updatedAt: agg.latestAnyAt,
    };
  }
  return out;
}

export function resolveThreadWorkSignal(
  signal: SessionThreadWorkSignal | undefined,
  params: { latestOtherSignalMs: number; nowMs: number },
  ttls: Pick<SessionWorkTtls, "threadWorkActiveTtlMs" | "threadWorkInactiveOverrideTtlMs">
): boolean | undefined {
  if (!signal) return undefined;
  const { latestOtherSignalMs, nowMs } = params;
  const signalMs = threadWorkSignalFreshMs(signal);
  if (!Number.isFinite(signalMs)) return undefined;
  const ageMs = nowMs - signalMs;
  const ttlMs = signal.active ? ttls.threadWorkActiveTtlMs : ttls.threadWorkInactiveOverrideTtlMs;
  if (ageMs < 0 || ageMs > ttlMs) return undefined;
  if (!signal.active && Number.isFinite(latestOtherSignalMs) && latestOtherSignalMs > signalMs) return undefined;
  return signal.active;
}

export function threadWorkSignalFreshMs(signal: SessionThreadWorkSignal | undefined) {
  return Math.max(parseIsoMs(signal?.updatedAt), parseIsoMs(signal?.lastActivityAt));
}

export function resolveAuthoritativeSessionWorkState(
  params: {
    nowMs: number;
    typing: { typing?: boolean; requestId?: string; updatedAt?: string } | undefined;
    threadWorkSignal: SessionThreadWorkSignal | undefined;
    orchestrationWork: SessionOrchestrationWork | undefined;
    recentNonUserActivity: SessionNonUserActivity | undefined;
  },
  ttls: SessionWorkTtls
) {
  const { nowMs, typing, threadWorkSignal, orchestrationWork, recentNonUserActivity } = params;
  const orchestrationWorkMs = parseIsoMs(orchestrationWork?.updatedAt);
  const hasFreshOrchestrationWork =
    Boolean(orchestrationWork?.active) &&
    Number.isFinite(orchestrationWorkMs) &&
    nowMs - orchestrationWorkMs >= 0 &&
    nowMs - orchestrationWorkMs <= ttls.orchestrationActiveTtlMs;
  const recentNonUserActivityMs = parseIsoMs(recentNonUserActivity?.updatedAt);
  const hasRecentNonUserActivity =
    Number.isFinite(recentNonUserActivityMs) &&
    nowMs - recentNonUserActivityMs >= 0 &&
    nowMs - recentNonUserActivityMs <= ttls.nonUserActivityTtlMs;
  const threadWorkSignalMs = threadWorkSignalFreshMs(threadWorkSignal);
  const latestOtherSignalMs = Math.max(
    parseIsoMs(typing?.updatedAt),
    hasFreshOrchestrationWork ? orchestrationWorkMs : Number.NaN,
    recentNonUserActivityMs
  );
  const directThreadSignal = resolveThreadWorkSignal(threadWorkSignal, { latestOtherSignalMs, nowMs }, ttls);
  const newerActivityAfterStopSignal =
    hasRecentNonUserActivity &&
    Number.isFinite(threadWorkSignalMs) &&
    Number.isFinite(recentNonUserActivityMs) &&
    recentNonUserActivityMs > threadWorkSignalMs;

  if (directThreadSignal === false) {
    const stopRequestId = normalizeOpenClawRequestId(threadWorkSignal?.requestId);
    const activeRequestId =
      normalizeOpenClawRequestId(typing?.requestId) ||
      normalizeOpenClawRequestId(hasFreshOrchestrationWork ? orchestrationWork?.requestId : "") ||
      normalizeOpenClawRequestId(recentNonUserActivity?.requestId);
    if ((!stopRequestId || !activeRequestId || stopRequestId === activeRequestId) && !newerActivityAfterStopSignal) {
      return false;
    }
  }
  if (directThreadSignal === true) return true;
  if (typing?.typing) return true;
  if (hasFreshOrchestrationWork) return true;
  return false;
}

export function normalizeAgentToken(value: string | undefined | null) {
  return String(value ?? "").trim().toLowerCase();
}

export function deriveTaskWorkspaceAttention(
  entries: LogEntry[],
  workspaceByAgentId: Map<string, OpenClawWorkspace>,
  sessionKey: string,
  seenByKey: Record<string, string>
) {
  const normalizedSessionKey = normalizeBoardSessionKey(sessionKey);
  if (!normalizedSessionKey) return null;

  let latestAny: { workspace: OpenClawWorkspace; agentId: string; activityAt: string; sessionKey: string } | null = null;
  let latestCoding: { workspace: OpenClawWorkspace; agentId: string; activityAt: string; sessionKey: string } | null = null;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const agentId = normalizeAgentToken(entry.agentId);
    if (!agentId || agentId === "user" || agentId === "assistant" || agentId === "system" || agentId === "toolresult") {
      continue;
    }
    if (isChatNoiseLog(entry)) continue;
    const entryType = String(entry.type ?? "").trim().toLowerCase();
    const authenticActivity = isMeaningfulToolingOrSystemChatLog(entry) || entryType === "conversation";
    if (!authenticActivity) continue;
    const workspace = workspaceByAgentId.get(agentId);
    if (!workspace?.ideUrl) continue;
    const activityAt = String(entry.createdAt ?? "").trim();
    if (!activityAt) continue;
    const candidate = { workspace, agentId, activityAt, sessionKey: normalizedSessionKey };
    if (!latestAny) latestAny = candidate;
    if (agentId === "coding") latestCoding = candidate;
    if (latestAny && latestCoding) break;
  }

  const candidates = [latestCoding, latestAny].filter(
    (candidate, index, list): candidate is NonNullable<typeof candidate> =>
      Boolean(candidate) &&
      list.findIndex(
        (other) =>
          other?.agentId === candidate?.agentId &&
          other?.activityAt === candidate?.activityAt &&
          other?.sessionKey === candidate?.sessionKey
      ) === index
  );
  const target = candidates.find((candidate) => {
    const seenKey = `${candidate.sessionKey}::${candidate.agentId}`;
    return seenByKey[seenKey] !== candidate.activityAt;
  });
  if (!target) return null;
  const agentName = String(target.workspace.agentName || "").trim() || target.agentId;
  const label = target.agentId === "coding" ? "Open coding workspace" : `Open ${agentName} workspace`;
  const hint = target.agentId === "coding" ? "Recent coding activity" : `Recent ${agentName} workspace activity`;
  return { ...target, label, hint };
}
