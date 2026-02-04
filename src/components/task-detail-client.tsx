"use client";

import { useState } from "react";
import type { LogEntry, Task, Topic } from "@/lib/types";
import { Badge, Button } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";
import { SectionNav } from "@/components/section-nav";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { TaskConversationPanel } from "@/components/task-conversation-panel";
import { buildTopicUrl } from "@/lib/url";

export function TaskDetailClient({
  task,
  topic,
  logs,
  topics,
}: {
  task: Task;
  topic?: Topic;
  logs: LogEntry[];
  topics: Topic[];
}) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Breadcrumbs
          items={[
            { label: "Home", href: "/" },
            ...(topic ? [{ label: topic.name, href: buildTopicUrl(topic) }] : []),
            { label: task.title },
          ]}
        />
        <div className="flex items-center gap-3">
          <Badge tone={showRaw ? "accent" : "muted"}>{showRaw ? "Raw prompts" : "Summaries"}</Badge>
          <Button size="sm" variant="secondary" onClick={() => setShowRaw((prev) => !prev)}>
            {showRaw ? "Show summaries" : "Show full prompts"}
          </Button>
        </div>
      </div>

      <SectionNav
        items={[
          { id: "overview", label: "Overview" },
          { id: "conversation", label: "Conversation" },
          { id: "log", label: "Log" },
        ]}
      />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 id="overview" className="text-3xl font-semibold tracking-tight">
            {task.title}
          </h1>
          <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">{topic?.name ?? "Unassigned"}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[rgb(var(--claw-muted))]">
            <span>Status: {task.status}</span>
            <span>Updated {formatRelativeTime(task.updatedAt)}</span>
          </div>
        </div>
        <Badge tone="accent">Task timeline</Badge>
      </div>

      <div id="conversation">
        <TaskConversationPanel logs={logs} topics={topics} showRaw={showRaw} />
      </div>
    </div>
  );
}
