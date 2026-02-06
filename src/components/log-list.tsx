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

type LaneFilter = "all" | string;
const MESSAGE_TRUNCATE_LIMIT = 220;
const SUMMARY_TRUNCATE_LIMIT = 96;

function normalizeInlineText(value: string | undefined | null) {
  return stripTransportNoise(value ?? "").replace(/\s+/g, " ").trim();
}

function stripTransportNoise(value: string) {
  let text = (value ?? "").replace(/\r\n?/g, "\n").trim();
  text = text.replace(/^\s*summary\s*[:\-]\s*/gim, "");
  text = text.replace(/^\[Discord [^\]]+\]\s*/gim, "");
  text = text.replace(/\[message[_\s-]?id:[^\]]+\]/gi, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function truncateText(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trim()}…`;
}

function deriveMessageSummary(entry: LogEntry, message: string) {
  const explicitSummary = normalizeInlineText(entry.summary);
  if (explicitSummary) {
    return truncateText(explicitSummary, SUMMARY_TRUNCATE_LIMIT);
  }
  const fallback = normalizeInlineText(message || entry.content || "");
  return fallback ? truncateText(fallback, SUMMARY_TRUNCATE_LIMIT) : "No summary";
}

export function LogList({
  logs: initialLogs,
  topics,
  showFilters = true,
  showRawToggle = true,
  showRawAll: showRawAllOverride,
  onShowRawAllChange,
  allowNotes = false,
  enableNavigation = true,
  initialVisibleCount,
  loadMoreStep,
}: {
  logs: LogEntry[];
  topics: Topic[];
  showFilters?: boolean;
  showRawToggle?: boolean;
  showRawAll?: boolean;
  onShowRawAllChange?: (value: boolean) => void;
  allowNotes?: boolean;
  enableNavigation?: boolean;
  initialVisibleCount?: number;
  loadMoreStep?: number;
}) {
  const { token, tokenRequired } = useAppConfig();
  const [logs, setLogs] = useState<LogEntry[]>(initialLogs);
  const [topicFilter, setTopicFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [laneFilter, setLaneFilter] = useState<LaneFilter>("all");
  const [search, setSearch] = useState("");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [localShowRawAll, setLocalShowRawAll] = useState(false);
  const [groupByDay, setGroupByDay] = useState(true);
  const loadMoreEnabled = Boolean(initialVisibleCount && initialVisibleCount > 0 && loadMoreStep && loadMoreStep > 0);
  const [visibleCount, setVisibleCount] = useState(() => (loadMoreEnabled ? initialVisibleCount! : 0));
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
    const label = entry.agentLabel || entry.agentId || "Unknown";
    return label === lane;
  };

  useEffect(() => {
    setLogs(initialLogs);
  }, [initialLogs]);

  useEffect(() => {
    if (!loadMoreEnabled) return;
    setVisibleCount(initialVisibleCount!);
  }, [agentFilter, groupByDay, initialVisibleCount, laneFilter, loadMoreEnabled, search, topicFilter, typeFilter]);

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

  const visibleFiltered = useMemo(() => {
    if (!loadMoreEnabled) return filtered;
    return filtered.slice(0, visibleCount);
  }, [filtered, loadMoreEnabled, visibleCount]);

  const grouped = useMemo(() => {
    if (!groupByDay) return { all: visibleFiltered };
    return visibleFiltered.reduce<Record<string, LogEntry[]>>((acc, entry) => {
      const date = entry.createdAt.slice(0, 10);
      acc[date] = acc[date] ?? [];
      acc[date].push(entry);
      return acc;
    }, {});
  }, [visibleFiltered, groupByDay]);

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

  const agentLabelCounts = useMemo(() => {
    return logs.reduce<Record<string, number>>((acc, entry) => {
      const label = entry.agentLabel || entry.agentId || "Unknown";
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {});
  }, [logs]);

  const agentLabels = useMemo(() => {
    return Object.entries(agentLabelCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label);
  }, [agentLabelCounts]);

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
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search messages" className="min-w-[220px] flex-1" />
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
            <Button variant="secondary" size="sm" onClick={() => setShowAdvancedFilters((prev) => !prev)}>
              {showAdvancedFilters ? "Hide filters" : "More filters"}
            </Button>
          </div>
          {showAdvancedFilters && (
            <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(14,17,22,0.9)] p-3">
              <div className="flex flex-wrap items-center gap-3">
                <Select value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)} className="max-w-[220px]">
                  <option value="all">All topics</option>
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.name}
                    </option>
                  ))}
                </Select>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Agent lanes</span>
                  <Button variant={laneFilter === "all" ? "secondary" : "ghost"} size="sm" onClick={() => setLaneFilter("all")}>
                    All
                  </Button>
                  {agentLabels.map((lane) => (
                    <Button
                      key={lane}
                      variant={laneFilter === lane ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => setLaneFilter(lane)}
                    >
                      {lane}
                    </Button>
                  ))}
                </div>
                {showRawToggle && (
                  <Button variant="secondary" size="sm" onClick={() => setShowRawAll(!showRawAll)}>
                    {showRawAll ? "Hide full messages" : "Show full messages"}
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => setGroupByDay((prev) => !prev)}>
                  {groupByDay ? "Ungrouped" : "Group by day"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {!showFilters && showRawToggle && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowRawAll(!showRawAll)}>
            {showRawAll ? "Hide full messages" : "Show full messages"}
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
        {visibleFiltered.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No log entries yet.</p>}

        {loadMoreEnabled && filtered.length > visibleFiltered.length && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-[rgb(var(--claw-muted))]">
            <span>
              Showing {visibleFiltered.length} of {filtered.length} entries.
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setVisibleCount((prev) => prev + loadMoreStep!)}
            >
              Load {loadMoreStep} more
            </Button>
          </div>
        )}
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
  const showFullMessage = showRawAll || expanded;
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
  const isConversation = entry.type === "conversation";
  const agentLabel = entry.agentLabel || entry.agentId;
  const showAgentBadge = Boolean(agentLabel && agentLabel.trim().toLowerCase() !== typeLabel.trim().toLowerCase());
  const messageSource = stripTransportNoise((entry.content ?? entry.raw ?? entry.summary ?? "").trim());
  const shouldTruncate = !showFullMessage && messageSource.length > MESSAGE_TRUNCATE_LIMIT;
  const messageText = shouldTruncate ? truncateText(messageSource, MESSAGE_TRUNCATE_LIMIT) : messageSource;
  const summaryText = deriveMessageSummary(entry, messageSource);
  const isUser = (entry.agentId || "").toLowerCase() === "user";

  return (
    <div
      data-log-id={entry.id}
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

      {isConversation ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-medium text-[rgb(var(--claw-text))]">{summaryText}</p>
          <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div className={`w-full max-w-[78%] ${isUser ? "text-right" : "text-left"}`}>
              <p className="mb-1 text-[10px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">
                {isUser ? "You" : agentLabel || "Assistant"}
              </p>
            </div>
          </div>
          <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div
              data-testid={`message-bubble-${entry.id}`}
              data-agent-side={isUser ? "right" : "left"}
              className={`max-w-[78%] rounded-[20px] border px-4 py-3 text-sm leading-relaxed ${
                isUser
                  ? "border-[rgba(36,145,255,0.35)] bg-[rgba(36,145,255,0.16)] text-[rgb(var(--claw-text))]"
                  : "border-[rgba(255,255,255,0.12)] bg-[rgba(20,24,31,0.8)] text-[rgb(var(--claw-text))]"
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{messageText || summary || "(empty)"}</p>
              {shouldTruncate && (
                <div className="mt-2">
                  <Button variant="ghost" size="sm" onClick={() => setExpanded(true)} aria-label="Expand message">
                    ...
                  </Button>
                </div>
              )}
              {!showRawAll && expanded && messageSource.length > MESSAGE_TRUNCATE_LIMIT && (
                <div className="mt-2">
                  <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
                    Collapse
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm leading-relaxed text-[rgb(var(--claw-text))]">{summary}</p>
          {entry.raw && (
            <div className="mt-3">
              {!showRawAll && (
                <Button variant="ghost" size="sm" onClick={() => setExpanded((prev) => !prev)}>
                  {expanded ? "Hide full message" : "Show full message"}
                </Button>
              )}
              {showFullMessage && (
                <pre className="mt-2 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-black/40 p-3 text-xs text-[rgb(var(--claw-text))]">
                  {entry.raw}
                </pre>
              )}
            </div>
          )}
        </>
      )}
      {allowNotes && entry.type !== "note" && (
        <div className="mt-3">
          {!noteOpen ? (
            <Button variant="secondary" size="sm" onClick={() => setNoteOpen(true)}>
              Add note
            </Button>
          ) : (
            <div className="space-y-2 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.55)] p-3">
              <textarea
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                placeholder={
                  readOnly
                    ? "Add token in Setup to enable curated notes that steer classification."
                    : "Add a curated note to this conversation..."
                }
                disabled={readOnly}
                readOnly={readOnly}
                className={`min-h-[90px] w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 py-2 text-sm text-[rgb(var(--claw-text))] placeholder:text-[rgb(var(--claw-muted))] focus:border-[rgb(var(--claw-accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(226,86,64,0.2)] ${
                  readOnly ? "cursor-not-allowed opacity-70" : ""
                }`}
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
