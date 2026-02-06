"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { LogEntry, Task, Topic } from "@/lib/types";
import { Badge, Button, Input, Select, StatusPill } from "@/components/ui";
import { LogList } from "@/components/log-list";
import { formatRelativeTime } from "@/lib/format";
import { useAppConfig } from "@/components/providers";
import { PinToggle } from "@/components/pin-toggle";
import { TaskPinToggle } from "@/components/task-pin-toggle";
import { decodeSlugId, encodeTaskSlug, encodeTopicSlug, slugify } from "@/lib/slug";
import { cn } from "@/lib/cn";
import { apiFetch } from "@/lib/api";
import { useDataStore } from "@/components/data-provider";
import { useSemanticSearch } from "@/lib/use-semantic-search";

const STATUS_TONE: Record<string, "muted" | "accent" | "accent2" | "warning" | "success"> = {
  todo: "muted",
  doing: "accent",
  blocked: "warning",
  done: "success",
};

const STATUS_LABELS: Record<string, string> = {
  todo: "To Do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

const TASK_STATUS_FILTERS = ["all", "todo", "doing", "blocked", "done"] as const;
type TaskStatusFilter = (typeof TASK_STATUS_FILTERS)[number];

const isTaskStatusFilter = (value: string): value is TaskStatusFilter =>
  TASK_STATUS_FILTERS.includes(value as TaskStatusFilter);

const TASK_TIMELINE_LIMIT = 2;
const TOPIC_TIMELINE_LIMIT = 4;
type MessageDensity = "comfortable" | "compact";
const TOPIC_FALLBACK_COLORS = ["#FF8A4A", "#4DA39E", "#6FA8FF", "#E0B35A", "#8BC17E", "#F17C8E"];
const TASK_FALLBACK_COLORS = ["#4EA1FF", "#59C3A6", "#F4B55F", "#9A8BFF", "#F0897C", "#6FB8D8"];
const topicChatLimitKey = (topicId: string) => `topic-chat:${topicId}`;

function normalizeHexColor(value: string | undefined | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

function hexToRgb(hex: string) {
  const normalized = normalizeHexColor(hex) ?? "#4EA1FF";
  const raw = normalized.slice(1);
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function rgba(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function colorFromSeed(seed: string, palette: string[]) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % palette.length;
  return palette[index];
}

function pickAlternatingColor(base: string, previous: string | null, index: number, palette: string[]) {
  const normalized = normalizeHexColor(base) ?? palette[index % palette.length];
  if (!previous || normalized !== previous) return normalized;
  const start = palette.indexOf(normalized);
  const nextIndex = start >= 0 ? (start + 1) % palette.length : (index + 1) % palette.length;
  return palette[nextIndex];
}

function topicGlowStyle(color: string, index: number, expanded: boolean): CSSProperties {
  const band = index % 2 === 0;
  const topAlpha = expanded ? (band ? 0.25 : 0.19) : band ? 0.18 : 0.14;
  const lowAlpha = expanded ? (band ? 0.13 : 0.09) : band ? 0.09 : 0.07;
  return {
    background: `linear-gradient(155deg, ${rgba(color, topAlpha)}, rgba(16,19,24,0.90) 48%, ${rgba(color, lowAlpha)})`,
    boxShadow: `0 0 0 1px ${rgba(color, expanded ? 0.28 : 0.2)}, 0 14px 34px ${rgba(color, expanded ? 0.15 : 0.1)}`,
  };
}

function taskGlowStyle(color: string, index: number, expanded: boolean): CSSProperties {
  const band = index % 2 === 0;
  const topAlpha = expanded ? (band ? 0.27 : 0.2) : band ? 0.19 : 0.15;
  const lowAlpha = expanded ? (band ? 0.14 : 0.1) : band ? 0.1 : 0.08;
  return {
    background: `linear-gradient(145deg, ${rgba(color, topAlpha)}, rgba(20,24,31,0.86) 52%, ${rgba(color, lowAlpha)})`,
    boxShadow: `0 0 0 1px ${rgba(color, expanded ? 0.3 : 0.2)}, 0 10px 26px ${rgba(color, expanded ? 0.17 : 0.1)}`,
  };
}

type UrlState = {
  search: string;
  raw: boolean;
  density: MessageDensity;
  done: boolean;
  status: string;
  page: number;
  topics: string[];
  tasks: string[];
};

function getInitialUrlState(basePath: string): UrlState {
  if (typeof window === "undefined") {
    return { search: "", raw: false, density: "comfortable", done: false, status: "all", page: 1, topics: [], tasks: [] };
  }
  const url = new URL(window.location.href);
  const params = url.searchParams;
  const segments = url.pathname.startsWith(basePath)
    ? url.pathname.slice(basePath.length).split("/").filter(Boolean)
    : [];
  const parsedTopics: string[] = [];
  const parsedTasks: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const key = segments[i];
    const value = segments[i + 1];
    if (!value) continue;
    if (key === "topic") {
      parsedTopics.push(decodeSlugId(value));
      i += 1;
    } else if (key === "task") {
      parsedTasks.push(decodeSlugId(value));
      i += 1;
    }
  }
  let nextTopics = parsedTopics;
  let nextTasks = parsedTasks;
  if (nextTopics.length === 0) {
    nextTopics = params.getAll("topic").map((value) => decodeSlugId(value)).filter(Boolean);
  }
  if (nextTasks.length === 0) {
    nextTasks = params.getAll("task").map((value) => decodeSlugId(value)).filter(Boolean);
  }
  if (nextTopics.length === 0) {
    const legacyTopics = params.get("topics")?.split(",").filter(Boolean) ?? [];
    nextTopics = legacyTopics.map((value) => decodeSlugId(value)).filter(Boolean);
  }
  if (nextTasks.length === 0) {
    const legacyTasks = params.get("tasks")?.split(",").filter(Boolean) ?? [];
    nextTasks = legacyTasks.map((value) => decodeSlugId(value)).filter(Boolean);
  }
  const density: MessageDensity = params.get("density") === "compact" ? "compact" : "comfortable";
  return {
    search: params.get("q") ?? "",
    raw: params.get("raw") === "1",
    density,
    done: params.get("done") === "1",
    status: params.get("status") ?? "all",
    page: Math.max(1, Number(params.get("page") ?? 1)),
    topics: nextTopics,
    tasks: nextTasks,
  };
}

export function UnifiedView({ basePath = "/u" }: { basePath?: string } = {}) {
  const { token, tokenRequired } = useAppConfig();
  const { topics, tasks, logs, setTopics, setTasks, setLogs } = useDataStore();
  const readOnly = tokenRequired && !token;
  const scrollMemory = useRef<Record<string, number>>({});
  const [initialUrlState] = useState(() => getInitialUrlState(basePath));
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set(initialUrlState.topics));
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set(initialUrlState.tasks));
  const [expandedTopicChats, setExpandedTopicChats] = useState<Set<string>>(new Set());
  const [showRaw, setShowRaw] = useState(initialUrlState.raw);
  const [messageDensity, setMessageDensity] = useState<MessageDensity>(initialUrlState.density);
  const [search, setSearch] = useState(initialUrlState.search);
  const [showDone, setShowDone] = useState(initialUrlState.done);
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>(
    isTaskStatusFilter(initialUrlState.status) ? initialUrlState.status : "all"
  );
  const [showViewOptions, setShowViewOptions] = useState(false);
  const [timelineLimits, setTimelineLimits] = useState<Record<string, number>>({});
  const [moveTaskId, setMoveTaskId] = useState<string | null>(null);
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [topicNameDraft, setTopicNameDraft] = useState("");
  const [topicColorDraft, setTopicColorDraft] = useState("#FF8A4A");
  const [taskNameDraft, setTaskNameDraft] = useState("");
  const [taskColorDraft, setTaskColorDraft] = useState("#4EA1FF");
  const [renameSavingKey, setRenameSavingKey] = useState<string | null>(null);
  const [deleteArmedKey, setDeleteArmedKey] = useState<string | null>(null);
  const [deleteInFlightKey, setDeleteInFlightKey] = useState<string | null>(null);
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});
  const [page, setPage] = useState(initialUrlState.page);
  const [isSticky, setIsSticky] = useState(false);
  const committedSearch = useRef(initialUrlState.search);

  // Hide unclassified logs from the unified view by default.
  // Use ?raw=1 to include everything (raw / debugging view).
  const visibleLogs = useMemo(() => {
    if (showRaw) return logs;
    return logs.filter((entry) => (entry.classificationStatus ?? "pending") === "classified");
  }, [logs, showRaw]);

  const currentUrlKey = useCallback(() => {
    if (typeof window === "undefined") return basePath;
    return `${window.location.pathname}${window.location.search}`;
  }, [basePath]);

  useEffect(() => {
    const handle = () => {
      setIsSticky(window.scrollY > 12);
    };
    handle();
    window.addEventListener("scroll", handle, { passive: true });
    return () => window.removeEventListener("scroll", handle);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const store = () => {
      scrollMemory.current[currentUrlKey()] = window.scrollY;
    };
    store();
    window.addEventListener("scroll", store, { passive: true });
    return () => window.removeEventListener("scroll", store);
  }, [currentUrlKey]);

  const expandedTopicsSafe = useMemo(() => {
    const topicIds = new Set(topics.map((topic) => topic.id));
    return new Set([...expandedTopics].filter((id) => topicIds.has(id)));
  }, [expandedTopics, topics]);

  const expandedTasksSafe = useMemo(() => {
    const taskIds = new Set(tasks.map((task) => task.id));
    return new Set([...expandedTasks].filter((id) => taskIds.has(id)));
  }, [expandedTasks, tasks]);

  const expandedTopicChatsSafe = useMemo(() => {
    const topicIds = new Set(topics.map((topic) => topic.id));
    return new Set([...expandedTopicChats].filter((id) => topicIds.has(id)));
  }, [expandedTopicChats, topics]);

  const tasksByTopic = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = task.topicId ?? "unassigned";
      const list = map.get(key) ?? [];
      list.push(task);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return a.updatedAt < b.updatedAt ? 1 : -1;
      });
    }
    return map;
  }, [tasks]);

  const logsByTask = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const entry of visibleLogs) {
      if (!entry.taskId) continue;
      const list = map.get(entry.taskId) ?? [];
      list.push(entry);
      map.set(entry.taskId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    return map;
  }, [visibleLogs]);

  const logsByTopic = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const entry of visibleLogs) {
      if (!entry.topicId) continue;
      const list = map.get(entry.topicId) ?? [];
      list.push(entry);
      map.set(entry.topicId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    return map;
  }, [visibleLogs]);

  const normalizedSearch = search.trim().toLowerCase();

  const semanticLimits = useMemo(
    () => ({
      topics: Math.min(Math.max(topics.length, 120), 500),
      tasks: Math.min(Math.max(tasks.length, 240), 1200),
      logs: Math.min(Math.max(visibleLogs.length, 800), 4000),
    }),
    [topics.length, tasks.length, visibleLogs.length]
  );

  const semanticRefreshKey = useMemo(() => {
    const latestTopic = topics.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    const latestTask = tasks.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    const latestLog = visibleLogs.reduce((acc, item) => {
      const stamp = item.updatedAt || item.createdAt || "";
      return stamp > acc ? stamp : acc;
    }, "");
    return `${topics.length}:${tasks.length}:${visibleLogs.length}:${latestTopic}:${latestTask}:${latestLog}:${statusFilter}:${showDone ? 1 : 0}:${showRaw ? 1 : 0}`;
  }, [showDone, showRaw, statusFilter, tasks, topics, visibleLogs]);

  const semanticSearch = useSemanticSearch({
    query: normalizedSearch,
    includePending: showRaw,
    limitTopics: semanticLimits.topics,
    limitTasks: semanticLimits.tasks,
    limitLogs: semanticLimits.logs,
    refreshKey: semanticRefreshKey,
  });

  const semanticForQuery = useMemo(() => {
    if (!semanticSearch.data) return null;
    const resultQuery = semanticSearch.data.query.trim().toLowerCase();
    if (!resultQuery || resultQuery !== normalizedSearch) return null;
    return semanticSearch.data;
  }, [normalizedSearch, semanticSearch.data]);

  const semanticTopicIds = useMemo(() => new Set(semanticForQuery?.matchedTopicIds ?? []), [semanticForQuery]);
  const semanticTaskIds = useMemo(() => new Set(semanticForQuery?.matchedTaskIds ?? []), [semanticForQuery]);
  const semanticLogIds = useMemo(() => new Set(semanticForQuery?.matchedLogIds ?? []), [semanticForQuery]);
  const semanticTopicScores = useMemo(
    () => new Map((semanticForQuery?.topics ?? []).map((item) => [item.id, Number(item.score) || 0])),
    [semanticForQuery]
  );

  const matchesLogSearch = useCallback((entry: LogEntry) => {
    if (!normalizedSearch) return true;
    if (semanticForQuery) {
      return semanticLogIds.has(entry.id);
    }
    const haystack = `${entry.summary ?? ""} ${entry.content ?? ""} ${entry.raw ?? ""}`.toLowerCase();
    return haystack.includes(normalizedSearch);
  }, [normalizedSearch, semanticForQuery, semanticLogIds]);

  const matchesTaskSearch = useCallback((task: Task) => {
    if (!normalizedSearch) return true;
    if (semanticForQuery) {
      if (semanticTaskIds.has(task.id)) return true;
      const logMatches = logsByTask.get(task.id)?.some((entry) => semanticLogIds.has(entry.id));
      return Boolean(logMatches);
    }
    if (task.title.toLowerCase().includes(normalizedSearch)) return true;
    const logMatches = logsByTask.get(task.id)?.some(matchesLogSearch);
    return Boolean(logMatches);
  }, [logsByTask, matchesLogSearch, normalizedSearch, semanticForQuery, semanticLogIds, semanticTaskIds]);

  const matchesStatusFilter = useCallback(
    (task: Task) => {
      if (statusFilter !== "all") return task.status === statusFilter;
      if (!showDone && task.status === "done") return false;
      return true;
    },
    [showDone, statusFilter]
  );

  const orderedTopics = useMemo(() => {
    const base = [...topics]
      .map((topic) => ({
        ...topic,
        lastActivity: logsByTopic.get(topic.id)?.[0]?.createdAt ?? topic.updatedAt,
      }))
      .sort((a, b) => {
        if (normalizedSearch && semanticForQuery) {
          const aScore = semanticTopicScores.get(a.id) ?? 0;
          const bScore = semanticTopicScores.get(b.id) ?? 0;
          if (aScore !== bScore) return bScore - aScore;
        }
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return a.lastActivity < b.lastActivity ? 1 : -1;
      });

    const filtered = base.filter((topic) => {
      const taskList = tasksByTopic.get(topic.id) ?? [];
      if (statusFilter !== "all") {
        return taskList.some((task) => matchesStatusFilter(task) && matchesTaskSearch(task));
      }
      if (!normalizedSearch) return true;
      if (semanticForQuery) {
        if (semanticTopicIds.has(topic.id)) return true;
        if (taskList.some((task) => matchesStatusFilter(task) && matchesTaskSearch(task))) return true;
        const topicLogs = logsByTopic.get(topic.id) ?? [];
        return topicLogs.some((entry) => semanticLogIds.has(entry.id));
      }
      const topicHit = `${topic.name} ${topic.description ?? ""}`.toLowerCase().includes(normalizedSearch);
      if (topicHit) return true;
      if (taskList.some((task) => matchesStatusFilter(task) && matchesTaskSearch(task))) return true;
      const topicLogs = logsByTopic.get(topic.id) ?? [];
      return topicLogs.some(matchesLogSearch);
    });

    if (tasksByTopic.has("unassigned")) {
      filtered.push({
        id: "unassigned",
        name: "Unassigned",
        description: "Tasks without a topic.",
        pinned: false,
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "active",
        priority: "low",
        tags: [],
        parentId: null,
      });
    }

    return filtered;
  }, [
    topics,
    logsByTopic,
    matchesLogSearch,
    matchesStatusFilter,
    matchesTaskSearch,
    normalizedSearch,
    semanticForQuery,
    semanticLogIds,
    semanticTopicIds,
    semanticTopicScores,
    statusFilter,
    tasksByTopic,
  ]);

  const pageSize = 10;
  const pageCount = Math.ceil(orderedTopics.length / pageSize);
  const safePage = pageCount <= 1 ? 1 : Math.min(page, pageCount);
  const pagedTopics = pageCount > 1 ? orderedTopics.slice((safePage - 1) * pageSize, safePage * pageSize) : orderedTopics;

  const topicDisplayColors = useMemo(() => {
    const map = new Map<string, string>();
    let previous: string | null = null;
    pagedTopics.forEach((topic, index) => {
      const seedColor = normalizeHexColor(topic.color) ?? colorFromSeed(`topic:${topic.id}:${topic.name}`, TOPIC_FALLBACK_COLORS);
      const color = pickAlternatingColor(seedColor, previous, index, TOPIC_FALLBACK_COLORS);
      map.set(topic.id, color);
      previous = color;
    });
    return map;
  }, [pagedTopics]);

  const taskDisplayColors = useMemo(() => {
    const map = new Map<string, string>();
    pagedTopics.forEach((topic) => {
      const taskList = tasksByTopic.get(topic.id) ?? [];
      let previous: string | null = null;
      taskList.forEach((task, index) => {
        const seedColor = normalizeHexColor(task.color) ?? colorFromSeed(`task:${task.id}:${task.title}`, TASK_FALLBACK_COLORS);
        const color = pickAlternatingColor(seedColor, previous, index, TASK_FALLBACK_COLORS);
        map.set(task.id, color);
        previous = color;
      });
    });
    return map;
  }, [pagedTopics, tasksByTopic]);

  const writeHeaders = {
    "Content-Type": "application/json",
  };

  const setRenameError = (key: string, message?: string) => {
    setRenameErrors((prev) => {
      const next = { ...prev };
      if (message) {
        next[key] = message;
      } else {
        delete next[key];
      }
      return next;
    });
  };

  const requestEmbeddingRefresh = async (payload: { kind: "topic" | "task"; id: string; text: string; topicId?: string | null }) => {
    try {
      await apiFetch(
        "/api/reindex",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify(payload),
        },
        token
      );
    } catch {
      // Best-effort only; DB update remains source of truth.
    }
  };

  const updateTask = async (taskId: string, updates: Partial<Task>) => {
    if (readOnly) return;
    const current = tasks.find((task) => task.id === taskId);
    if (!current) return;
    const res = await apiFetch(
      "/api/tasks",
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ ...current, ...updates }),
      },
      token
    );

    if (!res.ok) {
      return;
    }

    const updated = (await res.json().catch(() => null)) as Task | null;
    setTasks((prev) =>
      prev.map((task) =>
        task.id === taskId
          ? {
              ...task,
              ...(updated ?? updates),
              updatedAt: updated?.updatedAt ?? new Date().toISOString(),
            }
          : task
      )
    );
  };

  const saveTopicRename = async (topic: Topic) => {
    const renameKey = `topic:${topic.id}`;
    const nextName = topicNameDraft.trim();
    const currentColor =
      normalizeHexColor(topic.color) ??
      topicDisplayColors.get(topic.id) ??
      colorFromSeed(`topic:${topic.id}:${topic.name}`, TOPIC_FALLBACK_COLORS);
    const nextColor = normalizeHexColor(topicColorDraft) ?? currentColor;
    const nameChanged = nextName !== topic.name;
    const colorChanged = nextColor !== normalizeHexColor(topic.color);
    if (readOnly) return;
    if (!nextName) {
      setRenameError(renameKey, "Topic name cannot be empty.");
      return;
    }
    if (!nameChanged && !colorChanged) {
      setEditingTopicId(null);
      setTopicNameDraft("");
      setTopicColorDraft(currentColor);
      setDeleteArmedKey(null);
      setRenameError(renameKey);
      return;
    }
    setRenameSavingKey(renameKey);
    setRenameError(renameKey);
    try {
      const res = await apiFetch(
        "/api/topics",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({
            id: topic.id,
            name: nameChanged ? nextName : topic.name,
            color: nextColor,
          }),
        },
        token
      );
      if (!res.ok) {
        setRenameError(renameKey, "Failed to rename topic.");
        return;
      }
      const updated = (await res.json().catch(() => null)) as Topic | null;
      if (updated?.id) {
        setTopics((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
        if (nameChanged) {
          await requestEmbeddingRefresh({
            kind: "topic",
            id: updated.id,
            text: updated.name || nextName,
          });
        }
      } else {
        setTopics((prev) =>
          prev.map((item) =>
            item.id === topic.id
              ? { ...item, name: nameChanged ? nextName : topic.name, color: nextColor, updatedAt: new Date().toISOString() }
              : item
          )
        );
        if (nameChanged) {
          await requestEmbeddingRefresh({ kind: "topic", id: topic.id, text: nextName });
        }
      }
      setEditingTopicId(null);
      setTopicNameDraft("");
      setTopicColorDraft(currentColor);
      setDeleteArmedKey(null);
      setRenameError(renameKey);
    } finally {
      setRenameSavingKey(null);
    }
  };

  const saveTaskRename = async (task: Task) => {
    const renameKey = `task:${task.id}`;
    const nextTitle = taskNameDraft.trim();
    const currentColor =
      normalizeHexColor(task.color) ??
      taskDisplayColors.get(task.id) ??
      colorFromSeed(`task:${task.id}:${task.title}`, TASK_FALLBACK_COLORS);
    const nextColor = normalizeHexColor(taskColorDraft) ?? currentColor;
    const titleChanged = nextTitle !== task.title;
    const colorChanged = nextColor !== normalizeHexColor(task.color);
    if (readOnly) return;
    if (!nextTitle) {
      setRenameError(renameKey, "Task name cannot be empty.");
      return;
    }
    if (!titleChanged && !colorChanged) {
      setEditingTaskId(null);
      setTaskNameDraft("");
      setTaskColorDraft(currentColor);
      setDeleteArmedKey(null);
      setRenameError(renameKey);
      return;
    }
    setRenameSavingKey(renameKey);
    setRenameError(renameKey);
    try {
      const res = await apiFetch(
        "/api/tasks",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({
            id: task.id,
            title: titleChanged ? nextTitle : task.title,
            color: nextColor,
            topicId: task.topicId,
          }),
        },
        token
      );
      if (!res.ok) {
        setRenameError(renameKey, "Failed to rename task.");
        return;
      }
      const updated = (await res.json().catch(() => null)) as Task | null;
      if (updated?.id) {
        setTasks((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
        if (titleChanged) {
          await requestEmbeddingRefresh({
            kind: "task",
            id: updated.id,
            topicId: updated.topicId,
            text: updated.title || nextTitle,
          });
        }
      } else {
        setTasks((prev) =>
          prev.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  title: titleChanged ? nextTitle : task.title,
                  color: nextColor,
                  updatedAt: new Date().toISOString(),
                }
              : item
          )
        );
        if (titleChanged) {
          await requestEmbeddingRefresh({
            kind: "task",
            id: task.id,
            topicId: task.topicId,
            text: nextTitle,
          });
        }
      }
      setEditingTaskId(null);
      setTaskNameDraft("");
      setTaskColorDraft(currentColor);
      setDeleteArmedKey(null);
      setRenameError(renameKey);
    } finally {
      setRenameSavingKey(null);
    }
  };

  const deleteTopic = async (topic: Topic) => {
    const deleteKey = `topic:${topic.id}`;
    if (readOnly || topic.id === "unassigned") return;
    setDeleteInFlightKey(deleteKey);
    setRenameError(deleteKey);
    try {
      const res = await apiFetch(`/api/topics/${encodeURIComponent(topic.id)}`, { method: "DELETE" }, token);
      if (!res.ok) {
        setRenameError(deleteKey, "Failed to delete topic.");
        return;
      }
      const payload = (await res.json().catch(() => null)) as { deleted?: boolean } | null;
      if (!payload?.deleted) {
        setRenameError(deleteKey, "Topic not found.");
        return;
      }
      const updatedAt = new Date().toISOString();
      setTopics((prev) => prev.filter((item) => item.id !== topic.id));
      setTasks((prev) =>
        prev.map((item) => (item.topicId === topic.id ? { ...item, topicId: null, updatedAt } : item))
      );
      setLogs((prev) =>
        prev.map((item) => (item.topicId === topic.id ? { ...item, topicId: null, updatedAt } : item))
      );
      const nextTopics = Array.from(expandedTopicsSafe).filter((id) => id !== topic.id);
      setExpandedTopics(new Set(nextTopics));
      setExpandedTopicChats((prev) => {
        const next = new Set(prev);
        next.delete(topic.id);
        return next;
      });
      pushUrl({ topics: nextTopics }, "replace");
      setEditingTopicId(null);
      setTopicNameDraft("");
      setDeleteArmedKey(null);
      setRenameError(deleteKey);
    } finally {
      setDeleteInFlightKey(null);
    }
  };

  const deleteTask = async (task: Task) => {
    const deleteKey = `task:${task.id}`;
    if (readOnly) return;
    setDeleteInFlightKey(deleteKey);
    setRenameError(deleteKey);
    try {
      const res = await apiFetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" }, token);
      if (!res.ok) {
        setRenameError(deleteKey, "Failed to delete task.");
        return;
      }
      const payload = (await res.json().catch(() => null)) as { deleted?: boolean } | null;
      if (!payload?.deleted) {
        setRenameError(deleteKey, "Task not found.");
        return;
      }
      const updatedAt = new Date().toISOString();
      setTasks((prev) => prev.filter((item) => item.id !== task.id));
      setLogs((prev) =>
        prev.map((item) => (item.taskId === task.id ? { ...item, taskId: null, updatedAt } : item))
      );
      const nextTasks = Array.from(expandedTasksSafe).filter((id) => id !== task.id);
      setExpandedTasks(new Set(nextTasks));
      pushUrl({ tasks: nextTasks }, "replace");
      setMoveTaskId((prev) => (prev === task.id ? null : prev));
      setEditingTaskId(null);
      setTaskNameDraft("");
      setDeleteArmedKey(null);
      setRenameError(deleteKey);
    } finally {
      setDeleteInFlightKey(null);
    }
  };

  const expandAll = () => {
    setExpandedTopics(new Set(orderedTopics.map((topic) => topic.id)));
    setExpandedTasks(new Set(tasks.map((task) => task.id)));
    setExpandedTopicChats(new Set(orderedTopics.map((topic) => topic.id)));
  };

  const collapseAll = () => {
    setExpandedTopics(new Set());
    setExpandedTasks(new Set());
    setExpandedTopicChats(new Set());
  };

  const toggleTopicExpanded = (topicId: string) => {
    const next = new Set(expandedTopicsSafe);
    if (next.has(topicId)) {
      next.delete(topicId);
    } else {
      next.add(topicId);
    }
    setExpandedTopics(next);
    pushUrl({ topics: Array.from(next) });
  };

  const toggleTaskExpanded = (taskId: string) => {
    const next = new Set(expandedTasksSafe);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    setExpandedTasks(next);
    pushUrl({ tasks: Array.from(next) });
  };

  const toggleTopicChatExpanded = (topicId: string) => {
    const next = new Set(expandedTopicChatsSafe);
    if (next.has(topicId)) {
      next.delete(topicId);
    } else {
      next.add(topicId);
    }
    setExpandedTopicChats(next);
  };

  const toggleDoneVisibility = () => {
    const next = !showDone;
    setShowDone(next);
    const nextStatus = !next && statusFilter === "done" ? "all" : statusFilter;
    if (nextStatus !== statusFilter) {
      setStatusFilter(nextStatus);
    }
    setPage(1);
    pushUrl({ done: next ? "1" : "0", status: nextStatus, page: "1" });
  };

  const toggleRawVisibility = () => {
    const next = !showRaw;
    setShowRaw(next);
    pushUrl({ raw: next ? "1" : "0" });
  };

  const toggleMessageDensity = () => {
    const next: MessageDensity = messageDensity === "compact" ? "comfortable" : "compact";
    setMessageDensity(next);
    pushUrl({ density: next });
  };

  const updateStatusFilter = (nextValue: string) => {
    const nextStatus = isTaskStatusFilter(nextValue) ? nextValue : "all";
    setStatusFilter(nextStatus);
    const mustShowDone = nextStatus === "done";
    if (mustShowDone && !showDone) {
      setShowDone(true);
    }
    setPage(1);
    pushUrl({ status: nextStatus, done: mustShowDone || showDone ? "1" : "0", page: "1" });
  };

  const toggleExpandAll = () => {
    const allTopics = orderedTopics.map((topic) => topic.id);
    const allTasks = tasks.map((task) => task.id);
    const hasAnyExpandable = allTopics.length > 0 || allTasks.length > 0;
    const allExpanded =
      hasAnyExpandable &&
      expandedTopicsSafe.size === allTopics.length &&
      expandedTasksSafe.size === allTasks.length &&
      expandedTopicChatsSafe.size === allTopics.length;
    if (allExpanded) {
      collapseAll();
      pushUrl({ topics: [], tasks: [] });
      return;
    }
    expandAll();
    pushUrl({ topics: allTopics, tasks: allTasks });
  };

  const allowToggle = (target: HTMLElement | null) => {
    if (!target) return true;
    return !target.closest("a, button, input, select, textarea, option");
  };

  const resolveTopicId = useCallback(
    (value: string) => {
      if (!value) return "";
      const raw = decodeSlugId(value);
      if (topics.some((topic) => topic.id === raw)) return raw;
      const slug = value.includes("--") ? value.slice(0, value.lastIndexOf("--")) : value;
      const match = topics.find((topic) => slugify(topic.name) === slug);
      return match?.id ?? raw;
    },
    [topics]
  );

  const resolveTaskId = useCallback(
    (value: string) => {
      if (!value) return "";
      const raw = decodeSlugId(value);
      if (tasks.some((task) => task.id === raw)) return raw;
      const slug = value.includes("--") ? value.slice(0, value.lastIndexOf("--")) : value;
      const match = tasks.find((task) => slugify(task.title) === slug);
      return match?.id ?? raw;
    },
    [tasks]
  );

  const encodeTopicParam = useCallback(
    (topicId: string) => {
      const topic = topics.find((item) => item.id === topicId);
      return topic ? encodeTopicSlug(topic) : topicId;
    },
    [topics]
  );

  const encodeTaskParam = useCallback(
    (taskId: string) => {
      const task = tasks.find((item) => item.id === taskId);
      return task ? encodeTaskSlug(task) : taskId;
    },
    [tasks]
  );

  const parseSegments = (segments: string[]) => {
    const topics: string[] = [];
    const tasks: string[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const key = segments[i];
      const value = segments[i + 1];
      if (!value) continue;
      if (key === "topic") {
        topics.push(value);
        i += 1;
      } else if (key === "task") {
        tasks.push(value);
        i += 1;
      }
    }
    return { topics, tasks };
  };

  const syncFromUrl = useCallback(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const segments = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length).split("/").filter(Boolean)
      : [];
    const parsed = parseSegments(segments);
    const hasPathSelections = parsed.topics.length > 0 || parsed.tasks.length > 0;
    const nextSearch = params.get("q") ?? "";
    const nextRaw = params.get("raw") === "1";
    const nextDensity: MessageDensity = params.get("density") === "compact" ? "compact" : "comfortable";
    const nextShowDone = params.get("done") === "1";
    const nextStatusRaw = params.get("status") ?? "all";
    const nextStatus = isTaskStatusFilter(nextStatusRaw) ? nextStatusRaw : "all";
    const nextPage = Math.max(1, Number(params.get("page") ?? 1));
    let nextTopics = hasPathSelections
      ? parsed.topics.map((value) => resolveTopicId(value)).filter(Boolean)
      : params
          .getAll("topic")
          .map((value) => resolveTopicId(value))
          .filter(Boolean);
    let nextTasks = hasPathSelections
      ? parsed.tasks.map((value) => resolveTaskId(value)).filter(Boolean)
      : params
          .getAll("task")
          .map((value) => resolveTaskId(value))
          .filter(Boolean);
    if (nextTopics.length === 0) {
      const legacyTopics = params.get("topics")?.split(",").filter(Boolean) ?? [];
      nextTopics = legacyTopics.map((value) => resolveTopicId(value)).filter(Boolean);
    }
    if (nextTasks.length === 0) {
      const legacyTasks = params.get("tasks")?.split(",").filter(Boolean) ?? [];
      nextTasks = legacyTasks.map((value) => resolveTaskId(value)).filter(Boolean);
    }

    setSearch(nextSearch);
    committedSearch.current = nextSearch;
    setShowRaw(nextRaw);
    setMessageDensity(nextDensity);
    setStatusFilter(nextStatus);
    setShowDone(nextShowDone || nextStatus === "done");
    setPage(Number.isNaN(nextPage) ? 1 : nextPage);
    setExpandedTopics(new Set(nextTopics));
    setExpandedTasks(new Set(nextTasks));

    const key = `${url.pathname}${url.search}`;
    const y = scrollMemory.current[key];
    if (typeof y === "number") {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: y, left: 0, behavior: "auto" });
      });
    }
  }, [basePath, resolveTaskId, resolveTopicId]);

  useEffect(() => {
    const handlePop = () => syncFromUrl();
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [syncFromUrl]);

  const pushUrl = useCallback(
    (
      overrides: Partial<Record<"q" | "raw" | "done" | "status" | "page" | "density", string>> & {
        topics?: string[];
        tasks?: string[];
      },
      mode: "push" | "replace" = "push"
    ) => {
      const params = new URLSearchParams();
      const nextSearch = overrides.q ?? search;
      const nextRaw = overrides.raw ?? (showRaw ? "1" : "0");
      const nextDensity = overrides.density ?? messageDensity;
      const nextDone = overrides.done ?? (showDone ? "1" : "0");
      const nextStatus = overrides.status ?? statusFilter;
      const nextPage = overrides.page ?? String(safePage);
      const nextTopics = overrides.topics ?? Array.from(expandedTopicsSafe);
      const nextTasks = overrides.tasks ?? Array.from(expandedTasksSafe);

      if (nextSearch) params.set("q", nextSearch);
      if (nextRaw === "1") params.set("raw", "1");
      if (nextDensity === "compact") params.set("density", "compact");
      if (nextDone === "1") params.set("done", "1");
      if (nextStatus !== "all") params.set("status", nextStatus);
      if (nextPage && nextPage !== "1") params.set("page", nextPage);
      const segments: string[] = [];
      for (const topicId of nextTopics) {
        segments.push("topic", encodeTopicParam(topicId));
      }
      for (const taskId of nextTasks) {
        segments.push("task", encodeTaskParam(taskId));
      }

      const trimmedBase =
        basePath.endsWith("/") && basePath.length > 1 ? basePath.slice(0, -1) : basePath;
      const nextPath = segments.length > 0 ? `${trimmedBase}/${segments.join("/")}` : trimmedBase;
      const query = params.toString();
      const nextUrl = query ? `${nextPath}?${query}` : nextPath;
      if (typeof window !== "undefined") {
        const currentKey = currentUrlKey();
        scrollMemory.current[currentKey] = window.scrollY;
        scrollMemory.current[nextUrl] = window.scrollY;
        if (mode === "replace") {
          window.history.replaceState({ clawboard: true }, "", nextUrl);
        } else {
          window.history.pushState({ clawboard: true }, "", nextUrl);
        }
      }
    },
    [
      currentUrlKey,
      encodeTaskParam,
      encodeTopicParam,
      expandedTasksSafe,
      expandedTopicsSafe,
      safePage,
      search,
      messageDensity,
      showDone,
      showRaw,
      statusFilter,
      basePath,
    ]
  );



  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Unified View</h1>
          <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
            Topics → tasks → messages in a single, expandable view.
          </p>
        </div>
        <Badge tone="accent2">Unified</Badge>
      </div>

      <div
        className={cn(
          "sticky top-0 z-30 -mx-6 space-y-3 px-6 pb-3 pt-4 transition",
          isSticky
            ? "border-b border-[rgb(var(--claw-border))] bg-[rgba(12,14,18,0.9)] backdrop-blur"
            : "bg-transparent"
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={search}
            onChange={(event) => {
              const value = event.target.value;
              setSearch(value);
              setPage(1);
              pushUrl({ q: value, page: "1" }, "replace");
            }}
            onBlur={() => {
              if (committedSearch.current !== search) {
                committedSearch.current = search;
                pushUrl({ q: search });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                committedSearch.current = search;
                pushUrl({ q: search });
              }
            }}
            placeholder="Search topics, tasks, or messages"
            className="min-w-[240px] flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowViewOptions((prev) => !prev)}
            aria-expanded={showViewOptions}
          >
            {showViewOptions ? "Hide options" : "View options"}
          </Button>
        </div>
        {showViewOptions && (
          <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(14,17,22,0.92)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={statusFilter}
                onChange={(event) => updateStatusFilter(event.target.value)}
                className="max-w-[190px]"
              >
                <option value="all">All statuses</option>
                <option value="todo">To Do</option>
                <option value="doing">Doing</option>
                <option value="blocked">Blocked</option>
                <option value="done">Done</option>
              </Select>
              <Button
                variant="secondary"
                size="sm"
                className={cn(showDone ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                onClick={toggleDoneVisibility}
              >
                {showDone ? "Hide done" : "Show done"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className={cn(showRaw ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                onClick={toggleRawVisibility}
              >
                {showRaw ? "Hide full messages" : "Show full messages"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className={cn(messageDensity === "compact" ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                onClick={toggleMessageDensity}
              >
                {messageDensity === "compact" ? "Comfortable view" : "Compact view"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className={cn(
                  (orderedTopics.length > 0 || tasks.length > 0) &&
                    expandedTopicsSafe.size === orderedTopics.length &&
                    expandedTasksSafe.size === tasks.length
                    ? "border-[rgba(255,90,45,0.5)]"
                    : "opacity-85"
                )}
                onClick={toggleExpandAll}
              >
                {(orderedTopics.length > 0 || tasks.length > 0) &&
                expandedTopicsSafe.size === orderedTopics.length &&
                expandedTasksSafe.size === tasks.length
                  ? "Collapse all"
                  : "Expand all"}
              </Button>
            </div>
          </div>
        )}
        {readOnly && (
          <span className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add token to move tasks.</span>
        )}
        {normalizedSearch && (
          <span className="text-xs text-[rgb(var(--claw-muted))]">
            {semanticSearch.loading
              ? "Searching memory index…"
              : semanticForQuery
                ? `Semantic search (${semanticForQuery.mode})`
                : semanticSearch.error
                  ? "Semantic search unavailable, using local match fallback."
                  : "Searching…"}
          </span>
        )}
      </div>

      <div className="space-y-4">
        {pagedTopics.map((topic, topicIndex) => {
          const topicId = topic.id;
          const taskList = tasksByTopic.get(topicId) ?? [];
          const openCount = taskList.filter((task) => task.status !== "done").length;
          const doingCount = taskList.filter((task) => task.status === "doing").length;
          const blockedCount = taskList.filter((task) => task.status === "blocked").length;
          const lastActivity = logsByTopic.get(topicId)?.[0]?.createdAt ?? topic.updatedAt;
          const topicLogs = logsByTopic.get(topicId) ?? [];
          const topicOnlyLogs = topicLogs.filter((entry) => !entry.taskId && matchesLogSearch(entry));
          const showTasks = !normalizedSearch || taskList.length > 0 || topicOnlyLogs.length > 0;
          const isExpanded = expandedTopicsSafe.has(topicId);
          const topicChatExpanded = expandedTopicChatsSafe.has(topicId);
          const topicChatLimit = timelineLimits[topicChatLimitKey(topicId)] ?? TOPIC_TIMELINE_LIMIT;
          const topicChatLogs = topicOnlyLogs.slice(0, topicChatLimit);
          const topicChatTruncated = topicOnlyLogs.length > topicChatLimit;
          const topicColor =
            topicDisplayColors.get(topicId) ??
            normalizeHexColor(topic.color) ??
            colorFromSeed(`topic:${topic.id}:${topic.name}`, TOPIC_FALLBACK_COLORS);

          return (
            <div
              key={topicId}
              className="rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] p-5 transition-colors duration-300"
              style={topicGlowStyle(topicColor, topicIndex, isExpanded)}
            >
              <div
                role="button"
                tabIndex={0}
                className="flex flex-wrap items-start justify-between gap-4 text-left"
                onClick={(event) => {
                  if (!allowToggle(event.target as HTMLElement)) return;
                  toggleTopicExpanded(topicId);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggleTopicExpanded(topicId);
                  }
                }}
                aria-expanded={isExpanded}
              >
                <div>
                  <div className="flex items-center gap-2">
                    {editingTopicId === topic.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          data-testid={`rename-topic-input-${topic.id}`}
                          value={topicNameDraft}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setTopicNameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void saveTopicRename(topic);
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setEditingTopicId(null);
                              setTopicNameDraft("");
                              setDeleteArmedKey(null);
                              setRenameError(`topic:${topic.id}`);
                            }
                          }}
                          placeholder="Rename topic"
                          className="h-9 w-[260px] max-w-[70vw]"
                        />
                        <label
                          className="flex h-9 items-center gap-2 rounded-full border border-[rgb(var(--claw-border))] px-2 text-[10px] uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]"
                          onClick={(event) => event.stopPropagation()}
                        >
                          Color
                          <input
                            data-testid={`rename-topic-color-${topic.id}`}
                            type="color"
                            value={topicColorDraft}
                            disabled={readOnly}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => {
                              const next = normalizeHexColor(event.target.value);
                              if (next) setTopicColorDraft(next);
                            }}
                            className="h-6 w-7 cursor-pointer rounded border border-[rgb(var(--claw-border))] bg-transparent p-0 disabled:cursor-not-allowed"
                          />
                        </label>
                        <Button
                          data-testid={`save-topic-rename-${topic.id}`}
                          size="sm"
                          variant="secondary"
                          disabled={
                            readOnly ||
                            renameSavingKey === `topic:${topic.id}` ||
                            !topicNameDraft.trim() ||
                            !normalizeHexColor(topicColorDraft)
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            void saveTopicRename(topic);
                          }}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditingTopicId(null);
                            setTopicNameDraft("");
                            setTopicColorDraft(topicColor);
                            setDeleteArmedKey(null);
                            setRenameError(`topic:${topic.id}`);
                          }}
                        >
                          Cancel
                        </Button>
                        {deleteArmedKey === `topic:${topic.id}` ? (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                              disabled={readOnly || deleteInFlightKey === `topic:${topic.id}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void deleteTopic(topic);
                              }}
                            >
                              {deleteInFlightKey === `topic:${topic.id}` ? "Deleting..." : "Confirm delete"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDeleteArmedKey(null);
                              }}
                            >
                              Keep
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[rgb(var(--claw-danger))]"
                            disabled={readOnly || topic.id === "unassigned"}
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteArmedKey(`topic:${topic.id}`);
                              setRenameError(`topic:${topic.id}`);
                            }}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    ) : (
                      <>
                        <h2 className="text-lg font-semibold">{topic.name}</h2>
                        <button
                          type="button"
                          data-testid={`rename-topic-${topic.id}`}
                          aria-label={`Rename topic ${topic.name}`}
                          title={
                            topic.id === "unassigned"
                              ? "Unassigned is a virtual bucket."
                              : readOnly
                                ? "Read-only mode. Add token in Setup to rename."
                                : "Rename topic"
                          }
                          disabled={readOnly || topic.id === "unassigned"}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (readOnly || topic.id === "unassigned") return;
                            setEditingTaskId(null);
                            setTaskNameDraft("");
                            setTaskColorDraft(TASK_FALLBACK_COLORS[0]);
                            setEditingTopicId(topic.id);
                            setTopicNameDraft(topic.name);
                            setTopicColorDraft(topicColor);
                            setDeleteArmedKey(null);
                            setRenameError(`topic:${topic.id}`);
                          }}
                          className={cn(
                            "flex h-7 w-7 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] transition",
                            readOnly || topic.id === "unassigned"
                              ? "cursor-not-allowed opacity-60"
                              : "cursor-pointer hover:border-[rgba(255,90,45,0.3)] hover:text-[rgb(var(--claw-text))]"
                          )}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                          </svg>
                        </button>
                      </>
                    )}
                    <PinToggle
                      topic={topic}
                      size="sm"
                      onToggled={(nextPinned) =>
                        setTopics((prev) =>
                          prev.map((item) =>
                            item.id === topic.id ? { ...item, pinned: nextPinned, updatedAt: new Date().toISOString() } : item
                          )
                        )
                      }
                    />
                  </div>
                  {renameErrors[`topic:${topic.id}`] && (
                    <p className="mt-1 text-xs text-[rgb(var(--claw-warning))]">{renameErrors[`topic:${topic.id}`]}</p>
                  )}
                  {isExpanded && <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{topic.description}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[rgb(var(--claw-muted))]">
                    <span>{taskList.length} tasks</span>
                    <span>{openCount} open</span>
                    {isExpanded && <span>{doingCount} doing</span>}
                    {isExpanded && <span>{blockedCount} blocked</span>}
                    <span>Last activity {formatRelativeTime(lastActivity)}</span>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="min-w-[112px]"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleTopicExpanded(topicId);
                  }}
                >
                  {isExpanded ? "Collapse" : "Expand"}
                </Button>
              </div>

              {isExpanded && showTasks && (
                <div className="mt-4 space-y-3">
                  {taskList.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No tasks yet.</p>}
                  {taskList
                    .filter((task) => {
                      if (!matchesStatusFilter(task)) return false;
                      return matchesTaskSearch(task);
                    })
                    .map((task, taskIndex) => {
                      if (normalizedSearch && !matchesTaskSearch(task) && !`${topic.name} ${topic.description ?? ""}`.toLowerCase().includes(normalizedSearch)) {
                        return null;
                      }
                      const taskLogs = logsByTask.get(task.id) ?? [];
                      const taskExpanded = expandedTasksSafe.has(task.id);
                      const taskColor =
                        taskDisplayColors.get(task.id) ??
                        normalizeHexColor(task.color) ??
                        colorFromSeed(`task:${task.id}:${task.title}`, TASK_FALLBACK_COLORS);
                      const visibleLogs = taskLogs.filter(matchesLogSearch);
                      const limit = timelineLimits[task.id] ?? TASK_TIMELINE_LIMIT;
                      const limitedLogs = visibleLogs.slice(0, limit);
                      const truncated = visibleLogs.length > limit;
                      return (
                        <div
                          key={task.id}
                          className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] p-4 transition-colors duration-300"
                          style={taskGlowStyle(taskColor, taskIndex, taskExpanded)}
                        >
                          <div
                            role="button"
                            tabIndex={0}
                            className="flex flex-wrap items-center justify-between gap-3 text-left"
                            onClick={(event) => {
                              if (!allowToggle(event.target as HTMLElement)) return;
                              toggleTaskExpanded(task.id);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                toggleTaskExpanded(task.id);
                              }
                            }}
                            aria-expanded={taskExpanded}
                          >
                          <div>
                            <div className="flex items-center gap-2 text-sm font-semibold">
                              {editingTaskId === task.id ? (
                                <div className="flex flex-wrap items-center gap-2">
                                  <Input
                                    data-testid={`rename-task-input-${task.id}`}
                                    value={taskNameDraft}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={(event) => setTaskNameDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        void saveTaskRename(task);
                                      }
                                      if (event.key === "Escape") {
                                        event.preventDefault();
                                        setEditingTaskId(null);
                                        setTaskNameDraft("");
                                        setDeleteArmedKey(null);
                                        setRenameError(`task:${task.id}`);
                                      }
                                    }}
                                    placeholder="Rename task"
                                    className="h-9 w-[280px] max-w-[68vw]"
                                  />
                                  <label
                                    className="flex h-9 items-center gap-2 rounded-full border border-[rgb(var(--claw-border))] px-2 text-[10px] uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    Color
                                    <input
                                      data-testid={`rename-task-color-${task.id}`}
                                      type="color"
                                      value={taskColorDraft}
                                      disabled={readOnly}
                                      onClick={(event) => event.stopPropagation()}
                                      onChange={(event) => {
                                        const next = normalizeHexColor(event.target.value);
                                        if (next) setTaskColorDraft(next);
                                      }}
                                      className="h-6 w-7 cursor-pointer rounded border border-[rgb(var(--claw-border))] bg-transparent p-0 disabled:cursor-not-allowed"
                                    />
                                  </label>
                                  <Button
                                    data-testid={`save-task-rename-${task.id}`}
                                    size="sm"
                                    variant="secondary"
                                    disabled={
                                      readOnly ||
                                      renameSavingKey === `task:${task.id}` ||
                                      !taskNameDraft.trim() ||
                                      !normalizeHexColor(taskColorDraft)
                                    }
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void saveTaskRename(task);
                                    }}
                                  >
                                    Save
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setEditingTaskId(null);
                                      setTaskNameDraft("");
                                      setTaskColorDraft(taskColor);
                                      setDeleteArmedKey(null);
                                      setRenameError(`task:${task.id}`);
                                    }}
                                  >
                                    Cancel
                                  </Button>
                                  {deleteArmedKey === `task:${task.id}` ? (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="secondary"
                                        className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                                        disabled={readOnly || deleteInFlightKey === `task:${task.id}`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void deleteTask(task);
                                        }}
                                      >
                                        {deleteInFlightKey === `task:${task.id}` ? "Deleting..." : "Confirm delete"}
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setDeleteArmedKey(null);
                                        }}
                                      >
                                        Keep
                                      </Button>
                                    </>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="text-[rgb(var(--claw-danger))]"
                                      disabled={readOnly}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setDeleteArmedKey(`task:${task.id}`);
                                        setRenameError(`task:${task.id}`);
                                      }}
                                    >
                                      Delete
                                    </Button>
                                  )}
                                </div>
                              ) : (
                                <>
                                  <span>{task.title}</span>
                                  <button
                                    type="button"
                                    data-testid={`rename-task-${task.id}`}
                                    aria-label={`Rename task ${task.title}`}
                                    title={readOnly ? "Read-only mode. Add token in Setup to rename." : "Rename task"}
                                    disabled={readOnly}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (readOnly) return;
                                      setEditingTopicId(null);
                                      setTopicNameDraft("");
                                      setTopicColorDraft(TOPIC_FALLBACK_COLORS[0]);
                                      setEditingTaskId(task.id);
                                      setTaskNameDraft(task.title);
                                      setTaskColorDraft(taskColor);
                                      setDeleteArmedKey(null);
                                      setRenameError(`task:${task.id}`);
                                    }}
                                    className={cn(
                                      "flex h-7 w-7 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] transition",
                                      readOnly
                                        ? "cursor-not-allowed opacity-60"
                                        : "cursor-pointer hover:border-[rgba(255,90,45,0.3)] hover:text-[rgb(var(--claw-text))]"
                                    )}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                      <path d="M12 20h9" />
                                      <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                                    </svg>
                                  </button>
                                </>
                              )}
                              <TaskPinToggle
                                task={task}
                                size="sm"
                                onToggled={(nextPinned) =>
                                  setTasks((prev) =>
                                    prev.map((item) =>
                                      item.id === task.id ? { ...item, pinned: nextPinned, updatedAt: new Date().toISOString() } : item
                                    )
                                  )
                                }
                              />
                            </div>
                            {renameErrors[`task:${task.id}`] && (
                              <div className="mt-1 text-xs text-[rgb(var(--claw-warning))]">{renameErrors[`task:${task.id}`]}</div>
                            )}
                            <div className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                              {taskExpanded ? "Updated" : "Last touch"} {formatRelativeTime(task.updatedAt)}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Select
                              data-testid={`task-status-${task.id}`}
                              value={task.status}
                              disabled={readOnly}
                              className="h-9 w-[128px] text-xs"
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => {
                                event.stopPropagation();
                                const nextStatus = event.target.value as Task["status"];
                                if (nextStatus !== task.status) {
                                  void updateTask(task.id, { status: nextStatus });
                                }
                              }}
                            >
                              <option value="todo">To Do</option>
                              <option value="doing">Doing</option>
                              <option value="blocked">Blocked</option>
                              <option value="done">Done</option>
                            </Select>
                            <StatusPill tone={STATUS_TONE[task.status]} label={STATUS_LABELS[task.status] ?? task.status} />
                            <Button
                              variant="secondary"
                              size="sm"
                              className="min-w-[104px]"
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleTaskExpanded(task.id);
                              }}
                            >
                              {taskExpanded ? "Collapse" : "Expand"}
                            </Button>
                          </div>
                        </div>
                        {taskExpanded && (
                          <div className="mt-3">
                            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-[rgb(var(--claw-muted))]">
                              {moveTaskId !== task.id && (
                                <button
                                  type="button"
                                  className="rounded-full border border-[rgb(var(--claw-border))] px-3 py-1 uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))] transition hover:text-[rgb(var(--claw-text))]"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setMoveTaskId(task.id);
                                  }}
                                >
                                  Move
                                </button>
                              )}
                              {moveTaskId === task.id && (
                                <>
                                  <Select
                                    value={task.topicId ?? ""}
                                    onChange={async (event) => {
                                      event.stopPropagation();
                                      await updateTask(task.id, { topicId: event.target.value || null });
                                      setMoveTaskId(null);
                                    }}
                                    className="h-9 w-auto min-w-[180px] max-w-[240px] text-xs"
                                    disabled={readOnly}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <option value="">Unassigned</option>
                                    {topics.map((topicOption) => (
                                      <option key={topicOption.id} value={topicOption.id}>
                                        {topicOption.name}
                                      </option>
                                    ))}
                                  </Select>
                                  <button
                                    type="button"
                                    className="rounded-full border border-[rgb(var(--claw-border))] px-3 py-1 uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))] transition hover:text-[rgb(var(--claw-text))]"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setMoveTaskId(null);
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </>
                              )}
                            </div>
                            {visibleLogs.length === 0 ? (
                              <p className="text-sm text-[rgb(var(--claw-muted))]">No messages yet.</p>
                            ) : (
                              <div
                                className="rounded-[var(--radius-md)] border p-4"
                                style={{
                                  borderColor: rgba(taskColor, 0.34),
                                  background: `linear-gradient(150deg, ${rgba(taskColor, 0.15)}, ${rgba(taskColor, 0.08)} 44%, rgba(17,20,26,0.86))`,
                                }}
                              >
                                <div className="mb-3 flex items-center justify-between">
                                  <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">TASK CHAT</div>
                                  <span className="text-xs text-[rgb(var(--claw-muted))]">{visibleLogs.length} entries</span>
                                </div>
                                <LogList
                                  logs={limitedLogs}
                                  topics={topics}
                                  showFilters={false}
                                  showRawToggle={false}
                                  showDensityToggle={false}
                                  showRawAll={showRaw}
                                  messageDensity={messageDensity}
                                  allowNotes
                                  enableNavigation={false}
                                />
                                {truncated && (
                                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-[rgb(var(--claw-muted))]">
                                    <span>
                                      Showing {limitedLogs.length} of {visibleLogs.length} entries.
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      onClick={() =>
                                        setTimelineLimits((prev) => ({
                                          ...prev,
                                          [task.id]: (prev[task.id] ?? TASK_TIMELINE_LIMIT) + TASK_TIMELINE_LIMIT,
                                        }))
                                      }
                                    >
                                      Load 2 more
                                    </Button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                    })}
                  {taskList.filter((task) => {
                    if (!matchesStatusFilter(task)) return false;
                    return matchesTaskSearch(task);
                  }).length === 0 && (
                    <p className="text-sm text-[rgb(var(--claw-muted))]">No tasks match your filters.</p>
                  )}

                  {topicOnlyLogs.length > 0 && (
                    <div
                      className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] p-4 transition-colors duration-300"
                      style={taskGlowStyle(topicColor, taskList.length, topicChatExpanded)}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        className="flex flex-wrap items-center justify-between gap-3 text-left"
                        onClick={(event) => {
                          if (!allowToggle(event.target as HTMLElement)) return;
                          toggleTopicChatExpanded(topicId);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleTopicChatExpanded(topicId);
                          }
                        }}
                        aria-expanded={topicChatExpanded}
                      >
                        <div>
                          <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">TOPIC CHAT</div>
                          <div className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{topicOnlyLogs.length} entries</div>
                        </div>
                        <Button
                          data-testid={`toggle-topic-chat-${topicId}`}
                          variant="secondary"
                          size="sm"
                          className="min-w-[104px]"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleTopicChatExpanded(topicId);
                          }}
                        >
                          {topicChatExpanded ? "Collapse" : "Expand"}
                        </Button>
                      </div>
                      {topicChatExpanded && (
                        <div className="mt-3 rounded-[var(--radius-md)] border border-[rgba(255,90,45,0.25)] bg-[rgba(255,90,45,0.06)] p-4">
                          <LogList
                            logs={topicChatLogs}
                            topics={topics}
                            showFilters={false}
                            showRawToggle={false}
                            showDensityToggle={false}
                            showRawAll={showRaw}
                            messageDensity={messageDensity}
                            allowNotes
                            enableNavigation={false}
                          />
                          {topicChatTruncated && (
                            <div className="mt-3 flex justify-end">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                  setTimelineLimits((prev) => ({
                                    ...prev,
                                    [topicChatLimitKey(topicId)]:
                                      (prev[topicChatLimitKey(topicId)] ?? TOPIC_TIMELINE_LIMIT) + TOPIC_TIMELINE_LIMIT,
                                  }))
                                }
                              >
                                Load 4 more
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {pageCount > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-4 py-3 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">
          <span>
            Page {safePage} of {pageCount}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const next = Math.max(1, safePage - 1);
                setPage(next);
                pushUrl({ page: String(next) });
              }}
              disabled={safePage === 1}
            >
              Prev
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const next = Math.min(pageCount, safePage + 1);
                setPage(next);
                pushUrl({ page: String(next) });
              }}
              disabled={safePage === pageCount}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
