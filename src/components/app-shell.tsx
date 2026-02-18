"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchInput, Select } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { cn } from "@/lib/cn";
import { CommandPalette } from "@/components/command-palette";
import { DataProvider, useDataStore } from "@/components/data-provider";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";
import { formatRelativeTime } from "@/lib/format";
import { useSemanticSearch } from "@/lib/use-semantic-search";
import { buildSpaceVisibilityRevision, resolveSpaceVisibilityFromViewer } from "@/lib/space-visibility";
import { buildTaskUrl, buildTopicUrl, withRevealParam, withSpaceParam } from "@/lib/url";
import { apiFetch, getApiBase } from "@/lib/api";
import type { Space, Task, Topic } from "@/lib/types";

const ICONS: Record<string, React.ReactElement> = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h6M4 12h10M4 18h14" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="20" cy="12" r="2" />
      <circle cx="22" cy="18" r="2" />
    </svg>
  ),
  graph: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="8" cy="17" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M7.8 7.2l8.4 1.6" />
      <path d="M7.3 7.8l-1.4 7.4" />
      <path d="M9.8 17.1l6.4.7" />
      <path d="M16.8 10l1 6" />
    </svg>
  ),
  stats: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19h16" />
      <path d="M7 16V10" />
      <path d="M12 16V6" />
      <path d="M17 16v-4" />
    </svg>
  ),
  setup: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
      <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 0 1-4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 0 1 0-4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V4a2 2 0 0 1 4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6H20a2 2 0 0 1 0 4h-.2a1 1 0 0 0-.9.6z" />
    </svg>
  ),
  log: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 6h14" />
      <path d="M5 12h14" />
      <path d="M5 18h14" />
      <path d="M7 4v4" />
      <path d="M7 10v4" />
      <path d="M7 16v4" />
    </svg>
  ),
  providers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <path d="M16.5 7.5c0-2-2-3-4.5-3s-4.5 1-4.5 3 2 3 4.5 3 4.5 1 4.5 3-2 3-4.5 3-4.5-1-4.5-3" />
      <path d="M4 20l16-16" />
    </svg>
  ),
};

function GripIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={cn("h-4 w-4", className)}>
      <circle cx="7" cy="5" r="1" />
      <circle cx="13" cy="5" r="1" />
      <circle cx="7" cy="10" r="1" />
      <circle cx="13" cy="10" r="1" />
      <circle cx="7" cy="15" r="1" />
      <circle cx="13" cy="15" r="1" />
    </svg>
  );
}

function SpacesIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="6.5" cy="7" r="2.1" />
      <circle cx="17.5" cy="6.5" r="2.1" />
      <circle cx="12" cy="16.8" r="2.1" />
      <path d="M8.5 7.7l6.9-0.7" />
      <path d="M7.7 8.8l3 5.8" />
      <path d="M16.3 8.2l-3 6.3" />
    </svg>
  );
}

