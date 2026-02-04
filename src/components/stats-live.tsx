"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Badge, Card, CardHeader } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";
import { buildTopicUrl } from "@/lib/url";
import { useDataStore } from "@/components/data-provider";

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

  const topicActivity = topics
    .map((topic) => {
      const logCount = logs.filter((log) => log.topicId === topic.id).length;
      const taskCount = tasks.filter((task) => task.topicId === topic.id).length;
      return { ...topic, logCount, taskCount };
    })
    .sort((a, b) => b.logCount - a.logCount)
    .slice(0, 6);

  const agentCounts = logs.reduce<Record<string, number>>((acc, entry) => {
    const key = entry.agentLabel || entry.agentId || "Main";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const agentStats = Object.entries(agentCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);

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
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Topics</h2>
            <Badge tone="accent">{topics.length}</Badge>
          </CardHeader>
          <p className="text-sm text-[rgb(var(--claw-muted))]">Active areas of focus.</p>
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Tasks</h2>
            <Badge tone="accent2">{tasks.length}</Badge>
          </CardHeader>
          <p className="text-sm text-[rgb(var(--claw-muted))]">Total tracked actions.</p>
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Open</h2>
            <Badge tone="warning">{tasks.filter((task) => task.status !== "done").length}</Badge>
          </CardHeader>
          <p className="text-sm text-[rgb(var(--claw-muted))]">Needs attention.</p>
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Logs</h2>
            <Badge tone="accent">{logs.length}</Badge>
          </CardHeader>
          <p className="text-sm text-[rgb(var(--claw-muted))]">Conversation + action events.</p>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Task Status</h2>
            <Badge tone="muted">Breakdown</Badge>
          </CardHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">To Do</div>
              <div className="mt-2 text-2xl font-semibold">{taskCounts.todo ?? 0}</div>
            </div>
            <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Doing</div>
              <div className="mt-2 text-2xl font-semibold">{taskCounts.doing ?? 0}</div>
            </div>
            <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Blocked</div>
              <div className="mt-2 text-2xl font-semibold">{taskCounts.blocked ?? 0}</div>
            </div>
            <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Done</div>
              <div className="mt-2 text-2xl font-semibold">{taskCounts.done ?? 0}</div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Agent Lanes</h2>
            <Badge tone="muted">Top activity</Badge>
          </CardHeader>
          <div className="space-y-3 text-sm text-[rgb(var(--claw-muted))]">
            {agentStats.map(([label, count]) => (
              <div key={label} className="flex items-center justify-between">
                <span>{label}</span>
                <span className="text-[rgb(var(--claw-text))]">{count}</span>
              </div>
            ))}
            {agentStats.length === 0 && <p>No activity yet.</p>}
          </div>
        </Card>
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

      {logsSorted.length === 0 && (
        <p className="text-xs text-[rgb(var(--claw-muted))]">Waiting on the first events from OpenClaw.</p>
      )}
    </div>
  );
}
