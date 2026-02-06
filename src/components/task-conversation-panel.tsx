"use client";

import { useMemo } from "react";
import type { LogEntry, Topic } from "@/lib/types";
import { Card, CardHeader, Badge } from "@/components/ui";
import { LogList } from "@/components/log-list";

export function TaskConversationPanel({
  logs,
  topics,
  showRaw,
}: {
  logs: LogEntry[];
  topics: Topic[];
  showRaw: boolean;
}) {
  const summary = useMemo(() => {
    const latest = logs[0];
    if (!latest) return "No updates yet.";
    return latest.summary ?? latest.content ?? "No updates yet.";
  }, [logs]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
      <div className="space-y-4">
        <div className="rounded-[var(--radius-md)] border border-[rgba(255,90,45,0.35)] bg-[rgba(255,90,45,0.08)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Summary</div>
              <div className="mt-1 text-sm text-[rgb(var(--claw-text))]">{summary}</div>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="accent">Latest</Badge>
              <Badge tone="muted">{logs.length} entries</Badge>
            </div>
          </div>
        </div>

        <Card id="log">
          <CardHeader>
            <h2 className="text-lg font-semibold">Task Conversation</h2>
          </CardHeader>
          <LogList
            logs={logs}
            topics={topics}
            showFilters={false}
            showRawToggle={false}
            showRawAll={showRaw}
            allowNotes
            initialVisibleCount={2}
            loadMoreStep={2}
          />
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Curation</h2>
            <Badge tone="muted">Notes only</Badge>
          </CardHeader>
          <div className="space-y-3 text-sm text-[rgb(var(--claw-muted))]">
            <p>Use “Add note” on any entry to curate the conversation for OpenClaw.</p>
            <p>Notes are attached to the specific message and synced as context hints.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
