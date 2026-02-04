"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { LogEntry, Topic } from "@/lib/types";
import { Badge, Button, Input, Select } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { buildTaskUrl, buildTopicUrl, UNIFIED_BASE } from "@/lib/url";
import { useAppConfig } from "@/components/providers";
import { apiUrl } from "@/lib/api";

const TYPE_LABELS: Record<string, string> = {
  note: "Note",
  conversation: "Conversation",
  action: "Action",
  system: "System",
  import: "Import",
};

type LaneFilter = "all" | "main" | "coding" | "web" | "social";

export function LogList({
  logs: initialLogs,
  topics,
  showFilters = true,
  showRawToggle = true,
  showRawAll: showRawAllOverride,
  onShowRawAllChange,
  allowNotes = false,
  enableNavigation = true,
}: {
  logs: LogEntry[];
  topics: Topic[];
  showFilters?: boolean;
  showRawToggle?: boolean;
  showRawAll?: boolean;
  onShowRawAllChange?: (value: boolean) => void;
  allowNotes?: boolean;
  enableNavigation?: boolean;
}) {
  const { token, tokenRequired } = useAppConfig();
  const [logs, setLogs] = useState<LogEntry[]>(initialLogs);
  const [topicFilter, setTopicFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [laneFilter, setLaneFilter] = useState<LaneFilter>("all");
  const [search, setSearch] = useState("");
  const [localShowRawAll, setLocalShowRawAll] = useState(false);
  const [groupByDay, setGroupByDay] = useState(true);
  const [collapsedDays, setCollapsedDays] = useState<Record<string, boolean>>(() => {
    if (initialLogs.length === 0) return {};
    const dates = Array.from(new Set(initialLogs.map((entry) => entry.createdAt.slice(0, 10)))).sort((a, b) => b.localeCompare(a));
    if (dates.length === 0) return {};
    const mostRecent = dates[0];
    return dates.reduce<Record<string, boolean>>((acc, date) => {
      acc[date] = date !== mostRecent;
      return acc;
    }, {});
  });

  const showRawAll = typeof showRawAllOverride === "boolean" ? showRawAllOverride : localShowRawAll;
  const setShowRawAll = typeof showRawAllOverride === "boolean" ? onShowRawAllChange ?? (() => undefined) : setLocalShowRawAll;

  const matchesLane = (entry: LogEntry, lane: LaneFilter) => {
    if (lane === "all") return true;
    const label = `${entry.agentLabel ?? ""} ${entry.agentId ?? ""}`.toLowerCase();
    if (lane === "main") {
      return label.includes("openclaw") || label.includes("assistant") || label.includes("main");
    }
    if (lane === "coding") {
      return label.includes("coding");
    }
    if (lane === "web") {
      return label.includes("web");
    }
    if (lane === "social") {
      return label.includes("social") || label.includes("grok");
    }
    return false;
  };

  useEffect(() => {
    setLogs(initialLogs);
  }, [initialLogs]);

  const readOnly = tokenRequired && !token;

  const filtered = useMemo(() => {
    return logs.filter((entry) => {
      if (topicFilter !== "all" && entry.topicId !== topicFilter) return false;
      if (typeFilter !== "all" && entry.type !== typeFilter) return false;
      if (laneFilter !== "all" && !matchesLane(entry, laneFilter)) return false;
      if (agentFilter !== "all") {
        const label = entry.agentLabel || entry.agentId || "";
        if (label !== agentFilter) return false;
      }
      if (search.trim().length > 0) {
        const haystack = `${entry.summary ?? ""} ${entry.content ?? ""} ${entry.raw ?? ""}`.toLowerCase();
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [logs, topicFilter, typeFilter, laneFilter, agentFilter, search]);

  const grouped = useMemo(() => {
    if (!groupByDay) return { all: filtered };
    return filtered.reduce<Record<string, LogEntry[]>>((acc, entry) => {
      const date = entry.createdAt.slice(0, 10);
      acc[date] = acc[date] ?? [];
      acc[date].push(entry);
      return acc;
    }, {});
  }, [filtered, groupByDay]);

  useEffect(() => {
    if (!groupByDay) {
      setCollapsedDays((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
    if (dates.length === 0) return;
    const mostRecent = dates[0];
    setCollapsedDays((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const date of dates) {
        if (Object.prototype.hasOwnProperty.call(prev, date)) {
          next[date] = prev[date];
        } else {
          next[date] = date !== mostRecent;
          changed = true;
        }
      }
      if (Object.keys(prev).length !== dates.length) {
        changed = true;
      } else if (!dates.every((date) => prev[date] === next[date])) {
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [groupByDay, grouped]);

  const topicsMap = useMemo(() => {
    return new Map(topics.map((topic) => [topic.id, topic.name]));
  }, [topics]);

  const agentLabels = Array.from(new Set(logs.map((entry) => entry.agentLabel || entry.agentId).filter(Boolean)));

  const summarize = (value: string) => {
    const clean = value.trim().replace(/\s+/g, " ");
    if (clean.length <= 140) return clean;
    return `${clean.slice(0, 139)}…`;
  };

  const addNote = async (entry: LogEntry, note: string) => {
    if (readOnly) return { ok: false, error: "Read-only mode. Add a token in Setup." };
    const payload = {
      topicId: entry.topicId,
      taskId: entry.taskId ?? null,
      relatedLogId: entry.id,
      type: "note",
      content: note,
      summary: summarize(note),
      agentId: "user",
      agentLabel: "User",
    };

    const res = await fetch(apiUrl("/api/log"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Clawboard-Token": token,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      return { ok: false, error: "Failed to add note." };
    }
    const data = await res.json().catch(() => null);
    if (data?.logs && Array.isArray(data.logs)) {
      setLogs(data.logs);
    } else {
      setLogs((prev) => [{ ...(payload as LogEntry), id: `tmp-${Date.now()}`, createdAt: new Date().toISOString() }, ...prev]);
    }
    return { ok: true };
  };

  return (
    <div className="space-y-4">
      {showFilters && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search log" className="max-w-sm" />
            <Select value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)} className="max-w-[200px]">
              <option value="all">All topics</option>
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.name}
                </option>
              ))}
            </Select>
            <Select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="max-w-[180px]">
              <option value="all">All types</option>
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Select className="max-w-[180px]" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}>
              <option value="all">All agents</option>
              {agentLabels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Agent lanes</span>
            {(["all", "main", "coding", "web", "social"] as LaneFilter[]).map((lane) => (
              <Button
                key={lane}
                variant={laneFilter === lane ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setLaneFilter(lane)}
              >
                {lane === "all" ? "All" : lane.charAt(0).toUpperCase() + lane.slice(1)}
              </Button>
            ))}
            {showRawToggle && (
              <Button variant="secondary" size="sm" onClick={() => setShowRawAll(!showRawAll)}>
                {showRawAll ? "Show summaries" : "Show full prompts"}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setGroupByDay((prev) => !prev)}>
              {groupByDay ? "Ungrouped" : "Group by day"}
            </Button>
          </div>
        </div>
      )}

      {!showFilters && showRawToggle && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowRawAll(!showRawAll)}>
            {showRawAll ? "Show summaries" : "Show full prompts"}
          </Button>
        </div>
      )}

      <div className="space-y-3">
        {Object.entries(grouped).map(([date, entries]) => {
          const collapsed = collapsedDays[date];
          const label = groupByDay
            ? new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
            : "All";
          return (
            <div key={date} className="space-y-3">
              {groupByDay && (
                <div
                  role="button"
                  tabIndex={0}
                  className="flex items-center justify-between rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-4 py-3 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))] cursor-pointer"
                  onClick={() =>
                    setCollapsedDays((prev) => ({
                      ...prev,
                      [date]: !prev[date],
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setCollapsedDays((prev) => ({
                        ...prev,
                        [date]: !prev[date],
                      }));
                    }
                  }}
                  aria-label={collapsed ? "Expand day" : "Collapse day"}
                  title={collapsed ? "Expand" : "Collapse"}
                >
                  <span>{label}</span>
                  <span className="text-[rgb(var(--claw-accent))]">{collapsed ? "▸" : "▾"}</span>
                </div>
              )}
              {!collapsed &&
                entries.map((entry) => (
                <LogRow
                  key={entry.id}
                  entry={entry}
                  topicLabel={topicsMap.get(entry.topicId ?? "") ?? "Off-topic"}
                  topics={topics}
                  showRawAll={showRawAll}
                  allowNotes={allowNotes}
                  onAddNote={addNote}
                  readOnly={readOnly}
                  enableNavigation={enableNavigation}
                />
                ))}
            </div>
          );
        })}
        {filtered.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No log entries yet.</p>}
      </div>
    </div>
  );
}

function LogRow({
  entry,
  topicLabel,
  topics,
  showRawAll,
  allowNotes,
  onAddNote,
  readOnly,
  enableNavigation,
}: {
  entry: LogEntry;
  topicLabel: string;
  topics: Topic[];
  showRawAll: boolean;
  allowNotes: boolean;
  onAddNote: (entry: LogEntry, note: string) => Promise<{ ok: boolean; error?: string }>;
  readOnly: boolean;
  enableNavigation: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteStatus, setNoteStatus] = useState<string | null>(null);
  const showRaw = showRawAll || expanded;
  const summary = entry.summary ?? entry.content;
  const resolvedTopic = entry.topicId ? topics.find((topic) => topic.id === entry.topicId) : null;
  const destination = entry.taskId
    ? buildTaskUrl(
        { id: entry.taskId, title: entry.summary ?? entry.content ?? "task", topicId: entry.topicId ?? null },
        topics,
        resolvedTopic ?? null
      )
    : resolvedTopic
      ? buildTopicUrl(resolvedTopic, topics)
      : UNIFIED_BASE;

  const canNavigate = Boolean(destination) && enableNavigation;

  const handleNavigate = (target: HTMLElement | null) => {
    if (!canNavigate || !destination) return false;
    if (target?.closest("a, button, input, select, textarea, option")) return false;
    return true;
  };

  const typeLabel = TYPE_LABELS[entry.type] ?? entry.type;
  const agentLabel = entry.agentLabel || entry.agentId;
  const showAgentBadge = Boolean(agentLabel && agentLabel.trim().toLowerCase() !== typeLabel.trim().toLowerCase());

  return (
    <div
      className={`rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-4 ${
        canNavigate ? "cursor-pointer transition hover:border-[rgba(255,90,45,0.35)]" : ""
      }`}
      role={canNavigate ? "button" : undefined}
      tabIndex={canNavigate ? 0 : undefined}
      onClick={(event) => {
        if (!handleNavigate(event.target as HTMLElement)) return;
        router.push(destination!);
      }}
      onKeyDown={(event) => {
        if (!canNavigate || !destination) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          router.push(destination);
        }
      }}
      aria-label={canNavigate ? "Open related conversation" : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent2">{typeLabel}</Badge>
          <Badge tone="muted">{topicLabel}</Badge>
          {showAgentBadge && <Badge tone="accent">{agentLabel}</Badge>}
          {entry.relatedLogId && <Badge tone="muted">Curation</Badge>}
        </div>
        <span className="text-xs text-[rgb(var(--claw-muted))]">{formatDateTime(entry.createdAt)}</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-[rgb(var(--claw-text))]">{summary}</p>
      {entry.raw && (
        <div className="mt-3">
          {!showRawAll && (
            <Button variant="ghost" size="sm" onClick={() => setExpanded((prev) => !prev)}>
              {expanded ? "Hide raw" : "Show raw"}
            </Button>
          )}
          {showRaw && (
            <pre className="mt-2 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
              {entry.raw}
            </pre>
          )}
        </div>
      )}
      {allowNotes && entry.type !== "note" && (
        <div className="mt-3">
          {!noteOpen ? (
            <Button variant="ghost" size="sm" onClick={() => setNoteOpen(true)}>
              Add note
            </Button>
          ) : (
            <div className="space-y-2">
              <textarea
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                placeholder="Add a curated note to this conversation..."
                className="min-h-[90px] w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 py-2 text-sm text-[rgb(var(--claw-text))] placeholder:text-[rgb(var(--claw-muted))] focus:border-[rgb(var(--claw-accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(226,86,64,0.2)]"
              />
              {noteStatus && <p className="text-xs text-[rgb(var(--claw-muted))]">{noteStatus}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    if (!noteText.trim()) return;
                    setNoteStatus(null);
                    const result = await onAddNote(entry, noteText.trim());
                    if (!result.ok) {
                      setNoteStatus(result.error ?? "Failed to add note.");
                      return;
                    }
                    setNoteText("");
                    setNoteOpen(false);
                  }}
                  disabled={readOnly}
                >
                  Save note
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setNoteOpen(false)}>
                  Cancel
                </Button>
              </div>
              {readOnly && <p className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add a token in Setup.</p>}
            </div>
          )}
        </div>
      )}
      {(entry.source?.sessionKey || entry.source?.channel) && (
        <div className="mt-3 text-xs text-[rgb(var(--claw-muted))]">
          {entry.source?.channel ? `channel: ${entry.source.channel}` : null}
          {entry.source?.sessionKey ? `${entry.source?.channel ? " · " : ""}session: ${entry.source.sessionKey}` : null}
          {entry.source?.messageId ? ` · msg: ${entry.source.messageId}` : ""}
        </div>
      )}
    </div>
  );
}