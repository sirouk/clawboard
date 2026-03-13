"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Draft, LogEntry, Space, Task, Topic } from "@/lib/types";
import { apiFetch } from "@/lib/api";
import { useLiveUpdates } from "@/lib/use-live-updates";
import { LiveEvent, mergeById, mergeLogs, maxTimestamp, removeById, upsertById } from "@/lib/live-utils";
import { normalizeBoardSessionKey } from "@/lib/board-session";
import { CLAWBOARD_CONFIG_UPDATED_EVENT } from "@/lib/config-events";
import {
  CHAT_SEEN_AT_KEY,
  UNSNOOZED_TOPICS_KEY,
  chatKeyFromLogEntry,
  parseNumberMap,
  parseStringMap,
  isUnreadConversationCandidate,
} from "@/lib/attention-state";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";
import {
  CLAWBOARD_NOTIFICATION_CLICK_EVENT,
  CLAWBOARD_NOTIFICATION_CLICK_MESSAGE_TYPE,
  CLAWBOARD_NOTIFY_CHAT_PARAM,
  CLAWBOARD_NOTIFY_TOPIC_PARAM,
  PUSH_ENABLED_KEY,
  closePwaNotificationsByTag,
  parsePwaNotificationClickData,
  setPwaBadge,
  showPwaNotification,
  type PwaNotificationClickData,
} from "@/lib/pwa-utils";
import { buildTopicUrl } from "@/lib/url";

type DataContextValue = {
  spaces: Space[];
  topics: Topic[];
  topicTags: string[];
  tasks: Task[];
  logs: LogEntry[];
  unsnoozedTopicBadges: Record<string, number>;
  unsnoozedTaskBadges: Record<string, number>;
  chatSeenByKey: Record<string, string>;
  unreadMessageCount: number;
  drafts: Record<string, Draft>;
  openclawTyping: Record<string, { typing: boolean; requestId?: string; updatedAt: string }>;
  openclawThreadWork: Record<string, { active: boolean; requestId?: string; reason?: string; updatedAt: string }>;
  hydrated: boolean;
  sseConnected: boolean;
  setSpaces: React.Dispatch<React.SetStateAction<Space[]>>;
  setTopics: React.Dispatch<React.SetStateAction<Topic[]>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, Draft>>>;
  upsertSpace: (space: Space) => void;
  upsertTopic: (topic: Topic) => void;
  upsertTask: (task: Task) => void;
  appendLog: (log: LogEntry) => void;
  upsertDraft: (draft: Draft) => void;
  markChatSeen: (chatKey: string, explicitSeenAt?: string) => void;
  dismissUnsnoozedTopicBadge: (topicId: string) => void;
  dismissUnsnoozedTaskBadge: (taskId: string) => void;
};

const DataContext = createContext<DataContextValue | null>(null);

function normalizeTagValue(value: string) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("system:")) {
    const suffix = raw.split(":", 2)[1]?.trim() ?? "";
    return suffix ? `system:${suffix}` : "system";
  }
  const withDashes = raw.replace(/\s+/g, "-");
  const stripped = withDashes.replace(/[^a-z0-9:_-]/g, "");
  return stripped.replace(/:{2,}/g, ":").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function cleanTagLabel(value: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clipNotificationText(value: string, max = 140) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "New message";
  if (normalized.length <= max) return normalized;
  const safe = Math.max(1, max - 3);
  return `${normalized.slice(0, safe)}...`;
}

const UNSNOOZE_TOPIC_TAG_PREFIX = "clawboard-unsnooze-topic-";
const UNSNOOZE_TASK_TAG_PREFIX = "clawboard-unsnooze-task-";
const UNSNOOZE_TOPICS_SUMMARY_TAG = "clawboard-unsnooze-topics";
const UNSNOOZE_TASKS_SUMMARY_TAG = "clawboard-unsnooze-tasks";
const CHAT_TAG_PREFIX = "clawboard-chat-";
const CHAT_SUMMARY_TAG = "clawboard-chat-summary";
const DEFAULT_INITIAL_CHANGES_LIMIT_LOGS = 2000;

function parseIntegerEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
) {
  const parsed = Number(String(raw ?? "").trim());
  if (!Number.isFinite(parsed)) return fallback;
  const value = Math.floor(parsed);
  return Math.max(min, Math.min(max, value));
}

const INITIAL_CHANGES_LIMIT_LOGS = parseIntegerEnv(
  process.env.NEXT_PUBLIC_CLAWBOARD_INITIAL_CHANGES_LIMIT_LOGS,
  DEFAULT_INITIAL_CHANGES_LIMIT_LOGS,
  0,
  20000
);

