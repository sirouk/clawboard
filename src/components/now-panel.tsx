"use client";

import { useState } from "react";
import Link from "next/link";
import type { Topic, TaskStatus } from "@/lib/types";
import { Button, StatusPill } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { formatRelativeTime } from "@/lib/format";
import { buildTopicUrl, UNIFIED_BASE } from "@/lib/url";
import { apiFetch } from "@/lib/api";

const STATUS_TONE: Record<TaskStatus, "muted" | "accent" | "accent2" | "warning" | "success"> = {
  todo: "muted",
  doing: "accent",
  blocked: "warning",
  done: "success",
};

export function NowPanel({
  tasks: initialTopics,
  topics,
  allowStatusUpdate = true,
  linkEntireCard = false,
}: {
  tasks: Topic[];
  topics: Topic[];
  allowStatusUpdate?: boolean;
  linkEntireCard?: boolean;
}) {
  const { token, tokenRequired } = useAppConfig();
  const [items, setItems] = useState<Topic[]>(initialTopics);
  const readOnly = tokenRequired && !token;

  const updateTask = async (topicId: string, updates: Partial<Topic>) => {
    if (readOnly) return;
    if (!allowStatusUpdate) return;
    const current = items.find((t) => t.id === topicId);
    if (!current) return;
    const res = await apiFetch(
      `/api/topics/${encodeURIComponent(topicId)}`,
      {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updates),
      },
      token
    );

    if (!res.ok) return;
    setItems((prev) =>
      prev.map((t) => (t.id === topicId ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t))
    );
  };

  const openTasks = [...items]
    .filter((t) => t.status !== "done")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 3);

  return (
    <div className="space-y-4">
      {readOnly && (
        <p className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add a token to update topics.</p>
      )}
      {openTasks.length === 0 && (
        <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-3 text-sm text-[rgb(var(--claw-muted))]">
          <p>No open topics yet.</p>
          <Link href={UNIFIED_BASE} className="mt-2 inline-flex text-xs text-[rgb(var(--claw-accent))]">
            Open Board to create or triage topics
          </Link>
        </div>
      )}
      {openTasks.map((task) => {
        const taskHref = buildTopicUrl(task, topics);
        const titleNode = linkEntireCard && !allowStatusUpdate ? (
          <span className="text-sm font-semibold">{task.name}</span>
        ) : (
          <Link className="text-sm font-semibold" href={taskHref}>
            {task.name}
          </Link>
        );
        const statusKey = (task.status ?? "active") as TaskStatus;
        const CardBody = (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                {titleNode}
              </div>
              <StatusPill tone={STATUS_TONE[statusKey] ?? "muted"} label={statusKey} />
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
