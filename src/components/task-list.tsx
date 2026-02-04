"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Task, TaskStatus, Topic } from "@/lib/types";
import { Button, Input, Select, StatusPill } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { formatRelativeTime } from "@/lib/format";
import { buildTaskUrl } from "@/lib/url";
import { apiUrl } from "@/lib/api";

const STATUS_OPTIONS: TaskStatus[] = ["todo", "doing", "blocked", "done"];

const FILTER_OPTIONS = ["all", "open", ...STATUS_OPTIONS] as const;
export type StatusFilter = (typeof FILTER_OPTIONS)[number];

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: "All statuses",
  open: "Open",
  todo: STATUS_LABELS.todo,
  doing: STATUS_LABELS.doing,
  blocked: STATUS_LABELS.blocked,
  done: STATUS_LABELS.done,
};

const STATUS_TONE: Record<TaskStatus, "muted" | "accent" | "accent2" | "warning" | "success"> = {
  todo: "muted",
  doing: "accent",
  blocked: "warning",
  done: "success",
};

export function TaskList({
  tasks: initialTasks,
  topics,
  showTopicSelect = false,
  showFilters = true,
  allowDensityToggle = true,
  defaultDensity = "comfortable",
  defaultStatusFilter = "all",
  allowStatusChange = true,
  allowTitleEdit = true,
  allowTopicChange = true,
  enableCardNavigation = true,
}: {
  tasks: Task[];
  topics: Topic[];
  showTopicSelect?: boolean;
  showFilters?: boolean;
  allowDensityToggle?: boolean;
  defaultDensity?: "comfortable" | "compact";
  defaultStatusFilter?: StatusFilter;
  allowStatusChange?: boolean;
  allowTitleEdit?: boolean;
  allowTopicChange?: boolean;
  enableCardNavigation?: boolean;
}) {
  const { token, tokenRequired } = useAppConfig();
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const initialFilter = FILTER_OPTIONS.includes(defaultStatusFilter) ? defaultStatusFilter : "all";
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialFilter);
  const [search, setSearch] = useState("");
  const [density, setDensity] = useState<"comfortable" | "compact">(defaultDensity);

  const filtered = useMemo(() => {
    return tasks.filter((task) => {
      if (statusFilter === "open" && task.status === "done") return false;
      if (statusFilter !== "all" && statusFilter !== "open" && task.status !== statusFilter) return false;
      if (search.trim().length > 0 && !task.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [tasks, statusFilter, search]);

  const readOnly = tokenRequired && !token;

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
      body: JSON.stringify({
        ...current,
        ...updates,
      }),
    });

    if (!res.ok) {
      throw new Error("Failed to update task.");
    }

    setTasks((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, ...updates, updatedAt: new Date().toISOString() } : task))
    );
  };


  return (
    <div className="space-y-4">
      {readOnly && (
        <p className="text-sm text-[rgb(var(--claw-warning))]">Read-only mode. Add a token in Setup to update tasks.</p>
      )}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tasks"
            className="max-w-sm"
          />
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} className="max-w-[200px]">
            {FILTER_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {FILTER_LABELS[status]}
              </option>
            ))}
          </Select>
          {allowDensityToggle && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={density === "comfortable" ? "secondary" : "ghost"}
                onClick={() => setDensity("comfortable")}
              >
                Comfortable
              </Button>
              <Button size="sm" variant={density === "compact" ? "secondary" : "ghost"} onClick={() => setDensity("compact")}>
                Compact
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            topics={topics}
            showTopicSelect={showTopicSelect}
            onUpdate={updateTask}
            readOnly={readOnly}
            density={density}
            allowStatusChange={allowStatusChange}
            allowTitleEdit={allowTitleEdit}
            allowTopicChange={allowTopicChange}
            enableCardNavigation={enableCardNavigation}
          />
        ))}
        {filtered.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No tasks match yet.</p>}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  topics,
  showTopicSelect,
  onUpdate,
  readOnly,
  density,
  allowStatusChange,
  allowTitleEdit,
  allowTopicChange,
  enableCardNavigation,
}: {
  task: Task;
  topics: Topic[];
  showTopicSelect: boolean;
  onUpdate: (taskId: string, updates: Partial<Task>) => Promise<void>;
  readOnly: boolean;
  density: "comfortable" | "compact";
  allowStatusChange: boolean;
  allowTitleEdit: boolean;
  allowTopicChange: boolean;
  enableCardNavigation: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(task.title);
  const [saving, setSaving] = useState(false);
  const topicName = topics.find((topic) => topic.id === task.topicId)?.name ?? "Unassigned";
  const compact = density === "compact";
  const rowPadding = compact ? "p-3" : "p-4";
  const titleClass = compact ? "text-sm" : "text-base";
  const metaClass = compact ? "text-[11px]" : "text-xs";
  const selectClass = compact ? "h-9 min-w-[110px] text-xs" : "min-w-[130px]";
  const topicSelectClass = compact ? "h-9 min-w-[150px] text-xs" : "min-w-[180px]";

  const handleBlur = async () => {
    if (!allowTitleEdit || readOnly) return;
    if (title.trim() === task.title) return;
    setSaving(true);
    try {
      await onUpdate(task.id, { title: title.trim() });
    } finally {
      setSaving(false);
    }
  };

  const handleNavigate = (target: HTMLElement | null) => {
    if (!enableCardNavigation) return false;
    if (target?.closest("a, button, input, select, textarea, option")) return false;
    return true;
  };

  const taskHref = buildTaskUrl(task, topics);

  return (
    <div
      className={`rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] ${rowPadding} ${
        enableCardNavigation ? "cursor-pointer transition hover:border-[rgba(255,90,45,0.35)]" : ""
      }`}
      role={enableCardNavigation ? "button" : undefined}
      tabIndex={enableCardNavigation ? 0 : undefined}
      onClick={(event) => {
        if (!handleNavigate(event.target as HTMLElement)) return;
        router.push(taskHref);
      }}
      onKeyDown={(event) => {
        if (!enableCardNavigation) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          router.push(taskHref);
        }
      }}
      aria-label={enableCardNavigation ? `View task ${task.title}` : undefined}
    >
      <div className={`flex gap-3 ${compact ? "flex-col items-stretch" : "flex-wrap items-center justify-between"}`}>
        <div className="flex flex-1 flex-col gap-2">
          {allowTitleEdit && !readOnly ? (
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={handleBlur}
              readOnly={readOnly}
              className={`w-full bg-transparent font-medium text-[rgb(var(--claw-text))] outline-none ${titleClass}`}
            />
          ) : (
            <div className={`w-full font-medium text-[rgb(var(--claw-text))] ${titleClass}`}>{title}</div>
          )}
          <div className={`flex flex-wrap items-center gap-3 text-[rgb(var(--claw-muted))] ${metaClass}`}>
            <span>Updated {formatRelativeTime(task.updatedAt)}</span>
            {!showTopicSelect && <span>{topicName}</span>}
          </div>
        </div>
        <div className={`flex flex-wrap items-center gap-3 ${compact ? "w-full" : ""}`}>
          <StatusPill tone={STATUS_TONE[task.status]} label={STATUS_LABELS[task.status]} />
          {allowStatusChange && !readOnly && (
            <Select
              value={task.status}
              onChange={(event) => onUpdate(task.id, { status: event.target.value as TaskStatus })}
              className={selectClass}
              disabled={readOnly}
            >
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          )}
          {showTopicSelect && allowTopicChange && (
            <Select
              value={task.topicId ?? ""}
              onChange={(event) => onUpdate(task.id, { topicId: event.target.value || null })}
              className={topicSelectClass}
              disabled={readOnly}
            >
              <option value="">Unassigned</option>
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.name}
                </option>
              ))}
            </Select>
          )}
          {saving && <span className="text-xs text-[rgb(var(--claw-muted))]">Saving...</span>}
        </div>
      </div>
    </div>
  );
}