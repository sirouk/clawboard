"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Draft, LogEntry, Space, Task, Topic } from "@/lib/types";
import { apiFetch } from "@/lib/api";
import { useLiveUpdates } from "@/lib/use-live-updates";
import { LiveEvent, mergeById, mergeLogs, maxTimestamp, removeById, upsertById } from "@/lib/live-utils";
import { normalizeBoardSessionKey } from "@/lib/board-session";
import {
  CHAT_SEEN_AT_KEY,
  UNSNOOZED_TASKS_KEY,
  UNSNOOZED_TOPICS_KEY,
  chatKeyFromLogEntry,
  parseNumberMap,
  parseStringMap,
  isUnreadConversationCandidate,
} from "@/lib/attention-state";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";
import { PUSH_ENABLED_KEY, setPwaBadge, showPwaNotification } from "@/lib/pwa-utils";
import { buildTaskUrl, buildTopicUrl } from "@/lib/url";

type DataContextValue = {
  spaces: Space[];
  topics: Topic[];
  topicTags: string[];
  tasks: Task[];
  logs: LogEntry[];
  drafts: Record<string, Draft>;
  openclawTyping: Record<string, { typing: boolean; requestId?: string; updatedAt: string }>;
  hydrated: boolean;
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
};

const DataContext = createContext<DataContextValue | null>(null);

