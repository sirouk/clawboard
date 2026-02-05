"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { LogEntry, Task, Topic } from "@/lib/types";
import { apiUrl } from "@/lib/api";
import { useLiveUpdates } from "@/lib/use-live-updates";
import { LiveEvent, mergeById, mergeLogs, maxTimestamp, prependUnique, upsertById } from "@/lib/live-utils";

type DataContextValue = {
  topics: Topic[];
  tasks: Task[];
  logs: LogEntry[];
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

  const upsertTopic = (topic: Topic) => setTopics((prev) => upsertById(prev, topic));
  const upsertTask = (task: Task) => setTasks((prev) => upsertById(prev, task));
  const appendLog = (log: LogEntry) => setLogs((prev) => upsertById(prev, log));

  const reconcile = async (since?: string) => {
    const url = since ? `/api/changes?since=${encodeURIComponent(since)}` : "/api/changes";
    const res = await fetch(apiUrl(url), { cache: "no-store" });
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
      if (event.type === "task.upserted" && event.data && typeof event.data === "object") {
        upsertTask(event.data as Task);
        return;
      }
      if (
        (event.type === "log.appended" || event.type === "log.patched") &&
        event.data &&
        typeof event.data === "object"
      ) {
        appendLog(event.data as LogEntry);
      }
    },
    reconcile,
  });

  const value = useMemo(
    () => ({
      topics,
      tasks,
      logs,
      setTopics,
      setTasks,
      setLogs,
      upsertTopic,
      upsertTask,
      appendLog,
    }),
    [topics, tasks, logs]
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
