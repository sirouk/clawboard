"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Card, CardHeader, Badge } from "@/components/ui";
import { NowPanel } from "@/components/now-panel";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { buildTopicUrl, UNIFIED_BASE, withRevealParam } from "@/lib/url";
import type { LogEntry } from "@/lib/types";
import { useDataStore } from "@/components/data-provider";

export function DashboardLive() {
  const { logs, topics } = useDataStore();

  const sortedLogs = useMemo(() => [...logs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), [logs]);
  const sortedTopics = useMemo(
    () =>
      [...topics].sort((a, b) => {
        const sortDelta = Number(a.sortIndex ?? 0) - Number(b.sortIndex ?? 0);
        if (sortDelta !== 0) return sortDelta;
        if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
        return String(a.id ?? "").localeCompare(String(b.id ?? ""));
      }),
    [topics]
  );

  const openTopics = topics.filter((topic) => topic.status !== "done" && topic.status !== "archived");
  const doingTopics = topics.filter((topic) => topic.status === "doing");
  const blockedTopics = topics.filter((topic) => topic.status === "blocked");

  const buildLogUrl = (entry: LogEntry) => {
    const topicId = String(entry.topicId ?? "").trim();
    if (topicId) {
      const topic = topics.find((item) => item.id === topicId);
      if (topic) return withRevealParam(buildTopicUrl(topic, topics));
      return `${UNIFIED_BASE}/topic/${encodeURIComponent(topicId)}`;
    }
    return UNIFIED_BASE;
  };

		return (
			<div className="space-y-8">
	      <div className="grid gap-4 lg:grid-cols-4">
	        <Link href={UNIFIED_BASE} className="block">
            <Card className="h-full">
	            <CardHeader>
              <h2 className="text-lg font-semibold">Active Topics</h2>
              <Badge tone="accent">{openTopics.length}</Badge>
            </CardHeader>
            <p className="text-sm text-[rgb(var(--claw-muted))]">Topics not marked done.</p>
          </Card>
        </Link>
        <Link href={UNIFIED_BASE} className="block">
          <Card className="h-full">
            <CardHeader>
              <h2 className="text-lg font-semibold">Doing</h2>
              <Badge tone="accent2">{doingTopics.length}</Badge>
            </CardHeader>
            <p className="text-sm text-[rgb(var(--claw-muted))]">Currently in progress.</p>
          </Card>
        </Link>
        <Link href={UNIFIED_BASE} className="block">
          <Card className="h-full">
            <CardHeader>
              <h2 className="text-lg font-semibold">Blocked</h2>
              <Badge tone="warning">{blockedTopics.length}</Badge>
            </CardHeader>
            <p className="text-sm text-[rgb(var(--claw-muted))]">Needs attention to unblock.</p>
          </Card>
        </Link>
        <Link href={UNIFIED_BASE} className="block">
          <Card className="h-full">
            <CardHeader>
              <h2 className="text-lg font-semibold">Tracking Status</h2>
              <Badge tone={sortedLogs.length > 0 ? "success" : "warning"}>{sortedLogs.length > 0 ? "Live" : "Waiting"}</Badge>
            </CardHeader>
            <p className="text-sm text-[rgb(var(--claw-muted))]">
              {sortedLogs.length > 0 ? `Last event ${formatRelativeTime(sortedLogs[0].createdAt)}` : "Waiting for the first log entry."}
            </p>
          </Card>
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Recent Activity</h2>
            <Link className="text-sm text-[rgb(var(--claw-accent))]" href={UNIFIED_BASE}>
              View all
            </Link>
          </CardHeader>
          <div className="space-y-4">
            {sortedLogs.slice(0, 6).map((entry) => (
              <Link
                key={entry.id}
                href={buildLogUrl(entry)}
                className="block"
              >
                <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4 transition hover:border-[rgba(255,90,45,0.35)]">
                  <div className="flex items-center justify-between text-xs text-[rgb(var(--claw-muted))]">
                    <span>{entry.agentLabel || entry.agentId || "Main"}</span>
                    <span>{formatRelativeTime(entry.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-sm text-[rgb(var(--claw-text))]">{entry.summary ?? entry.content}</p>
                  <div className="mt-2 text-xs text-[rgb(var(--claw-muted))]">{formatDateTime(entry.createdAt)}</div>
                </div>
              </Link>
            ))}
            {sortedLogs.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No activity logged yet.</p>}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Topics</h2>
            <Link className="text-sm text-[rgb(var(--claw-accent))]" href={UNIFIED_BASE}>
              Manage topics
            </Link>
          </CardHeader>
          <div className="space-y-3">
            {sortedTopics.slice(0, 6).map((topic) => (
              <Link
                key={topic.id}
                href={withRevealParam(buildTopicUrl(topic, topics))}
                className="flex items-center justify-between rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 py-2 text-sm"
              >
                <span>{topic.name}</span>
                <span className="text-xs text-[rgb(var(--claw-muted))]">{formatRelativeTime(topic.updatedAt)}</span>
              </Link>
            ))}
            {sortedTopics.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No topics yet.</p>}
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Now</h2>
            <Badge tone="accent2">Next actions</Badge>
          </CardHeader>
          <NowPanel tasks={openTopics} topics={topics} allowStatusUpdate={false} linkEntireCard />
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Signals</h2>
            <Badge tone="accent">Momentum</Badge>
          </CardHeader>
          <div className="space-y-3 text-sm text-[rgb(var(--claw-muted))]">
            <div className="flex items-center justify-between">
              <span>Open topics</span>
              <span className="text-[rgb(var(--claw-text))]">{openTopics.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Doing now</span>
              <span className="text-[rgb(var(--claw-text))]">{doingTopics.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Blocked</span>
              <span className="text-[rgb(var(--claw-text))]">{blockedTopics.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Topics active</span>
              <span className="text-[rgb(var(--claw-text))]">{topics.length}</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
