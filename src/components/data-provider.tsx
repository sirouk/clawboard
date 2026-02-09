"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { LogEntry, Task, Topic } from "@/lib/types";
import { apiFetch } from "@/lib/api";
import { useLiveUpdates } from "@/lib/use-live-updates";
import { LiveEvent, mergeById, mergeLogs, maxTimestamp, removeById, upsertById } from "@/lib/live-utils";

type DataContextValue = {
  topics: Topic[];
  tasks: Task[];
  logs: LogEntry[];
  openclawTyping: Record<string, { typing: boolean; requestId?: string; updatedAt: string }>;
  setTopics: React.Dispatch<React.SetStateAction<Topic[]>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  upsertTopic: (topic: Topic) => void;
  upsertTask: (task: Task) => void;
  appendLog: (log: LogEntry) => void;
};

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [openclawTyping, setOpenclawTyping] = useState<
    Record<string, { typing: boolean; requestId?: string; updatedAt: string }>
  >({});

  const upsertTopic = (topic: Topic) => setTopics((prev) => upsertById(prev, topic));
  const upsertTask = (task: Task) => setTasks((prev) => upsertById(prev, task));
  const appendLog = (log: LogEntry) => setLogs((prev) => mergeLogs(prev, [log]));

  const reconcile = async (since?: string) => {
    const url = since ? `/api/changes?since=${encodeURIComponent(since)}` : "/api/changes";
    const res = await apiFetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json().catch(() => null);
    if (!payload) return;
    if (Array.isArray(payload.topics)) setTopics((prev) => mergeById(prev, payload.topics as Topic[]));
    if (Array.isArray(payload.tasks)) setTasks((prev) => mergeById(prev, payload.tasks as Task[]));
    if (Array.isArray(payload.logs)) setLogs((prev) => mergeLogs(prev, payload.logs as LogEntry[]));
    const ts = maxTimestamp([...(payload.topics ?? []), ...(payload.tasks ?? []), ...(payload.logs ?? [])]);
    return ts;
  };

  useLiveUpdates({
    onEvent: (event: LiveEvent) => {
      if (!event || !event.type) return;
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
        if (!sessionKey) return;
        const typing = Boolean(payload.typing);
        const requestId = String(payload.requestId ?? "").trim();
        const updatedAt = new Date().toISOString();
        setOpenclawTyping((prev) => ({
          ...prev,
          [sessionKey]: { typing, requestId: requestId || undefined, updatedAt },
        }));
        return;
      }
      if (event.type === "log.deleted" && event.data && typeof event.data === "object") {
        const id = (event.data as { id?: string }).id;
        if (id) setLogs((prev) => removeById(prev, id));
      }
    },
    reconcile,
  });

  const value = useMemo(
    () => ({
      topics,
      tasks,
      logs,
      openclawTyping,
      setTopics,
      setTasks,
      setLogs,
      upsertTopic,
      upsertTask,
      appendLog,
    }),
    [topics, tasks, logs, openclawTyping]
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
