"use client";

import { useState } from "react";
import type { LogEntry, Task, Topic } from "@/lib/types";
import { Badge, Button } from "@/components/ui";
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
  const [showRaw, setShowRaw] = useState(true);

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
          <Badge tone={showRaw ? "accent" : "muted"}>{showRaw ? "Full messages" : "Summaries"}</Badge>
          <Button size="sm" variant="secondary" onClick={() => setShowRaw((prev) => !prev)}>
            {showRaw ? "Hide full messages" : "Show full messages"}
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

      <h1 id="overview" className="sr-only">
        {task.title}
      </h1>

      <div id="conversation">
        <TaskConversationPanel logs={logs} topics={topics} showRaw={showRaw} />
      </div>
    </div>
  );
}