function normalizeTagValue(value: string) {
  const lowered = String(value ?? "").toLowerCase();
  const withDashes = lowered.replace(/\s+/g, "-");
  const stripped = withDashes.replace(/[^a-z0-9-]/g, "");
  return stripped.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function clipNotificationText(value: string, max = 140) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "New message";
  if (normalized.length <= max) return normalized;
  const safe = Math.max(1, max - 3);
  return `${normalized.slice(0, safe)}...`;
}

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [openclawTyping, setOpenclawTyping] = useState<
    Record<string, { typing: boolean; requestId?: string; updatedAt: string }>
  >({});
  const [hydrated, setHydrated] = useState(false);
  const unsnoozedTopicsRaw = useLocalStorageItem(UNSNOOZED_TOPICS_KEY) ?? "{}";
  const unsnoozedTasksRaw = useLocalStorageItem(UNSNOOZED_TASKS_KEY) ?? "{}";
  const chatSeenRaw = useLocalStorageItem(CHAT_SEEN_AT_KEY) ?? "{}";
  const notificationsEnabledRaw = useLocalStorageItem(PUSH_ENABLED_KEY);

  const unsnoozedTopicBadges = useMemo(() => parseNumberMap(unsnoozedTopicsRaw), [unsnoozedTopicsRaw]);
  const unsnoozedTaskBadges = useMemo(() => parseNumberMap(unsnoozedTasksRaw), [unsnoozedTasksRaw]);
  const chatSeenByKey = useMemo(() => parseStringMap(chatSeenRaw), [chatSeenRaw]);
  const notificationsEnabled = useMemo(() => notificationsEnabledRaw !== "false", [notificationsEnabledRaw]);

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

  const pwaAttentionCount = useMemo(
    () => Object.keys(unsnoozedTopicBadges).length + Object.keys(unsnoozedTaskBadges).length + unreadMessageCount,
    [unsnoozedTaskBadges, unsnoozedTopicBadges, unreadMessageCount]
  );

  const upsertSpace = (space: Space) => setSpaces((prev) => upsertById(prev, space));
  const upsertTopic = (topic: Topic) => setTopics((prev) => upsertById(prev, topic));
  const upsertTask = (task: Task) => setTasks((prev) => upsertById(prev, task));
  const appendLog = (log: LogEntry) => setLogs((prev) => mergeLogs(prev, [log]));
  const upsertDraft = (draft: Draft) =>
    setDrafts((prev) => {
      const key = (draft?.key ?? "").trim();
      if (!key) return prev;
      const current = prev[key];
      if (current && JSON.stringify(current) === JSON.stringify(draft)) return prev;
      return { ...prev, [key]: draft };
    });

  const reconcile = async (since?: string) => {
    const url = since ? `/api/changes?since=${encodeURIComponent(since)}` : "/api/changes";
    const res = await apiFetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json().catch(() => null);
    if (!payload) return;
    // Full snapshot: replace to avoid keeping stale items when the stream resets or base/token changes.
    if (!since) {
      // Preserve newer local/SSE-updated space rows if a full snapshot races with in-flight writes.
      if (Array.isArray(payload.spaces)) setSpaces((prev) => mergeById(prev, payload.spaces as Space[]));
      if (Array.isArray(payload.topics)) setTopics(payload.topics as Topic[]);
      if (Array.isArray(payload.tasks)) setTasks(payload.tasks as Task[]);
      if (Array.isArray(payload.logs)) setLogs(mergeLogs([], payload.logs as LogEntry[]));
      if (Array.isArray(payload.drafts)) {
        const next: Record<string, Draft> = {};
        for (const item of payload.drafts as Draft[]) {
          const key = String((item as Draft | undefined)?.key ?? "").trim();
          if (!key) continue;
          next[key] = item as Draft;
        }
        setDrafts(next);
      }
      setHydrated(true);
    } else {
      if (Array.isArray(payload.spaces)) setSpaces((prev) => mergeById(prev, payload.spaces as Space[]));
      if (Array.isArray(payload.topics)) setTopics((prev) => mergeById(prev, payload.topics as Topic[]));
      if (Array.isArray(payload.tasks)) setTasks((prev) => mergeById(prev, payload.tasks as Task[]));
      if (Array.isArray(payload.logs)) setLogs((prev) => mergeLogs(prev, payload.logs as LogEntry[]));
      if (Array.isArray(payload.deletedLogIds) && payload.deletedLogIds.length > 0) {
        const deleted = new Set(payload.deletedLogIds.map((id: unknown) => String(id ?? "").trim()).filter(Boolean));
        if (deleted.size > 0) setLogs((prev) => prev.filter((row) => !deleted.has(row.id)));
      }
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
    const ts = maxTimestamp([
      ...(payload.spaces ?? []),
      ...(payload.topics ?? []),
      ...(payload.tasks ?? []),
      ...(payload.logs ?? []),
      ...(payload.drafts ?? []),
    ]);
    return ts;
  };

  useLiveUpdates({
    onEvent: (event: LiveEvent) => {
      if (!event || !event.type) return;
      if (event.type === "space.upserted" && event.data && typeof event.data === "object") {
        upsertSpace(event.data as Space);
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
          setTasks((prev) => prev.map((item) => (item.topicId === id ? { ...item, topicId: null } : item)));
          setLogs((prev) => prev.map((item) => (item.topicId === id ? { ...item, topicId: null } : item)));
        }
        return;
      }
      if (event.type === "task.upserted" && event.data && typeof event.data === "object") {
        upsertTask(event.data as Task);
        return;
      }
      if (event.type === "task.deleted" && event.data && typeof event.data === "object") {
        const id = (event.data as { id?: string }).id;
        if (id) {
          setTasks((prev) => removeById(prev, id));
          setLogs((prev) => prev.map((item) => (item.taskId === id ? { ...item, taskId: null } : item)));
        }
        return;
      }
      if (
        (event.type === "log.appended" || event.type === "log.patched") &&
        event.data &&
        typeof event.data === "object"
      ) {
        appendLog(event.data as LogEntry);
        return;
      }
      if (event.type === "openclaw.typing" && event.data && typeof event.data === "object") {
        const payload = event.data as { sessionKey?: unknown; typing?: unknown; requestId?: unknown };
        const sessionKey = String(payload.sessionKey ?? "").trim();
        const normalizedSessionKey = normalizeBoardSessionKey(sessionKey);
        if (!normalizedSessionKey) return;
        const typing = Boolean(payload.typing);
        const requestId = String(payload.requestId ?? "").trim();
        const updatedAt = new Date().toISOString();
        setOpenclawTyping((prev) => ({
          ...prev,
          [normalizedSessionKey]: { typing, requestId: requestId || undefined, updatedAt },
        }));
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
  const prevTaskSnoozeRef = useRef<Map<string, string | null> | null>(null);
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
      const url = `${buildTopicUrl(topic, topics)}?chat=1&focus=1`;
      void showPwaNotification(
        {
          title: `Topic unsnoozed: ${topic.name}`,
          body: "Activity resumed.",
          tag: `clawboard-unsnooze-topic-${topic.id}`,
          url,
        },
        notificationsEnabled
      );
      return;
    }

    void showPwaNotification(
      {
        title: "Clawboard",
        body: `${additions.length} topics unsnoozed.`,
        tag: "clawboard-unsnooze-topics",
        url: "/u",
      },
      notificationsEnabled
    );
  }, [notificationsEnabled, topics, unsnoozedTopicBadges]);

  useEffect(() => {
    const previous = prevTaskSnoozeRef.current;
    const next = new Map<string, string | null>();
    const additions: Task[] = [];

    for (const task of tasks) {
      const snoozedUntil = task.snoozedUntil ? String(task.snoozedUntil) : null;
      next.set(task.id, snoozedUntil);
      if (!previous) continue;
      const before = previous.get(task.id);
      if (!before) continue;
      if (before && !snoozedUntil) additions.push(task);
    }
    prevTaskSnoozeRef.current = next;

    if (!previous || additions.length === 0) return;

    const stamp = Date.now();
    let changed = false;
    const updated: Record<string, number> = { ...unsnoozedTaskBadges };
    for (const task of additions) {
      if (!Object.prototype.hasOwnProperty.call(updated, task.id)) changed = true;
      updated[task.id] = stamp;
    }
    if (changed) {
      setLocalStorageItem(UNSNOOZED_TASKS_KEY, JSON.stringify(updated));
    }

    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible") return;
    if (!notificationsEnabled) return;

    if (additions.length === 1) {
      const task = additions[0];
      const url = `${buildTaskUrl(task, topics)}?focus=1`;
      void showPwaNotification(
        {
          title: `Task unsnoozed: ${task.title}`,
          body: "Activity resumed.",
          tag: `clawboard-unsnooze-task-${task.id}`,
          url,
        },
        notificationsEnabled
      );
      return;
    }

    void showPwaNotification(
      {
        title: "Clawboard",
        body: `${additions.length} tasks unsnoozed.`,
        tag: "clawboard-unsnooze-tasks",
        url: "/u",
      },
      notificationsEnabled
    );
  }, [notificationsEnabled, tasks, topics, unsnoozedTaskBadges]);

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
      if (chatKey.startsWith("task:")) {
        const taskId = chatKey.slice("task:".length).trim();
        const task = taskById.get(taskId);
        if (task) {
          const url = `${buildTaskUrl(task, topics)}?focus=1`;
          void showPwaNotification(
            {
              title: `Task Chat: ${task.title}`,
              body,
              tag: `clawboard-chat-${chatKey}`,
              url,
            },
            notificationsEnabled
          );
          return;
        }
      } else if (chatKey.startsWith("topic:")) {
        const topicId = chatKey.slice("topic:".length).trim();
        const topic = topicById.get(topicId);
        if (topic) {
          const url = `${buildTopicUrl(topic, topics)}?chat=1&focus=1`;
          void showPwaNotification(
            {
              title: `Topic Chat: ${topic.name}`,
              body,
              tag: `clawboard-chat-${chatKey}`,
              url,
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
        tag: "clawboard-chat-summary",
        url: "/u",
      },
      notificationsEnabled
    );
  }, [chatSeenByKey, hydrated, logs, notificationsEnabled, taskById, topicById, topics]);

  const topicTags = useMemo(() => {
    const seen = new Set<string>();
    for (const topic of topics) {
      for (const rawTag of topic.tags ?? []) {
        const normalized = normalizeTagValue(String(rawTag ?? ""));
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
      }
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [topics]);

  const value = useMemo(
    () => ({
      spaces,
      topics,
      topicTags,
      tasks,
      logs,
      drafts,
      openclawTyping,
      hydrated,
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
    }),
    [spaces, topics, topicTags, tasks, logs, drafts, openclawTyping, hydrated]
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
