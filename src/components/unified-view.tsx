"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, Task } from "@/lib/types";
import { Badge, Button, Input, Select, StatusPill } from "@/components/ui";
import { LogList } from "@/components/log-list";
import { formatRelativeTime } from "@/lib/format";
import { useAppConfig } from "@/components/providers";
import { PinToggle } from "@/components/pin-toggle";
import { TaskPinToggle } from "@/components/task-pin-toggle";
import { decodeSlugId, encodeTaskSlug, encodeTopicSlug, slugify } from "@/lib/slug";
import { cn } from "@/lib/cn";
import { apiUrl } from "@/lib/api";
import { useDataStore } from "@/components/data-provider";

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

const DEFAULT_TIMELINE_LIMIT = 5;

type UrlState = {
  search: string;
  raw: boolean;
  done: boolean;
  page: number;
  topics: string[];
  tasks: string[];
};

function getInitialUrlState(basePath: string): UrlState {
  if (typeof window === "undefined") {
    return { search: "", raw: false, done: false, page: 1, topics: [], tasks: [] };
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
  return {
    search: params.get("q") ?? "",
    raw: params.get("raw") === "1",
    done: params.get("done") === "1",
    page: Math.max(1, Number(params.get("page") ?? 1)),
    topics: nextTopics,
    tasks: nextTasks,
  };
}

export function UnifiedView({ basePath = "/u" }: { basePath?: string } = {}) {
  const { token, tokenRequired } = useAppConfig();
  const { topics, tasks, logs, setTopics, setTasks } = useDataStore();
  const readOnly = tokenRequired && !token;
  const scrollMemory = useRef<Record<string, number>>({});
  const [initialUrlState] = useState(() => getInitialUrlState(basePath));
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set(initialUrlState.topics));
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set(initialUrlState.tasks));
  const [showRaw, setShowRaw] = useState(initialUrlState.raw);
  const [search, setSearch] = useState(initialUrlState.search);
  const [showDone, setShowDone] = useState(initialUrlState.done);
  const [timelineLimits, setTimelineLimits] = useState<Record<string, number>>({});
  const [moveTaskId, setMoveTaskId] = useState<string | null>(null);
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

  const matchesLogSearch = useCallback((entry: LogEntry) => {
    if (!normalizedSearch) return true;
    const haystack = `${entry.summary ?? ""} ${entry.content ?? ""} ${entry.raw ?? ""}`.toLowerCase();
    return haystack.includes(normalizedSearch);
  }, [normalizedSearch]);

  const matchesTaskSearch = useCallback((task: Task) => {
    if (!normalizedSearch) return true;
    if (task.title.toLowerCase().includes(normalizedSearch)) return true;
    const logMatches = logsByTask.get(task.id)?.some(matchesLogSearch);
    return Boolean(logMatches);
  }, [logsByTask, matchesLogSearch, normalizedSearch]);

  const orderedTopics = useMemo(() => {
    const base = [...topics]
      .map((topic) => ({
        ...topic,
        lastActivity: logsByTopic.get(topic.id)?.[0]?.createdAt ?? topic.updatedAt,
      }))
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return a.lastActivity < b.lastActivity ? 1 : -1;
      });

    const filtered = base.filter((topic) => {
      if (!normalizedSearch) return true;
      const topicHit = `${topic.name} ${topic.description ?? ""}`.toLowerCase().includes(normalizedSearch);
      if (topicHit) return true;
      const taskList = tasksByTopic.get(topic.id) ?? [];
      if (taskList.some((task) => matchesTaskSearch(task))) return true;
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
  }, [topics, tasksByTopic, normalizedSearch, logsByTopic, matchesLogSearch, matchesTaskSearch]);

  const pageSize = 10;
  const pageCount = Math.ceil(orderedTopics.length / pageSize);
  const safePage = pageCount <= 1 ? 1 : Math.min(page, pageCount);
  const pagedTopics = pageCount > 1 ? orderedTopics.slice((safePage - 1) * pageSize, safePage * pageSize) : orderedTopics;

  const updateTask = async (taskId: string, updates: Partial<Task>) => {
    if (readOnly) return;
    const current = tasks.find((task) => task.id === taskId);
    if (!current) return;
    const res = await fetch(apiUrl("/api/tasks"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Clawboard-Token": token,
      },
      body: JSON.stringify({ ...current, ...updates }),
    });

    if (!res.ok) {
      return;
    }

    setTasks((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, ...updates, updatedAt: new Date().toISOString() } : task))
    );
  };

  const expandAll = () => {
    setExpandedTopics(new Set(orderedTopics.map((topic) => topic.id)));
    setExpandedTasks(new Set(tasks.map((task) => task.id)));
  };

  const collapseAll = () => {
    setExpandedTopics(new Set());
    setExpandedTasks(new Set());
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
    const nextShowDone = params.get("done") === "1";
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
    setShowDone(nextShowDone);
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
      overrides: Partial<Record<"q" | "raw" | "done" | "page", string>> & { topics?: string[]; tasks?: string[] },
      mode: "push" | "replace" = "push"
    ) => {
      const params = new URLSearchParams();
      const nextSearch = overrides.q ?? search;
      const nextRaw = overrides.raw ?? (showRaw ? "1" : "0");
      const nextDone = overrides.done ?? (showDone ? "1" : "0");
      const nextPage = overrides.page ?? String(safePage);
      const nextTopics = overrides.topics ?? Array.from(expandedTopicsSafe);
      const nextTasks = overrides.tasks ?? Array.from(expandedTasksSafe);

      if (nextSearch) params.set("q", nextSearch);
      if (nextRaw === "1") params.set("raw", "1");
      if (nextDone === "1") params.set("done", "1");
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
      showDone,
      showRaw,
      basePath,
    ]
  );



  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Unified View</h1>
          <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
            Topics → tasks → timelines in a single, expandable view.
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
            placeholder="Search topics, tasks, or timeline entries"
            className="min-w-[240px] flex-1"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={showDone ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                const next = !showDone;
                setShowDone(next);
                setPage(1);
                pushUrl({ done: next ? "1" : "0", page: "1" });
              }}
            >
              {showDone ? "Hide done" : "Show done"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const next = !showRaw;
                setShowRaw(next);
                pushUrl({ raw: next ? "1" : "0" });
              }}
            >
              {showRaw ? "Hide full messages" : "Show full messages"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                expandAll();
              pushUrl({ topics: orderedTopics.map((topic) => topic.id), tasks: tasks.map((task) => task.id) });
              }}
            >
              Expand all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                collapseAll();
              pushUrl({ topics: [], tasks: [] });
              }}
            >
              Collapse all
            </Button>
          </div>
        </div>
        {readOnly && (
          <span className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add token to move tasks.</span>
        )}
      </div>

      <div className="space-y-4">
        {pagedTopics.map((topic) => {
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

          return (
            <div key={topicId} className="rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] bg-[rgba(16,19,24,0.88)] p-5">
              <div
                role="button"
                tabIndex={0}
                className="flex flex-wrap items-start justify-between gap-4 text-left"
                onClick={(event) => {
                  if (!allowToggle(event.target as HTMLElement)) return;
                  const next = new Set(expandedTopicsSafe);
                  if (next.has(topicId)) {
                    next.delete(topicId);
                  } else {
                    next.add(topicId);
                  }
                  setExpandedTopics(next);
                  pushUrl({ topics: Array.from(next) });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    const next = new Set(expandedTopicsSafe);
                    if (next.has(topicId)) {
                      next.delete(topicId);
                    } else {
                      next.add(topicId);
                    }
                    setExpandedTopics(next);
                    pushUrl({ topics: Array.from(next) });
                  }
                }}
                aria-expanded={isExpanded}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold">{topic.name}</h2>
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
                  <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{topic.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[rgb(var(--claw-muted))]">
                    <span>{taskList.length} tasks</span>
                    <span>{openCount} open</span>
                    <span>{doingCount} doing</span>
                    <span>{blockedCount} blocked</span>
                    <span>Last activity {formatRelativeTime(lastActivity)}</span>
                  </div>
                </div>
                <span className="text-[rgb(var(--claw-accent))]">{isExpanded ? "▾" : "▸"}</span>
              </div>

              {isExpanded && showTasks && (
                <div className="mt-4 space-y-3">
                  {taskList.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No tasks yet.</p>}
                  {taskList
                    .filter((task) => {
                      if (!showDone && task.status === "done") return false;
                      return matchesTaskSearch(task);
                    })
                    .map((task) => {
                      if (normalizedSearch && !matchesTaskSearch(task) && !`${topic.name} ${topic.description ?? ""}`.toLowerCase().includes(normalizedSearch)) {
                        return null;
                      }
                      const taskLogs = logsByTask.get(task.id) ?? [];
                      const taskExpanded = expandedTasksSafe.has(task.id);
                      const visibleLogs = taskLogs.filter(matchesLogSearch);
                      const limit = timelineLimits[task.id] ?? DEFAULT_TIMELINE_LIMIT;
                      const limitedLogs = visibleLogs.slice(0, limit);
                      const truncated = visibleLogs.length > limit;
                      return (
                        <div key={task.id} className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
                          <div
                            role="button"
                            tabIndex={0}
                          className="flex flex-wrap items-center justify-between gap-3 text-left"
                          onClick={(event) => {
                            if (!allowToggle(event.target as HTMLElement)) return;
                            const next = new Set(expandedTasksSafe);
                            if (next.has(task.id)) {
                              next.delete(task.id);
                            } else {
                              next.add(task.id);
                            }
                            setExpandedTasks(next);
                            pushUrl({ tasks: Array.from(next) });
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              const next = new Set(expandedTasksSafe);
                              if (next.has(task.id)) {
                                next.delete(task.id);
                              } else {
                                next.add(task.id);
                              }
                              setExpandedTasks(next);
                              pushUrl({ tasks: Array.from(next) });
                            }
                          }}
                          aria-expanded={taskExpanded}
                        >
                          <div>
                            <div className="flex items-center gap-2 text-sm font-semibold">
                              <span>{task.title}</span>
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
                            <div className="mt-1 text-xs text-[rgb(var(--claw-muted))]">Updated {formatRelativeTime(task.updatedAt)}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <StatusPill tone={STATUS_TONE[task.status]} label={STATUS_LABELS[task.status] ?? task.status} />
                            <span className="text-[rgb(var(--claw-accent))]">{taskExpanded ? "▾" : "▸"}</span>
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
                              <p className="text-sm text-[rgb(var(--claw-muted))]">No timeline entries yet.</p>
                            ) : (
                              <>
                                <LogList
                                  logs={limitedLogs}
                                  topics={topics}
                                  showFilters={false}
                                  showRawToggle={false}
                                  showRawAll={showRaw}
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
                                          [task.id]: (prev[task.id] ?? DEFAULT_TIMELINE_LIMIT) + DEFAULT_TIMELINE_LIMIT,
                                        }))
                                      }
                                    >
                                      Load 5 more
                                    </Button>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                    })}
                  {taskList.filter((task) => {
                    if (!showDone && task.status === "done") return false;
                    return matchesTaskSearch(task);
                  }).length === 0 && (
                    <p className="text-sm text-[rgb(var(--claw-muted))]">No tasks match your filters.</p>
                  )}

                  {topicOnlyLogs.length > 0 && (
                    <div className="rounded-[var(--radius-md)] border border-[rgba(255,90,45,0.25)] bg-[rgba(255,90,45,0.06)] p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Topic Chat</div>
                        <span className="text-xs text-[rgb(var(--claw-muted))]">{topicOnlyLogs.length} entries</span>
                      </div>
                      <LogList
                        logs={topicOnlyLogs.slice(0, timelineLimits[topicId] ?? DEFAULT_TIMELINE_LIMIT)}
                        topics={topics}
                        showFilters={false}
                        showRawToggle={false}
                        showRawAll={showRaw}
                        allowNotes
                        enableNavigation={false}
                      />
                      {topicOnlyLogs.length > (timelineLimits[topicId] ?? DEFAULT_TIMELINE_LIMIT) && (
                        <div className="mt-3 flex justify-end">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              setTimelineLimits((prev) => ({
                                ...prev,
                                [topicId]: (prev[topicId] ?? DEFAULT_TIMELINE_LIMIT) + DEFAULT_TIMELINE_LIMIT,
                              }))
                            }
                          >
                            Load 5 more
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
