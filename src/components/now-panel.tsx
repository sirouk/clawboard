"use client";

import { useState } from "react";
import Link from "next/link";
import type { Task, Topic, TaskStatus } from "@/lib/types";
import { Button, StatusPill } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { formatRelativeTime } from "@/lib/format";
import { buildTaskUrl } from "@/lib/url";
import { apiUrl } from "@/lib/api";

const STATUS_TONE: Record<TaskStatus, "muted" | "accent" | "accent2" | "warning" | "success"> = {
  todo: "muted",
  doing: "accent",
  blocked: "warning",
  done: "success",
};

export function NowPanel({
  tasks: initialTasks,
  topics,
  allowStatusUpdate = true,
  linkEntireCard = false,
}: {
  tasks: Task[];
  topics: Topic[];
  allowStatusUpdate?: boolean;
  linkEntireCard?: boolean;
}) {
  const { token, tokenRequired } = useAppConfig();
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const readOnly = tokenRequired && !token;

  const updateTask = async (taskId: string, updates: Partial<Task>) => {
    if (readOnly) return;
    if (!allowStatusUpdate) return;
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

    if (!res.ok) return;
    setTasks((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, ...updates, updatedAt: new Date().toISOString() } : task))
    );
  };

  const openTasks = [...tasks]
    .filter((task) => task.status !== "done")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 3);

  return (
    <div className="space-y-4">
      {readOnly && (
        <p className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add a token to update tasks.</p>
      )}
      {openTasks.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No open tasks yet.</p>}
      {openTasks.map((task) => {
        const topicLabel = topics.find((topic) => topic.id === task.topicId)?.name ?? "Unassigned";
        const taskHref = buildTaskUrl(task, topics);
        const titleNode = linkEntireCard && !allowStatusUpdate ? (
          <span className="text-sm font-semibold">{task.title}</span>
        ) : (
          <Link className="text-sm font-semibold" href={taskHref}>
            {task.title}
          </Link>
        );
        const CardBody = (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                {titleNode}
                <div className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{topicLabel}</div>
              </div>
              <StatusPill tone={STATUS_TONE[task.status]} label={task.status} />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-[rgb(var(--claw-muted))]">
              <span>Updated {formatRelativeTime(task.updatedAt)}</span>
              <div className="flex items-center gap-2">
                {allowStatusUpdate && task.status !== "doing" && (
                  <Button size="sm" variant="secondary" onClick={() => updateTask(task.id, { status: "doing" })} disabled={readOnly}>
                    Start
                  </Button>
                )}
                {allowStatusUpdate && task.status !== "done" && (
                  <Button size="sm" onClick={() => updateTask(task.id, { status: "done" })} disabled={readOnly}>
                    Done
                  </Button>
                )}
              </div>
            </div>
          </>
        );

        return linkEntireCard && !allowStatusUpdate ? (
          <Link
            key={task.id}
            href={taskHref}
            className="block rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-3 transition hover:border-[rgba(255,90,45,0.35)]"
          >
            {CardBody}
          </Link>
        ) : (
          <div
            key={task.id}
            className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-3"
          >
            {CardBody}
          </div>
        );
      })}
    </div>
  );
}