"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { Draft, LogEntry, Space, Task, Topic } from "@/lib/types";
import { apiFetch } from "@/lib/api";
import { useLiveUpdates } from "@/lib/use-live-updates";
import { LiveEvent, mergeById, mergeLogs, maxTimestamp, removeById, upsertById } from "@/lib/live-utils";
import { normalizeBoardSessionKey } from "@/lib/board-session";

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
      if (Array.isArray(payload.spaces)) setSpaces(payload.spaces as Space[]);
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
