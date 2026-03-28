import type { BoardScope } from "./types.js";

export function normalizeId(value: string | undefined | null) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

export function normalizeRequestId(value: unknown) {
  return normalizeId(typeof value === "string" ? value : undefined);
}

export function inferRequestIdFromMessageId(value: unknown, prefix: string) {
  const candidate = normalizeId(typeof value === "string" ? value : undefined);
  if (!candidate) return undefined;
  return candidate.toLowerCase().startsWith(prefix.toLowerCase()) ? candidate : undefined;
}

export function requestSessionKeys<Route>(
  sessionKey: string | undefined | null,
  helpers: {
    parseBoardSessionKey: (value: string | undefined | null) => Route | null;
    boardSessionRouteToSessionKeys: (route: Route) => string[];
  },
): string[] {
  const normalized = normalizeId(sessionKey);
  if (!normalized) return [];
  const keys = new Set<string>();
  keys.add(normalized);
  const base = normalized.split("|", 1)[0]?.trim() || normalized;
  if (base) keys.add(base);
  const boardRoute = helpers.parseBoardSessionKey(normalized);
  if (boardRoute) {
    for (const canonical of helpers.boardSessionRouteToSessionKeys(boardRoute)) {
      keys.add(canonical);
    }
  }
  return Array.from(keys);
}

export function shortId(value: string, length = 8) {
  const clean = value.replace(/[^a-zA-Z0-9]+/g, "");
  return clean.slice(0, length) || value.slice(0, length);
}

export function parseSubagentSession(sessionKey: string | undefined | null) {
  const key = normalizeId(sessionKey);
  if (!key || !key.startsWith("agent:")) return null;
  const parts = key.split(":");
  if (parts.length < 4) return null;
  const ownerAgentId = normalizeId(parts[1]);
  const subagentIdx = parts.indexOf("subagent");
  if (!ownerAgentId || subagentIdx < 0 || subagentIdx + 1 >= parts.length) return null;
  const subagentId = normalizeId(parts[subagentIdx + 1]);
  if (!subagentId) return null;
  return { ownerAgentId, subagentId };
}

export function parseAgentSessionOwner(sessionKey: string | undefined | null) {
  const key = normalizeId(sessionKey);
  if (!key || !key.startsWith("agent:")) return undefined;
  const parts = key.split(":");
  return normalizeId(parts[1]);
}

export function resolveAgentLabel(agentId?: string | null, sessionKey?: string | null) {
  const fromCtx = agentId && agentId !== "agent" ? agentId : undefined;
  let fromSession: string | undefined;
  if (!fromCtx && sessionKey && sessionKey.startsWith("agent:")) {
    const parts = sessionKey.split(":");
    if (parts.length >= 2) fromSession = parts[1];
  }
  const resolved = fromCtx ?? fromSession;
  if (!resolved || resolved === "main") return "OpenClaw";
  return `Agent ${resolved}`;
}

export function boardScopeFromSessionKey<Route extends { kind: "topic" | "task"; topicId: string; taskId?: string }>(
  sessionKey: string | undefined | null,
  helpers: {
    parseBoardSessionKey: (value: string | undefined | null) => Route | null;
    nowMs: () => number;
  },
): BoardScope | undefined {
  const key = normalizeId(sessionKey);
  if (!key) return undefined;
  const route = helpers.parseBoardSessionKey(key);
  if (!route) return undefined;
  if (route.kind === "task" && route.taskId) {
    return {
      topicId: route.topicId,
      taskId: route.taskId,
      kind: "task",
      sessionKey: key,
      inherited: false,
      updatedAt: helpers.nowMs(),
    };
  }
  return {
    topicId: route.topicId,
    kind: "topic",
    sessionKey: key,
    inherited: false,
    updatedAt: helpers.nowMs(),
  };
}
