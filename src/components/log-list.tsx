"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LogEntry, Task, Topic } from "@/lib/types";
import { Badge, Button, Input, SearchInput, Select, TextArea } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { buildTaskUrl, buildTopicUrl, UNIFIED_BASE, withRevealParam, withSpaceParam } from "@/lib/url";
import { useAppConfig } from "@/components/providers";
import { useDataStore } from "@/components/data-provider";
import { apiFetch } from "@/lib/api";
import { useSemanticSearch } from "@/lib/use-semantic-search";
import { compareLogsDesc } from "@/lib/live-utils";
import { Markdown } from "@/components/markdown";
import { AttachmentStrip } from "@/components/attachments";
import { usePersistentDraft } from "@/lib/drafts";

const TYPE_LABELS: Record<string, string> = {
  note: "Note",
  conversation: "Conversation",
  action: "Action",
  system: "System",
  import: "Import",
};

type LaneFilter = "all" | string;
type MessageDensity = "comfortable" | "compact";
type LogListVariant = "cards" | "chat";
type LogPatchPayload = Partial<{
  topicId: string | null;
  taskId: string | null;
  content: string;
  summary: string | null;
  raw: string | null;
}>;
const MESSAGE_TRUNCATE_LIMIT = 220;
const SUMMARY_TRUNCATE_LIMIT = 96;

type ToolEventKind = "call" | "result" | "error";
type ToolEvent = { kind: ToolEventKind; toolName: string };

const TOOL_EVENT_RE = /^(Tool call|Tool result|Tool error)\s*:\s*(.+)\s*$/i;

function parseToolEvent(entry: LogEntry): ToolEvent | null {
  if (entry.type !== "action") return null;
  const label = String(entry.summary ?? entry.content ?? "").trim();
  if (!label) return null;
  const match = label.match(TOOL_EVENT_RE);
  if (!match) return null;
  const kindRaw = match[1]?.trim().toLowerCase();
  const toolName = String(match[2] ?? "").trim();
  if (!toolName) return null;
  const kind: ToolEventKind =
    kindRaw === "tool call" ? "call" : kindRaw === "tool result" ? "result" : "error";
  return { kind, toolName };
}

const logRawCache = new Map<string, string | null>();
const logRawPromiseCache = new Map<string, Promise<string | null>>();

async function fetchLogRaw(logId: string): Promise<string | null> {
  const id = String(logId ?? "").trim();
  if (!id) return null;
  if (logRawCache.has(id)) return logRawCache.get(id) ?? null;
  const inflight = logRawPromiseCache.get(id);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const res = await apiFetch(`/api/log/${encodeURIComponent(id)}?includeRaw=1`, { cache: "no-store" });
      if (!res.ok) return null;
      const payload = (await res.json().catch(() => null)) as { raw?: unknown } | null;
      const raw = typeof payload?.raw === "string" ? payload.raw : null;
      logRawCache.set(id, raw);
      return raw;
    } catch {
      return null;
    } finally {
      logRawPromiseCache.delete(id);
    }
  })();
  logRawPromiseCache.set(id, promise);
  return promise;
}

async function writeClipboardText(text: string) {
  const value = String(text ?? "");
  if (!value) return;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document === "undefined") return;

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function CopyPill({ value, className }: { value: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      disabled={!value.trim()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          try {
            await writeClipboardText(value);
            setState("copied");
          } catch {
            setState("failed");
          } finally {
            if (timerRef.current != null) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => setState("idle"), 1200);
          }
        })();
      }}
      aria-label={state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy message"}
      title={state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      className={`inline-flex items-center gap-1 rounded-full border border-[rgba(255,255,255,0.10)] bg-[rgba(10,12,16,0.35)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[rgba(148,163,184,0.9)] transition hover:border-[rgba(255,90,45,0.35)] hover:text-[rgb(var(--claw-text))] disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ""}`}
    >
      {state === "copied" ? (
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3.5 w-3.5">
          <path
            fillRule="evenodd"
            d="M16.704 5.296a1 1 0 0 1 0 1.414l-7.25 7.25a1 1 0 0 1-1.414 0l-3.25-3.25a1 1 0 1 1 1.414-1.414l2.543 2.543 6.543-6.543a1 1 0 0 1 1.414 0Z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3.5 w-3.5">
          <path d="M6 2a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1v-2H6V4h7v1h2V4a2 2 0 0 0-2-2H6Z" />
          <path d="M9 7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H9Zm0 2h7v9H9V9Z" />
        </svg>
      )}
      <span className="leading-none">{state === "copied" ? "Copied" : "Copy"}</span>
    </button>
  );
}

function normalizeInlineText(value: string | undefined | null) {
  return stripTransportNoise(value ?? "").replace(/\s+/g, " ").trim();
}

function stripTransportNoise(value: string) {
  let text = (value ?? "").replace(/\r\n?/g, "\n").trim();
  text = text.replace(
    /(?:\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]|\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\])\s*/gi,
    " ",
  );
  text = text.replace(/^\s*summary\s*[:\-]\s*/gim, "");
  text = text.replace(/^\[Discord [^\]]+\]\s*/gim, "");
  text = text.replace(/\[message[_\s-]?id:[^\]]+\]/gi, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function truncateText(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function deriveMessageSummary(entry: LogEntry, message: string) {
  const explicitSummary = normalizeInlineText(entry.summary);
  if (explicitSummary) {
    return truncateText(explicitSummary, SUMMARY_TRUNCATE_LIMIT);
  }
  const fallback = normalizeInlineText(message || entry.content || "");
  return fallback ? truncateText(fallback, SUMMARY_TRUNCATE_LIMIT) : "No summary";
}

function areLogsEquivalent(a: LogEntry[], b: LogEntry[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (left.id !== right.id) return false;
    if ((left.updatedAt ?? "") !== (right.updatedAt ?? "")) return false;
    if ((left.createdAt ?? "") !== (right.createdAt ?? "")) return false;
    if ((left.topicId ?? "") !== (right.topicId ?? "")) return false;
    if ((left.taskId ?? "") !== (right.taskId ?? "")) return false;
    if ((left.type ?? "") !== (right.type ?? "")) return false;
    if ((left.classificationStatus ?? "") !== (right.classificationStatus ?? "")) return false;
    if (String(left.summary ?? "").length !== String(right.summary ?? "").length) return false;
    if (String(left.content ?? "").length !== String(right.content ?? "").length) return false;
    if (String(left.raw ?? "").length !== String(right.raw ?? "").length) return false;
  }
  return true;
}

function summarizeText(value: string) {
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length <= 140) return clean;
  return `${clean.slice(0, 139)}…`;
}

const UNKNOWN_DATE_KEY = "__unknown_date__";

function extractDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length < 10) return null;
  return normalized.slice(0, 10);
}

function getEntryDateKey(entry: Pick<LogEntry, "createdAt" | "updatedAt">): string {
  return extractDateKey(entry.createdAt) ?? extractDateKey(entry.updatedAt) ?? UNKNOWN_DATE_KEY;
}

function compareDateKeysDesc(a: string, b: string): number {
  const aUnknown = a === UNKNOWN_DATE_KEY;
  const bUnknown = b === UNKNOWN_DATE_KEY;
  if (aUnknown && bUnknown) return 0;
  if (aUnknown) return 1;
  if (bUnknown) return -1;
  return b.localeCompare(a);
}

