"use client";

import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Draft, LogEntry, Space, Task, Topic } from "@/lib/types";
import { apiFetch } from "@/lib/api";
import {
  loadBoardSnapshot,
  saveBoardSnapshot,
  type BoardSnapshot,
  type OpenClawThreadWorkSnapshot,
} from "@/lib/board-cache";
import { useLiveUpdates, type ConnectionInfo, type ReconcileCursor, type ReconcileResult } from "@/lib/use-live-updates";
import { drainQueuedMutations } from "@/lib/write-queue";
import { LiveEvent, mergeById, mergeLogs, maxTimestamp, removeById, upsertById } from "@/lib/live-utils";
import { effectiveLogTopicId, normalizeBoardSessionKey } from "@/lib/board-session";
import { CLAWBOARD_CONFIG_UPDATED_EVENT } from "@/lib/config-events";
import { isChatNoiseLog } from "@/lib/chat-log-visibility";
import {
  CHAT_SEEN_AT_KEY,
  UNSNOOZED_TOPICS_KEY,
  chatKeyForTopic,
  chatKeyFromLogEntry,
  parseNumberMap,
  parseStringMap,
} from "@/lib/attention-state";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";
import { cleanTopicTagLabel, filterUserFacingTopicTagLabels } from "@/lib/topic-tags";
import { buildLatestTopicTouchById, deriveAttentionTopicIds, topicLastTouchedAt } from "@/lib/topic-attention";
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
  attentionTopicCount: number;
  drafts: Record<string, Draft>;
  openclawTyping: Record<string, { typing: boolean; requestId?: string; updatedAt: string }>;
  openclawThreadWork: Record<string, OpenClawThreadWorkSnapshot>;
  hydrated: boolean;
  sseConnected: boolean;
  connectionStatus: "connected" | "reconnecting" | "offline";
  disconnectedSince: number | null;
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

function clipNotificationText(value: string, max = 140) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "New message";
  if (normalized.length <= max) return normalized;
  const safe = Math.max(1, max - 3);
  return `${normalized.slice(0, safe)}...`;
}

const UNSNOOZE_TOPIC_TAG_PREFIX = "clawboard-unsnooze-topic-";
const UNSNOOZE_TOPICS_SUMMARY_TAG = "clawboard-unsnooze-topics";
const CHAT_TAG_PREFIX = "clawboard-chat-";
const CHAT_SUMMARY_TAG = "clawboard-chat-summary";
const DELETED_TOPICS_STORAGE_KEY = "clawboard.deletedTopics";
const STREAM_EVENT_TS_STORAGE_KEY = "clawboard.stream.eventTs";
const STREAM_EVENT_SEQ_STORAGE_KEY = "clawboard.stream.lastSeq";
const RESET_AT_STORAGE_KEY = "clawboard.instance.resetAt";
const DEFAULT_INITIAL_CHANGES_LIMIT_LOGS = 200;
const INITIAL_CHANGES_FETCH_TIMEOUT_MS = 12_000;
const INITIAL_CHANGES_FALLBACK_LIMIT_LOGS = 200;

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

function buildInitialChangesLimitCandidates(limit: number) {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const normalized = Math.floor(limit);
  const candidates = [normalized];
  if (normalized > 400) candidates.push(Math.max(INITIAL_CHANGES_FALLBACK_LIMIT_LOGS, Math.floor(normalized / 2)));
  if (normalized > INITIAL_CHANGES_FALLBACK_LIMIT_LOGS) candidates.push(INITIAL_CHANGES_FALLBACK_LIMIT_LOGS);
  return [...new Set(candidates.filter((value) => value > 0))];
}

function hasBoardSnapshotData(snapshot: BoardSnapshot) {
  return (
    snapshot.spaces.length > 0 ||
    snapshot.topics.length > 0 ||
    snapshot.logs.length > 0 ||
    Object.keys(snapshot.drafts).length > 0 ||
    Object.keys(snapshot.openclawTyping).length > 0 ||
    Object.keys(snapshot.openclawThreadWork).length > 0
  );
}

