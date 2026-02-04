"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { LogEntry, Task, Topic } from "@/lib/types";
import { Badge, Button, Input, Select, StatusPill } from "@/components/ui";
import { LogList } from "@/components/log-list";
import { formatRelativeTime } from "@/lib/format";
import { useAppConfig } from "@/components/providers";
import { PinToggle } from "@/components/pin-toggle";
import { TaskPinToggle } from "@/components/task-pin-toggle";
import { decodeSlugId, encodeTaskSlug, encodeTopicSlug, slugify } from "@/lib/slug";
import { cn } from "@/lib/cn";
import { apiUrl } from "@/lib/api";

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

export function UnifiedView({
  topics,
  tasks,
  logs,
  basePath = "/u",
}: {
  topics: Topic[];
  tasks: Task[];
  logs: LogEntry[];
  basePath?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { token, tokenRequired } = useAppConfig();
  const readOnly = tokenRequired && !token;
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [showRaw, setShowRaw] = useState(false);
  const [search, setSearch] = useState("");
  const [taskState, setTaskState] = useState<Task[]>(tasks);
  const [topicState, setTopicState] = useState<Topic[]>(topics);
  const [logState, setLogState] = useState<LogEntry[]>(logs);
  const [showDone, setShowDone] = useState(false);
  const [timelineLimits, setTimelineLimits] = useState<Record<string, number>>({});
  const [moveTaskId, setMoveTaskId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [isSticky, setIsSticky] = useState(false);
  const committedSearch = useRef("");
  const basePathRef = useRef(basePath);

  useEffect(() => {
    const handle = () => {
      setIsSticky(window.scrollY > 12);
    };
    handle();
    window.addEventListener("scroll", handle, { passive: true });
    return () => window.removeEventListener("scroll", handle);
  }, []);

  useEffect(() => {
    setTaskState(tasks);
  }, [tasks]);

  useEffect(() => {
    setTopicState(topics);
  }, [topics]);

  useEffect(() => {
    setLogState(logs);
  }, [logs]);

  const taskRef = useRef(taskState);
  const topicRef = useRef(topicState);
  const logRef = useRef(logState);

  useEffect(() => {
    taskRef.current = taskState;
  }, [taskState]);

  useEffect(() => {
    topicRef.current = topicState;
  }, [topicState]);

  useEffect(() => {
    logRef.current = logState;
  }, [logState]);

  useEffect(() => {
    const topicIds = new Set(topicState.map((topic) => topic.id));
    setExpandedTopics((prev) => new Set([...prev].filter((id) => topicIds.has(id))));
  }, [topicState]);

  useEffect(() => {
    const taskIds = new Set(taskState.map((task) => task.id));
    setExpandedTasks((prev) => new Set([...prev].filter((id) => taskIds.has(id))));
  }, [taskState]);

  const tasksByTopic = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of taskState) {
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
  }, [taskState]);

  const logsByTask = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const entry of logState) {
      if (!entry.taskId) continue;
      const list = map.get(entry.taskId) ?? [];
      list.push(entry);
      map.set(entry.taskId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    return map;
  }, [logState]);

  const logsByTopic = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const entry of logState) {
      if (!entry.topicId) continue;
      const list = map.get(entry.topicId) ?? [];
      list.push(entry);
      map.set(entry.topicId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    return map;
  }, [logState]);

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
    const base = [...topicState]
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
  }, [topicState, tasksByTopic, normalizedSearch, logsByTopic, matchesLogSearch, matchesTaskSearch]);

  const pageSize = 10;
  const pageCount = Math.ceil(orderedTopics.length / pageSize);
  const pagedTopics = pageCount > 1 ? orderedTopics.slice((page - 1) * pageSize, page * pageSize) : orderedTopics;

  useEffect(() => {
    if (pageCount <= 1) {
      setPage(1);
      return;
    }
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  useEffect(() => {
    setPage(1);
  }, [normalizedSearch, showDone]);

  const updateTask = async (taskId: string, updates: Partial<Task>) => {
    if (readOnly) return;
    const current = taskState.find((task) => task.id === taskId);
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

    setTaskState((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, ...updates, updatedAt: new Date().toISOString() } : task))
    );
  };

  const expandAll = () => {
    setExpandedTopics(new Set(orderedTopics.map((topic) => topic.id)));
    setExpandedTasks(new Set(taskState.map((task) => task.id)));
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
      if (topicState.some((topic) => topic.id === raw)) return raw;
      const slug = value.includes("--") ? value.slice(0, value.lastIndexOf("--")) : value;
      const match = topicState.find((topic) => slugify(topic.name) === slug);
      return match?.id ?? raw;
    },
    [topicState]
  );

  const resolveTaskId = useCallback(
    (value: string) => {
      if (!value) return "";
      const raw = decodeSlugId(value);
      if (taskState.some((task) => task.id === raw)) return raw;
      const slug = value.includes("--") ? value.slice(0, value.lastIndexOf("--")) : value;
      const match = taskState.find((task) => slugify(task.title) === slug);
      return match?.id ?? raw;
    },
    [taskState]
  );

  const encodeTopicParam = useCallback(
    (topicId: string) => {
      const topic = topicState.find((item) => item.id === topicId);
      return topic ? encodeTopicSlug(topic) : topicId;
    },
    [topicState]
  );

  const encodeTaskParam = useCallback(
    (taskId: string) => {
      const task = taskState.find((item) => item.id === taskId);
      return task ? encodeTaskSlug(task) : taskId;
    },
    [taskState]
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

  useEffect(() => {
    const basePathValue = basePathRef.current;
    const params = new URLSearchParams(searchParams.toString());
    const segments = pathname.startsWith(basePathValue)
      ? pathname.slice(basePathValue.length).split("/").filter(Boolean)
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
  }, [pathname, resolveTaskId, resolveTopicId, searchParams]);

  const pushUrl = useCallback(
    (
      overrides: Partial<Record<"q" | "raw" | "done" | "page", string>> & { topics?: string[]; tasks?: string[] },
      mode: "push" | "replace" = "push"
    ) => {
      const params = new URLSearchParams();
      const nextSearch = overrides.q ?? search;
      const nextRaw = overrides.raw ?? (showRaw ? "1" : "0");
      const nextDone = overrides.done ?? (showDone ? "1" : "0");
      const nextPage = overrides.page ?? String(page);
      const nextTopics = overrides.topics ?? Array.from(expandedTopics);
      const nextTasks = overrides.tasks ?? Array.from(expandedTasks);

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

      const basePathValue = basePathRef.current;
      const trimmedBase =
        basePathValue.endsWith("/") && basePathValue.length > 1 ? basePathValue.slice(0, -1) : basePathValue;
      const nextPath = segments.length > 0 ? `${trimmedBase}/${segments.join("/")}` : trimmedBase;
      const query = params.toString();
      const nextUrl = query ? `${nextPath}?${query}` : nextPath;
      if (mode === "replace") {
        router.replace(nextUrl, { scroll: false });
      } else {
        router.push(nextUrl, { scroll: false });
      }
    },
    [encodeTaskParam, encodeTopicParam, expandedTasks, expandedTopics, page, router, search, showDone, showRaw]
  );

  const REFRESH_MS = 12000;

  useEffect(() => {
    let mounted = true;
    const maxTimestamp = (items: Array<{ updatedAt?: string; createdAt?: string }>, key: "updatedAt" | "createdAt") =>
      items.reduce((max, item) => {
        const value = item[key] ?? "";
        return value > max ? value : max;
      }, "");

    const refresh = async () => {
      try {
        const [topicsRes, tasksRes, logsRes] = await Promise.all([
          fetch(apiUrl("/api/topics"), { cache: "no-store" }),
          fetch(apiUrl("/api/tasks"), { cache: "no-store" }),
          fetch(apiUrl("/api/log"), { cache: "no-store" }),
        ]);

        if (!mounted) return;
        const topicsData = await topicsRes.json().catch(() => null);
        const tasksData = await tasksRes.json().catch(() => null);
        const logsData = await logsRes.json().catch(() => null);

        if (Array.isArray(topicsData?.topics)) {
          const nextTopics = topicsData.topics as Topic[];
          const nextFingerprint = `${nextTopics.length}:${maxTimestamp(nextTopics, "updatedAt")}`;
          const currentFingerprint = `${topicRef.current.length}:${maxTimestamp(topicRef.current, "updatedAt")}`;
          if (nextFingerprint !== currentFingerprint) {
            setTopicState(nextTopics);
          }
        }

        if (Array.isArray(tasksData?.tasks)) {
          const nextTasks = tasksData.tasks as Task[];
          const nextFingerprint = `${nextTasks.length}:${maxTimestamp(nextTasks, "updatedAt")}`;
          const currentFingerprint = `${taskRef.current.length}:${maxTimestamp(taskRef.current, "updatedAt")}`;
          if (nextFingerprint !== currentFingerprint) {
            setTaskState(nextTasks);
          }
        }

        if (Array.isArray(logsData?.logs)) {
          const nextLogs = logsData.logs as LogEntry[];
          const nextFingerprint = `${nextLogs.length}:${maxTimestamp(nextLogs, "createdAt")}`;
          const currentFingerprint = `${logRef.current.length}:${maxTimestamp(logRef.current, "createdAt")}`;
          if (nextFingerprint !== currentFingerprint) {
            setLogState(nextLogs);
          }
        }
      } catch {
        // ignore refresh errors
      }
    };

    const interval = window.setInterval(refresh, REFRESH_MS);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

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
              pushUrl({ q: value }, "replace");
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
              {showRaw ? "Show summaries" : "Show full prompts"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                expandAll();
              pushUrl({ topics: orderedTopics.map((topic) => topic.id), tasks: taskState.map((task) => task.id) });
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
          const showTasks = !normalizedSearch || taskList.length > 0;
          const isExpanded = expandedTopics.has(topicId);

          return (
            <div key={topicId} className="rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] bg-[rgba(16,19,24,0.88)] p-5">
              <div
                role="button"
                tabIndex={0}
                className="flex flex-wrap items-start justify-between gap-4 text-left"
                onClick={(event) => {
                  if (!allowToggle(event.target as HTMLElement)) return;
                  const next = new Set(expandedTopics);
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
                    const next = new Set(expandedTopics);
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
                        setTopicState((prev) =>
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
                      const taskExpanded = expandedTasks.has(task.id);
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
                            const next = new Set(expandedTasks);
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
                              const next = new Set(expandedTasks);
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
                                  setTaskState((prev) =>
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
                                    {topicState.map((topicOption) => (
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
                                  topics={topicState}
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
                </div>
              )}
            </div>
          );
        })}
      </div>

      {pageCount > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-4 py-3 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">
          <span>
            Page {page} of {pageCount}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const next = Math.max(1, page - 1);
                setPage(next);
                pushUrl({ page: String(next) });
              }}
              disabled={page === 1}
            >
              Prev
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const next = Math.min(pageCount, page + 1);
                setPage(next);
                pushUrl({ page: String(next) });
              }}
              disabled={page === pageCount}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}