function parseIsoMs(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function resolveLiveEventTimestamp(event: LiveEvent) {
  const maybeEvent = event as LiveEvent & { eventTs?: unknown };
  const candidate = String(maybeEvent.eventTs ?? "").trim();
  if (Number.isFinite(parseIsoMs(candidate))) return candidate;
  return new Date().toISOString();
}

function normalizeControlText(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isIncomingSignalNewer(previousUpdatedAt: string | undefined, incomingUpdatedAt: string) {
  const previousMs = parseIsoMs(previousUpdatedAt);
  const incomingMs = parseIsoMs(incomingUpdatedAt);
  if (!Number.isFinite(incomingMs)) return true;
  if (!Number.isFinite(previousMs)) return true;
  return incomingMs >= previousMs;
}

function isTimestampAfterCursor(value: string | undefined, cursor: string | undefined) {
  const valueMs = parseIsoMs(value);
  const cursorMs = parseIsoMs(cursor);
  if (Number.isFinite(valueMs) && Number.isFinite(cursorMs)) return valueMs > cursorMs;
  const valueText = String(value ?? "").trim();
  const cursorText = String(cursor ?? "").trim();
  if (!valueText || !cursorText) return false;
  return valueText > cursorText;
}

function overlayFresherById<T extends { id: string; updatedAt?: string; createdAt?: string }>(
  snapshot: T[],
  current: T[],
  cursor: string | undefined,
  merge: (items: T[], incoming: T[]) => T[]
) {
  if (!cursor) return snapshot;
  const fresher = current.filter((item) => isTimestampAfterCursor(item.updatedAt ?? item.createdAt, cursor));
  if (fresher.length === 0) return snapshot;
  return merge(snapshot, fresher);
}

function overlayFresherDrafts(
  snapshot: Record<string, Draft>,
  current: Record<string, Draft>,
  cursor: string | undefined
) {
  if (!cursor) return snapshot;
  let changed = false;
  const next = { ...snapshot };
  for (const [key, value] of Object.entries(current)) {
    if (!isTimestampAfterCursor(value.updatedAt ?? value.createdAt, cursor)) continue;
    if (JSON.stringify(next[key]) === JSON.stringify(value)) continue;
    next[key] = value;
    changed = true;
  }
  return changed ? next : snapshot;
}

type DeletedEntityRef = { id?: unknown; deletedAt?: unknown };
type TypingSignalSnapshot = { sessionKey?: unknown; typing?: unknown; requestId?: unknown; updatedAt?: unknown };
type ThreadWorkSignalSnapshot = {
  sessionKey?: unknown;
  active?: unknown;
  requestId?: unknown;
  reason?: unknown;
  updatedAt?: unknown;
};
type ChangesPayload = {
  cursor?: unknown;
  spaces?: unknown;
  topics?: unknown;
  tasks?: unknown;
  logs?: unknown;
  drafts?: unknown;
  deletedLogIds?: unknown;
  deletedTopics?: unknown;
  deletedTasks?: unknown;
  openclawTyping?: unknown;
  openclawThreadWork?: unknown;
};

function applyDeletedEntityTombstones<T extends { id: string; updatedAt?: string; createdAt?: string }>(
  items: T[],
  tombstones: DeletedEntityRef[]
) {
  if (tombstones.length === 0) return items;
  const deletedById = new Map<string, string>();
  for (const row of tombstones) {
    const id = String(row.id ?? "").trim();
    const deletedAt = String(row.deletedAt ?? "").trim();
    if (!id || !deletedAt) continue;
    const previous = deletedById.get(id) ?? "";
    if (!previous || deletedAt > previous) deletedById.set(id, deletedAt);
  }
  if (deletedById.size === 0) return items;
  return items.filter((item) => {
    const deletedAt = deletedById.get(item.id);
    if (!deletedAt) return true;
    const itemStamp = item.updatedAt ?? item.createdAt;
    return isTimestampAfterCursor(itemStamp, deletedAt);
  });
}

function reconcileTypingSnapshot(
  previous: Record<string, { typing: boolean; requestId?: string; updatedAt: string }>,
  incoming: TypingSignalSnapshot[],
  cursor: string | undefined
) {
  const next: Record<string, { typing: boolean; requestId?: string; updatedAt: string }> = {};
  for (const row of incoming) {
    const sessionKey = normalizeBoardSessionKey(String(row.sessionKey ?? "").trim());
    const updatedAt = String(row.updatedAt ?? "").trim();
    if (!sessionKey || !updatedAt) continue;
    const current = next[sessionKey];
    if (current && !isIncomingSignalNewer(current.updatedAt, updatedAt)) continue;
    next[sessionKey] = {
      typing: Boolean(row.typing ?? true),
      requestId: String(row.requestId ?? "").trim() || undefined,
      updatedAt,
    };
  }
  if (cursor) {
    for (const [sessionKey, row] of Object.entries(previous)) {
      if (next[sessionKey]) continue;
      if (!isTimestampAfterCursor(row.updatedAt, cursor)) continue;
      next[sessionKey] = row;
    }
  }
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function reconcileThreadWorkSnapshot(
  previous: Record<string, { active: boolean; requestId?: string; reason?: string; updatedAt: string }>,
  incoming: ThreadWorkSignalSnapshot[],
  cursor: string | undefined
) {
  const next: Record<string, { active: boolean; requestId?: string; reason?: string; updatedAt: string }> = {};
  for (const row of incoming) {
    const sessionKey = normalizeBoardSessionKey(String(row.sessionKey ?? "").trim());
    const updatedAt = String(row.updatedAt ?? "").trim();
    if (!sessionKey || !updatedAt) continue;
    const current = next[sessionKey];
    if (current && !isIncomingSignalNewer(current.updatedAt, updatedAt)) continue;
    next[sessionKey] = {
      active: Boolean(row.active ?? true),
      requestId: String(row.requestId ?? "").trim() || undefined,
      reason: String(row.reason ?? "").trim() || undefined,
      updatedAt,
    };
  }
  if (cursor) {
    for (const [sessionKey, row] of Object.entries(previous)) {
      if (next[sessionKey]) continue;
      if (!isTimestampAfterCursor(row.updatedAt, cursor)) continue;
      next[sessionKey] = row;
    }
  }
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function isTerminalSystemRequestEventLog(entry: LogEntry) {
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  if (agentId !== "system") return false;
  const type = String(entry.type ?? "").trim().toLowerCase();
  if (type !== "system") return false;
  const source = (entry.source && typeof entry.source === "object" ? entry.source : {}) as Record<string, unknown>;
  if (Boolean(source.watchdogMissingAssistant)) return false;
  if (source.requestTerminal === false) return false;
  return true;
}

function shouldScheduleAuthoritativeReplay(entry: LogEntry) {
  if (!isTerminalSystemRequestEventLog(entry)) return false;
  const sessionKey = normalizeBoardSessionKey(String(entry.source?.sessionKey ?? ""));
  if (!sessionKey) return false;
  const text = normalizeControlText(entry.summary || entry.content || entry.raw || "");
  return text.includes("all tracked work items reached terminal completion.");
}

function unsnoozedTopicTag(topicId: string) {
  return `${UNSNOOZE_TOPIC_TAG_PREFIX}${topicId}`;
}

function unsnoozedTaskTag(taskId: string) {
  return `${UNSNOOZE_TASK_TAG_PREFIX}${taskId}`;
}

function chatTag(chatKey: string) {
  return `${CHAT_TAG_PREFIX}${chatKey}`;
}

function readNotificationClickDataFromSearchParams(searchParams: URLSearchParams): PwaNotificationClickData {
  const topicId = String(searchParams.get(CLAWBOARD_NOTIFY_TOPIC_PARAM) ?? "").trim();
  const chatKey = String(searchParams.get(CLAWBOARD_NOTIFY_CHAT_PARAM) ?? "").trim();
  const out: PwaNotificationClickData = {};
  if (topicId) out.topicId = topicId;
  if (chatKey) out.chatKey = chatKey;
  return out;
}

function topicToTask(topic: Topic): Task {
  return {
    ...topic,
    title: topic.name,
    topicId: topic.id,
  };
}

function taskToTopic(task: Task, fallback?: Topic): Topic {
  const name = String(task.title ?? task.name ?? fallback?.name ?? "").trim();
  return {
    ...(fallback ?? {}),
    ...task,
    name: name || fallback?.name || "",
    parentId: task.topicId && task.topicId !== task.id ? task.topicId : (task.parentId ?? fallback?.parentId ?? null),
  };
}

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const tasks: Task[] = useMemo(() => topics.map(topicToTask), [topics]);
  const setTasks: React.Dispatch<React.SetStateAction<Task[]>> = useCallback((next) => {
    setTopics((previousTopics) => {
      const previousTasks = previousTopics.map(topicToTask);
      const resolvedTasks = typeof next === "function" ? next(previousTasks) : next;
      const previousById = new Map(previousTopics.map((topic) => [topic.id, topic]));
      return resolvedTasks.map((task) => taskToTopic(task, previousById.get(task.id)));
    });
  }, []);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [openclawTyping, setOpenclawTyping] = useState<
    Record<string, { typing: boolean; requestId?: string; updatedAt: string }>
  >({});
  const [openclawThreadWork, setOpenclawThreadWork] = useState<
    Record<string, { active: boolean; requestId?: string; reason?: string; updatedAt: string }>
  >({});
  const [hydrated, setHydrated] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const unsnoozedTopicsRaw = useLocalStorageItem(UNSNOOZED_TOPICS_KEY) ?? "{}";
  const chatSeenRaw = useLocalStorageItem(CHAT_SEEN_AT_KEY) ?? "{}";
  const notificationsEnabledRaw = useLocalStorageItem(PUSH_ENABLED_KEY);

  const unsnoozedTopicBadges = useMemo(() => parseNumberMap(unsnoozedTopicsRaw), [unsnoozedTopicsRaw]);
  const unsnoozedTaskBadges = useMemo(() => ({}), []);
  const chatSeenByKey = useMemo(() => parseStringMap(chatSeenRaw), [chatSeenRaw]);
  const notificationsEnabled = useMemo(() => notificationsEnabledRaw !== "false", [notificationsEnabledRaw]);
  const activeUnsnoozedTopicCount = useMemo(() => {
    const validTopicIds = new Set(topics.map((topic) => topic.id));
    let count = 0;
    for (const topicId of Object.keys(unsnoozedTopicBadges)) {
      if (validTopicIds.has(topicId)) count += 1;
    }
    return count;
  }, [topics, unsnoozedTopicBadges]);
  const activeUnsnoozedTaskCount = 0;

  const unreadMessageCount = useMemo(() => {
    const seenAtMs = new Map<string, number>();
    for (const [chatKey, seenAt] of Object.entries(chatSeenByKey)) {
      const stamp = Date.parse(seenAt);
      if (!Number.isFinite(stamp)) continue;
      seenAtMs.set(chatKey, stamp);
    }

    let count = 0;
    for (const entry of logs) {
      if (!isUnreadConversationCandidate(entry)) continue;
      const chatKey = chatKeyFromLogEntry(entry);
      if (!chatKey) continue;
      const createdAtMs = Date.parse(entry.createdAt);
      if (!Number.isFinite(createdAtMs)) continue;
      const seenAt = seenAtMs.get(chatKey) ?? Number.NEGATIVE_INFINITY;
      if (createdAtMs > seenAt) count += 1;
    }
    return count;
  }, [chatSeenByKey, logs]);

  // Keep PWA badge scope strict: unread topic chat replies and unsnoozed topics only.
  const pwaAttentionCount = useMemo(
    () => activeUnsnoozedTopicCount + unreadMessageCount,
    [activeUnsnoozedTopicCount, unreadMessageCount]
  );

  const upsertSpace = (space: Space) => setSpaces((prev) => upsertById(prev, space));
  const upsertTopic = (topic: Topic) => setTopics((prev) => upsertById(prev, topic));
  const upsertTask = (task: Task) => upsertTopic({ ...task, name: task.title ?? task.name });
  const appendLog = (log: LogEntry) => setLogs((prev) => mergeLogs(prev, [log]));
  const upsertDraft = (draft: Draft) =>
    setDrafts((prev) => {
      const key = (draft?.key ?? "").trim();
      if (!key) return prev;
      const current = prev[key];
      if (current && JSON.stringify(current) === JSON.stringify(draft)) return prev;
      return { ...prev, [key]: draft };
    });

  const markChatSeen = useCallback(
    (chatKey: string, explicitSeenAt?: string) => {
      const key = String(chatKey ?? "").trim();
      if (!key) return;

      const candidate = String(explicitSeenAt ?? "").trim();
      const candidateMs = Date.parse(candidate);
      const previousSeenAt = chatSeenByKey[key] ?? "";
      const hasExplicitSeenAt = candidate.length > 0 && Number.isFinite(candidateMs);

      // For implicit "mark seen now" calls, avoid rewriting the timestamp once a chat
      // already has a seen marker. Rewriting on every render can create update loops.
      if (!hasExplicitSeenAt && previousSeenAt) return;

      const seenAt = hasExplicitSeenAt ? candidate : new Date().toISOString();
      if (previousSeenAt && previousSeenAt >= seenAt) return;

      setLocalStorageItem(CHAT_SEEN_AT_KEY, JSON.stringify({ ...chatSeenByKey, [key]: seenAt }));
      void closePwaNotificationsByTag([chatTag(key)]);
    },
    [chatSeenByKey]
  );

  const dismissUnsnoozedTopicBadge = useCallback(
    (topicId: string) => {
      const id = String(topicId || "").trim();
      if (!id) return;
      const updated: Record<string, number> = { ...unsnoozedTopicBadges };
      if (!Object.prototype.hasOwnProperty.call(updated, id)) return;
      delete updated[id];
      setLocalStorageItem(UNSNOOZED_TOPICS_KEY, JSON.stringify(updated));

      const tags = [unsnoozedTopicTag(id)];
      if (Object.keys(updated).length === 0) tags.push(UNSNOOZE_TOPICS_SUMMARY_TAG);
      void closePwaNotificationsByTag(tags);
    },
    [unsnoozedTopicBadges]
  );

  const dismissUnsnoozedTaskBadge = useCallback(
    (taskId: string) => {
      const id = String(taskId || "").trim();
      if (!id) return;
      dismissUnsnoozedTopicBadge(id);
    },
    [dismissUnsnoozedTopicBadge]
  );

  const handleNotificationClickData = useCallback(
    (rawData: unknown) => {
      const data = parsePwaNotificationClickData(rawData);
      if (data.topicId) dismissUnsnoozedTopicBadge(data.topicId);
      if (data.chatKey) markChatSeen(data.chatKey);
    },
    [dismissUnsnoozedTopicBadge, markChatSeen]
  );

  useEffect(() => {
    const handleNotificationClick = (event: Event) => {
      const customEvent = event as CustomEvent;
      handleNotificationClickData(customEvent.detail);
    };

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== "object") return;
      const value = payload as { type?: unknown; data?: unknown };
      const type = String(value.type ?? "").trim();
      if (type !== CLAWBOARD_NOTIFICATION_CLICK_MESSAGE_TYPE) return;
      handleNotificationClickData(value.data);
    };

    window.addEventListener(CLAWBOARD_NOTIFICATION_CLICK_EVENT, handleNotificationClick);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    }

    const currentUrl = new URL(window.location.href);
    const fromUrl = readNotificationClickDataFromSearchParams(currentUrl.searchParams);
    if (fromUrl.topicId || fromUrl.chatKey) {
      handleNotificationClickData(fromUrl);
      currentUrl.searchParams.delete(CLAWBOARD_NOTIFY_TOPIC_PARAM);
      currentUrl.searchParams.delete(CLAWBOARD_NOTIFY_CHAT_PARAM);
      window.history.replaceState(window.history.state, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    }

    return () => {
      window.removeEventListener(CLAWBOARD_NOTIFICATION_CLICK_EVENT, handleNotificationClick);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
      }
    };
  }, [handleNotificationClickData]);

  const reconcile = useCallback(async (since?: string) => {
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (!since && INITIAL_CHANGES_LIMIT_LOGS > 0) {
      params.set("limitLogs", String(INITIAL_CHANGES_LIMIT_LOGS));
    }
    const query = params.toString();
    const url = query ? `/api/changes?${query}` : "/api/changes";
    let res: Response;
    try {
      res = await apiFetch(url, { cache: "no-store" });
    } catch {
      // Network unavailable or API temporarily unreachable — will retry on next poll/watchdog tick.
      return;
    }
    if (!res.ok) return;
    const payload = (await res.json().catch(() => null)) as ChangesPayload | null;
    if (!payload) return;
    const cursor = String(payload.cursor ?? "").trim() || undefined;
    const deletedTopics = Array.isArray(payload.deletedTopics) ? (payload.deletedTopics as DeletedEntityRef[]) : [];
    const deletedTasks = Array.isArray(payload.deletedTasks) ? (payload.deletedTasks as DeletedEntityRef[]) : [];
    const typingSignals = Array.isArray(payload.openclawTyping) ? (payload.openclawTyping as TypingSignalSnapshot[]) : [];
    const threadWorkSignals = Array.isArray(payload.openclawThreadWork)
      ? (payload.openclawThreadWork as ThreadWorkSignalSnapshot[])
      : [];
    // Full snapshot: replace to avoid keeping stale items when the stream resets or base/token changes.
    if (!since) {
      if (Array.isArray(payload.spaces)) {
        setSpaces((prev) => overlayFresherById(payload.spaces as Space[], prev, cursor, mergeById));
      }
      if (Array.isArray(payload.topics)) {
        setTopics((prev) =>
          applyDeletedEntityTombstones(
            overlayFresherById(payload.topics as Topic[], prev, cursor, mergeById),
            deletedTopics
          )
        );
      } else if (deletedTopics.length > 0) {
        setTopics((prev) => applyDeletedEntityTombstones(prev, deletedTopics));
      }
      if (deletedTasks.length > 0) {
        setTopics((prev) => applyDeletedEntityTombstones(prev, deletedTasks));
      }
      if (Array.isArray(payload.logs)) {
        setLogs((prev) => {
          const next = overlayFresherById(payload.logs as LogEntry[], prev, cursor, mergeLogs);
          if (!Array.isArray(payload.deletedLogIds) || payload.deletedLogIds.length === 0) return next;
          const deleted = new Set(payload.deletedLogIds.map((id: unknown) => String(id ?? "").trim()).filter(Boolean));
          if (deleted.size === 0) return next;
          return next.filter((row) => !deleted.has(row.id));
        });
      } else if (Array.isArray(payload.deletedLogIds) && payload.deletedLogIds.length > 0) {
        const deleted = new Set(payload.deletedLogIds.map((id: unknown) => String(id ?? "").trim()).filter(Boolean));
        if (deleted.size > 0) {
          setLogs((prev) => prev.filter((row) => !deleted.has(row.id)));
        }
      }
      setOpenclawTyping((prev) => reconcileTypingSnapshot(prev, typingSignals, cursor));
      setOpenclawThreadWork((prev) => reconcileThreadWorkSnapshot(prev, threadWorkSignals, cursor));
      if (Array.isArray(payload.drafts)) {
        setDrafts((prev) => {
          const next: Record<string, Draft> = {};
          for (const item of payload.drafts as Draft[]) {
            const key = String((item as Draft | undefined)?.key ?? "").trim();
            if (!key) continue;
            next[key] = item as Draft;
          }
          return overlayFresherDrafts(next, prev, cursor);
        });
      }
      setHydrated(true);
    } else {
      if (Array.isArray(payload.spaces)) setSpaces((prev) => mergeById(prev, payload.spaces as Space[]));
      if (Array.isArray(payload.topics)) {
        setTopics((prev) => applyDeletedEntityTombstones(mergeById(prev, payload.topics as Topic[]), deletedTopics));
      } else if (deletedTopics.length > 0) {
        setTopics((prev) => applyDeletedEntityTombstones(prev, deletedTopics));
      }
      if (deletedTasks.length > 0) {
        setTopics((prev) => applyDeletedEntityTombstones(prev, deletedTasks));
      }
      if (Array.isArray(payload.logs)) setLogs((prev) => mergeLogs(prev, payload.logs as LogEntry[]));
      if (Array.isArray(payload.deletedLogIds) && payload.deletedLogIds.length > 0) {
        const deleted = new Set(payload.deletedLogIds.map((id: unknown) => String(id ?? "").trim()).filter(Boolean));
        if (deleted.size > 0) setLogs((prev) => prev.filter((row) => !deleted.has(row.id)));
      }
      setOpenclawTyping((prev) => reconcileTypingSnapshot(prev, typingSignals, cursor));
      setOpenclawThreadWork((prev) => reconcileThreadWorkSnapshot(prev, threadWorkSignals, cursor));
      if (Array.isArray(payload.drafts)) {
        setDrafts((prev) => {
          const next = { ...prev };
          for (const item of payload.drafts as Draft[]) {
            const key = String((item as Draft | undefined)?.key ?? "").trim();
            if (!key) continue;
            next[key] = item as Draft;
          }
          return next;
        });
      }
    }
    const ts =
      cursor ||
      maxTimestamp([
        ...((payload.spaces as Array<{ updatedAt?: string; createdAt?: string }> | undefined) ?? []),
        ...((payload.topics as Array<{ updatedAt?: string; createdAt?: string }> | undefined) ?? []),
        ...((payload.tasks as Array<{ updatedAt?: string; createdAt?: string }> | undefined) ?? []),
        ...((payload.logs as Array<{ updatedAt?: string; createdAt?: string }> | undefined) ?? []),
        ...((payload.drafts as Array<{ updatedAt?: string; createdAt?: string }> | undefined) ?? []),
      ]);
    return ts;
  }, []);

  useLiveUpdates({
    onConnectionChange: setSseConnected,
    onEvent: (event: LiveEvent) => {
      if (!event || !event.type) return;
      if (event.type === "space.upserted" && event.data && typeof event.data === "object") {
        upsertSpace(event.data as Space);
        return;
      }
      if (event.type === "config.updated") {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event(CLAWBOARD_CONFIG_UPDATED_EVENT));
        }
        return;
      }
      if (event.type === "topic.upserted" && event.data && typeof event.data === "object") {
        upsertTopic(event.data as Topic);
        return;
      }
      if (event.type === "topic.deleted" && event.data && typeof event.data === "object") {
        const id = (event.data as { id?: string }).id;
        if (id) {
          setTopics((prev) => removeById(prev, id));
          setLogs((prev) => prev.map((item) => (item.topicId === id ? { ...item, topicId: null } : item)));
        }
        return;
      }
      if (
        (event.type === "log.appended" || event.type === "log.patched") &&
        event.data &&
        typeof event.data === "object"
      ) {
        const entry = event.data as LogEntry;
        appendLog(entry);
        if (shouldScheduleAuthoritativeReplay(entry)) {
          void reconcile();
        }
        return;
      }
      if (event.type === "openclaw.typing" && event.data && typeof event.data === "object") {
        const payload = event.data as { sessionKey?: unknown; typing?: unknown; requestId?: unknown };
        const sessionKey = String(payload.sessionKey ?? "").trim();
        const normalizedSessionKey = normalizeBoardSessionKey(sessionKey);
        if (!normalizedSessionKey) return;
        const typing = Boolean(payload.typing);
        const requestId = String(payload.requestId ?? "").trim();
        const updatedAt = resolveLiveEventTimestamp(event);
        setOpenclawTyping((prev) => {
          const current = prev[normalizedSessionKey];
          if (!isIncomingSignalNewer(current?.updatedAt, updatedAt)) return prev;
          return {
            ...prev,
            [normalizedSessionKey]: { typing, requestId: requestId || undefined, updatedAt },
          };
        });
        return;
      }
      if (event.type === "openclaw.thread_work" && event.data && typeof event.data === "object") {
        const payload = event.data as { sessionKey?: unknown; active?: unknown; requestId?: unknown; reason?: unknown };
        const sessionKey = String(payload.sessionKey ?? "").trim();
        const normalizedSessionKey = normalizeBoardSessionKey(sessionKey);
        if (!normalizedSessionKey) return;
        const active = Boolean(payload.active);
        const requestId = String(payload.requestId ?? "").trim();
        const reason = String(payload.reason ?? "").trim();
        const updatedAt = resolveLiveEventTimestamp(event);
        setOpenclawThreadWork((prev) => {
          const current = prev[normalizedSessionKey];
          if (!isIncomingSignalNewer(current?.updatedAt, updatedAt)) return prev;
          return {
            ...prev,
            [normalizedSessionKey]: {
              active,
              requestId: requestId || undefined,
              reason: reason || undefined,
              updatedAt,
            },
          };
        });
        if (!active) {
          void reconcile();
        }
        return;
      }
      if (event.type === "draft.upserted" && event.data && typeof event.data === "object") {
        const draft = event.data as Draft;
        const key = String((draft as Draft | undefined)?.key ?? "").trim();
        if (!key) return;
        upsertDraft(draft);
        return;
      }
      if (event.type === "log.deleted" && event.data && typeof event.data === "object") {
        const id = (event.data as { id?: string }).id;
        if (id) setLogs((prev) => removeById(prev, id));
      }
    },
    reconcile,
  });

  const topicById = useMemo(() => new Map(topics.map((topic) => [topic.id, topic])), [topics]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const knownLogIdsRef = useRef<Set<string> | null>(null);
  const prevTopicStatusRef = useRef<Map<string, { status: string; snoozedUntil: string | null }> | null>(null);
  const seededSeenMapRef = useRef(false);

  useEffect(() => {
    if (!hydrated) return;
    if (seededSeenMapRef.current) return;
    seededSeenMapRef.current = true;
    if (Object.keys(chatSeenByKey).length > 0) return;

    const seeded: Record<string, string> = {};
    for (const entry of logs) {
      const chatKey = chatKeyFromLogEntry(entry);
      if (!chatKey) continue;
      const createdAt = String(entry.createdAt ?? "").trim();
      if (!createdAt) continue;
      const previous = seeded[chatKey] ?? "";
      if (!previous || createdAt > previous) seeded[chatKey] = createdAt;
    }
    if (Object.keys(seeded).length === 0) return;
    setLocalStorageItem(CHAT_SEEN_AT_KEY, JSON.stringify(seeded));
  }, [chatSeenByKey, hydrated, logs]);

  useEffect(() => {
    void setPwaBadge(pwaAttentionCount);
  }, [pwaAttentionCount]);

  useEffect(() => {
    if (!hydrated) return;
    const validTopicIds = new Set(topics.map((topic) => topic.id));
    const staleTopicIds = Object.keys(unsnoozedTopicBadges).filter((topicId) => !validTopicIds.has(topicId));
    if (staleTopicIds.length === 0) return;
    const updated: Record<string, number> = { ...unsnoozedTopicBadges };
    for (const topicId of staleTopicIds) {
      delete updated[topicId];
    }
    setLocalStorageItem(UNSNOOZED_TOPICS_KEY, JSON.stringify(updated));
    const tags = staleTopicIds.map((topicId) => unsnoozedTopicTag(topicId));
    if (Object.keys(updated).length === 0) tags.push(UNSNOOZE_TOPICS_SUMMARY_TAG);
    void closePwaNotificationsByTag(tags);
  }, [hydrated, topics, unsnoozedTopicBadges]);

  useEffect(() => {
    if (Object.keys(unsnoozedTopicBadges).length > 0) return;
    void closePwaNotificationsByTag([UNSNOOZE_TOPICS_SUMMARY_TAG]);
  }, [unsnoozedTopicBadges]);

  useEffect(() => {
    if (unreadMessageCount > 0) return;
    void closePwaNotificationsByTag([CHAT_SUMMARY_TAG]);
  }, [unreadMessageCount]);

  useEffect(() => {
    const previous = prevTopicStatusRef.current;
    const next = new Map<string, { status: string; snoozedUntil: string | null }>();
    const additions: Topic[] = [];

    for (const topic of topics) {
      let status = String(topic.status ?? "active").trim().toLowerCase();
      if (status === "paused") status = "snoozed";
      const snoozedUntil = topic.snoozedUntil ? String(topic.snoozedUntil) : null;
      next.set(topic.id, { status, snoozedUntil });
      if (!previous) continue;
      const before = previous.get(topic.id);
      if (!before) continue;
      if (before.status === "snoozed" && status === "active") {
        additions.push(topic);
      }
    }
    prevTopicStatusRef.current = next;

    if (!previous || additions.length === 0) return;

    const stamp = Date.now();
    let changed = false;
    const updated: Record<string, number> = { ...unsnoozedTopicBadges };
    for (const topic of additions) {
      if (!Object.prototype.hasOwnProperty.call(updated, topic.id)) changed = true;
      updated[topic.id] = stamp;
    }
    if (changed) {
      setLocalStorageItem(UNSNOOZED_TOPICS_KEY, JSON.stringify(updated));
    }

    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible") return;
    if (!notificationsEnabled) return;

    if (additions.length === 1) {
      const topic = additions[0];
      const url = `${buildTopicUrl(topic, topics)}?focus=1`;
      void showPwaNotification(
        {
          title: `Topic unsnoozed: ${topic.name}`,
          body: "Activity resumed.",
          tag: unsnoozedTopicTag(topic.id),
          url,
          data: { topicId: topic.id },
        },
        notificationsEnabled
      );
      return;
    }

    void showPwaNotification(
      {
        title: "Clawboard",
        body: `${additions.length} topics unsnoozed.`,
        tag: UNSNOOZE_TOPICS_SUMMARY_TAG,
        url: "/u",
      },
      notificationsEnabled
    );
  }, [notificationsEnabled, topics, unsnoozedTopicBadges]);

  useEffect(() => {
    if (!hydrated) return;

    const known = knownLogIdsRef.current;
    if (!known) {
      knownLogIdsRef.current = new Set(logs.map((entry) => entry.id));
      return;
    }

    const additions: LogEntry[] = [];
    for (const entry of logs) {
      if (known.has(entry.id)) continue;
      known.add(entry.id);
      additions.push(entry);
    }
    if (additions.length === 0) return;
    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible") return;
    if (!notificationsEnabled) return;

    const unseenAdditions = additions.filter((entry) => {
      if (!isUnreadConversationCandidate(entry)) return false;
      const chatKey = chatKeyFromLogEntry(entry);
      if (!chatKey) return false;
      const createdAtMs = Date.parse(entry.createdAt);
      if (!Number.isFinite(createdAtMs)) return false;
      const seenAtMs = Date.parse(chatSeenByKey[chatKey] ?? "");
      return !Number.isFinite(seenAtMs) || createdAtMs > seenAtMs;
    });
    if (unseenAdditions.length === 0) return;

    if (unseenAdditions.length === 1) {
      const entry = unseenAdditions[0];
      const chatKey = chatKeyFromLogEntry(entry);
      const body = clipNotificationText(entry.content ?? entry.summary ?? "");
      if (chatKey.startsWith("topic:")) {
        const topicId = chatKey.slice("topic:".length).trim();
        const topic = topicById.get(topicId);
        if (topic) {
          const url = `${buildTopicUrl(topic, topics)}?focus=1`;
          void showPwaNotification(
            {
              title: `Topic Chat: ${topic.name}`,
              body,
              tag: chatTag(chatKey),
              url,
              data: { chatKey, topicId: topic.id },
            },
            notificationsEnabled
          );
          return;
        }
      }
    }

    const chatKeys = new Set<string>();
    for (const entry of unseenAdditions) {
      const key = chatKeyFromLogEntry(entry);
      if (key) chatKeys.add(key);
    }
    void showPwaNotification(
      {
        title: "Clawboard",
        body: `${unseenAdditions.length} unread messages in ${chatKeys.size} chats.`,
        tag: CHAT_SUMMARY_TAG,
        url: "/u",
      },
      notificationsEnabled
    );
  }, [chatSeenByKey, hydrated, logs, notificationsEnabled, topicById, topics]);

  const topicTags = useMemo(() => {
    const labels = new Map<string, string>();
    for (const topic of topics) {
      for (const rawTag of topic.tags ?? []) {
        const label = cleanTagLabel(String(rawTag ?? ""));
        const normalized = normalizeTagValue(label);
        if (!normalized || labels.has(normalized)) continue;
        labels.set(normalized, label);
      }
    }
    return Array.from(labels.values()).sort(
      (a, b) => normalizeTagValue(a).localeCompare(normalizeTagValue(b)) || a.localeCompare(b)
    );
  }, [topics]);

  const value = useMemo(
    () => ({
      spaces,
      topics,
      topicTags,
      tasks,
      logs,
      unsnoozedTopicBadges,
      unsnoozedTaskBadges,
      chatSeenByKey,
      unreadMessageCount,
      drafts,
      openclawTyping,
      openclawThreadWork,
      hydrated,
      sseConnected,
      setSpaces,
      setTopics,
      setTasks,
      setLogs,
      setDrafts,
      upsertSpace,
      upsertTopic,
      upsertTask,
      appendLog,
      upsertDraft,
      markChatSeen,
      dismissUnsnoozedTopicBadge,
      dismissUnsnoozedTaskBadge,
    }),
    [
      spaces,
      topics,
      topicTags,
      tasks,
      logs,
      unsnoozedTopicBadges,
      unsnoozedTaskBadges,
      chatSeenByKey,
      unreadMessageCount,
      drafts,
      openclawTyping,
      openclawThreadWork,
      hydrated,
      sseConnected,
      markChatSeen,
      dismissUnsnoozedTopicBadge,
      dismissUnsnoozedTaskBadge,
    ]
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useDataStore() {
  const ctx = useContext(DataContext);
  if (!ctx) {
    throw new Error("useDataStore must be used within DataProvider");
  }
  return ctx;
}
