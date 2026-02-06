"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Badge, Card, CardHeader, type BadgeTone } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";
import { buildTopicUrl } from "@/lib/url";
import { useDataStore } from "@/components/data-provider";
import type { Task } from "@/lib/types";

type StatusKey = Task["status"];

const STATUS_LABELS: Record<StatusKey, string> = {
  todo: "To Do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

const STATUS_ORDER: StatusKey[] = ["todo", "doing", "blocked", "done"];

const STATUS_TONES: Record<StatusKey, BadgeTone> = {
  todo: "muted",
  doing: "accent2",
  blocked: "warning",
  done: "success",
};

function MetricCard({
  title,
  count,
  tone,
  description,
  href,
  cta,
}: {
  title: string;
  count: number;
  tone: BadgeTone;
  description: string;
  href: string;
  cta: string;
}) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">{title}</h2>
        <Badge tone={tone}>{count}</Badge>
      </CardHeader>
      <p className="text-sm text-[rgb(var(--claw-muted))]">{description}</p>
      <Link
        href={href}
        className="mt-3 inline-flex rounded-full border border-[rgb(var(--claw-border))] px-3 py-1 text-xs uppercase tracking-[0.18em] text-[rgb(var(--claw-muted))] transition hover:border-[rgba(255,90,45,0.35)] hover:text-[rgb(var(--claw-text))]"
      >
        {cta}
      </Link>
    </Card>
  );
}

export function StatsLive() {
  const { tasks, logs, topics } = useDataStore();

  const logsSorted = useMemo(() => [...logs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), [logs]);

  const taskCounts = tasks.reduce<Record<string, number>>(
    (acc, task) => {
      acc[task.status] = (acc[task.status] ?? 0) + 1;
      return acc;
    },
    { todo: 0, doing: 0, blocked: 0, done: 0 }
  );
  const openCount = tasks.filter((task) => task.status !== "done").length;

  const topicActivity = topics
    .map((topic) => {
      const logCount = logs.filter((log) => log.topicId === topic.id).length;
      const taskCount = tasks.filter((task) => task.topicId === topic.id).length;
      return { ...topic, logCount, taskCount };
    })
    .sort((a, b) => b.logCount - a.logCount)
    .slice(0, 6);

  const agentStats = useMemo(() => {
    const latestEventTime = logs.reduce((max, entry) => {
      const createdAt = Date.parse(entry.createdAt);
      if (Number.isNaN(createdAt)) return max;
      return Math.max(max, createdAt);
    }, 0);
    const currentStart = latestEventTime - 24 * 60 * 60 * 1000;
    const previousStart = currentStart - 24 * 60 * 60 * 1000;
    const stats = new Map<string, { total: number; current: number; previous: number }>();
    for (const entry of logs) {
      const label = entry.agentLabel || entry.agentId || "Main";
      const createdAt = Date.parse(entry.createdAt);
      const slot = stats.get(label) ?? { total: 0, current: 0, previous: 0 };
      slot.total += 1;
      if (!Number.isNaN(createdAt)) {
        if (createdAt >= currentStart) {
          slot.current += 1;
        } else if (createdAt >= previousStart) {
          slot.previous += 1;
        }
      }
      stats.set(label, slot);
    }
    return Array.from(stats.entries())
      .map(([label, values]) => ({
        label,
        total: values.total,
        delta: values.current - values.previous,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  }, [logs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Stats</h1>
          <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
            Coverage and momentum across topics, tasks, and conversations.
          </p>
        </div>
        <Badge tone="accent2">Live snapshot</Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Topics" count={topics.length} tone="accent" description="Active areas of focus." href="/u" cta="Open board" />
        <MetricCard title="Tasks" count={tasks.length} tone="accent2" description="Total tracked actions." href="/u" cta="Review tasks" />
        <MetricCard title="Open" count={openCount} tone="warning" description="Needs attention." href="/u?status=blocked" cta="View blocked tasks" />
        <MetricCard title="Logs" count={logs.length} tone="accent" description="Conversation + action events." href="/log" cta="Open logs" />
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Most Active Topics</h2>
          <Badge tone="accent2">Last updated</Badge>
        </CardHeader>
        <div className="space-y-3">
          {topicActivity.map((topic) => (
            <Link
              key={topic.id}
              href={buildTopicUrl(topic, topics)}
              className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-4 py-3 text-sm transition hover:border-[rgba(255,90,45,0.35)]"
            >
              <div>
                <div className="font-semibold">{topic.name}</div>
                <div className="text-xs text-[rgb(var(--claw-muted))]">{topic.description}</div>
              </div>
              <div className="text-xs text-[rgb(var(--claw-muted))]">
                {topic.logCount} logs · {topic.taskCount} tasks · updated {formatRelativeTime(topic.updatedAt)}
              </div>
            </Link>
          ))}
          {topicActivity.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No topics tracked yet.</p>}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Task Status</h2>
            <Badge tone="muted">Filters</Badge>
          </CardHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {STATUS_ORDER.map((status) => {
              const doneParam = status === "done" ? "&done=1" : "";
              return (
                <Link
                  key={status}
                  href={`/u?status=${status}${doneParam}`}
                  className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4 transition hover:border-[rgba(255,90,45,0.35)]"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">{STATUS_LABELS[status]}</div>
                    <Badge tone={STATUS_TONES[status]}>Filter</Badge>
                  </div>
                  <div className="mt-2 text-2xl font-semibold">{taskCounts[status] ?? 0}</div>
                </Link>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Agent Lanes</h2>
            <Badge tone="muted">24h delta</Badge>
          </CardHeader>
          <div className="space-y-3 text-sm text-[rgb(var(--claw-muted))]">
            {agentStats.map((agent) => (
              <Link
                key={agent.label}
                href={`/log?agent=${encodeURIComponent(agent.label)}`}
                className="flex items-center justify-between rounded-[var(--radius-sm)] px-2 py-1 transition hover:bg-[rgba(255,255,255,0.03)]"
              >
                <span>{agent.label}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[rgb(var(--claw-text))]">{agent.total}</span>
                  <span
                    className={
                      agent.delta > 0
                        ? "text-[rgb(var(--claw-accent2))]"
                        : agent.delta < 0
                          ? "text-[rgb(var(--claw-warning))]"
                          : "text-[rgb(var(--claw-muted))]"
                    }
                  >
                    {agent.delta > 0 ? `+${agent.delta}` : agent.delta}
                  </span>
                </span>
              </Link>
            ))}
            {agentStats.length === 0 && <p>No activity yet.</p>}
          </div>
        </Card>
      </div>

      {logsSorted.length === 0 && (
        <p className="text-xs text-[rgb(var(--claw-muted))]">Waiting on the first events from OpenClaw.</p>
      )}
    </div>
  );
}
