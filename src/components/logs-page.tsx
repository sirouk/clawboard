"use client";

import { useMemo, useState } from "react";
import { useDataStore } from "@/components/data-provider";
import { Badge, Card, CardHeader } from "@/components/ui";
import { LogList } from "@/components/log-list";

export function LogsPage() {
  const { logs, topics } = useDataStore();
  const [showRawAll, setShowRawAll] = useState(true);

  const sortedLogs = useMemo(() => {
    return [...logs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [logs]);

  const counts = useMemo(() => {
    return sortedLogs.reduce(
      (acc, entry) => {
        const status = entry.classificationStatus ?? "pending";
        acc.total += 1;
        acc[status] = (acc[status] ?? 0) + 1;
        return acc;
      },
      { total: 0, pending: 0, classified: 0, failed: 0 } as Record<string, number>
    );
  }, [sortedLogs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-[rgb(var(--claw-muted))]">Logs</div>
          <h1 className="text-2xl font-semibold text-[rgb(var(--claw-text))]">All Activity</h1>
          <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
            This view includes pending logs before classification, plus classified history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="muted">Total {counts.total}</Badge>
          <Badge tone="warning">Pending {counts.pending}</Badge>
          <Badge tone="success">Classified {counts.classified}</Badge>
          <Badge tone="danger">Failed {counts.failed}</Badge>
        </div>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Log Stream</h2>
          <Badge tone={showRawAll ? "accent" : "muted"}>{showRawAll ? "Raw" : "Filtered"}</Badge>
        </CardHeader>
        <LogList
          logs={sortedLogs}
          topics={topics}
          showFilters
          showRawToggle
          showRawAll={showRawAll}
          onShowRawAllChange={setShowRawAll}
          allowNotes
          initialVisibleCount={50}
          loadMoreStep={50}
        />
      </Card>
    </div>
  );
}