function deriveSpaceName(spaceId: string) {
  const normalized = String(spaceId || "").trim();
  if (!normalized || normalized === "space-default") return "Global";
  const base = normalized.replace(/^space[-_]+/i, "");
  const withSpaces = base.replace(/[-_]+/g, " ").trim();
  if (!withSpaces) return normalized;
  return withSpaces
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => {
      const token = String(segment ?? "").trim().toLowerCase();
      if (!token) return "";
      const devSuffix = token.match(/^([a-z]{2})dev$/);
      if (devSuffix) return `${devSuffix[1].toUpperCase()}Dev`;
      if (/^[a-z]{1,2}$/.test(token)) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
}

function friendlyLabelFromSlug(value: string) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "";
  return slug
    .split("-")
    .filter(Boolean)
    .map((segment) => {
      const token = String(segment ?? "").trim().toLowerCase();
      if (!token) return "";
      const devSuffix = token.match(/^([a-z]{2})dev$/);
      if (devSuffix) return `${devSuffix[1].toUpperCase()}Dev`;
      if (/^[a-z]{1,2}$/.test(token)) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
}

function displaySpaceName(space: Pick<Space, "id" | "name">) {
  const id = String(space?.id ?? "").trim();
  const raw = String(space?.name ?? "").trim();
  if (!raw) return deriveSpaceName(id);
  const friendly = friendlyLabelFromSlug(raw);
  return friendly || deriveSpaceName(id);
}

function spaceIdFromTagLabel(value: string) {
  let text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (text.startsWith("system:")) return null;
  if (text.startsWith("space:")) text = text.split(":", 2)[1]?.trim() ?? "";
  const slugged = text
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slugged || slugged === "default" || slugged === "global" || slugged === "all" || slugged === "all-spaces") {
    return null;
  }
  return `space-${slugged}`;
}

function topicSpaceIds(topic: Pick<Topic, "spaceId" | "tags"> | null | undefined) {
  const out = new Set<string>();
  for (const rawTag of topic?.tags ?? []) {
    const fromTag = spaceIdFromTagLabel(String(rawTag ?? ""));
    if (fromTag) out.add(fromTag);
  }
  const primary = String(topic?.spaceId ?? "").trim();
  if (primary && primary !== "space-default") out.add(primary);
  return Array.from(out);
}

const NAV_ITEMS = [
  { href: "/u", label: "Board", id: "home" },
  { href: "/graph", label: "Graph", id: "graph" },
  { href: "/log", label: "Logs", id: "log" },
  { href: "/stats", label: "Stats", id: "stats" },
  { href: "/providers", label: "Providers", id: "providers" },
  { href: "/settings", label: "Settings", id: "setup" },
];

const BOARD_TOPICS_EXPANDED_KEY = "clawboard.board.topics.navExpanded";
const BOARD_SPACES_EXPANDED_KEY = "clawboard.board.spaces.navExpanded";
const BOARD_TOPICS_SEARCH_KEY = "clawboard.board.topics.search";
const BOARD_TOPICS_TASKS_EXPANDED_KEY = "clawboard.board.topics.tasksExpanded";
const HEADER_COMPACT_KEY = "clawboard.header.compact";
const ACTIVE_SPACE_KEY = "clawboard.space.active";
const NAV_SEARCH_TASKS_LIMIT = 5;
const NAV_SEARCH_TOPICS_LIMIT = 5;

function statusIconColor(status: string) {
  switch (status) {
    case "CONNECTED":
      return "text-[rgb(var(--claw-success))] drop-shadow-[0_0_12px_rgba(80,200,120,0.45)]";
    case "AUTH FAIL":
      return "text-[rgb(var(--claw-danger))] drop-shadow-[0_0_10px_rgba(239,68,68,0.35)]";
    case "TOKEN SET":
    case "READ-ONLY":
      return "text-[rgb(var(--claw-warning))] drop-shadow-[0_0_9px_rgba(234,179,8,0.3)]";
    default:
      return "text-[rgb(var(--claw-accent-2))] drop-shadow-[0_0_9px_rgba(77,171,158,0.32)]";
  }
}

function StatusGlyph({ status, className }: { status: string; className?: string }) {
  if (status === "CONNECTED") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M13 2 5 13h6l-1 9 9-11h-6z" />
      </svg>
    );
  }
  if (status === "AUTH FAIL") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <circle cx="12" cy="12" r="8.8" />
        <path d="m9 9 6 6" />
        <path d="m15 9-6 6" />
      </svg>
    );
  }
  if (status === "TOKEN SET") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <circle cx="8.5" cy="12" r="3.5" />
        <path d="M12 12h9" />
        <path d="M18 12v3" />
        <path d="M21 12v2" />
      </svg>
    );
  }
  if (status === "READ-ONLY") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <rect x="4" y="11" width="16" height="10" rx="2.2" />
        <path d="M8 11V8a4 4 0 1 1 8 0v3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 12h5" />
      <path d="M15 12h5" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function TaskNavRow({
  task,
  selected,
  onGo,
}: {
  task: Task;
  selected: boolean;
  onGo: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onGo}
      className={cn(
        // Indent via padding (not margin) so we don't overflow the nav panel width.
        "w-full rounded-[var(--radius-sm)] border px-3 py-2 pl-7 text-left text-xs transition",
        selected
          ? "border-[rgba(77,171,158,0.5)] bg-[rgba(77,171,158,0.16)] text-[rgb(var(--claw-text))]"
          : "border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="truncate">{task.title}</div>
        <div className="shrink-0 text-[10px]">{(task.status ?? "todo").toUpperCase()}</div>
      </div>
    </button>
  );
}

function TopicNavRow({
  topic,
  selected,
  onGo,
  onDoubleClick,
  reorderEnabled,
  dropActive,
  onReorderPointerDown,
}: {
  topic: Topic;
  selected: boolean;
  onGo: () => void;
  onDoubleClick?: () => void;
  reorderEnabled: boolean;
  dropActive: boolean;
  onReorderPointerDown: (topicId: string, event: React.PointerEvent) => void;
}) {
  return (
    <div
      data-board-topic-id={topic.id}
      className={cn(
        "relative overflow-hidden rounded-[var(--radius-sm)] border",
        selected ? "border-[rgba(255,90,45,0.45)]" : "border-[rgb(var(--claw-border))]",
        dropActive ? "border-[rgba(255,90,45,0.45)] bg-[rgba(255,90,45,0.06)]" : ""
      )}
    >
      <button
        type="button"
        onClick={onGo}
        onDoubleClick={onDoubleClick}
        className={cn(
          "flex w-full items-stretch gap-2 bg-transparent px-3 py-2 text-left text-xs",
          selected
            ? "bg-[rgba(255,90,45,0.12)] text-[rgb(var(--claw-text))]"
            : "text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]"
        )}
      >
        {reorderEnabled ? (
          <span
            role="button"
            tabIndex={-1}
            aria-label={`Reorder topic ${topic.name}`}
            title={dropActive ? "Drop to reorder" : "Drag to reorder topics"}
            onPointerDown={(event) => onReorderPointerDown(topic.id, event)}
            onClick={(event) => {
              // Prevent accidental navigation clicks when the user is just grabbing the handle.
              event.preventDefault();
              event.stopPropagation();
            }}
            className={cn(
              "flex w-7 shrink-0 items-center justify-center text-[rgb(var(--claw-muted))]",
              "cursor-grab active:cursor-grabbing",
              dropActive ? "text-[rgb(var(--claw-text))]" : ""
            )}
          >
            <GripIcon />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate font-semibold">{topic.name}</div>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[rgba(148,163,184,0.9)]">
            <div className="truncate">{formatRelativeTime(topic.updatedAt)}</div>
            <div className="shrink-0">{topic.pinned ? "PINNED" : (topic.status ?? "active").toUpperCase()}</div>
          </div>
        </div>
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DataProvider>
      <AppShellLayout>{children}</AppShellLayout>
    </DataProvider>
  );
}

function AppShellLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { spaces: storeSpaces, logs: storeLogs, topics: storeTopics, tasks: storeTasks, setTopics, hydrated } = useDataStore();
  const { instanceTitle, token, tokenRequired, tokenConfigured, remoteReadLocked } = useAppConfig();
  const collapsed = useLocalStorageItem("clawboard.navCollapsed") === "true";
  const boardSpacesExpanded = useLocalStorageItem(BOARD_SPACES_EXPANDED_KEY) !== "false";
  const boardTopicsExpanded = useLocalStorageItem(BOARD_TOPICS_EXPANDED_KEY) === "true";
  const topicPanelSearch = useLocalStorageItem(BOARD_TOPICS_SEARCH_KEY) ?? "";
  const topicTasksExpandedRaw = useLocalStorageItem(BOARD_TOPICS_TASKS_EXPANDED_KEY) ?? "";
  const compactHeader = useLocalStorageItem(HEADER_COMPACT_KEY) === "true";
  const activeSpaceIdStored = (useLocalStorageItem(ACTIVE_SPACE_KEY) ?? "").trim();
  useLocalStorageItem("clawboard.apiBase");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  const topicBackedSpaceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const topic of storeTopics) {
      for (const id of topicSpaceIds(topic)) ids.add(id);
    }
    return ids;
  }, [storeTopics]);

  const mergedSpaces = useMemo(() => {
    const byId = new Map<string, Space>();
    for (const space of storeSpaces) {
      const id = String(space?.id ?? "").trim();
      if (!id) continue;
      if (id === "space-default") continue;
      if (!topicBackedSpaceIds.has(id)) continue;
      byId.set(id, { ...space, name: displaySpaceName(space) });
    }
    for (const topic of storeTopics) {
      for (const id of topicSpaceIds(topic)) {
        if (byId.has(id)) continue;
        byId.set(id, {
          id,
          name: deriveSpaceName(id),
          color: null,
          defaultVisible: true,
          connectivity: {},
          createdAt: "",
          updatedAt: "",
        });
      }
    }
    const out = Array.from(byId.values());
    out.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return out;
  }, [storeSpaces, storeTopics, topicBackedSpaceIds]);

  const selectedSpaceId = useMemo(() => {
    if (!activeSpaceIdStored) return "";
    if (mergedSpaces.some((space) => space.id === activeSpaceIdStored)) return activeSpaceIdStored;
    return "";
  }, [activeSpaceIdStored, mergedSpaces]);
  useEffect(() => {
    if (!hydrated) return;
    if (!activeSpaceIdStored) return;
    if (selectedSpaceId) return;
    setLocalStorageItem(ACTIVE_SPACE_KEY, "");
  }, [activeSpaceIdStored, hydrated, selectedSpaceId]);
  const selectedSpaceName = useMemo(() => {
    if (!selectedSpaceId) return "Global";
    return mergedSpaces.find((space) => space.id === selectedSpaceId)?.name ?? deriveSpaceName(selectedSpaceId);
  }, [mergedSpaces, selectedSpaceId]);
  const selectedSpaceTagLabel = useMemo(() => {
    const normalized = String(selectedSpaceName || "Global")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return (normalized || "Global").toUpperCase();
  }, [selectedSpaceName]);

  const allowedSpaceIds = useMemo(() => {
    if (mergedSpaces.length === 0) return [] as string[];
    if (!selectedSpaceId) return [] as string[];
    const source = mergedSpaces.find((space) => space.id === selectedSpaceId);
    const out = [selectedSpaceId];
    for (const candidate of mergedSpaces) {
      if (candidate.id === selectedSpaceId) continue;
      const enabled = resolveSpaceVisibilityFromViewer(source, candidate);
      if (enabled) out.push(candidate.id);
    }
    return out;
  }, [mergedSpaces, selectedSpaceId]);
  const spaceVisibilityRevision = useMemo(() => buildSpaceVisibilityRevision(mergedSpaces), [mergedSpaces]);

  const allowedSpaceSet = useMemo(() => new Set(allowedSpaceIds), [allowedSpaceIds]);
  const storeTopicById = useMemo(() => new Map(storeTopics.map((topic) => [topic.id, topic])), [storeTopics]);
  const storeTaskById = useMemo(() => new Map(storeTasks.map((task) => [task.id, task])), [storeTasks]);

  const topics = useMemo(() => {
    if (!selectedSpaceId || allowedSpaceSet.size === 0) return storeTopics;
    return storeTopics.filter((topic) => topicSpaceIds(topic).some((spaceId) => allowedSpaceSet.has(spaceId)));
  }, [allowedSpaceSet, selectedSpaceId, storeTopics]);

  const tasks = useMemo(() => {
    if (!selectedSpaceId || allowedSpaceSet.size === 0) return storeTasks;
    return storeTasks.filter((task) => {
      const taskSpace = String(task.spaceId ?? "").trim();
      if (taskSpace) return allowedSpaceSet.has(taskSpace);
      if (task.topicId) {
        const parent = storeTopicById.get(task.topicId);
        if (!parent) return false;
        return topicSpaceIds(parent).some((spaceId) => allowedSpaceSet.has(spaceId));
      }
      return false;
    });
  }, [allowedSpaceSet, selectedSpaceId, storeTasks, storeTopicById]);

  const logs = useMemo(() => {
    if (!selectedSpaceId || allowedSpaceSet.size === 0) return storeLogs;
    return storeLogs.filter((entry) => {
      const directSpace = String(entry.spaceId ?? "").trim();
      if (directSpace) return allowedSpaceSet.has(directSpace);
      if (entry.taskId) {
        const task = storeTaskById.get(entry.taskId);
        if (task) {
          const taskSpace = String(task.spaceId ?? "").trim();
          if (taskSpace) return allowedSpaceSet.has(taskSpace);
          if (task.topicId) {
            const parent = storeTopicById.get(task.topicId);
            if (parent) {
              return topicSpaceIds(parent).some((spaceId) => allowedSpaceSet.has(spaceId));
            }
          }
        }
      }
      if (entry.topicId) {
        const topic = storeTopicById.get(entry.topicId);
        if (topic) {
          return topicSpaceIds(topic).some((spaceId) => allowedSpaceSet.has(spaceId));
        }
      }
      return false;
    });
  }, [allowedSpaceSet, selectedSpaceId, storeLogs, storeTaskById, storeTopicById]);

  const apiBase = getApiBase();
  const isBoardRoute =
    pathname === "/" || pathname === "/dashboard" || pathname === "/u" || pathname.startsWith("/u");
  const showBoardTopics = isBoardRoute && boardTopicsExpanded && !collapsed;

  const hasToken = token.trim().length > 0;
  const readOnly = tokenRequired && !hasToken;
  const status = hasToken
    ? remoteReadLocked
      ? "AUTH FAIL"
      : tokenConfigured
        ? "CONNECTED"
        : "TOKEN SET"
    : remoteReadLocked
      ? "LOCKED"
      : tokenRequired
        ? "READ-ONLY"
        : "OPEN";
  const statusTitle = hasToken
    ? remoteReadLocked
      ? "Token was provided but rejected by API. Paste raw CLAWBOARD_TOKEN value."
      : tokenConfigured
        ? "Token accepted. Read/write access enabled."
        : "Token stored locally, but API server token is not configured."
    : remoteReadLocked
      ? "Non-localhost reads require a token. Add token in Settings."
      : tokenRequired
        ? "Token required for writes."
        : "No token required.";
  const statusIconClass = statusIconColor(status);
  const statusTooltip = statusTitle;
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const docsHref = mounted ? `${apiBase || ""}/docs` : "";
  const iconSize = collapsed ? 32 : 40;

  const toggleCollapsed = () => {
    setLocalStorageItem("clawboard.navCollapsed", collapsed ? "false" : "true");
  };

  const toggleCompactHeader = () => {
    setLocalStorageItem(HEADER_COMPACT_KEY, compactHeader ? "false" : "true");
  };

  useEffect(() => {
    const node = headerRef.current;
    if (!node) return;
    const apply = () => {
      const rect = node.getBoundingClientRect();
      document.documentElement.style.setProperty("--claw-header-h", `${Math.round(rect.height)}px`);
    };
    apply();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => apply());
      ro.observe(node);
    }
    window.addEventListener("resize", apply, { passive: true });
    return () => {
      window.removeEventListener("resize", apply);
      ro?.disconnect();
    };
  }, [compactHeader]);

  const isItemActive = (href: string) => {
    const isUnified = href === "/u";
    return (
      pathname === href ||
      (isUnified && (pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/u")))
    );
  };

  const mobilePrimaryItems = NAV_ITEMS.slice(0, 4);
  const mobileOverflowItems = NAV_ITEMS.slice(4);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  const pageHeader = useMemo(() => {
    const cleanPath = pathname.split("?")[0] ?? "";
    if (cleanPath.startsWith("/u")) {
      return {
        title: "Unified View",
        subtitle: "Topics → tasks → messages in a single, expandable view.",
      };
    }
    if (cleanPath === "/" || cleanPath === "/dashboard") {
      return {
        title: "Dashboard",
        subtitle: "Your live view of what is active, blocked, and recently discussed.",
      };
    }
    if (cleanPath === "/graph") {
      return {
        title: "Clawgraph",
        subtitle: "Topic, task, entity, and agent relationships mapped as an interactive memory graph.",
      };
    }
    if (cleanPath === "/stats") {
      return {
        title: "Stats",
        subtitle: "Coverage and momentum across topics, tasks, and conversations.",
      };
    }
    if (cleanPath === "/providers") {
      return {
        title: "Providers",
        subtitle: "Add new inference providers to your OpenClaw instance with the fastest, safest path.",
      };
    }
    if (cleanPath === "/setup" || cleanPath === "/settings") {
      return {
        title: "Settings",
        subtitle: "Configure your Clawboard instance, integration level, and space visibility.",
      };
    }
    if (cleanPath === "/log") {
      return {
        title: "Logs",
        subtitle: "Conversation, notes, and actions across topics and tasks.",
      };
    }
    if (cleanPath === "/chat" || cleanPath.startsWith("/chat/")) {
      return {
        title: "Chat",
        subtitle: "Direct conversations with OpenClaw.",
      };
    }
    if (cleanPath === "/tasks") {
      return {
        title: "Tasks",
        subtitle: "All tasks across topics.",
      };
    }
    if (cleanPath === "/topics") {
      return {
        title: "Topics",
        subtitle: "All tracked topics.",
      };
    }
    if (cleanPath.startsWith("/tasks/")) {
      const parts = cleanPath.split("/").filter(Boolean);
      const taskId = parts.length >= 2 ? decodeURIComponent(parts[1] ?? "") : "";
      const task = taskId ? tasks.find((row) => row.id === taskId) ?? null : null;
      const topic = task?.topicId ? topics.find((row) => row.id === task.topicId) ?? null : null;
      return {
        title: task?.title?.trim() || "Task",
        subtitle: topic?.name?.trim() || "Unassigned",
      };
    }
    if (cleanPath.startsWith("/topics/")) {
      const parts = cleanPath.split("/").filter(Boolean);
      const topicId = parts.length >= 2 ? decodeURIComponent(parts[1] ?? "") : "";
      const topic = topicId ? topics.find((row) => row.id === topicId) ?? null : null;
      return {
        title: topic?.name?.trim() || "Topic",
        subtitle: "Topic details",
      };
    }
    return { title: "Clawboard", subtitle: "" };
  }, [pathname, tasks, topics]);

  const normalizedTopicSearch = topicPanelSearch.trim().toLowerCase();

  const expandedTopicIds = useMemo((): string[] => {
    const raw = topicTasksExpandedRaw.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((id) => String(id)).filter(Boolean);
      return [];
    } catch {
      return [];
    }
  }, [topicTasksExpandedRaw]);

  const setExpandedTopicIds = useCallback((next: string[]) => {
    setLocalStorageItem(BOARD_TOPICS_TASKS_EXPANDED_KEY, JSON.stringify(next));
  }, []);

  const toggleTopicExpanded = useCallback(
    (topicId: string) => {
      if (!topicId) return;
      const set = new Set(expandedTopicIds);
      if (set.has(topicId)) set.delete(topicId);
      else set.add(topicId);
      setExpandedTopicIds(Array.from(set));
    },
    [expandedTopicIds, setExpandedTopicIds]
  );

  const topicsById = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const topicSemanticRefreshKey = useMemo(() => {
    if (!showBoardTopics || normalizedTopicSearch.length < 1) return "";
    const latestTopic = topics.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    return `${topics.length}:${latestTopic}:${tasks.length}:${spaceVisibilityRevision}`;
  }, [normalizedTopicSearch.length, showBoardTopics, spaceVisibilityRevision, tasks.length, topics]);

  const topicSemanticSearch = useSemanticSearch({
    query: normalizedTopicSearch,
    spaceId: selectedSpaceId || undefined,
    allowedSpaceIds,
    includePending: true,
    limitTopics: 120,
    limitTasks: 80,
    limitLogs: 180,
    enabled: showBoardTopics && normalizedTopicSearch.length > 0,
    refreshKey: topicSemanticRefreshKey,
  });

  const topicSemanticForQuery = useMemo(() => {
    if (!topicSemanticSearch.data) return null;
    const resultQuery = topicSemanticSearch.data.query.trim().toLowerCase();
    if (!resultQuery || resultQuery !== normalizedTopicSearch) return null;
    return topicSemanticSearch.data;
  }, [normalizedTopicSearch, topicSemanticSearch.data]);

  const filteredTopics = useMemo((): Topic[] => {
    const query = normalizedTopicSearch;

	    const base = [...topics].filter((topic) => {
	      if (query || !selectedSpaceId) return true;
	      return topicSpaceIds(topic).includes(selectedSpaceId);
	    });
	    base.sort((a, b) => {
	      const ap = Boolean(a.pinned);
	      const bp = Boolean(b.pinned);
	      if (ap && !bp) return -1;
	      if (!ap && bp) return 1;
	      const as = (a.status ?? "active") === "archived" ? 1 : 0;
	      const bs = (b.status ?? "active") === "archived" ? 1 : 0;
	      if (as !== bs) return as - bs;
	      const ai = typeof a.sortIndex === "number" ? a.sortIndex : 0;
	      const bi = typeof b.sortIndex === "number" ? b.sortIndex : 0;
	      if (ai !== bi) return ai - bi;
	      return b.updatedAt.localeCompare(a.updatedAt);
	    });
      if (!query) {
        // Default nav should focus on active topics; snoozed topics only surface via search.
        return base.filter((topic) => {
          const status = topic.status ?? "active";
          return status !== "archived" && status !== "snoozed";
        });
      }

      if (topicSemanticForQuery) {
        const ranked = (topicSemanticForQuery.topics ?? [])
          .map((match) => topicsById.get(match.id))
          .filter((t): t is Topic => Boolean(t));
        if (ranked.length > 0) return ranked;
      }

      // Fallback: substring match if semantic returned nothing (or isn't available yet).
      const q = query.toLowerCase();
      return base.filter((topic) => {
        const name = (topic.name ?? "").toLowerCase();
        const id = (topic.id ?? "").toLowerCase();
        const description = (topic.description ?? "").toLowerCase();
        const tags = (topic.tags ?? []).join(" ").toLowerCase();
        return name.includes(q) || id.includes(q) || description.includes(q) || tags.includes(q);
      });
	  }, [normalizedTopicSearch, selectedSpaceId, topicSemanticForQuery, topics, topicsById]);

  const filteredTasksForSearch = useMemo((): Task[] => {
    if (!topicSemanticForQuery) return [];
    return (topicSemanticForQuery.tasks ?? [])
      .map((match) => tasksById.get(match.id))
      .filter((t): t is Task => Boolean(t))
      .slice(0, NAV_SEARCH_TASKS_LIMIT);
  }, [tasksById, topicSemanticForQuery]);

  const boardTopicReorderEnabled = showBoardTopics && !readOnly && normalizedTopicSearch.length === 0;

  const visibleTasksByTopicId = useMemo(() => {
    const byTopic = new Map<string, Task[]>();
    if (normalizedTopicSearch.length > 0) return byTopic;

    for (const task of tasks) {
      const topicId = task.topicId;
      if (!topicId) continue;
      if (task.status === "done") continue;
      if (task.snoozedUntil) continue;
      const existing = byTopic.get(topicId);
      if (existing) existing.push(task);
      else byTopic.set(topicId, [task]);
    }

    const rank = (status: Task["status"]) => {
      switch (status) {
        case "doing":
          return 0;
        case "blocked":
          return 1;
        case "todo":
          return 2;
        case "done":
          return 3;
        default:
          return 9;
      }
    };

    for (const [topicId, list] of byTopic.entries()) {
      list.sort((a, b) => {
        const rs = rank(a.status) - rank(b.status);
        if (rs !== 0) return rs;
        return (b.updatedAt || "").localeCompare(a.updatedAt || "");
      });
      byTopic.set(topicId, list.slice(0, 8));
    }

    return byTopic;
  }, [normalizedTopicSearch.length, tasks]);

  const boardTopicsForNav = useMemo(() => {
    if (boardTopicReorderEnabled) return filteredTopics;
    if (normalizedTopicSearch.length > 0) return filteredTopics.slice(0, NAV_SEARCH_TOPICS_LIMIT);
    return filteredTopics.slice(0, 70);
  }, [boardTopicReorderEnabled, filteredTopics, normalizedTopicSearch.length]);

  const [draggingBoardTopicId, setDraggingBoardTopicId] = useState<string | null>(null);
  const [boardTopicDropTargetId, setBoardTopicDropTargetId] = useState<string | null>(null);
  const draggingBoardTopicIdRef = useRef<string | null>(null);
  const boardTopicDropTargetIdRef = useRef<string | null>(null);
  const topicClickTimersRef = useRef<Map<string, number>>(new Map());

  const moveInArray = useCallback(<T,>(items: T[], from: number, to: number) => {
    if (from === to) return items;
    if (from < 0 || to < 0) return items;
    if (from >= items.length || to >= items.length) return items;
    const next = items.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  }, []);

  const orderedTopicIds = useMemo(() => {
    const base = [...topics];
    base.sort((a, b) => {
      const ap = Boolean(a.pinned);
      const bp = Boolean(b.pinned);
      if (ap && !bp) return -1;
      if (!ap && bp) return 1;
      const as = (a.status ?? "active") === "archived" ? 1 : 0;
      const bs = (b.status ?? "active") === "archived" ? 1 : 0;
      if (as !== bs) return as - bs;
      const ai = typeof a.sortIndex === "number" ? a.sortIndex : 0;
      const bi = typeof b.sortIndex === "number" ? b.sortIndex : 0;
      if (ai !== bi) return ai - bi;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return base.map((topic) => topic.id);
  }, [topics]);

  const persistBoardTopicOrder = useCallback(
    async (orderedIds: string[]) => {
      if (readOnly) return;
      const snapshot = topics;
      const indexById = new Map(orderedIds.map((id, idx) => [id, idx]));
      setTopics((prev) =>
        prev.map((topic) => {
          const idx = indexById.get(topic.id);
          if (typeof idx !== "number") return topic;
          if (topic.sortIndex === idx) return topic;
          return { ...topic, sortIndex: idx };
        })
      );
      try {
        const res = await apiFetch(
          "/api/topics/reorder",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderedIds }),
          },
          token
        );
        if (!res.ok) throw new Error(`Failed to reorder topics (${res.status}).`);
      } catch (err) {
        setTopics(snapshot);
        console.error(err);
      }
    },
    [readOnly, setTopics, token, topics]
  );

  const commitBoardTopicReorder = useCallback(
    (draggedId: string, targetId: string) => {
      if (!boardTopicReorderEnabled) return;
      if (!draggedId || !targetId || draggedId === targetId) return;
      const draggedTopic = topicsById.get(draggedId);
      const targetTopic = topicsById.get(targetId);
      if (!draggedTopic || !targetTopic) return;
      if (Boolean(draggedTopic.pinned) !== Boolean(targetTopic.pinned)) return;

      const visibleIds = filteredTopics.map((item) => item.id);
      const from = visibleIds.indexOf(draggedId);
      const to = visibleIds.indexOf(targetId);
      const nextVisible = moveInArray(visibleIds, from, to);
      const visibleSet = new Set(visibleIds);
      let cursor = 0;
      const globalNew = orderedTopicIds.map((id) => (visibleSet.has(id) ? nextVisible[cursor++] : id));

      setDraggingBoardTopicId(null);
      setBoardTopicDropTargetId(null);
      draggingBoardTopicIdRef.current = null;
      boardTopicDropTargetIdRef.current = null;
      void persistBoardTopicOrder(globalNew);
    },
    [
      boardTopicReorderEnabled,
      draggingBoardTopicIdRef,
      boardTopicDropTargetIdRef,
      filteredTopics,
      moveInArray,
      orderedTopicIds,
      persistBoardTopicOrder,
      topicsById,
    ]
  );

  const beginPointerTopicReorder = useCallback(
    (topicId: string, event: React.PointerEvent) => {
      if (!boardTopicReorderEnabled) return;
      event.preventDefault();
      event.stopPropagation();
      const el = event.currentTarget as HTMLElement;
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // ok
      }
      setDraggingBoardTopicId(topicId);
      setBoardTopicDropTargetId(null);
      draggingBoardTopicIdRef.current = topicId;
      boardTopicDropTargetIdRef.current = null;

      const onMove = (moveEvent: PointerEvent) => {
        const dragged = draggingBoardTopicIdRef.current;
        if (!dragged) return;
        const hit = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null;
        const row = hit?.closest?.("[data-board-topic-id]") as HTMLElement | null;
        const targetId = (row?.getAttribute("data-board-topic-id") ?? "").trim();
        if (!targetId || targetId === dragged) return;
        const draggedTopic = topicsById.get(dragged);
        const targetTopic = topicsById.get(targetId);
        if (!draggedTopic || !targetTopic) return;
        if (Boolean(draggedTopic.pinned) !== Boolean(targetTopic.pinned)) return;
        boardTopicDropTargetIdRef.current = targetId;
        setBoardTopicDropTargetId(targetId);
      };

      const finish = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        const dragged = draggingBoardTopicIdRef.current;
        const target = boardTopicDropTargetIdRef.current;
        draggingBoardTopicIdRef.current = null;
        boardTopicDropTargetIdRef.current = null;
        if (dragged && target) commitBoardTopicReorder(dragged, target);
        else {
          setDraggingBoardTopicId(null);
          setBoardTopicDropTargetId(null);
        }
      };

      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [boardTopicReorderEnabled, commitBoardTopicReorder, setBoardTopicDropTargetId, topicsById]
  );

  const activeBoardIds = useMemo(() => {
    if (!pathname.startsWith("/u")) return { topicId: null as string | null, taskId: null as string | null };
    const parts = pathname.split("/").filter(Boolean);
    let topicId: string | null = null;
    let taskId: string | null = null;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] === "topic" && parts[i + 1]) {
        const raw = parts[i + 1] ?? "";
        topicId = raw.includes("--") ? raw.slice(raw.lastIndexOf("--") + 2) : raw;
        i += 1;
      } else if (parts[i] === "task" && parts[i + 1]) {
        const raw = parts[i + 1] ?? "";
        taskId = raw.includes("--") ? raw.slice(raw.lastIndexOf("--") + 2) : raw;
        i += 1;
      }
    }
    return { topicId, taskId };
  }, [pathname]);

  const mostRecentTaskByTopicId = useMemo(() => {
    const activityByTaskId = new Map<string, string>();
    for (const task of tasks) {
      activityByTaskId.set(task.id, task.updatedAt || "");
    }
    for (const entry of logs) {
      const taskId = entry.taskId;
      if (!taskId) continue;
      const ts = entry.createdAt || entry.updatedAt || "";
      if (!ts) continue;
      const prev = activityByTaskId.get(taskId) ?? "";
      if (ts > prev) activityByTaskId.set(taskId, ts);
    }

    const bestByTopic = new Map<string, { task: Task; activity: string }>();
    for (const task of tasks) {
      const topicId = task.topicId;
      if (!topicId) continue;
      const activity = activityByTaskId.get(task.id) ?? (task.updatedAt || "");
      const existing = bestByTopic.get(topicId);
      if (!existing || activity > existing.activity) bestByTopic.set(topicId, { task, activity });
    }

    const out = new Map<string, Task>();
    for (const [topicId, record] of bestByTopic.entries()) out.set(topicId, record.task);
    return out;
  }, [logs, tasks]);

  return (
    <div className="claw-ambient min-h-screen">
        <div className="flex min-h-screen flex-col lg:flex-row">
			          <aside
                    data-claw-shell-nav="1"
			            className={cn(
			              "relative z-[80] border-b border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel))] px-3 py-2.5 lg:z-auto lg:min-h-screen lg:h-screen lg:border-b-0 lg:border-r lg:px-4 lg:py-6 transition-all lg:sticky lg:top-0 lg:self-start lg:flex lg:flex-col lg:overflow-hidden",
			              collapsed ? "lg:w-20" : "lg:w-64"
			            )}
			          >
		            <div className="min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
		              <div className="flex items-center justify-between gap-2.5 lg:block">
		                <div className="flex min-w-0 items-center gap-2.5 lg:mx-auto lg:w-fit lg:justify-center">
		                  <Link href="/u" className="flex items-center justify-center">
			                    <div className={cn("relative transition-all", collapsed ? "h-8 w-8" : "h-8 w-8 lg:h-12 lg:w-12")}>
			                      <Image
			                        src="/clawboard-mark.png"
			                        alt="Clawboard"
		                        width={iconSize}
		                        height={iconSize}
		                        priority
		                        className="h-full w-full object-contain"
		                      />
		                    </div>
		                  </Link>
				                  <div className="min-w-0 lg:hidden">
				                    <div className="truncate text-xs font-semibold text-[rgb(var(--claw-text))]">{pageHeader.title}</div>
				                  </div>
					                </div>
					                <div className="flex items-center gap-2 lg:hidden">
                          <Select
                            value={selectedSpaceId}
                            onChange={(event) => {
                              const next = String(event.target.value || "").trim();
                              setLocalStorageItem(ACTIVE_SPACE_KEY, next);
                            }}
                            className="h-8 min-w-[130px] max-w-[52vw] rounded-full px-2.5 py-0 text-[11px]"
                            aria-label="Active space"
                          >
                            <option value="">Global</option>
                            {mergedSpaces.map((space) => (
                              <option key={`mobile-space-${space.id}`} value={space.id}>
                                {space.name}
                              </option>
                            ))}
                          </Select>
                          <span
                            className="inline-flex h-8 w-8 items-center justify-center"
                            title={statusTooltip}
                            aria-label={statusTitle}
                          >
                            <StatusGlyph status={status} className={cn("h-5 w-5", statusIconClass)} />
                          </span>
				                </div>
				              </div>
	              <nav className="mt-1.5 grid grid-cols-5 gap-1 lg:hidden">
	                {mobilePrimaryItems.map((item) => {
	                  const active = isItemActive(item.href);
	                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileMenuOpen(false)}
	                      className={cn(
	                        "flex h-9 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] px-1 py-1 text-[9px] transition",
	                        active
	                          ? "bg-[linear-gradient(90deg,rgba(255,90,45,0.24),rgba(255,90,45,0.04))] text-[rgb(var(--claw-text))] shadow-[0_0_0_1px_rgba(255,90,45,0.35)]"
	                          : "text-[rgb(var(--claw-muted))]"
                      )}
                      aria-label={item.label}
                      aria-current={active ? "page" : undefined}
                    >
                      <span className="h-3.5 w-3.5 text-current">{ICONS[item.id]}</span>
                      <span className="leading-none">{item.label}</span>
                    </Link>
                  );
                })}
                <div className="relative">
	                  <button
	                    type="button"
	                    onClick={() => setMobileMenuOpen((prev) => !prev)}
	                    className={cn(
	                      "flex h-9 w-full flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] px-1 py-1 text-[9px] transition",
	                      mobileMenuOpen ? "text-[rgb(var(--claw-text))] shadow-[0_0_0_1px_rgba(255,90,45,0.35)]" : "text-[rgb(var(--claw-muted))]"
	                    )}
	                    aria-expanded={mobileMenuOpen}
                    aria-label="More navigation"
                  >
                    <span className="text-sm">⋯</span>
                    <span className="leading-none">More</span>
                  </button>
                  {mobileMenuOpen && (
                    <>
                      <button
	                        type="button"
	                        aria-label="Close more navigation"
	                        onClick={() => setMobileMenuOpen(false)}
	                        className="fixed inset-0 z-[85] bg-transparent"
	                      />
	                      <div className="absolute right-0 top-[108%] z-[90] min-w-[160px] rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel))] p-2 shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
	                        {mobileOverflowItems.map((item) => {
	                          const active = isItemActive(item.href);
	                          return (
                            <Link
                              key={item.href}
                              href={item.href}
                              onClick={() => setMobileMenuOpen(false)}
                              className={cn(
                                "flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-xs transition",
                                active
                                  ? "bg-[rgba(255,90,45,0.15)] text-[rgb(var(--claw-text))]"
                                  : "text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]"
                              )}
                            >
                              <span className="h-4 w-4 text-current">{ICONS[item.id]}</span>
                              <span>{item.label}</span>
                            </Link>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </nav>
              {!collapsed && (
                <div className="mt-4 hidden lg:block space-y-2">
                    <button
                      type="button"
                      onClick={() =>
                        setLocalStorageItem(
                          BOARD_SPACES_EXPANDED_KEY,
                          boardSpacesExpanded ? "false" : "true"
                        )
                      }
                      className={cn(
                        "flex w-full items-center justify-between rounded-full px-4 py-2 text-sm transition",
                        boardSpacesExpanded
                          ? "bg-[linear-gradient(90deg,rgba(255,90,45,0.24),rgba(255,90,45,0.04))] text-[rgb(var(--claw-text))] shadow-[0_0_0_1px_rgba(255,90,45,0.35)]"
                          : "border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]"
                      )}
                      aria-expanded={boardSpacesExpanded}
                      aria-controls="clawboard-nav-spaces"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            "inline-flex h-5 w-5 items-center justify-center rounded-full border bg-[rgba(255,255,255,0.02)]",
                            boardSpacesExpanded
                              ? "border-[rgba(255,159,122,0.48)] text-[rgba(255,198,179,0.98)]"
                              : "border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))]"
                          )}
                        >
                          <SpacesIcon className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-xs uppercase tracking-[0.2em]">{selectedSpaceTagLabel}</span>
                      </span>
                      <span className="text-[10px]">{boardSpacesExpanded ? "▾" : "▸"}</span>
                    </button>
                    {boardSpacesExpanded && (
                      <div
                        id="clawboard-nav-spaces"
                        className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.18)] p-3"
                      >
                        <div className="space-y-1">
                        <button
                          type="button"
                          onClick={() => {
                            setLocalStorageItem(ACTIVE_SPACE_KEY, "");
                            setLocalStorageItem(BOARD_SPACES_EXPANDED_KEY, "false");
                          }}
                          className={cn(
                            "w-full rounded-full px-3 py-2 text-left text-xs transition",
                            !selectedSpaceId
                              ? "bg-[linear-gradient(90deg,rgba(255,90,45,0.24),rgba(255,90,45,0.04))] text-[rgb(var(--claw-text))] shadow-[0_0_0_1px_rgba(255,90,45,0.35)]"
                              : "text-[rgb(var(--claw-muted))] hover:bg-[rgba(255,255,255,0.03)] hover:text-[rgb(var(--claw-text))]"
                          )}
                          title="Show everything across spaces"
                        >
                          <div className="truncate font-semibold">Global</div>
                          <div className="mt-0.5 truncate font-mono text-[10px] text-[rgba(148,163,184,0.8)]">all spaces</div>
                        </button>
                        <div className="space-y-1">
                          {mergedSpaces.map((space) => {
                            const active = space.id === selectedSpaceId;
                            const swatch =
                              typeof space.color === "string" && /^#[0-9a-fA-F]{6}$/.test(space.color)
                                ? space.color
                                : "#4DA39E";
                            return (
                              <button
                                key={space.id}
                                type="button"
                                onClick={() => {
                                  setLocalStorageItem(ACTIVE_SPACE_KEY, space.id);
                                  setLocalStorageItem(BOARD_SPACES_EXPANDED_KEY, "false");
                                }}
                                className={cn(
                                  "w-full rounded-full px-3 py-2 text-left text-xs transition",
                                  active
                                    ? "bg-[linear-gradient(90deg,rgba(255,90,45,0.24),rgba(255,90,45,0.04))] text-[rgb(var(--claw-text))] shadow-[0_0_0_1px_rgba(255,90,45,0.35)]"
                                    : "text-[rgb(var(--claw-muted))] hover:bg-[rgba(255,255,255,0.03)] hover:text-[rgb(var(--claw-text))]"
                                )}
                                title={space.name}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0 flex items-center gap-2">
                                    <span
                                      className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full"
                                      style={{ backgroundColor: swatch }}
                                    />
                                    <div className="truncate font-semibold">{space.name}</div>
                                  </div>
                                  {active ? (
                                    <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-[rgba(255,159,122,0.95)]">
                                      Active
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-1 truncate font-mono text-[10px] text-[rgba(148,163,184,0.8)]">{space.id}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      </div>
                    )}
                </div>
              )}
		              <nav className="mt-6 hidden gap-3 lg:flex lg:flex-col">
		                {NAV_ITEMS.map((item) => {
		                  const active = isItemActive(item.href);
		                  const isBoardItem = item.href === "/u";
		                  const expanded = isBoardItem && showBoardTopics;
	
	                  const navLink = (
	                    <Link
	                      key={item.href}
	                      href={item.href}
		                      onClick={(event) => {
		                        const isToggleItem = isBoardItem;
		                        if (!isToggleItem) return;
		                        if (!active) return;
		                        if (collapsed) return;
		                        event.preventDefault();
		                        if (isBoardItem) {
		                          setLocalStorageItem(BOARD_TOPICS_EXPANDED_KEY, showBoardTopics ? "false" : "true");
		                        }
		                      }}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        "flex items-center rounded-full text-sm transition",
                        collapsed ? "justify-center px-3 py-2" : "justify-between px-4 py-2",
                        active
                          ? "bg-[linear-gradient(90deg,rgba(255,90,45,0.24),rgba(255,90,45,0.04))] text-[rgb(var(--claw-text))] shadow-[0_0_0_1px_rgba(255,90,45,0.35)]"
                          : "text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]"
                      )}
		                      aria-label={item.label}
		                      aria-current={active ? "page" : undefined}
		                      aria-expanded={isBoardItem && active ? expanded : undefined}
		                    >
                      <span className="flex items-center gap-2">
                        <span className="h-4 w-4 text-current">{ICONS[item.id]}</span>
                        {!collapsed && <span>{item.label}</span>}
                      </span>
		                      {!collapsed && isBoardItem && active ? (
		                        <span className="text-xs uppercase tracking-[0.2em]">{expanded ? "▾" : "▸"}</span>
		                      ) : null}
		                    </Link>
		                  );
		
		                  if (!isBoardItem) return navLink;
		
		                  return (
		                    <div key={item.href} className="flex flex-col gap-2">
		                      {navLink}
		                      {expanded && isBoardItem && (
		                        <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.18)] p-3">
	                          <div className="flex items-center gap-2">
	                            <SearchInput
		                              value={topicPanelSearch}
		                              onChange={(e) => {
		                                const next = e.target.value;
		                                setLocalStorageItem(BOARD_TOPICS_SEARCH_KEY, next);
		                              }}
                                  onClear={() => setLocalStorageItem(BOARD_TOPICS_SEARCH_KEY, "")}
	                              placeholder="Search tasks, topics…"
                                  className="flex-1"
	                              inputClassName="h-9 text-xs"
	                            />
	                          </div>
	                          <div className="mt-2 flex items-center justify-between text-[11px] text-[rgb(var(--claw-muted))]">
	                            <span>
	                              {normalizedTopicSearch.length > 0
	                                ? topicSemanticSearch.loading
	                                  ? "Searching…"
	                                  : `${topicSemanticForQuery?.tasks?.length ?? 0} tasks · ${filteredTopics.length} topics`
	                                : `${filteredTopics.length} topics`}
	                            </span>
	                            {normalizedTopicSearch.length > 0 && topicSemanticSearch.error ? <span>Search failed</span> : null}
	                          </div>

	                          {normalizedTopicSearch.length > 0 && filteredTasksForSearch.length > 0 && (
	                            <div className="mt-3 border-t border-[rgb(var(--claw-border))] pt-3">
	                              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[rgb(var(--claw-muted))]">
	                                Tasks
	                              </div>
	                              <div className="space-y-1">
	                                {filteredTasksForSearch.map((task) => {
	                                  const selected = task.id === activeBoardIds.taskId;
	                                  const href = buildTaskUrl(task, topics);
	                                  const taskSpaceId =
	                                    String(task.spaceId ?? "").trim() ||
	                                    String(topicsById.get(String(task.topicId ?? ""))?.spaceId ?? "").trim();
	                                  const destination = withSpaceParam(withRevealParam(href, true), taskSpaceId);
	                                  return (
	                                    <button
	                                      key={task.id}
	                                      type="button"
	                                      onClick={() => {
	                                        // Keep the nav search query intact so users can click multiple results.
	                                        router.push(destination);
	                                      }}
	                                      className={cn(
	                                        "w-full rounded-[var(--radius-sm)] border px-3 py-2 text-left text-xs transition",
	                                        selected
	                                          ? "border-[rgba(77,171,158,0.5)] bg-[rgba(77,171,158,0.16)] text-[rgb(var(--claw-text))]"
	                                          : "border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]"
	                                      )}
	                                    >
	                                      <div className="flex items-center justify-between gap-2">
	                                        <div className="truncate font-semibold">{task.title}</div>
	                                        <div className="shrink-0 text-[10px]">{(task.status ?? "todo").toUpperCase()}</div>
	                                      </div>
	                                      <div className="mt-1 truncate font-mono text-[10px] text-[rgba(148,163,184,0.9)]">{task.id}</div>
	                                    </button>
	                                  );
	                                })}
	                              </div>
	                            </div>
	                          )}
			                          <div className="mt-3 max-h-[52vh] space-y-1 overflow-y-auto overscroll-contain pr-1">
		                            {filteredTopics.length === 0 ? (
		                              <div className="rounded-[var(--radius-sm)] border border-[rgb(var(--claw-border))] px-3 py-2 text-xs text-[rgb(var(--claw-muted))]">
		                                No topics found.
		                              </div>
		                            ) : (
			                              boardTopicsForNav.map((topic) => {
			                                const selected = topic.id === activeBoardIds.topicId;
			                                const href = buildTopicUrl(topic, topics);
			                                const chatHref = href.includes("?") ? `${href}&chat=1` : `${href}?chat=1`;
			                                const chatFocusHref = chatHref.includes("?") ? `${chatHref}&focus=1` : `${chatHref}?focus=1`;
			                                const recentTask = mostRecentTaskByTopicId.get(topic.id) ?? null;
			                                const expanded = normalizedTopicSearch.length === 0 && expandedTopicIds.includes(topic.id);
			                                const visibleTasks = expanded ? (visibleTasksByTopicId.get(topic.id) ?? []) : [];

			                                const go = () => {
			                                  // Search mode: unchanged (single click navigates + reveals).
			                                  if (normalizedTopicSearch.length > 0) {
			                                    router.push(withSpaceParam(withRevealParam(href, true), topic.spaceId));
			                                    return;
			                                  }

			                                  // Non-search mode: single click navigates, double click expands.
			                                  const timers = topicClickTimersRef.current;
			                                  const existing = timers.get(topic.id);
			                                  if (existing) window.clearTimeout(existing);
			                                  const handle = window.setTimeout(() => {
			                                    timers.delete(topic.id);
			                                    void recentTask; // keep computed value available for future UX tweaks
			                                    router.push(chatFocusHref);
			                                  }, 250);
			                                  timers.set(topic.id, handle);
			                                };

			                                const onDoubleClick = () => {
			                                  if (normalizedTopicSearch.length > 0) return;
			                                  const timers = topicClickTimersRef.current;
			                                  const existing = timers.get(topic.id);
			                                  if (existing) window.clearTimeout(existing);
			                                  timers.delete(topic.id);
			                                  toggleTopicExpanded(topic.id);
			                                };
			                                const dropActive = Boolean(draggingBoardTopicId) && boardTopicDropTargetId === topic.id;
			                                return (
			                                  <div key={topic.id} className="space-y-1">
			                                    <TopicNavRow
			                                      topic={topic}
			                                      selected={selected}
			                                      onGo={go}
			                                      onDoubleClick={onDoubleClick}
			                                      reorderEnabled={boardTopicReorderEnabled}
			                                      dropActive={dropActive}
			                                      onReorderPointerDown={beginPointerTopicReorder}
			                                    />
			                                    {expanded && visibleTasks.length > 0 ? (
			                                      <div className="space-y-1">
			                                        {visibleTasks.map((task) => {
			                                          const taskSelected = task.id === activeBoardIds.taskId;
			                                          const taskHref = withRevealParam(buildTaskUrl(task, topics), true);
			                                          return (
			                                            <TaskNavRow
			                                              key={task.id}
			                                              task={task}
			                                              selected={taskSelected}
			                                              onGo={() => router.push(taskHref)}
			                                            />
			                                          );
			                                        })}
			                                      </div>
			                                    ) : null}
			                                  </div>
			                                );
			                              })
			                            )}
				                          </div>
	                        </div>
	                      )}
	                    </div>
	                  );
	                })}
	              </nav>
            </div>
            <div className="mt-auto hidden lg:block space-y-4">
              <button
                className={cn(
                  "flex items-center justify-center rounded-full border border-[rgb(var(--claw-border))] px-3 py-2 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))] transition hover:text-[rgb(var(--claw-text))]",
                  collapsed ? "h-10 w-10" : "w-full"
                )}
                onClick={toggleCollapsed}
                aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
              >
                {collapsed ? "›" : "‹"}
              </button>
              <a
                href={docsHref}
                target="_blank"
                rel="noreferrer"
                className="block text-center text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))] transition hover:text-[rgb(var(--claw-text))]"
              >
                API
              </a>
            </div>
          </aside>

          <div className="flex-1">
            <header
              ref={headerRef}
              className={cn(
                "hidden lg:block border-b border-[rgb(var(--claw-border))] bg-[rgba(0,0,0,0.3)] pl-5 pr-6 backdrop-blur",
                compactHeader ? "py-2" : "py-4"
              )}
            >
              <div className="mr-auto grid w-full max-w-[1280px] grid-cols-[auto_1fr_auto] items-center gap-4">
                <Link href="/u" className={cn("flex items-center gap-3", compactHeader ? "py-1" : "")}>
                  <div
                    aria-hidden="true"
                    className={cn(
                      "grid place-items-center rounded-[var(--radius-sm)] border border-[rgba(255,255,255,0.12)] bg-[rgba(10,12,16,0.35)] text-[rgb(var(--claw-muted))]",
                      compactHeader ? "h-9 w-9 text-sm" : "h-10 w-10 text-base"
                    )}
                  >
                    C
                  </div>
                  <div className={cn(compactHeader ? "sr-only" : "")}>
                    <div className="text-sm uppercase tracking-[0.3em] text-[rgb(var(--claw-muted))]">Clawboard</div>
                    <div className="text-lg font-semibold text-[rgb(var(--claw-text))]">{instanceTitle}</div>
                  </div>
                </Link>
                <div className="min-w-0 px-2 text-center">
                  <h1 className={cn("truncate font-semibold text-[rgb(var(--claw-text))]", compactHeader ? "text-sm" : "text-lg")}>
                    {pageHeader.title}
                  </h1>
                  {!compactHeader && pageHeader.subtitle ? (
                    <div className="mt-1 truncate text-xs text-[rgb(var(--claw-muted))]">{pageHeader.subtitle}</div>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={toggleCompactHeader}
                    className={cn(
                      "lg:hidden grid place-items-center rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(10,12,16,0.25)] text-[rgb(var(--claw-muted))] transition hover:text-[rgb(var(--claw-text))]",
                      compactHeader ? "h-9 w-9" : "h-10 w-10"
                    )}
                    aria-label={compactHeader ? "Expand header" : "Compact header"}
                    title={compactHeader ? "Expand header" : "Compact header"}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                      <path d="M6 8h12" />
                      <path d="M6 12h12" />
                      <path d="M6 16h12" />
                    </svg>
	                  </button>
	                  <div className={cn("hidden items-center gap-3 lg:flex", compactHeader ? "" : "")}>
                        <span
                          className="inline-flex h-9 w-9 items-center justify-center"
                          title={statusTooltip}
                          aria-label={statusTitle}
                        >
                          <StatusGlyph status={status} className={cn("h-6 w-6", statusIconClass)} />
                        </span>
	                  </div>
	                  <div className={cn("lg:hidden", compactHeader ? "" : "hidden")}>
	                    <span
	                      className="inline-flex h-8 w-8 items-center justify-center"
	                      title={statusTooltip}
	                      aria-label={statusTitle}
	                    >
	                        <StatusGlyph status={status} className={cn("h-5 w-5", statusIconClass)} />
	                      </span>
	                  </div>
	                </div>
	              </div>
            </header>
	            <main className="mr-auto w-full max-w-[1280px] px-3 py-3 sm:px-4 sm:py-4 lg:pl-5 lg:pr-6 lg:py-8">{children}</main>
	          </div>
	        </div>
	        <CommandPalette />
	      </div>
	  );
}