function formatDateGroupLabel(dateKey: string): string {
  if (dateKey === UNKNOWN_DATE_KEY) return "Unknown date";
  const parsed = Date.parse(dateKey);
  if (!Number.isFinite(parsed)) return dateKey;
  return new Date(parsed).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function LogList({
  logs: initialLogs,
  topics,
  tasks: tasksOverride,
  scopeTopicId,
  scopeTaskId,
  showFilters = true,
  showRawToggle = true,
  showRawAll: showRawAllOverride,
  onShowRawAllChange,
  allowNotes = false,
  allowDelete = true,
  showDensityToggle = true,
  messageDensity: messageDensityOverride,
  onMessageDensityChange,
  enableNavigation = true,
  initialVisibleCount,
  loadMoreStep,
  initialSearch = "",
  initialTypeFilter = "all",
  initialAgentFilter = "all",
  initialTopicFilter = "all",
  initialLaneFilter = "all",
  variant = "cards",
}: {
  logs: LogEntry[];
  topics: Topic[];
  tasks?: Task[];
  scopeTopicId?: string | null;
  scopeTaskId?: string | null;
  showFilters?: boolean;
  showRawToggle?: boolean;
  showRawAll?: boolean;
  onShowRawAllChange?: (value: boolean) => void;
  allowNotes?: boolean;
  allowDelete?: boolean;
  showDensityToggle?: boolean;
  messageDensity?: MessageDensity;
  onMessageDensityChange?: (value: MessageDensity) => void;
  enableNavigation?: boolean;
  initialVisibleCount?: number;
  loadMoreStep?: number;
  initialSearch?: string;
  initialTypeFilter?: string;
  initialAgentFilter?: string;
  initialTopicFilter?: string;
  initialLaneFilter?: LaneFilter;
  variant?: LogListVariant;
}) {
  const { token, tokenRequired } = useAppConfig();
  const { setLogs: setStoreLogs } = useDataStore();
  const [logs, setLogs] = useState<LogEntry[]>(initialLogs);
  const [tasksCache, setTasksCache] = useState<Record<string, Task[]>>({});
  const [tasksLoading, setTasksLoading] = useState<Record<string, boolean>>({});
  const [topicFilter, setTopicFilter] = useState(initialTopicFilter || "all");
  const [typeFilter, setTypeFilter] = useState(initialTypeFilter || "all");
  const [agentFilter, setAgentFilter] = useState(initialAgentFilter || "all");
  const [laneFilter, setLaneFilter] = useState<LaneFilter>(initialLaneFilter || "all");
  const [search, setSearch] = useState(initialSearch || "");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [localShowRawAll, setLocalShowRawAll] = useState(true);
  const [localMessageDensity, setLocalMessageDensity] = useState<MessageDensity>("comfortable");
  const [groupByDay, setGroupByDay] = useState(variant !== "chat");
  const loadMoreEnabled = Boolean(initialVisibleCount && initialVisibleCount > 0 && loadMoreStep && loadMoreStep > 0);
  const [visibleCount, setVisibleCount] = useState(() => (loadMoreEnabled ? initialVisibleCount! : 0));
  const [collapsedDays, setCollapsedDays] = useState<Record<string, boolean>>(() => {
    if (variant === "chat") return {};
    if (initialLogs.length === 0) return {};
    const dates = Array.from(new Set(initialLogs.map((entry) => getEntryDateKey(entry)))).sort(compareDateKeysDesc);
    if (dates.length === 0) return {};
    const mostRecent = dates[0];
    return dates.reduce<Record<string, boolean>>((acc, date) => {
      acc[date] = date !== mostRecent;
      return acc;
    }, {});
  });

  const showRawAll = typeof showRawAllOverride === "boolean" ? showRawAllOverride : localShowRawAll;
  const setShowRawAll = typeof showRawAllOverride === "boolean" ? onShowRawAllChange ?? (() => undefined) : setLocalShowRawAll;
  const messageDensity = messageDensityOverride ?? localMessageDensity;
  const setMessageDensity =
    messageDensityOverride !== undefined ? onMessageDensityChange ?? (() => undefined) : setLocalMessageDensity;
  const lastInitialLogsRef = useRef(initialLogs);

  const matchesLane = (entry: LogEntry, lane: LaneFilter) => {
    if (lane === "all") return true;
    const label = entry.agentLabel || entry.agentId || "Unknown";
    return label === lane;
  };

  useEffect(() => {
    if (areLogsEquivalent(lastInitialLogsRef.current, initialLogs)) return;
    lastInitialLogsRef.current = initialLogs;
    setLogs(initialLogs);
  }, [initialLogs]);

  useEffect(() => {
    const next = initialSearch || "";
    setSearch((prev) => (prev === next ? prev : next));
  }, [initialSearch]);

  useEffect(() => {
    const next = initialTypeFilter || "all";
    setTypeFilter((prev) => (prev === next ? prev : next));
  }, [initialTypeFilter]);

  useEffect(() => {
    const next = initialAgentFilter || "all";
    setAgentFilter((prev) => (prev === next ? prev : next));
  }, [initialAgentFilter]);

  useEffect(() => {
    const next = initialTopicFilter || "all";
    setTopicFilter((prev) => (prev === next ? prev : next));
  }, [initialTopicFilter]);

  useEffect(() => {
    const next = initialLaneFilter || "all";
    setLaneFilter((prev) => (prev === next ? prev : next));
  }, [initialLaneFilter]);

  useEffect(() => {
    if (!loadMoreEnabled) return;
    const next = initialVisibleCount!;
    setVisibleCount((prev) => (prev === next ? prev : next));
  }, [agentFilter, groupByDay, initialVisibleCount, laneFilter, loadMoreEnabled, search, topicFilter, typeFilter]);

  const readOnly = tokenRequired && !token;
  const topicKey = useCallback((topicId: string | null | undefined) => (topicId ? topicId : "__null__"), []);

  // Stable reference: avoid a new array literal on every render when tasksOverride is undefined.
  const tasksFromOverride = useMemo(() => tasksOverride ?? [], [tasksOverride]);

  const getTasksForTopic = useCallback(
    (topicId: string | null) => {
      if (tasksFromOverride.length > 0) {
        return tasksFromOverride.filter((task) => (topicId ? task.topicId === topicId : task.topicId == null));
      }
      return tasksCache[topicKey(topicId)] ?? [];
    },
    [tasksFromOverride, tasksCache, topicKey]
  );

  const ensureTasksForTopic = useCallback(
    async (topicId: string | null) => {
      if (tasksFromOverride.length > 0) return;
      const key = topicKey(topicId);
      if (tasksCache[key]) return;
      if (tasksLoading[key]) return;
      setTasksLoading((prev) => ({ ...prev, [key]: true }));
      try {
        const url = topicId ? `/api/tasks?topicId=${encodeURIComponent(topicId)}` : "/api/tasks";
        const res = await apiFetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const raw = await res.json().catch(() => null);
        const payload = Array.isArray(raw)
          ? (raw as Task[])
          : raw && typeof raw === "object" && Array.isArray((raw as { tasks?: unknown }).tasks)
            ? ((raw as { tasks: Task[] }).tasks ?? [])
            : null;
        if (!payload || !Array.isArray(payload)) return;
        const next = topicId ? payload : payload.filter((task) => task.topicId == null);
        setTasksCache((prev) => ({ ...prev, [key]: next }));
      } finally {
        setTasksLoading((prev) => ({ ...prev, [key]: false }));
      }
    },
    [tasksFromOverride, tasksCache, tasksLoading, topicKey, token]
  );

  const isTasksLoadingForTopic = useCallback(
    (topicId: string | null) => Boolean(tasksLoading[topicKey(topicId)]),
    [tasksLoading, topicKey]
  );

  const patchLogEntry = useCallback(
    async (entry: LogEntry, patch: LogPatchPayload) => {
      if (readOnly) return { ok: false, error: "Read-only mode. Add a token in Setup." };
      const res = await apiFetch(
        `/api/log/${encodeURIComponent(entry.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
        token
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const msg = typeof detail?.detail === "string" ? detail.detail : "Failed to edit message.";
        return { ok: false, error: msg };
      }
      const updated = (await res.json().catch(() => null)) as LogEntry | null;
      if (!updated) return { ok: false, error: "Failed to edit message." };
      setStoreLogs((prev) => prev.map((item) => (item.id === entry.id ? updated : item)));
      setLogs((prev) => {
        const next = prev.map((item) => (item.id === entry.id ? updated : item));
        const scoped = scopeTopicId !== undefined || scopeTaskId !== undefined;
        if (!scoped) return next;
        return next.filter((row) => {
          if (scopeTopicId !== undefined) {
            if (scopeTopicId == null) {
              if (row.topicId != null) return false;
            } else if (row.topicId !== scopeTopicId) {
              return false;
            }
          }
          if (scopeTaskId !== undefined) {
            if (scopeTaskId == null) {
              if (row.taskId != null) return false;
            } else if ((row.taskId ?? null) !== scopeTaskId) {
              return false;
            }
          }
          return true;
        });
      });
      return { ok: true, entry: updated };
    },
    [readOnly, token, setStoreLogs, scopeTopicId, scopeTaskId]
  );

  const replayClassifierBundle = useCallback(
    async (anchorLogId: string) => {
      const id = String(anchorLogId ?? "").trim();
      if (!id) return { ok: false, error: "Missing anchor log id." };
      if (readOnly) return { ok: false, error: "Read-only mode. Add a token in Setup." };
      const res = await apiFetch(
        "/api/classifier/replay",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anchorLogId: id, mode: "bundle" }),
        },
        token
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const msg = typeof detail?.detail === "string" ? detail.detail : "Failed to replay classifier.";
        return { ok: false, error: msg };
      }
      const payload = (await res.json().catch(() => null)) as { logCount?: unknown } | null;
      const logCount = typeof payload?.logCount === "number" ? payload.logCount : undefined;
      return { ok: true, logCount };
    },
    [readOnly, token]
  );

  const purgeForward = useCallback(
    async (anchorLogId: string) => {
      const id = String(anchorLogId ?? "").trim();
      if (!id) return { ok: false, error: "Missing anchor log id." };
      if (readOnly) return { ok: false, error: "Read-only mode. Add a token in Setup." };
      const res = await apiFetch(`/api/log/${encodeURIComponent(id)}/purge_forward`, { method: "POST" }, token);
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const msg = typeof detail?.detail === "string" ? detail.detail : "Failed to purge forward.";
        return { ok: false, error: msg };
      }
      const payload = (await res.json().catch(() => null)) as { deletedCount?: unknown; deletedIds?: unknown } | null;
      const deletedCount = typeof payload?.deletedCount === "number" ? payload.deletedCount : undefined;
      const deletedIds = Array.isArray(payload?.deletedIds)
        ? payload.deletedIds.map((item) => String(item ?? "").trim()).filter(Boolean)
        : [];

      if (deletedIds.length > 0) {
        const deletedSet = new Set(deletedIds);
        setStoreLogs((prev) => prev.filter((row) => !deletedSet.has(row.id)));
        setLogs((prev) => prev.filter((row) => !deletedSet.has(row.id)));
      }

      return { ok: true, deletedCount };
    },
    [readOnly, token, setStoreLogs]
  );

  const normalizedSearch = search.trim().toLowerCase();
  const semanticRefreshKey = useMemo(() => {
    const latestLog = logs.reduce((acc, item) => {
      const stamp = item.updatedAt || item.createdAt || "";
      return stamp > acc ? stamp : acc;
    }, "");
    return `${logs.length}:${topics.length}:${latestLog}:${topicFilter}:${typeFilter}:${agentFilter}:${laneFilter}`;
  }, [agentFilter, laneFilter, logs, topicFilter, topics.length, typeFilter]);

  const semanticSearch = useSemanticSearch({
    query: normalizedSearch,
    topicId: topicFilter !== "all" ? topicFilter : undefined,
    includePending: true,
    limitTopics: Math.min(Math.max(topics.length, 60), 120),
    limitTasks: Math.min(Math.max(Math.ceil(logs.length / 3), 120), 240),
    limitLogs: Math.min(Math.max(logs.length, 160), 320),
    refreshKey: semanticRefreshKey,
  });

  const semanticForQuery = useMemo(() => {
    if (!semanticSearch.data) return null;
    const resultQuery = semanticSearch.data.query.trim().toLowerCase();
    if (!resultQuery || resultQuery !== normalizedSearch) return null;
    return semanticSearch.data;
  }, [normalizedSearch, semanticSearch.data]);

  const semanticLogIds = useMemo(() => new Set(semanticForQuery?.matchedLogIds ?? []), [semanticForQuery]);
  const semanticLogScores = useMemo(
    () => new Map((semanticForQuery?.logs ?? []).map((item) => [item.id, Number(item.score) || 0])),
    [semanticForQuery]
  );

  const filtered = useMemo(() => {
    const rows = logs.filter((entry) => {
      if (topicFilter !== "all" && entry.topicId !== topicFilter) return false;
      if (typeFilter !== "all" && entry.type !== typeFilter) return false;
      if (laneFilter !== "all" && !matchesLane(entry, laneFilter)) return false;
      if (agentFilter !== "all") {
        const label = entry.agentLabel || entry.agentId || "";
        if (label !== agentFilter) return false;
      }
      if (normalizedSearch.length > 0) {
        if (semanticForQuery) {
          return semanticLogIds.has(entry.id);
        }
        const haystack = `${entry.summary ?? ""} ${entry.content ?? ""} ${entry.raw ?? ""}`.toLowerCase();
        if (!haystack.includes(normalizedSearch)) return false;
      }
      return true;
    });

    if (!semanticForQuery || normalizedSearch.length < 1 || rows.length < 2) return rows;

    return [...rows].sort((a, b) => {
      const scoreA = semanticLogScores.get(a.id) ?? 0;
      const scoreB = semanticLogScores.get(b.id) ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return compareLogsDesc(a, b);
    });
  }, [
    agentFilter,
    laneFilter,
    logs,
    normalizedSearch,
    semanticForQuery,
    semanticLogIds,
    semanticLogScores,
    topicFilter,
    typeFilter,
  ]);

  const visibleFiltered = useMemo(() => {
    if (!loadMoreEnabled) return filtered;
    return filtered.slice(0, visibleCount);
  }, [filtered, loadMoreEnabled, visibleCount]);

  const grouped = useMemo(() => {
    if (!groupByDay) return { all: visibleFiltered };
    return visibleFiltered.reduce<Record<string, LogEntry[]>>((acc, entry) => {
      const date = getEntryDateKey(entry);
      acc[date] = acc[date] ?? [];
      acc[date].push(entry);
      return acc;
    }, {});
  }, [visibleFiltered, groupByDay]);

  useEffect(() => {
    if (!groupByDay) {
      setCollapsedDays((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const dates = Object.keys(grouped).sort(compareDateKeysDesc);
    if (dates.length === 0) return;
    const mostRecent = dates[0];
    setCollapsedDays((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const date of dates) {
        if (Object.prototype.hasOwnProperty.call(prev, date)) {
          next[date] = prev[date];
        } else {
          next[date] = date !== mostRecent;
          changed = true;
        }
      }
      if (Object.keys(prev).length !== dates.length) {
        changed = true;
      } else if (!dates.every((date) => prev[date] === next[date])) {
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [groupByDay, grouped]);

  const topicsMap = useMemo(() => {
    return new Map(topics.map((topic) => [topic.id, topic.name]));
  }, [topics]);

  const agentLabelCounts = useMemo(() => {
    return logs.reduce<Record<string, number>>((acc, entry) => {
      const label = entry.agentLabel || entry.agentId || "Unknown";
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {});
  }, [logs]);

  const agentLabels = useMemo(() => {
    return Object.entries(agentLabelCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label);
  }, [agentLabelCounts]);

  const addNote = useCallback(
    async (entry: LogEntry, note: string) => {
      if (readOnly) return { ok: false, error: "Read-only mode. Add a token in Setup." };
      const payload = {
        topicId: entry.topicId,
        taskId: entry.taskId ?? null,
        relatedLogId: entry.id,
        type: "note",
        content: note,
        summary: summarizeText(note),
        agentId: "user",
        agentLabel: "User",
      };

      const res = await apiFetch(
        "/api/log",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        token
      );

      if (!res.ok) {
        return { ok: false, error: "Failed to add note." };
      }
      const data = await res.json().catch(() => null);
      if (data?.logs && Array.isArray(data.logs)) {
        setStoreLogs(data.logs);
        setLogs(data.logs);
      } else {
        const optimistic = { ...(payload as LogEntry), id: `tmp-${Date.now()}`, createdAt: new Date().toISOString() };
        setStoreLogs((prev) => [optimistic, ...prev]);
        setLogs((prev) => [optimistic, ...prev]);
      }
      return { ok: true };
    },
    [readOnly, token, setStoreLogs]
  );

  const deleteLogEntry = useCallback(
    async (entry: LogEntry) => {
      if (readOnly) return { ok: false, error: "Read-only mode. Add a token in Setup." };

      const res = await apiFetch(`/api/log/${encodeURIComponent(entry.id)}`, { method: "DELETE" }, token);

      if (!res.ok) {
        return { ok: false, error: "Failed to delete message." };
      }

      const data = (await res.json().catch(() => null)) as { deletedIds?: string[] } | null;
      const deletedIds = Array.isArray(data?.deletedIds) ? data?.deletedIds.filter(Boolean) : [entry.id];
      const removed = new Set(deletedIds.length > 0 ? deletedIds : [entry.id]);
      setStoreLogs((prev) => prev.filter((item) => !removed.has(item.id)));
      setLogs((prev) => prev.filter((item) => !removed.has(item.id)));
      return { ok: true };
    },
    [readOnly, token, setStoreLogs]
  );

  return (
    <div className="space-y-4">
      {showFilters && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <SearchInput
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onClear={() => setSearch("")}
              placeholder="Search messages"
              className="min-w-[220px] flex-1"
            />
            <Select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="max-w-[180px]">
              <option value="all">All types</option>
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Select className="max-w-[180px]" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}>
              <option value="all">All agents</option>
              {agentLabels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </Select>
            <Button variant="secondary" size="sm" onClick={() => setShowAdvancedFilters((prev) => !prev)}>
              {showAdvancedFilters ? "Hide filters" : "More filters"}
            </Button>
          </div>
          {normalizedSearch && (
            <p className="text-xs text-[rgb(var(--claw-muted))]">
              {semanticSearch.loading
                ? "Searching semantic index…"
                : semanticForQuery
                  ? `Semantic search (${semanticForQuery.mode})`
                  : semanticSearch.error === "search_timeout"
                    ? "Semantic search timed out, using local match fallback."
                    : semanticSearch.error
                    ? "Semantic search unavailable, using local match fallback."
                    : "Searching…"}
            </p>
          )}
          {showAdvancedFilters && (
            <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(14,17,22,0.9)] p-3">
              <div className="flex flex-wrap items-center gap-3">
                <Select value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)} className="max-w-[220px]">
                  <option value="all">All topics</option>
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.name}
                    </option>
                  ))}
                </Select>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Agent lanes</span>
                  <Button variant={laneFilter === "all" ? "secondary" : "ghost"} size="sm" onClick={() => setLaneFilter("all")}>
                    All
                  </Button>
                  {agentLabels.map((lane) => (
                    <Button
                      key={lane}
                      variant={laneFilter === lane ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => setLaneFilter(lane)}
                    >
                      {lane}
                    </Button>
                  ))}
                </div>
                {showRawToggle && (
                  <Button variant="secondary" size="sm" onClick={() => setShowRawAll(!showRawAll)}>
                    {showRawAll ? "Hide full messages" : "Show full messages"}
                  </Button>
                )}
                {showDensityToggle && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className={messageDensity === "compact" ? "border-[rgba(255,90,45,0.5)]" : ""}
                    onClick={() => setMessageDensity(messageDensity === "compact" ? "comfortable" : "compact")}
                  >
                    {messageDensity === "compact" ? "Comfortable view" : "Compact view"}
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => setGroupByDay((prev) => !prev)}>
                  {groupByDay ? "Ungrouped" : "Group by day"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {!showFilters && showRawToggle && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowRawAll(!showRawAll)}>
            {showRawAll ? "Hide full messages" : "Show full messages"}
          </Button>
          {showDensityToggle && (
            <Button
              variant="secondary"
              size="sm"
              className={messageDensity === "compact" ? "border-[rgba(255,90,45,0.5)]" : ""}
              onClick={() => setMessageDensity(messageDensity === "compact" ? "comfortable" : "compact")}
            >
              {messageDensity === "compact" ? "Comfortable view" : "Compact view"}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-3">
        {Object.entries(grouped).map(([date, entries]) => {
          const collapsed = collapsedDays[date];
          const label = groupByDay ? formatDateGroupLabel(date) : "All";
          return (
            <div key={date} className="space-y-3">
              {groupByDay && (
                <div
                  role="button"
                  tabIndex={0}
                  className="flex items-center justify-between rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-4 py-3 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))] cursor-pointer"
                  onClick={() =>
                    setCollapsedDays((prev) => ({
                      ...prev,
                      [date]: !prev[date],
                    }))
                  }
                  aria-label={collapsed ? "Expand day" : "Collapse day"}
                  title={collapsed ? "Expand" : "Collapse"}
                >
                  <span>{label}</span>
                  <span className="text-[rgb(var(--claw-accent))]">{collapsed ? "▸" : "▾"}</span>
                </div>
              )}
              {!collapsed &&
                entries.map((entry) => (
                <LogRow
                  key={entry.id}
                  entry={entry}
                  topicLabel={topicsMap.get(entry.topicId ?? "") ?? "Off-topic"}
                  topics={topics}
                  scopeTopicId={scopeTopicId}
                  scopeTaskId={scopeTaskId}
                  showRawAll={showRawAll}
                  allowNotes={allowNotes}
                  allowDelete={allowDelete}
                  messageDensity={messageDensity}
                  onAddNote={addNote}
                  onDelete={deleteLogEntry}
                  onPatch={patchLogEntry}
                  onReplayClassifier={replayClassifierBundle}
                  onPurgeForward={purgeForward}
                  getTasksForTopic={getTasksForTopic}
                  ensureTasksForTopic={ensureTasksForTopic}
                  isTasksLoadingForTopic={isTasksLoadingForTopic}
                  readOnly={readOnly}
                  enableNavigation={enableNavigation}
                  variant={variant}
                />
                ))}
            </div>
          );
        })}
        {visibleFiltered.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No log entries yet.</p>}

        {loadMoreEnabled && filtered.length > visibleFiltered.length && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-[rgb(var(--claw-muted))]">
            <span>
              Showing {visibleFiltered.length} of {filtered.length} entries.
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setVisibleCount((prev) => prev + loadMoreStep!)}
            >
              Load {loadMoreStep} more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

type LogRowProps = {
  entry: LogEntry;
  topicLabel: string;
  topics: Topic[];
  scopeTopicId?: string | null;
  scopeTaskId?: string | null;
  showRawAll: boolean;
  allowNotes: boolean;
  allowDelete: boolean;
  messageDensity: MessageDensity;
  onAddNote: (entry: LogEntry, note: string) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (entry: LogEntry) => Promise<{ ok: boolean; error?: string }>;
  onPatch: (
    entry: LogEntry,
    patch: LogPatchPayload
  ) => Promise<{ ok: boolean; error?: string; entry?: LogEntry }>;
  onReplayClassifier: (anchorLogId: string) => Promise<{ ok: boolean; error?: string; logCount?: number }>;
  onPurgeForward: (anchorLogId: string) => Promise<{ ok: boolean; error?: string; deletedCount?: number }>;
  getTasksForTopic: (topicId: string | null) => Task[];
  ensureTasksForTopic: (topicId: string | null) => Promise<void>;
  isTasksLoadingForTopic: (topicId: string | null) => boolean;
  readOnly: boolean;
  enableNavigation: boolean;
  variant: LogListVariant;
};

const LogRow = memo(function LogRow({
  entry,
  topicLabel,
  topics,
  scopeTopicId,
  scopeTaskId,
  showRawAll,
  allowNotes,
  allowDelete,
  messageDensity,
  onAddNote,
  onDelete,
  onPatch,
  onReplayClassifier,
  onPurgeForward,
  getTasksForTopic,
  ensureTasksForTopic,
  isTasksLoadingForTopic,
  readOnly,
  enableNavigation,
  variant,
}: LogRowProps) {
  const router = useRouter();
  const [compactMessageVisible, setCompactMessageVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraftKey, setNoteDraftKey] = useState<string | null>(null);
  const { value: noteText, setValue: setNoteText } = usePersistentDraft(noteDraftKey ? `draft:note:${noteDraftKey}` : "", {
    fallback: "",
  });
  const [noteStatus, setNoteStatus] = useState<string | null>(null);
  const notePanelRef = useRef<HTMLDivElement | null>(null);
  const noteTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editTopicId, setEditTopicId] = useState(entry.topicId ?? "");
  const [editTaskId, setEditTaskId] = useState(entry.taskId ?? "");
  const [editContent, setEditContent] = useState(entry.content ?? "");
  const [editSummary, setEditSummary] = useState(entry.summary ?? "");
  const [editStatus, setEditStatus] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState<string | null>(null);
  const [purgeArmed, setPurgeArmed] = useState(false);
  const [purgeStatus, setPurgeStatus] = useState<string | null>(null);
  const showFullMessage = showRawAll || expanded;
  const summary = entry.summary ?? entry.content;
  const resolvedTopic = entry.topicId ? topics.find((topic) => topic.id === entry.topicId) : null;
  const destinationBase = entry.taskId
    ? buildTaskUrl(
        { id: entry.taskId, title: entry.summary ?? entry.content ?? "task", topicId: entry.topicId ?? null },
        topics,
        resolvedTopic ?? null
      )
    : resolvedTopic
      ? buildTopicUrl(resolvedTopic, topics)
      : UNIFIED_BASE;
  const destinationSpaceId = String(entry.spaceId ?? "").trim() || String(resolvedTopic?.spaceId ?? "").trim();

  // Navigating from Logs should always "reveal" the selection in Unified View.
  const destination = withSpaceParam(withRevealParam(destinationBase, true), destinationSpaceId);

  const canNavigate = Boolean(destination) && enableNavigation;

  useEffect(() => {
    if (!noteOpen) return;
    if (readOnly) return;
    if (typeof window === "undefined") return;
    // Wait for the textarea to mount (note is conditional).
    const raf = window.requestAnimationFrame(() => {
      // Ensure the note bubble is visible inside whichever scroll container owns it.
      notePanelRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
      // Focus without a second scroll jump (best-effort).
      try {
        noteTextAreaRef.current?.focus({ preventScroll: true } as FocusOptions);
      } catch {
        noteTextAreaRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [noteOpen, readOnly]);

  const handleNavigate = (target: HTMLElement | null) => {
    if (!canNavigate || !destination) return false;
    if (target?.closest("a, button, input, select, textarea, option")) return false;
    return true;
  };

  const typeLabel = TYPE_LABELS[entry.type] ?? entry.type;
  const isConversation = entry.type === "conversation";
  const toolEvent = parseToolEvent(entry);
  const allowEdit = allowDelete;
  const agentLabel = entry.agentLabel || entry.agentId;
  const showAgentBadge = Boolean(agentLabel && agentLabel.trim().toLowerCase() !== typeLabel.trim().toLowerCase());
  const messageSource = stripTransportNoise((entry.content ?? entry.raw ?? entry.summary ?? "").trim());
  const shouldTruncate = !showFullMessage && messageSource.length > MESSAGE_TRUNCATE_LIMIT;
  const messageText = shouldTruncate ? truncateText(messageSource, MESSAGE_TRUNCATE_LIMIT) : messageSource;
  const summaryText = deriveMessageSummary(entry, messageSource);
  const isUser = (entry.agentId || "").toLowerCase() === "user";
  const classificationStatus = entry.classificationStatus ?? "pending";
  const isPending = classificationStatus !== "classified";
  const compactMode = messageDensity === "compact";
  // Compact mode should still show chat bubbles; it mainly affects density/styling.
  const canShowMessage = variant === "chat" ? true : !compactMode || compactMessageVisible;
  const speakerLabel = String(entry.source?.speakerLabel ?? "").trim();
  const audienceLabel = String(entry.source?.audienceLabel ?? "").trim();
  const flowLabel = speakerLabel && audienceLabel ? `${speakerLabel} -> ${audienceLabel}` : "";
  const conversationLaneLabel = flowLabel || (isUser ? "You" : agentLabel || "Assistant");
  const sourceMetaParts = [
    flowLabel ? `flow: ${flowLabel}` : null,
    entry.source?.channel ? `channel: ${entry.source.channel}` : null,
    entry.source?.sessionKey ? `session: ${entry.source.sessionKey}` : null,
    entry.source?.messageId ? `msg: ${entry.source.messageId}` : null,
  ].filter(Boolean);
  const sourceMeta = sourceMetaParts.length > 0 ? sourceMetaParts.join(" · ") : null;
  const editTopicValue = editTopicId || "";
  const editTopicNullable = editTopicId ? editTopicId : null;
  const taskOptions = getTasksForTopic(editTopicNullable);
  const tasksLoadingForEdit = isTasksLoadingForTopic(editTopicNullable);

  const [toolRawLoaded, setToolRawLoaded] = useState(() => {
    if (typeof entry.raw === "string" && entry.raw.trim()) return true;
    return logRawCache.has(entry.id);
  });
  const [toolRaw, setToolRaw] = useState<string | null>(() => {
    if (typeof entry.raw === "string" && entry.raw.trim()) return entry.raw;
    return logRawCache.has(entry.id) ? logRawCache.get(entry.id) ?? null : null;
  });

  const baseCopyValue = useMemo(() => {
    const content = String(entry.content ?? "").trim();
    if (content) return content;
    const raw = String(entry.raw ?? "").trim();
    if (raw) return raw;
    const summary = String(entry.summary ?? "").trim();
    if (summary) return summary;
    return "";
  }, [entry.content, entry.raw, entry.summary]);
  const copyValue = toolEvent && toolRaw ? toolRaw : baseCopyValue;

  const [replayStatus, setReplayStatus] = useState<"idle" | "running" | "queued" | "failed">("idle");
  const [replayError, setReplayError] = useState<string | null>(null);

  // Eagerly load tool raw content so it's visible by default (no click required).
  useEffect(() => {
    if (!toolEvent) return;
    if (toolRawLoaded) return;
    let alive = true;
    void fetchLogRaw(entry.id)
      .then((raw) => {
        if (!alive) return;
        setToolRaw(raw);
        setToolRawLoaded(true);
      })
    return () => {
      alive = false;
    };
  }, [entry.id, toolEvent, toolRawLoaded]);

  // Available in all variants (chat bubble + cards edit panel).
  const showPurgeForward =
    allowDelete && Boolean(scopeTopicId) && typeof onPurgeForward === "function";

  if (variant === "chat") {
    const chatBubbleText = (() => {
      if (!isConversation) return summary || "(empty)";
      const raw = messageText || summary || "(empty)";
      return raw;
    })();
    const bubbleTitle = sourceMeta ? `${formatDateTime(entry.createdAt)}\n${sourceMeta}` : formatDateTime(entry.createdAt);
    const showReplay =
      isUser && isConversation && scopeTaskId === null && Boolean(scopeTopicId) && typeof onReplayClassifier === "function";

    return (
      <div
        data-log-id={entry.id}
        className={`py-1 ${canNavigate ? "cursor-pointer" : ""}`}
        role={canNavigate ? "button" : undefined}
        tabIndex={canNavigate ? 0 : undefined}
        onClick={(event) => {
          if (!handleNavigate(event.target as HTMLElement)) return;
          router.push(destination!);
        }}
        aria-label={canNavigate ? "Open related conversation" : undefined}
      >
        {isConversation ? (
          <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div className="w-full max-w-[78%]">
	              <div className={`mb-1 flex items-center ${isUser ? "justify-end" : "justify-start"}`}>
	                {flowLabel ? (
	                  <span className="mr-2 text-[10px] uppercase tracking-[0.12em] text-[rgb(var(--claw-muted))]">{flowLabel}</span>
	                ) : null}
	                <span className="text-xs text-[rgb(var(--claw-muted))]">{formatDateTime(entry.createdAt)}</span>
	                {isPending && (
	                  <span className="ml-2 text-[10px] uppercase tracking-[0.18em] text-[rgba(148,163,184,0.9)]">
	                    pending
	                  </span>
	                )}
	              </div>

	              <div
	                data-testid={`message-bubble-${entry.id}`}
	                data-agent-side={isUser ? "right" : "left"}
	                data-classification-status={classificationStatus}
	                title={bubbleTitle}
	                onClick={(event) => {
	                  // In compact mode we want a simple "click message to expand" interaction.
	                  if (!shouldTruncate) return;
	                  if (showRawAll) return;
	                  if (expanded) return;
	                  event.stopPropagation();
	                  setExpanded(true);
	                }}
	                className={`rounded-[20px] border px-4 py-3 text-sm leading-relaxed ${isPending ? "opacity-85 " : ""}${
	                  isUser
	                    ? "border-[rgba(36,145,255,0.35)] bg-[rgba(36,145,255,0.16)] text-[rgb(var(--claw-text))]"
	                    : "border-[rgba(255,255,255,0.12)] bg-[rgba(20,24,31,0.8)] text-[rgb(var(--claw-text))]"
	                }`}
	              >
                  {entry.attachments && entry.attachments.length > 0 ? (
                    <AttachmentStrip attachments={entry.attachments} className="mt-0 mb-3" />
                  ) : null}
                  <Markdown highlightCommands={variant === "chat"}>{chatBubbleText}</Markdown>
	                {shouldTruncate && (
	                  <div className="mt-2">
	                    <Button variant="ghost" size="sm" onClick={() => setExpanded(true)} aria-label="Expand message">
	                      ...
	                    </Button>
	                  </div>
	                )}
	                {!showRawAll && expanded && messageSource.length > MESSAGE_TRUNCATE_LIMIT && (
	                  <div className="mt-2">
	                    <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
	                      Collapse
	                    </Button>
	                  </div>
	                )}
	              </div>

              <div className={`mt-2 flex flex-wrap items-center gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
                <CopyPill value={copyValue || messageSource || chatBubbleText} />
                {(allowEdit || (allowNotes && entry.type !== "note")) && !noteOpen && !editOpen ? (
                  <>
                    {showReplay && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={readOnly || replayStatus === "running"}
                        title={
                          readOnly
                            ? "Read-only mode. Add token in Setup to replay classification."
                            : replayStatus === "running"
                              ? "Rechecking..."
                              : "Re-run the classifier for this message bundle"
                        }
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (readOnly) return;
                          if (replayStatus === "running") return;
                          setReplayStatus("running");
                          setReplayError(null);
                          void (async () => {
                            try {
                              const result = await onReplayClassifier(entry.id);
                              if (!result.ok) {
                                setReplayStatus("failed");
                                setReplayError(result.error ?? "Failed to replay classifier.");
                                return;
                              }
                              setReplayStatus("queued");
                              window.setTimeout(() => setReplayStatus("idle"), 1400);
                            } catch {
                              setReplayStatus("failed");
                              setReplayError("Failed to replay classifier.");
                            }
                          })();
                        }}
                      >
                        {replayStatus === "running" ? "Rechecking..." : replayStatus === "queued" ? "Queued" : "Recheck tasks"}
                      </Button>
                    )}
                    {allowEdit && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={readOnly}
                        title={readOnly ? "Read-only mode. Add token in Setup to edit/delete." : "Edit message actions"}
                        onClick={() => {
                          setEditOpen(true);
                          setDeleteArmed(false);
                          setDeleteStatus(null);
                          setPurgeArmed(false);
                          setPurgeStatus(null);
                          setEditTopicId(entry.topicId ?? "");
                          setEditTaskId(entry.taskId ?? "");
                          setEditContent(entry.content ?? "");
                          setEditSummary(entry.summary ?? "");
                          setEditStatus(null);
                          void ensureTasksForTopic(entry.topicId ?? null);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                    {allowNotes && entry.type !== "note" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setNoteDraftKey(entry.id);
                          setNoteOpen(true);
                        }}
                      >
                        Add note
                      </Button>
                    )}
                  </>
                ) : null}
              </div>
              {showReplay && replayStatus === "failed" && replayError ? (
                <p className={`mt-1 text-xs ${isUser ? "text-right" : "text-left"} text-[rgb(var(--claw-warning))]`}>
                  {replayError}
                </p>
              ) : null}

              {allowNotes && entry.type !== "note" && noteOpen && (
                <div className="mt-2">
                  <div
	                    ref={notePanelRef}
	                    className="space-y-2 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.55)] p-3"
	                  >
	                    <TextArea
	                      ref={noteTextAreaRef}
	                      value={noteText}
	                      onChange={(event) => setNoteText(event.target.value)}
	                      placeholder={
	                        readOnly
	                          ? "Add token in Setup to enable curated notes that steer classification."
	                          : "Add a curated note to this conversation..."
	                      }
	                      disabled={readOnly}
	                      readOnly={readOnly}
	                      className="min-h-[90px]"
	                    />
                    {noteStatus && <p className="text-xs text-[rgb(var(--claw-muted))]">{noteStatus}</p>}
                    <div className={`flex flex-wrap items-center gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
                      <Button
                        size="sm"
                        onClick={async () => {
                          if (!noteText.trim()) return;
                          setNoteStatus(null);
                          const result = await onAddNote(entry, noteText.trim());
                          if (!result.ok) {
                            setNoteStatus(result.error ?? "Failed to add note.");
                            return;
                          }
                          setNoteText("");
                          setNoteOpen(false);
                          setNoteDraftKey(null);
                        }}
                        disabled={readOnly}
                      >
                        Save note
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setNoteOpen(false);
                          setNoteDraftKey(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                    {readOnly && <p className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add a token in Setup.</p>}
                  </div>
                </div>
              )}

              {allowEdit && editOpen && (
                <div className="mt-2">
                  <div className="space-y-2 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.55)] p-3">
                    <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Edit message</div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Topic</div>
                        <Select
                          value={editTopicValue}
                          onChange={(event) => {
                            const next = event.target.value;
                            setEditTopicId(next);
                            setEditTaskId("");
                            setEditStatus(null);
                            void ensureTasksForTopic(next ? next : null);
                          }}
                        >
                          <option value="">Unassigned</option>
                          {topics.map((topic) => (
                            <option key={topic.id} value={topic.id}>
                              {topic.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Task</div>
                        <Select
                          value={editTaskId || ""}
                          disabled={tasksLoadingForEdit}
                          onChange={(event) => {
                            setEditTaskId(event.target.value);
                            setEditStatus(null);
                          }}
                        >
                          <option value="">No task</option>
                          {taskOptions.map((task) => (
                            <option key={task.id} value={task.id}>
                              {task.title}
                            </option>
                          ))}
                        </Select>
                        {tasksLoadingForEdit && <div className="text-xs text-[rgb(var(--claw-muted))]">Loading tasks…</div>}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Summary (optional)</div>
                      <Input
                        value={editSummary}
                        onChange={(event) => setEditSummary(event.target.value)}
                        placeholder="Short summary"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Content</div>
                      <TextArea
                        value={editContent}
                        onChange={(event) => setEditContent(event.target.value)}
                        disabled={readOnly}
                        readOnly={readOnly}
                        className="min-h-[110px]"
                      />
                    </div>

                    {editStatus && <p className="text-xs text-[rgb(var(--claw-muted))]">{editStatus}</p>}

                    <div className={`flex flex-wrap items-center gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
                      <Button
                        size="sm"
                        disabled={readOnly || editSaving}
                        onClick={async () => {
                          setEditSaving(true);
                          setEditStatus(null);
                          const result = await onPatch(entry, {
                            topicId: editTopicId ? editTopicId : null,
                            taskId: editTaskId ? editTaskId : null,
                            content: editContent ?? "",
                            summary: editSummary.trim() ? editSummary.trim() : null,
                          });
                          setEditSaving(false);
                          if (!result.ok) {
                            setEditStatus(result.error ?? "Failed to edit message.");
                            return;
                          }
                          setEditOpen(false);
                          setDeleteArmed(false);
                          setDeleteStatus(null);
                          setPurgeArmed(false);
                          setPurgeStatus(null);
                        }}
                      >
                        {editSaving ? "Saving…" : "Save"}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setEditOpen(false);
                          setDeleteArmed(false);
                          setDeleteStatus(null);
                          setPurgeArmed(false);
                          setPurgeStatus(null);
                          setEditStatus(null);
                        }}
                      >
                        Close
                      </Button>
                    </div>

                    <div className="pt-2">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Danger zone</div>
                      {deleteStatus && <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{deleteStatus}</p>}
                      <div className={`mt-2 flex flex-wrap items-center gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
                        {!deleteArmed ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                            disabled={readOnly}
                            onClick={() => {
                              setDeleteArmed(true);
                              setDeleteStatus(null);
                            }}
                          >
                            Delete
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                            disabled={readOnly}
                            onClick={async () => {
                              setDeleteStatus(null);
                              const result = await onDelete(entry);
                              if (!result.ok) {
                                setDeleteStatus(result.error ?? "Failed to delete message.");
                                return;
                              }
                              setEditOpen(false);
                              setDeleteArmed(false);
                            }}
                          >
                            Confirm delete
                          </Button>
                        )}
                        {deleteArmed && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setDeleteArmed(false);
                              setDeleteStatus(null);
                            }}
                          >
                            Keep message
                          </Button>
                        )}
                      </div>

                      {showPurgeForward && (
                        <>
                          {purgeStatus && <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">{purgeStatus}</p>}
                          <div className={`mt-2 flex flex-wrap items-center gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
                            {!purgeArmed ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                className="border-[rgba(255,90,45,0.35)] text-[rgba(255,90,45,0.92)]"
                                disabled={readOnly}
                                onClick={() => {
                                  setPurgeArmed(true);
                                  setPurgeStatus(null);
                                }}
                                title={
                                  scopeTaskId
                                    ? "Delete this message and everything after it in this Task Chat"
                                    : "Delete this message and everything after it in this Topic Chat"
                                }
                              >
                                Purge from here
                              </Button>
                            ) : (
                              <Button
                                variant="secondary"
                                size="sm"
                                className="border-[rgba(255,90,45,0.35)] text-[rgba(255,90,45,0.92)]"
                                disabled={readOnly}
                                onClick={async () => {
                                  setPurgeStatus(null);
                                  const result = await onPurgeForward(entry.id);
                                  if (!result.ok) {
                                    setPurgeStatus(result.error ?? "Failed to purge forward.");
                                    return;
                                  }
                                  setEditOpen(false);
                                  setPurgeArmed(false);
                                }}
                              >
                                Confirm purge
                              </Button>
                            )}
                            {purgeArmed && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  setPurgeArmed(false);
                                  setPurgeStatus(null);
                                }}
                              >
                                Cancel
                              </Button>
                            )}
                          </div>
                        </>
                      )}
                    </div>

                    {sourceMeta && (
                      <div className="pt-2 text-xs text-[rgb(var(--claw-muted))]">
                        <span className="font-mono">{sourceMeta}</span>
                      </div>
                    )}
                    {readOnly && <p className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add a token in Setup.</p>}
                  </div>
                </div>
	              )}
            </div>
          </div>
	        ) : (
	          <div className="flex w-full flex-col items-start">
	            <div className="mb-1 flex w-full max-w-[78%] items-center justify-start">
	              <span className="text-xs text-[rgb(var(--claw-muted))]">{formatDateTime(entry.createdAt)}</span>
	              {isPending && (
	                <span className="ml-2 text-[10px] uppercase tracking-[0.18em] text-[rgba(148,163,184,0.9)]">pending</span>
	              )}
	            </div>
	            <div
	              title={bubbleTitle}
	              data-classification-status={classificationStatus}
	              className={`w-full max-w-[78%] rounded-[14px] border border-[rgba(255,255,255,0.10)] bg-[rgba(20,24,31,0.8)] px-4 py-3 text-xs text-[rgb(var(--claw-muted))] ${
	                isPending ? "opacity-90" : ""
	              }`}
	            >
	              {toolEvent ? (
	                <>
	                  <div className="flex flex-wrap items-center justify-start gap-x-2 gap-y-1">
	                    <span className="uppercase tracking-[0.14em]">
	                      {toolEvent.kind === "call" ? "Tool call" : toolEvent.kind === "result" ? "Tool result" : "Tool error"}
	                    </span>
	                    <span className="font-mono text-[rgb(var(--claw-text))]">{toolEvent.toolName}</span>
	                  </div>
	                  <div className="mt-2 text-left">
	                    {!toolRawLoaded ? (
	                      <div className="text-[10px] uppercase tracking-[0.18em] text-[rgba(148,163,184,0.9)]">
	                        Loading…
	                      </div>
	                    ) : null}
	                    <pre className="mt-1 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-[rgba(255,255,255,0.10)] bg-[rgba(10,12,16,0.55)] px-3 py-2 font-mono text-[11px] text-[rgb(var(--claw-text))]">
	                      {toolRaw ?? "(No tool details)"}
	                    </pre>
	                  </div>
	                </>
	              ) : (
	                <>
	                  <span className="uppercase tracking-[0.14em]">{typeLabel}</span>
	                  {isPending ? (
	                    <span className="ml-2 text-[10px] uppercase tracking-[0.18em] text-[rgba(148,163,184,0.9)]">
	                      pending
	                    </span>
	                  ) : null}
	                  {chatBubbleText ? (
	                    <span className="ml-2 normal-case tracking-normal text-[rgb(var(--claw-text))]">{chatBubbleText}</span>
	                  ) : null}
	                </>
	              )}
	            </div>

            <div className="mt-2 flex flex-wrap items-center justify-start gap-2">
              <CopyPill value={copyValue || messageSource || chatBubbleText} />
              {(allowEdit || (allowNotes && entry.type !== "note")) && !noteOpen && !editOpen ? (
                <>
                  {allowEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={readOnly}
                      title={readOnly ? "Read-only mode. Add token in Setup to edit/delete." : "Edit message actions"}
                      onClick={() => {
                        setEditOpen(true);
                        setDeleteArmed(false);
                        setDeleteStatus(null);
                        setEditTopicId(entry.topicId ?? "");
                        setEditTaskId(entry.taskId ?? "");
                        setEditContent(entry.content ?? "");
                        setEditSummary(entry.summary ?? "");
                        setEditStatus(null);
                        void ensureTasksForTopic(entry.topicId ?? null);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                  {allowNotes && entry.type !== "note" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setNoteDraftKey(entry.id);
                        setNoteOpen(true);
                      }}
                    >
                      Add note
                    </Button>
                  )}
                </>
              ) : null}
            </div>

            {allowNotes && entry.type !== "note" && noteOpen && (
              <div className="mt-2 w-full max-w-[90%]">
                <div className="space-y-2 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.55)] p-3">
                  <TextArea
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    placeholder={
                      readOnly
                        ? "Add token in Setup to enable curated notes that steer classification."
                        : "Add a curated note to this conversation..."
                    }
                    disabled={readOnly}
                    readOnly={readOnly}
                    className="min-h-[90px]"
                  />
                  {noteStatus && <p className="text-xs text-[rgb(var(--claw-muted))]">{noteStatus}</p>}
                  <div className="flex flex-wrap items-center justify-start gap-2">
                    <Button
                      size="sm"
                      onClick={async () => {
                        if (!noteText.trim()) return;
                        setNoteStatus(null);
                        const result = await onAddNote(entry, noteText.trim());
                        if (!result.ok) {
                          setNoteStatus(result.error ?? "Failed to add note.");
                          return;
                        }
                        setNoteText("");
                        setNoteOpen(false);
                        setNoteDraftKey(null);
                      }}
                      disabled={readOnly}
                    >
                      Save note
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setNoteOpen(false);
                        setNoteDraftKey(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                  {readOnly && <p className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add a token in Setup.</p>}
                </div>
              </div>
            )}

            {allowEdit && editOpen && (
              <div className="mt-2 w-full max-w-[90%]">
                <div className="space-y-2 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.55)] p-3">
                  <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Edit message</div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Topic</div>
                      <Select
                        value={editTopicValue}
                        onChange={(event) => {
                          const next = event.target.value;
                          setEditTopicId(next);
                          setEditTaskId("");
                          setEditStatus(null);
                          void ensureTasksForTopic(next ? next : null);
                        }}
                      >
                        <option value="">Unassigned</option>
                        {topics.map((topic) => (
                          <option key={topic.id} value={topic.id}>
                            {topic.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Task</div>
                      <Select
                        value={editTaskId || ""}
                        disabled={tasksLoadingForEdit}
                        onChange={(event) => {
                          setEditTaskId(event.target.value);
                          setEditStatus(null);
                        }}
                      >
                        <option value="">No task</option>
                        {taskOptions.map((task) => (
                          <option key={task.id} value={task.id}>
                            {task.title}
                          </option>
                        ))}
                      </Select>
                      {tasksLoadingForEdit && <div className="text-xs text-[rgb(var(--claw-muted))]">Loading tasks…</div>}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Summary (optional)</div>
                    <Input value={editSummary} onChange={(event) => setEditSummary(event.target.value)} placeholder="Short summary" />
                  </div>

                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Content</div>
                    <TextArea
                      value={editContent}
                      onChange={(event) => setEditContent(event.target.value)}
                      disabled={readOnly}
                      readOnly={readOnly}
                      className="min-h-[110px]"
                    />
                  </div>

                  {editStatus && <p className="text-xs text-[rgb(var(--claw-muted))]">{editStatus}</p>}

                  <div className="flex flex-wrap items-center justify-start gap-2">
                    <Button
                      size="sm"
                      disabled={readOnly || editSaving}
                      onClick={async () => {
                        setEditSaving(true);
                        setEditStatus(null);
                        const result = await onPatch(entry, {
                          topicId: editTopicId ? editTopicId : null,
                          taskId: editTaskId ? editTaskId : null,
                          content: editContent ?? "",
                          summary: editSummary.trim() ? editSummary.trim() : null,
                        });
                        setEditSaving(false);
                        if (!result.ok) {
                          setEditStatus(result.error ?? "Failed to edit message.");
                          return;
                        }
                        setEditOpen(false);
                        setDeleteArmed(false);
                        setDeleteStatus(null);
                      }}
                    >
                      {editSaving ? "Saving…" : "Save"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setEditOpen(false);
                        setDeleteArmed(false);
                        setDeleteStatus(null);
                        setEditStatus(null);
                      }}
                    >
                      Close
                    </Button>
                  </div>

                  <div className="pt-2">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Danger zone</div>
                    {deleteStatus && <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{deleteStatus}</p>}
                    <div className="mt-2 flex flex-wrap items-center justify-start gap-2">
                      {!deleteArmed ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                          disabled={readOnly}
                          onClick={() => {
                            setDeleteArmed(true);
                            setDeleteStatus(null);
                          }}
                        >
                          Delete
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                          disabled={readOnly}
                          onClick={async () => {
                            setDeleteStatus(null);
                            const result = await onDelete(entry);
                            if (!result.ok) {
                              setDeleteStatus(result.error ?? "Failed to delete message.");
                              return;
                            }
                            setEditOpen(false);
                            setDeleteArmed(false);
                          }}
                        >
                          Confirm delete
                        </Button>
                      )}
                      {deleteArmed && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setDeleteArmed(false);
                            setDeleteStatus(null);
                          }}
                        >
                          Keep message
                        </Button>
                      )}
                    </div>
                  </div>

                  {showPurgeForward && (
                    <>
                      {purgeStatus && <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">{purgeStatus}</p>}
                      <div className="mt-2 flex flex-wrap items-center justify-start gap-2">
                        {!purgeArmed ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="border-[rgba(255,90,45,0.35)] text-[rgba(255,90,45,0.92)]"
                            disabled={readOnly}
                            onClick={() => {
                              setPurgeArmed(true);
                              setPurgeStatus(null);
                            }}
                            title={
                              scopeTaskId
                                ? "Delete this message and everything after it in this Task Chat"
                                : "Delete this message and everything after it in this Topic Chat"
                            }
                          >
                            Purge from here
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="border-[rgba(255,90,45,0.35)] text-[rgba(255,90,45,0.92)]"
                            disabled={readOnly}
                            onClick={async () => {
                              setPurgeStatus(null);
                              const result = await onPurgeForward(entry.id);
                              if (!result.ok) {
                                setPurgeStatus(result.error ?? "Failed to purge forward.");
                                return;
                              }
                              setEditOpen(false);
                              setPurgeArmed(false);
                            }}
                          >
                            Confirm purge
                          </Button>
                        )}
                        {purgeArmed && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setPurgeArmed(false);
                              setPurgeStatus(null);
                            }}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </>
                  )}

                  {sourceMeta && (
                    <div className="pt-2 text-xs text-[rgb(var(--claw-muted))]">
                      <span className="font-mono">{sourceMeta}</span>
                    </div>
                  )}
                  {readOnly && <p className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add a token in Setup.</p>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-log-id={entry.id}
      className={`rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4 ${
        canNavigate ? "cursor-pointer transition hover:border-[rgba(255,90,45,0.35)]" : ""
      }`}
      role={canNavigate ? "button" : undefined}
      tabIndex={canNavigate ? 0 : undefined}
      onClick={(event) => {
        if (!handleNavigate(event.target as HTMLElement)) return;
        router.push(destination!);
      }}
      aria-label={canNavigate ? "Open related conversation" : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {!isConversation && <Badge tone="accent2">{typeLabel}</Badge>}
          <Badge tone="muted">{topicLabel}</Badge>
          {showAgentBadge && <Badge tone="accent">{agentLabel}</Badge>}
          {entry.relatedLogId && <Badge tone="muted">Curation</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[rgb(var(--claw-muted))]">{formatDateTime(entry.createdAt)}</span>
        </div>
      </div>

      {isConversation ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-medium text-[rgb(var(--claw-text))]">{summaryText}</p>
          {compactMode && (
            <div>
              {!compactMessageVisible ? (
                <button
                  type="button"
                  className="text-xs text-[rgb(var(--claw-muted))] underline decoration-[rgba(255,255,255,0.18)] underline-offset-4 transition hover:text-[rgb(var(--claw-text))]"
                  onClick={(event) => {
                    event.stopPropagation();
                    setCompactMessageVisible(true);
                    if (shouldTruncate && !showRawAll) setExpanded(true);
                  }}
                >
                  Show message…
                </button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCompactMessageVisible(false);
                    setExpanded(false);
                  }}
                  aria-label="Hide message"
                >
                  Hide message
                </Button>
              )}
            </div>
          )}
          {canShowMessage && (
            <>
              <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div className={`w-full max-w-[78%] ${isUser ? "text-right" : "text-left"}`}>
                  <p className="mb-1 text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">
                    {conversationLaneLabel}
                  </p>
                  <div
                    data-testid={`message-bubble-${entry.id}`}
                    data-agent-side={isUser ? "right" : "left"}
                    onClick={(event) => {
                      if (!shouldTruncate) return;
                      if (showRawAll) return;
                      if (expanded) return;
                      event.stopPropagation();
                      setExpanded(true);
                    }}
                    className={`max-w-[78%] rounded-[20px] border px-4 py-3 text-sm leading-relaxed ${
                      isUser
                        ? "border-[rgba(36,145,255,0.35)] bg-[rgba(36,145,255,0.16)] text-[rgb(var(--claw-text))]"
                        : "border-[rgba(255,255,255,0.12)] bg-[rgba(20,24,31,0.8)] text-[rgb(var(--claw-text))]"
                    }`}
                  >
                    <Markdown>
                      {(() => {
                        const raw = messageText || summary || "(empty)";
                        return raw;
                      })()}
                    </Markdown>
                    {shouldTruncate && (
                      <div className="mt-2">
                        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)} aria-label="Expand message">
                          ...
                        </Button>
                      </div>
                    )}
                    {!showRawAll && expanded && messageSource.length > MESSAGE_TRUNCATE_LIMIT && (
                      <div className="mt-2">
                        <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
                          Collapse
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          {toolEvent ? (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-[rgb(var(--claw-muted))]">
                <span className="uppercase tracking-[0.14em]">
                  {toolEvent.kind === "call" ? "Tool call" : toolEvent.kind === "result" ? "Tool result" : "Tool error"}
                </span>
                <span className="font-mono text-[rgb(var(--claw-text))]">{toolEvent.toolName}</span>
              </div>
              {!toolRawLoaded && (
                <div className="text-[10px] uppercase tracking-[0.18em] text-[rgba(148,163,184,0.9)]">Loading…</div>
              )}
              {(toolRaw || entry.raw) && (
                <div>
                  {!showRawAll && (
                    <Button variant="ghost" size="sm" onClick={() => setExpanded((prev) => !prev)}>
                      {expanded ? "Hide tool details" : "Show tool details"}
                    </Button>
                  )}
                  {showFullMessage && (
                    <pre className="mt-2 max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
                      {toolRaw ?? entry.raw}
                    </pre>
                  )}
                </div>
              )}
              {toolRawLoaded && !toolRaw && !entry.raw ? (
                <p className="text-xs text-[rgb(var(--claw-muted))]">(No tool details)</p>
              ) : null}
            </div>
          ) : (
            <>
              <p className="mt-3 text-sm leading-relaxed text-[rgb(var(--claw-text))]">{summary}</p>
              {entry.raw && (
                <div className="mt-3">
                  {!showRawAll && (
                    <Button variant="ghost" size="sm" onClick={() => setExpanded((prev) => !prev)}>
                      {expanded ? "Hide full message" : "Show full message"}
                    </Button>
                  )}
                  {showFullMessage && (
                    <pre className="mt-2 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
                      {entry.raw}
                    </pre>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
      {(allowEdit || (allowNotes && entry.type !== "note")) && !noteOpen && !editOpen && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {allowEdit && (
            <Button
              variant="secondary"
              size="sm"
              disabled={readOnly}
              title={readOnly ? "Read-only mode. Add token in Setup to edit/delete." : "Edit message actions"}
              onClick={() => {
                setEditOpen(true);
                setDeleteArmed(false);
                setDeleteStatus(null);
                setEditTopicId(entry.topicId ?? "");
                setEditTaskId(entry.taskId ?? "");
                setEditContent(entry.content ?? "");
                setEditSummary(entry.summary ?? "");
                setEditStatus(null);
                void ensureTasksForTopic(entry.topicId ?? null);
              }}
            >
              Edit
            </Button>
          )}
          {allowNotes && entry.type !== "note" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setNoteDraftKey(entry.id);
                setNoteOpen(true);
              }}
            >
              Add note
            </Button>
          )}
        </div>
      )}
	      {allowNotes && entry.type !== "note" && noteOpen && (
	        <div className="mt-3">
	          <div
	            ref={notePanelRef}
	            className="space-y-2 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.55)] p-3"
	          >
	            <TextArea
	              ref={noteTextAreaRef}
	              value={noteText}
	              onChange={(event) => setNoteText(event.target.value)}
	              placeholder={
	                readOnly
	                  ? "Add token in Setup to enable curated notes that steer classification."
	                  : "Add a curated note to this conversation..."
	              }
	              disabled={readOnly}
	              readOnly={readOnly}
	              className="min-h-[90px]"
	            />
            {noteStatus && <p className="text-xs text-[rgb(var(--claw-muted))]">{noteStatus}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  if (!noteText.trim()) return;
                  setNoteStatus(null);
                  const result = await onAddNote(entry, noteText.trim());
                  if (!result.ok) {
                    setNoteStatus(result.error ?? "Failed to add note.");
                    return;
                  }
                  setNoteText("");
                  setNoteOpen(false);
                  setNoteDraftKey(null);
                }}
                disabled={readOnly}
              >
                Save note
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setNoteOpen(false);
                  setNoteDraftKey(null);
                }}
              >
                Cancel
              </Button>
            </div>
            {readOnly && <p className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add a token in Setup.</p>}
          </div>
        </div>
      )}
      {allowEdit && editOpen && (
        <div className="mt-3">
          <div className="space-y-2 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.55)] p-3">
            <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Edit message</div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Topic</div>
                <Select
                  value={editTopicValue}
                  onChange={(event) => {
                    const next = event.target.value;
                    setEditTopicId(next);
                    setEditTaskId("");
                    setEditStatus(null);
                    void ensureTasksForTopic(next ? next : null);
                  }}
                >
                  <option value="">Unassigned</option>
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Task</div>
                <Select
                  value={editTaskId || ""}
                  disabled={tasksLoadingForEdit}
                  onChange={(event) => {
                    setEditTaskId(event.target.value);
                    setEditStatus(null);
                  }}
                >
                  <option value="">No task</option>
                  {taskOptions.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </Select>
                {tasksLoadingForEdit && <div className="text-xs text-[rgb(var(--claw-muted))]">Loading tasks…</div>}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Summary (optional)</div>
              <Input value={editSummary} onChange={(event) => setEditSummary(event.target.value)} placeholder="Short summary" />
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Content</div>
              <TextArea
                value={editContent}
                onChange={(event) => setEditContent(event.target.value)}
                disabled={readOnly}
                readOnly={readOnly}
                className="min-h-[110px]"
              />
            </div>

            {editStatus && <p className="text-xs text-[rgb(var(--claw-muted))]">{editStatus}</p>}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={readOnly || editSaving}
                onClick={async () => {
                  setEditSaving(true);
                  setEditStatus(null);
                  const result = await onPatch(entry, {
                    topicId: editTopicId ? editTopicId : null,
                    taskId: editTaskId ? editTaskId : null,
                    content: editContent ?? "",
                    summary: editSummary.trim() ? editSummary.trim() : null,
                  });
                  setEditSaving(false);
                  if (!result.ok) {
                    setEditStatus(result.error ?? "Failed to edit message.");
                    return;
                  }
                  setEditOpen(false);
                  setDeleteArmed(false);
                  setDeleteStatus(null);
                }}
              >
                {editSaving ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEditOpen(false);
                  setDeleteArmed(false);
                  setDeleteStatus(null);
                  setEditStatus(null);
                }}
              >
                Close
              </Button>
            </div>

            <div className="pt-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">Danger zone</div>
              {deleteStatus && <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{deleteStatus}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {!deleteArmed ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                    disabled={readOnly}
                    onClick={() => {
                      setDeleteArmed(true);
                      setDeleteStatus(null);
                    }}
                  >
                    Delete
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                    disabled={readOnly}
                    onClick={async () => {
                      setDeleteStatus(null);
                      const result = await onDelete(entry);
                      if (!result.ok) {
                        setDeleteStatus(result.error ?? "Failed to delete message.");
                        return;
                      }
                      setEditOpen(false);
                      setDeleteArmed(false);
                    }}
                  >
                    Confirm delete
                  </Button>
                )}
                {deleteArmed && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setDeleteArmed(false);
                      setDeleteStatus(null);
                    }}
                  >
                    Keep message
                  </Button>
                )}
              </div>
            </div>

            {showPurgeForward && (
              <>
                {purgeStatus && <p className="mt-2 text-xs text-[rgb(var(--claw-muted))]">{purgeStatus}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {!purgeArmed ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="border-[rgba(255,90,45,0.35)] text-[rgba(255,90,45,0.92)]"
                      disabled={readOnly}
                      onClick={() => {
                        setPurgeArmed(true);
                        setPurgeStatus(null);
                      }}
                      title={
                        scopeTaskId
                          ? "Delete this message and everything after it in this Task Chat"
                          : "Delete this message and everything after it in this Topic Chat"
                      }
                    >
                      Purge from here
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="border-[rgba(255,90,45,0.35)] text-[rgba(255,90,45,0.92)]"
                      disabled={readOnly}
                      onClick={async () => {
                        setPurgeStatus(null);
                        const result = await onPurgeForward(entry.id);
                        if (!result.ok) {
                          setPurgeStatus(result.error ?? "Failed to purge forward.");
                          return;
                        }
                        setEditOpen(false);
                        setPurgeArmed(false);
                      }}
                    >
                      Confirm purge
                    </Button>
                  )}
                  {purgeArmed && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setPurgeArmed(false);
                        setPurgeStatus(null);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </>
            )}

            {sourceMeta && (
              <div className="pt-2 text-xs text-[rgb(var(--claw-muted))]">
                <span className="font-mono">{sourceMeta}</span>
              </div>
            )}
            {readOnly && <p className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add a token in Setup.</p>}
          </div>
        </div>
      )}
    </div>
  );
}, (prev: LogRowProps, next: LogRowProps) => {
  // Skip re-render when the entry object reference is unchanged (the common SSE case where a
  // new message is appended but existing entries keep their reference from upsertById).
  if (prev.entry !== next.entry) return false;
  if (prev.topicLabel !== next.topicLabel) return false;
  if (prev.topics !== next.topics) return false;
  if (prev.scopeTopicId !== next.scopeTopicId) return false;
  if (prev.scopeTaskId !== next.scopeTaskId) return false;
  if (prev.showRawAll !== next.showRawAll) return false;
  if (prev.allowNotes !== next.allowNotes) return false;
  if (prev.allowDelete !== next.allowDelete) return false;
  if (prev.messageDensity !== next.messageDensity) return false;
  if (prev.readOnly !== next.readOnly) return false;
  if (prev.enableNavigation !== next.enableNavigation) return false;
  if (prev.variant !== next.variant) return false;
  if (prev.onAddNote !== next.onAddNote) return false;
  if (prev.onDelete !== next.onDelete) return false;
  if (prev.onPatch !== next.onPatch) return false;
  if (prev.onReplayClassifier !== next.onReplayClassifier) return false;
  if (prev.onPurgeForward !== next.onPurgeForward) return false;
  if (prev.getTasksForTopic !== next.getTasksForTopic) return false;
  if (prev.ensureTasksForTopic !== next.ensureTasksForTopic) return false;
  if (prev.isTasksLoadingForTopic !== next.isTasksLoadingForTopic) return false;
  return true;
});