function snapshotCursorFromBoardSnapshot(snapshot: BoardSnapshot): ReconcileCursor | null {
  const cursorSeq =
    typeof snapshot.cursorSeq === "number" && Number.isFinite(snapshot.cursorSeq)
      ? Math.floor(snapshot.cursorSeq)
      : undefined;
  const cursor = String(snapshot.cursor ?? snapshot.cachedAt ?? "").trim() || undefined;
  if (typeof cursorSeq !== "number" && !cursor) return null;
  return {
    since: typeof cursorSeq === "number" ? undefined : cursor,
    sinceSeq: cursorSeq,
  };
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

async function fetchChangesResponse(url: string, timeoutMs?: number) {
  if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === "undefined") {
    return apiFetch(url, { cache: "no-store" });
  }
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiFetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

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
  runId?: unknown;
  activeItems?: unknown;
  waitingItemKeys?: unknown;
  lastActivityAt?: unknown;
  updatedAt?: unknown;
};
type ChangesPayload = {
  cursor?: unknown;
  cursorSeq?: unknown;
  spaces?: unknown;
  topics?: unknown;
  logs?: unknown;
  drafts?: unknown;
  deletedLogIds?: unknown;
  deletedTopics?: unknown;
  openclawTyping?: unknown;
  openclawThreadWork?: unknown;
  authoritativeOpenclawTyping?: unknown;
  authoritativeOpenclawThreadWork?: unknown;
  resetAt?: unknown;
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

function applyDeletedTopicTimestampRecord<T extends { id: string; updatedAt?: string; createdAt?: string }>(
  items: T[],
  deletedById: Record<string, string>
) {
  if (!items.length) return items;
  const entries = Object.entries(deletedById).filter(([id, deletedAt]) => String(id).trim() && String(deletedAt).trim());
  if (entries.length === 0) return items;
  const deletedMap = new Map(entries);
  const filtered = items.filter((item) => {
    const deletedAt = deletedMap.get(item.id);
    if (!deletedAt) return true;
    const itemStamp = item.updatedAt ?? item.createdAt;
    return isTimestampAfterCursor(itemStamp, deletedAt);
  });
  if (filtered.length === items.length && filtered.every((item, index) => item === items[index])) {
    return items;
  }
  return filtered;
}

function mergeDeletedTopicTimestamps(previous: Record<string, string>, tombstones: DeletedEntityRef[]) {
  if (tombstones.length === 0) return previous;
  const next: Record<string, string> = { ...previous };
  let changed = false;
  for (const row of tombstones) {
    const id = String(row.id ?? "").trim();
    const deletedAt = String(row.deletedAt ?? "").trim();
    if (!id || !deletedAt) continue;
    const current = String(next[id] ?? "").trim();
    if (current && !isTimestampAfterCursor(deletedAt, current)) continue;
    next[id] = deletedAt;
    changed = true;
  }
  return changed ? next : previous;
}

function reconcileTypingSnapshot(
  previous: Record<string, { typing: boolean; requestId?: string; updatedAt: string }>,
  incoming: TypingSignalSnapshot[],
  cursor: string | undefined,
  options?: { replace?: boolean }
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
  if (options?.replace) {
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
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
  previous: Record<string, OpenClawThreadWorkSnapshot>,
  incoming: ThreadWorkSignalSnapshot[],
  cursor: string | undefined,
  options?: { replace?: boolean }
) {
  const next: Record<string, OpenClawThreadWorkSnapshot> = {};
  for (const row of incoming) {
    const sessionKey = normalizeBoardSessionKey(String(row.sessionKey ?? "").trim());
    const updatedAt = String(row.updatedAt ?? "").trim();
    if (!sessionKey || !updatedAt) continue;
    const current = next[sessionKey];
    if (current && !isIncomingSignalNewer(current.updatedAt, updatedAt)) continue;
    const waitingItemKeys = Array.isArray(row.waitingItemKeys)
      ? row.waitingItemKeys.map((value) => String(value ?? "").trim()).filter(Boolean).slice(0, 6)
      : undefined;
    const activeItemsRaw = row.activeItems == null ? Number.NaN : Number(row.activeItems);
    const activeItems = Number.isFinite(activeItemsRaw) ? Math.max(0, Math.floor(activeItemsRaw)) : undefined;
    const lastActivityAt = String(row.lastActivityAt ?? "").trim() || undefined;
    next[sessionKey] = {
      active: Boolean(row.active ?? true),
      requestId: String(row.requestId ?? "").trim() || undefined,
      reason: String(row.reason ?? "").trim() || undefined,
      runId: String(row.runId ?? "").trim() || undefined,
      activeItems,
      waitingItemKeys,
      lastActivityAt,
      updatedAt,
    };
  }
  if (options?.replace) {
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
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

function taskToTopic(task: Task, fallback?: Topic): Topic {
  const name = String(task.title ?? task.name ?? fallback?.name ?? "").trim();
  return {
    ...(fallback ?? {}),
    ...task,
    name: name || fallback?.name || "",
  };
}

function isValidTopicRow(topic: Topic | null | undefined): topic is Topic {
  return Boolean(
    topic &&
      String(topic.id ?? "").trim() &&
      String(topic.name ?? "").trim() &&
      String(topic.updatedAt ?? topic.createdAt ?? "").trim()
  );
}

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const deletedTopicsRaw = useLocalStorageItem(DELETED_TOPICS_STORAGE_KEY) ?? "{}";
  const deletedTopicTimestamps = useMemo(() => parseStringMap(deletedTopicsRaw), [deletedTopicsRaw]);
  const deletedTopicTimestampsRef = useRef<Record<string, string>>(deletedTopicTimestamps);
  useEffect(() => {
    deletedTopicTimestampsRef.current = deletedTopicTimestamps;
  }, [deletedTopicTimestamps]);
  const persistDeletedTopicTimestamps = useCallback((next: Record<string, string>) => {
    const cleaned = Object.fromEntries(
      Object.entries(next)
        .map(([id, deletedAt]) => [String(id).trim(), String(deletedAt).trim()] as const)
        .filter(([id, deletedAt]) => id && deletedAt)
    );
    deletedTopicTimestampsRef.current = cleaned;
    setLocalStorageItem(DELETED_TOPICS_STORAGE_KEY, JSON.stringify(cleaned));
  }, []);
  const recordDeletedTopics = useCallback(
    (tombstones: DeletedEntityRef[]) => {
      const next = mergeDeletedTopicTimestamps(deletedTopicTimestampsRef.current, tombstones);
      if (next === deletedTopicTimestampsRef.current) return;
      persistDeletedTopicTimestamps(next);
    },
    [persistDeletedTopicTimestamps]
  );
  const tasks: Task[] = useMemo(() => [], []);
  const setTasks: React.Dispatch<React.SetStateAction<Task[]>> = useCallback((next) => {
    setTopics((previousTopics) => {
      const previousTasks: Task[] = [];
      const resolvedTasks = typeof next === "function" ? next(previousTasks) : next;
      const previousById = new Map(previousTopics.map((topic) => [topic.id, topic]));
      return applyDeletedTopicTimestampRecord(
        mergeById(previousTopics, resolvedTasks.map((task) => taskToTopic(task, previousById.get(task.id)))),
        deletedTopicTimestampsRef.current
      );
    });
  }, []);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [openclawTyping, setOpenclawTyping] = useState<
    Record<string, { typing: boolean; requestId?: string; updatedAt: string }>
  >({});
  const [openclawThreadWork, setOpenclawThreadWork] = useState<
    Record<string, OpenClawThreadWorkSnapshot>
  >({});
  const [hydrated, setHydrated] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [disconnectedSince, setDisconnectedSince] = useState<number | null>(null);
  const [browserOnline, setBrowserOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const liveEventQueueRef = useRef<LiveEvent[]>([]);
  const liveEventFlushFrameRef = useRef<number | null>(null);
  const snapshotSaveTimerRef = useRef<number | null>(null);
  const snapshotCursorRef = useRef<ReconcileCursor | null>(null);
  const unsnoozedTopicsRaw = useLocalStorageItem(UNSNOOZED_TOPICS_KEY) ?? "{}";
  const chatSeenRaw = useLocalStorageItem(CHAT_SEEN_AT_KEY) ?? "{}";
  const notificationsEnabledRaw = useLocalStorageItem(PUSH_ENABLED_KEY);

  const unsnoozedTopicBadges = useMemo(() => parseNumberMap(unsnoozedTopicsRaw), [unsnoozedTopicsRaw]);
  const unsnoozedTaskBadges = useMemo(() => ({}), []);
  const chatSeenByKey = useMemo(() => parseStringMap(chatSeenRaw), [chatSeenRaw]);
  const notificationsEnabled = useMemo(() => notificationsEnabledRaw !== "false", [notificationsEnabledRaw]);
  const safeTopics = useMemo(
    () => applyDeletedTopicTimestampRecord(topics.filter(isValidTopicRow), deletedTopicTimestamps),
    [deletedTopicTimestamps, topics]
  );
  const latestTopicTouchById = useMemo(() => buildLatestTopicTouchById(logs), [logs]);
  const attentionTopicIds = useMemo(
    () =>
      deriveAttentionTopicIds({
        topics: safeTopics,
        latestTopicTouchById,
        topicSeenByKey: chatSeenByKey,
        unsnoozedTopicBadges,
      }),
    [chatSeenByKey, latestTopicTouchById, safeTopics, unsnoozedTopicBadges]
  );
  const attentionTopicCount = useMemo(() => attentionTopicIds.size, [attentionTopicIds]);

  // Keep PWA badge scope strict: count topics that currently need a look.
  const pwaAttentionCount = useMemo(() => attentionTopicCount, [attentionTopicCount]);

  const upsertSpace = useCallback((space: Space) => {
    setSpaces((prev) => upsertById(prev, space));
  }, []);
  const upsertTopic = useCallback((topic: Topic) => {
    const topicId = String(topic.id ?? "").trim();
    if (!topicId) return;
    const deletedAt = String(deletedTopicTimestampsRef.current[topicId] ?? "").trim();
    const topicStamp = String(topic.updatedAt ?? topic.createdAt ?? "").trim();
    if (deletedAt) {
      if (!isTimestampAfterCursor(topicStamp, deletedAt)) {
        return;
      }
      const nextDeleted = { ...deletedTopicTimestampsRef.current };
      delete nextDeleted[topicId];
      persistDeletedTopicTimestamps(nextDeleted);
    }
    setTopics((prev) => applyDeletedTopicTimestampRecord(upsertById(prev, topic), deletedTopicTimestampsRef.current));
  }, [persistDeletedTopicTimestamps]);
  const upsertTask = useCallback((task: Task) => {
    upsertTopic(taskToTopic(task));
  }, [upsertTopic]);
  const appendLog = useCallback((log: LogEntry) => {
    setLogs((prev) => mergeLogs(prev, [log]));
  }, []);
  const upsertDraft = useCallback((draft: Draft) =>
    setDrafts((prev) => {
      const key = (draft?.key ?? "").trim();
      if (!key) return prev;
      const current = prev[key];
      if (current && JSON.stringify(current) === JSON.stringify(draft)) return prev;
      return { ...prev, [key]: draft };
    }), []);

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
      if (data.chatKey) markChatSeen(data.chatKey, new Date().toISOString());
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

  // Track browser online/offline state for the connection status indicator.
  useEffect(() => {
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const handleConnectionChange = useCallback((info: ConnectionInfo) => {
    setSseConnected(info.connected);
    if (info.connected) {
      setDisconnectedSince(null);
    } else {
      setDisconnectedSince((prev) => prev ?? Date.now());
    }
  }, []);

  const connectionStatus: "connected" | "reconnecting" | "offline" = useMemo(() => {
    if (!browserOnline) return "offline";
    if (sseConnected) return "connected";
    return "reconnecting";
  }, [browserOnline, sseConnected]);

  useEffect(() => {
    let active = true;
    void loadBoardSnapshot().then((snapshot) => {
      if (!active) return;
      if (snapshot) {
        setSpaces((prev) => (prev.length > 0 ? prev : snapshot.spaces));
        setTopics((prev) =>
          prev.length > 0
            ? applyDeletedTopicTimestampRecord(prev, deletedTopicTimestampsRef.current)
            : applyDeletedTopicTimestampRecord(snapshot.topics, deletedTopicTimestampsRef.current)
        );
        setLogs((prev) => (prev.length > 0 ? prev : snapshot.logs));
        setDrafts((prev) => (Object.keys(prev).length > 0 ? prev : snapshot.drafts));
        setOpenclawTyping((prev) => (Object.keys(prev).length > 0 ? prev : snapshot.openclawTyping));
        setOpenclawThreadWork((prev) => (Object.keys(prev).length > 0 ? prev : snapshot.openclawThreadWork));
        snapshotCursorRef.current = hasBoardSnapshotData(snapshot) ? snapshotCursorFromBoardSnapshot(snapshot) : null;
      } else {
        snapshotCursorRef.current = null;
      }
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const reconcile = useCallback(async (reconcileCursor?: ReconcileCursor): Promise<ReconcileResult> => {
    const since = String(reconcileCursor?.since ?? "").trim() || undefined;
    const sinceSeq =
      typeof reconcileCursor?.sinceSeq === "number" && Number.isFinite(reconcileCursor.sinceSeq)
        ? Math.floor(reconcileCursor.sinceSeq)
        : undefined;
    const fallbackCursor = !since && typeof sinceSeq !== "number" ? snapshotCursorRef.current : null;
    const effectiveSinceSeq =
      typeof sinceSeq === "number"
        ? sinceSeq
        : typeof fallbackCursor?.sinceSeq === "number" && Number.isFinite(fallbackCursor.sinceSeq)
          ? Math.floor(fallbackCursor.sinceSeq)
          : undefined;
    const effectiveSince =
      since || (typeof effectiveSinceSeq === "number" ? undefined : String(fallbackCursor?.since ?? "").trim() || undefined);
    const incremental = Boolean(effectiveSince) || typeof effectiveSinceSeq === "number";
    const params = new URLSearchParams();
    if (effectiveSince) params.set("since", effectiveSince);
    if (typeof effectiveSinceSeq === "number" && effectiveSinceSeq >= 0) {
      params.set("sinceSeq", String(effectiveSinceSeq));
    }
    let res: Response | null = null;
    const initialLimitCandidates = incremental ? [] : buildInitialChangesLimitCandidates(INITIAL_CHANGES_LIMIT_LOGS);
    if (initialLimitCandidates.length > 0) {
      for (const limit of initialLimitCandidates) {
        const attemptParams = new URLSearchParams(params);
        attemptParams.set("limitLogs", String(limit));
        const attemptQuery = attemptParams.toString();
        const attemptUrl = attemptQuery ? `/api/changes?${attemptQuery}` : "/api/changes";
        try {
          res = await fetchChangesResponse(attemptUrl, INITIAL_CHANGES_FETCH_TIMEOUT_MS);
        } catch (error) {
          if (isAbortError(error)) continue;
          return;
        }
        if (res.ok) break;
        if (res.status < 500) break;
      }
    } else {
      const query = params.toString();
      const url = query ? `/api/changes?${query}` : "/api/changes";
      try {
        res = await fetchChangesResponse(url);
      } catch {
        // Network unavailable or API temporarily unreachable — will retry on next poll/watchdog tick.
        return;
      }
    }
    if (!res) return;
    if (!res.ok) return;
    const payload = (await res.json().catch(() => null)) as ChangesPayload | null;
    if (!payload) return;
    const resetAt = String(payload.resetAt ?? "").trim() || undefined;
    if (typeof window !== "undefined") {
      const prevStoredResetAt = window.localStorage.getItem(RESET_AT_STORAGE_KEY) || undefined;
      const prevStoredMs = prevStoredResetAt ? parseIsoMs(prevStoredResetAt) : 0;
      if (resetAt) {
        window.localStorage.setItem(RESET_AT_STORAGE_KEY, resetAt);
      }
      if (resetAt && incremental) {
        const resetMs = parseIsoMs(resetAt);
        if (Number.isFinite(resetMs) && resetMs > prevStoredMs) {
          snapshotCursorRef.current = null;
          return { reset: true };
        }
      }
    }
    const responseCursor = String(payload.cursor ?? "").trim() || undefined;
    const cursorSeqRaw = Number(payload.cursorSeq);
    const cursorSeq = Number.isFinite(cursorSeqRaw) && cursorSeqRaw >= 0 ? Math.floor(cursorSeqRaw) : undefined;
    const deletedTopics = Array.isArray(payload.deletedTopics) ? (payload.deletedTopics as DeletedEntityRef[]) : [];
    recordDeletedTopics(deletedTopics);
    const typingSignals = Array.isArray(payload.openclawTyping) ? (payload.openclawTyping as TypingSignalSnapshot[]) : [];
    const threadWorkSignals = Array.isArray(payload.openclawThreadWork)
      ? (payload.openclawThreadWork as ThreadWorkSignalSnapshot[])
      : [];
    const authoritativeOpenclawTyping = Boolean(payload.authoritativeOpenclawTyping);
    const authoritativeOpenclawThreadWork = Boolean(payload.authoritativeOpenclawThreadWork);
    const replaceSignalSnapshots = typeof effectiveSinceSeq !== "number";
    // Full snapshot: replace to avoid keeping stale items when the stream resets or base/token changes.
    if (!incremental) {
      if (Array.isArray(payload.spaces)) {
        setSpaces((prev) => overlayFresherById(payload.spaces as Space[], prev, responseCursor, mergeById));
      }
      if (Array.isArray(payload.topics)) {
        setTopics((prev) =>
          applyDeletedTopicTimestampRecord(
            applyDeletedEntityTombstones(
              overlayFresherById(payload.topics as Topic[], prev, responseCursor, mergeById),
              deletedTopics
            ),
            deletedTopicTimestampsRef.current
          )
        );
      } else if (deletedTopics.length > 0) {
        setTopics((prev) =>
          applyDeletedTopicTimestampRecord(applyDeletedEntityTombstones(prev, deletedTopics), deletedTopicTimestampsRef.current)
        );
      }
      if (Array.isArray(payload.logs)) {
        setLogs((prev) => {
          const next = overlayFresherById(payload.logs as LogEntry[], prev, responseCursor, mergeLogs);
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
      setOpenclawTyping((prev) =>
        reconcileTypingSnapshot(prev, typingSignals, responseCursor, {
          replace: authoritativeOpenclawTyping && replaceSignalSnapshots,
        })
      );
      setOpenclawThreadWork((prev) =>
        reconcileThreadWorkSnapshot(prev, threadWorkSignals, responseCursor, {
          replace: authoritativeOpenclawThreadWork && replaceSignalSnapshots,
        })
      );
      if (Array.isArray(payload.drafts)) {
        setDrafts((prev) => {
          const next: Record<string, Draft> = {};
          for (const item of payload.drafts as Draft[]) {
            const key = String((item as Draft | undefined)?.key ?? "").trim();
            if (!key) continue;
            next[key] = item as Draft;
          }
          return overlayFresherDrafts(next, prev, responseCursor);
        });
      }
      setHydrated(true);
    } else {
      if (Array.isArray(payload.spaces)) setSpaces((prev) => mergeById(prev, payload.spaces as Space[]));
      if (Array.isArray(payload.topics)) {
        setTopics((prev) =>
          applyDeletedTopicTimestampRecord(
            applyDeletedEntityTombstones(mergeById(prev, payload.topics as Topic[]), deletedTopics),
            deletedTopicTimestampsRef.current
          )
        );
      } else if (deletedTopics.length > 0) {
        setTopics((prev) =>
          applyDeletedTopicTimestampRecord(applyDeletedEntityTombstones(prev, deletedTopics), deletedTopicTimestampsRef.current)
        );
      }
      if (Array.isArray(payload.logs)) setLogs((prev) => mergeLogs(prev, payload.logs as LogEntry[]));
      if (Array.isArray(payload.deletedLogIds) && payload.deletedLogIds.length > 0) {
        const deleted = new Set(payload.deletedLogIds.map((id: unknown) => String(id ?? "").trim()).filter(Boolean));
        if (deleted.size > 0) setLogs((prev) => prev.filter((row) => !deleted.has(row.id)));
      }
      setOpenclawTyping((prev) =>
        reconcileTypingSnapshot(prev, typingSignals, responseCursor, {
          replace: authoritativeOpenclawTyping && replaceSignalSnapshots,
        })
      );
      setOpenclawThreadWork((prev) =>
        reconcileThreadWorkSnapshot(prev, threadWorkSignals, responseCursor, {
          replace: authoritativeOpenclawThreadWork && replaceSignalSnapshots,
        })
      );
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
      responseCursor ||
      maxTimestamp([
        ...((payload.spaces as Array<{ updatedAt?: string; createdAt?: string }> | undefined) ?? []),
        ...((payload.topics as Array<{ updatedAt?: string; createdAt?: string }> | undefined) ?? []),
        ...((payload.logs as Array<{ updatedAt?: string; createdAt?: string }> | undefined) ?? []),
        ...((payload.drafts as Array<{ updatedAt?: string; createdAt?: string }> | undefined) ?? []),
      ]);
    return { cursor: ts, cursorSeq };
  }, [recordDeletedTopics]);

  const applyLiveEvent = useCallback((event: LiveEvent) => {
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
        recordDeletedTopics([{ id, deletedAt: resolveLiveEventTimestamp(event) }]);
        setTopics((prev) => applyDeletedTopicTimestampRecord(removeById(prev, id), deletedTopicTimestampsRef.current));
        setLogs((prev) => prev.map((item) => (item.topicId === id ? { ...item, topicId: null } : item)));
      }
      return;
    }
    if ((event.type === "log.appended" || event.type === "log.patched") && event.data && typeof event.data === "object") {
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
      const payload = event.data as ThreadWorkSignalSnapshot;
      const sessionKey = String(payload.sessionKey ?? "").trim();
      const normalizedSessionKey = normalizeBoardSessionKey(sessionKey);
      if (!normalizedSessionKey) return;
      const active = Boolean(payload.active);
      const requestId = String(payload.requestId ?? "").trim();
      const reason = String(payload.reason ?? "").trim();
      const runId = String(payload.runId ?? "").trim();
      const waitingItemKeys = Array.isArray(payload.waitingItemKeys)
        ? payload.waitingItemKeys.map((value) => String(value ?? "").trim()).filter(Boolean).slice(0, 6)
        : undefined;
      const activeItemsRaw = payload.activeItems == null ? Number.NaN : Number(payload.activeItems);
      const activeItems = Number.isFinite(activeItemsRaw) ? Math.max(0, Math.floor(activeItemsRaw)) : undefined;
      const lastActivityAt = String(payload.lastActivityAt ?? "").trim();
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
            runId: runId || undefined,
            activeItems,
            waitingItemKeys,
            lastActivityAt: lastActivityAt || undefined,
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
  }, [appendLog, reconcile, recordDeletedTopics, upsertDraft, upsertSpace, upsertTopic]);

  const enqueueLiveEvent = useCallback((event: LiveEvent) => {
    liveEventQueueRef.current.push(event);
    if (liveEventFlushFrameRef.current != null) return;
    liveEventFlushFrameRef.current = window.requestAnimationFrame(() => {
      liveEventFlushFrameRef.current = null;
      const batch = liveEventQueueRef.current.splice(0);
      if (batch.length === 0) return;
      startTransition(() => {
        for (const item of batch) {
          applyLiveEvent(item);
        }
      });
    });
  }, [applyLiveEvent]);

  useLiveUpdates({
    onConnectionChange: handleConnectionChange,
    onEvent: enqueueLiveEvent,
    reconcile,
  });

  const topicById = useMemo(() => new Map(safeTopics.map((topic) => [topic.id, topic])), [safeTopics]);
  const knownLogIdsRef = useRef<Set<string> | null>(null);
  const prevTopicStatusRef = useRef<Map<string, { status: string; snoozedUntil: string | null }> | null>(null);
  const seenSeedCutoffRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (liveEventFlushFrameRef.current != null) {
        window.cancelAnimationFrame(liveEventFlushFrameRef.current);
      }
      if (snapshotSaveTimerRef.current != null) {
        window.clearTimeout(snapshotSaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!browserOnline) return;
    void drainQueuedMutations();
    const timer = window.setInterval(() => {
      void drainQueuedMutations();
    }, 5_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [browserOnline, hydrated, sseConnected]);

  useEffect(() => {
    if (!hydrated) return;
    if (!seenSeedCutoffRef.current) {
      seenSeedCutoffRef.current = new Date().toISOString();
    }
    const cutoff = seenSeedCutoffRef.current;
    if (!cutoff) return;
    if (logs.length === 0 && safeTopics.length === 0) return;

    const seeded: Record<string, string> = {};
    for (const entry of logs) {
      const chatKey = chatKeyFromLogEntry(entry);
      if (!chatKey) continue;
      if (chatSeenByKey[chatKey]) continue;
      const createdAt = String(entry.createdAt ?? "").trim();
      if (!createdAt) continue;
      if (createdAt > cutoff) continue;
      const previous = seeded[chatKey] ?? "";
      if (!previous || createdAt > previous) seeded[chatKey] = createdAt;
    }
    for (const topic of safeTopics) {
      const topicId = String(topic.id ?? "").trim();
      if (!topicId) continue;
      const chatKey = chatKeyForTopic(topicId);
      if (chatSeenByKey[chatKey]) continue;
      const seenAt = topicLastTouchedAt(topic, latestTopicTouchById[topicId]);
      if (!seenAt) continue;
      if (seenAt > cutoff) continue;
      const previous = seeded[chatKey] ?? "";
      if (!previous || seenAt > previous) seeded[chatKey] = seenAt;
    }
    if (Object.keys(seeded).length === 0) return;
    setLocalStorageItem(CHAT_SEEN_AT_KEY, JSON.stringify({ ...chatSeenByKey, ...seeded }));
  }, [chatSeenByKey, hydrated, latestTopicTouchById, logs, safeTopics]);

  useEffect(() => {
    void setPwaBadge(pwaAttentionCount);
  }, [pwaAttentionCount]);

  useEffect(() => {
    if (!hydrated) return;
    const validTopicIds = new Set(safeTopics.map((topic) => topic.id));
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
  }, [hydrated, safeTopics, unsnoozedTopicBadges]);

  useEffect(() => {
    if (Object.keys(unsnoozedTopicBadges).length > 0) return;
    void closePwaNotificationsByTag([UNSNOOZE_TOPICS_SUMMARY_TAG]);
  }, [unsnoozedTopicBadges]);

  useEffect(() => {
    if (attentionTopicCount > 0) return;
    void closePwaNotificationsByTag([CHAT_SUMMARY_TAG]);
  }, [attentionTopicCount]);

  useEffect(() => {
    const previous = prevTopicStatusRef.current;
    const next = new Map<string, { status: string; snoozedUntil: string | null }>();
    const additions: Topic[] = [];

    for (const topic of safeTopics) {
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
      const url = `${buildTopicUrl(topic, safeTopics)}?focus=1`;
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
        title: "ClawBoard",
        body: `${additions.length} topics unsnoozed.`,
        tag: UNSNOOZE_TOPICS_SUMMARY_TAG,
        url: "/u",
      },
      notificationsEnabled
    );
  }, [notificationsEnabled, safeTopics, unsnoozedTopicBadges]);

  useEffect(() => {
    if (!hydrated) return;
    if (snapshotSaveTimerRef.current != null) {
      window.clearTimeout(snapshotSaveTimerRef.current);
    }
    snapshotSaveTimerRef.current = window.setTimeout(() => {
      const cursor = window.localStorage.getItem(STREAM_EVENT_TS_STORAGE_KEY) ?? "";
      const cursorSeqRaw = Number.parseInt(window.localStorage.getItem(STREAM_EVENT_SEQ_STORAGE_KEY) ?? "", 10);
      void saveBoardSnapshot({
        spaces,
        topics: safeTopics,
        logs,
        drafts,
        openclawTyping,
        openclawThreadWork,
        cursor: String(cursor).trim() || undefined,
        cursorSeq: Number.isFinite(cursorSeqRaw) && cursorSeqRaw >= 0 ? cursorSeqRaw : undefined,
        cachedAt: new Date().toISOString(),
      });
      snapshotSaveTimerRef.current = null;
    }, 180);
    return () => {
      if (snapshotSaveTimerRef.current != null) {
        window.clearTimeout(snapshotSaveTimerRef.current);
        snapshotSaveTimerRef.current = null;
      }
    };
  }, [drafts, hydrated, logs, openclawThreadWork, openclawTyping, safeTopics, spaces]);

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
      const topicId = effectiveLogTopicId(entry);
      if (!topicId) return false;
      if (isChatNoiseLog(entry)) return false;
      const createdAtMs = Date.parse(entry.createdAt);
      if (!Number.isFinite(createdAtMs)) return false;
      const seenAtMs = Date.parse(chatSeenByKey[chatKeyForTopic(topicId)] ?? "");
      return !Number.isFinite(seenAtMs) || createdAtMs > seenAtMs;
    });
    if (unseenAdditions.length === 0) return;

    const topicIds = new Set<string>();
    for (const entry of unseenAdditions) {
      const topicId = effectiveLogTopicId(entry);
      if (topicId) topicIds.add(topicId);
    }
    if (topicIds.size === 0) return;

    if (topicIds.size === 1) {
      const topicId = Array.from(topicIds)[0];
      const topic = topicById.get(topicId);
      if (topic) {
        const entry = [...unseenAdditions]
          .reverse()
          .find((candidate) => effectiveLogTopicId(candidate) === topicId);
        const body = clipNotificationText(entry?.content ?? entry?.summary ?? "Recent activity needs a look.");
        const chatKey = topicId ? `topic:${topicId}` : "";
        const url = `${buildTopicUrl(topic, safeTopics)}?focus=1`;
        void showPwaNotification(
          {
            title: `Topic Activity: ${topic.name}`,
            body,
            tag: chatKey ? chatTag(chatKey) : CHAT_SUMMARY_TAG,
            url,
            data: { chatKey, topicId: topic.id },
          },
          notificationsEnabled
        );
        return;
      }
    }

    void showPwaNotification(
      {
        title: "ClawBoard",
        body: `${topicIds.size} topics need a look.`,
        tag: CHAT_SUMMARY_TAG,
        url: "/u",
      },
      notificationsEnabled
    );
  }, [chatSeenByKey, hydrated, logs, notificationsEnabled, safeTopics, topicById]);

  const topicTags = useMemo(() => {
    const labels = new Map<string, string>();
    for (const topic of safeTopics) {
      for (const rawTag of filterUserFacingTopicTagLabels(topic.tags ?? [])) {
        const label = cleanTopicTagLabel(rawTag);
        const normalized = normalizeTagValue(label);
        if (!normalized || labels.has(normalized)) continue;
        labels.set(normalized, label);
      }
    }
    return Array.from(labels.values()).sort(
      (a, b) => normalizeTagValue(a).localeCompare(normalizeTagValue(b)) || a.localeCompare(b)
    );
  }, [safeTopics]);

  const value = useMemo(
    () => ({
      spaces,
      topics: safeTopics,
      topicTags,
      tasks,
      logs,
      unsnoozedTopicBadges,
      unsnoozedTaskBadges,
      chatSeenByKey,
      attentionTopicCount,
      drafts,
      openclawTyping,
      openclawThreadWork,
      hydrated,
      sseConnected,
      connectionStatus,
      disconnectedSince,
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
      safeTopics,
      topicTags,
      tasks,
      logs,
      unsnoozedTopicBadges,
      unsnoozedTaskBadges,
      chatSeenByKey,
      attentionTopicCount,
      drafts,
      openclawTyping,
      openclawThreadWork,
      hydrated,
      sseConnected,
      connectionStatus,
      disconnectedSince,
      upsertSpace,
      upsertTopic,
      appendLog,
      upsertDraft,
      setTasks,
      markChatSeen,
      upsertTask,
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
