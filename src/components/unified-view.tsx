"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { LogEntry, Task, Topic } from "@/lib/types";
import { Button, Input, Select, StatusPill } from "@/components/ui";
import { LogList } from "@/components/log-list";
import { formatRelativeTime } from "@/lib/format";
import { useAppConfig } from "@/components/providers";
import { PinToggle } from "@/components/pin-toggle";
import { TaskPinToggle } from "@/components/task-pin-toggle";
import { decodeSlugId, encodeTaskSlug, encodeTopicSlug, slugify } from "@/lib/slug";
import { cn } from "@/lib/cn";
import { apiFetch } from "@/lib/api";
import { useDataStore } from "@/components/data-provider";
import { useSemanticSearch } from "@/lib/use-semantic-search";
import { BoardChatComposer, type BoardChatComposerHandle } from "@/components/board-chat-composer";
import { BOARD_TASK_SESSION_PREFIX, BOARD_TOPIC_SESSION_PREFIX, taskSessionKey, topicSessionKey } from "@/lib/board-session";
import { Markdown } from "@/components/markdown";
import { AttachmentStrip, type AttachmentLike } from "@/components/attachments";
import { queueDraftUpsert, readBestDraftValue, usePersistentDraft } from "@/lib/drafts";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";

const STATUS_TONE: Record<string, "muted" | "accent" | "accent2" | "warning" | "success"> = {
  todo: "muted",
  doing: "accent",
  blocked: "warning",
  done: "success",
};

const STATUS_LABELS: Record<string, string> = {
  todo: "To Do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

const TASK_STATUS_FILTERS = ["all", "todo", "doing", "blocked", "done"] as const;
type TaskStatusFilter = (typeof TASK_STATUS_FILTERS)[number];

const isTaskStatusFilter = (value: string): value is TaskStatusFilter =>
  TASK_STATUS_FILTERS.includes(value as TaskStatusFilter);

function GripIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <circle cx="7" cy="5" r="1" />
      <circle cx="13" cy="5" r="1" />
      <circle cx="7" cy="10" r="1" />
      <circle cx="13" cy="10" r="1" />
      <circle cx="7" cy="15" r="1" />
      <circle cx="13" cy="15" r="1" />
    </svg>
  );
}

function TypingDots({ className, dotClassName }: { className?: string; dotClassName?: string }) {
  const baseDot = cn("h-1.5 w-1.5 rounded-full", dotClassName ?? "bg-[rgba(148,163,184,0.9)]");
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className={cn(baseDot, "animate-pulse")} />
      <span className={cn(baseDot, "animate-pulse [animation-delay:120ms]")} />
      <span className={cn(baseDot, "animate-pulse [animation-delay:240ms]")} />
    </span>
  );
}

const TASK_TIMELINE_LIMIT = 2;
const TOPIC_TIMELINE_LIMIT = 4;
type MessageDensity = "comfortable" | "compact";
const TOPIC_FALLBACK_COLORS = ["#FF8A4A", "#4DA39E", "#6FA8FF", "#E0B35A", "#8BC17E", "#F17C8E"];
const TASK_FALLBACK_COLORS = ["#4EA1FF", "#59C3A6", "#F4B55F", "#9A8BFF", "#F0897C", "#6FB8D8"];
const chatKeyForTopic = (topicId: string) => `topic:${topicId}`;
const chatKeyForTask = (taskId: string) => `task:${taskId}`;

const TOPIC_ACTION_REVEAL_PX = 248;
// New Topics/Tasks should float to the very top immediately after creation.
// Keep that priority for a long window so "something else happening" displaces it,
// instead of the item unexpectedly dropping due to time passing mid-session.
const NEW_ITEM_BUMP_MS = 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function parseTags(text: string) {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 32);
}

function formatTags(tags: string[] | undefined | null) {
  const list = (tags ?? []).map((t) => String(t || "").trim()).filter(Boolean);
  return list.join(", ");
}

const CHAT_HEADER_BLURB_LIMIT = 56;

function stripTransportNoise(value: string) {
  let text = (value ?? "").replace(/\r\n?/g, "\n").trim();
  text = text.replace(/^\s*summary\s*[:\-]\s*/gim, "");
  text = text.replace(/^\[Discord [^\]]+\]\s*/gim, "");
  text = text.replace(/\[message[_\s-]?id:[^\]]+\]/gi, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function normalizeInlineText(value: string | undefined | null) {
  return stripTransportNoise(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3).trim()}...`;
}

function deriveChatHeaderBlurb(entries: LogEntry[]) {
  const pickText = (entry: LogEntry) => {
    if (entry.type === "conversation") {
      return normalizeInlineText(entry.summary) || normalizeInlineText(entry.content) || normalizeInlineText(entry.raw);
    }
    return normalizeInlineText(entry.summary) || normalizeInlineText(entry.content) || normalizeInlineText(entry.raw);
  };

  const pick = (predicate: (entry: LogEntry) => boolean) => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!predicate(entry)) continue;
      const full = pickText(entry);
      if (!full) continue;
      return { full, clipped: truncateText(full, CHAT_HEADER_BLURB_LIMIT) };
    }
    return null;
  };

  const isUser = (entry: LogEntry) => (entry.agentId ?? "").trim().toLowerCase() === "user";
  const status = (entry: LogEntry) => (entry.classificationStatus ?? "pending");

  return (
    // Prefer stable classifier summaries first...
    pick((entry) => entry.type === "conversation" && status(entry) === "classified" && isUser(entry)) ??
    pick((entry) => entry.type === "conversation" && status(entry) === "classified") ??
    // ...but fall back to pending chat so newly-sent messages still surface instantly.
    pick((entry) => entry.type === "conversation" && status(entry) !== "failed" && isUser(entry)) ??
    pick((entry) => entry.type === "conversation" && status(entry) !== "failed") ??
    pick((entry) => entry.type === "note") ??
    null
  );
}

function SwipeRevealRow({
  rowId,
  openId,
  setOpenId,
  actions,
  children,
}: {
  rowId: string;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const isOpen = openId === rowId;
  const gesture = useRef<{ startX: number; startY: number; startOffset: number; pointerType: string } | null>(
    null,
  );
  const [swiping, setSwiping] = useState(false);
  // Keep swipe state in a ref so pointer events remain correct even if React state
  // hasn't re-rendered between pointermove and pointerup (fast swipes, test dispatch).
  const swipingRef = useRef(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragOffsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const pendingOffsetRef = useRef(0);
  const wheelEndTimerRef = useRef<number | null>(null);
  const wheelWasOpenRef = useRef(false);

  const effectiveOffset = swiping ? dragOffset : isOpen ? TOPIC_ACTION_REVEAL_PX : 0;
  const actionsOpacity = clamp(effectiveOffset / TOPIC_ACTION_REVEAL_PX, 0, 1);
  const showActions = actionsOpacity > 0.01;

  const scheduleOffset = (next: number) => {
    dragOffsetRef.current = next;
    pendingOffsetRef.current = next;
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      setDragOffset(pendingOffsetRef.current);
    });
  };

  const settleSwipe = useCallback(() => {
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // Favor easier "swipe back to close" when the row started open (mobile and trackpad).
    const threshold = wheelWasOpenRef.current ? TOPIC_ACTION_REVEAL_PX * 0.85 : TOPIC_ACTION_REVEAL_PX * 0.35;
    const shouldOpen = dragOffsetRef.current > threshold;
    setOpenId(shouldOpen ? rowId : null);
    setDragOffset(0);
    dragOffsetRef.current = 0;
    pendingOffsetRef.current = 0;
    setSwiping(false);
    swipingRef.current = false;
  }, [rowId, setOpenId]);

  return (
    <div className="relative overflow-hidden rounded-[var(--radius-lg)]">
      {showActions ? (
        <div
          className="absolute inset-0 flex items-stretch justify-end gap-1 bg-[rgba(10,12,16,0.18)] p-2 transition-opacity"
          style={{ opacity: actionsOpacity }}
        >
          {actions}
        </div>
      ) : null}
      <div
        onClickCapture={(event) => {
          if (swiping || effectiveOffset > 8) {
            event.preventDefault();
            event.stopPropagation();
          }
          if (isOpen && !swiping) {
            // Gmail-style: a tap closes the actions, but does not trigger the underlying click handler.
            setOpenId(null);
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onWheel={(event) => {
          // Enable swipe-to-reveal on trackpads via horizontal wheel deltas.
          // Gate on pixel-based deltas so mouse wheels (line/page deltas) don't accidentally open rows.
          if (event.deltaMode !== 0) return;

          const target = event.target as HTMLElement | null;
          if (target?.closest("button, a, input, textarea, select, [data-no-swipe='true']")) return;
          const dx = event.deltaX;
          const dy = event.deltaY;
          if (Math.abs(dx) < 10) return;
          if (Math.abs(dx) < Math.abs(dy) * 1.35) return;
          event.preventDefault();
          event.stopPropagation();

          // deltaX > 0 corresponds to a leftward finger swipe on macOS trackpads in most cases.
          const current = swipingRef.current ? dragOffsetRef.current : isOpen ? TOPIC_ACTION_REVEAL_PX : 0;
          const next = clamp(current + dx, 0, TOPIC_ACTION_REVEAL_PX);
          if (!swipingRef.current) {
            wheelWasOpenRef.current = isOpen;
            swipingRef.current = true;
            setSwiping(true);
            if (openId !== rowId) setOpenId(rowId);
          }
          scheduleOffset(next);

          if (wheelEndTimerRef.current != null) window.clearTimeout(wheelEndTimerRef.current);
          wheelEndTimerRef.current = window.setTimeout(() => {
            wheelEndTimerRef.current = null;
            settleSwipe();
          }, 120);
        }}
        onPointerDown={(event) => {
          if ("button" in event && event.button !== 0) return;
          const target = event.target as HTMLElement | null;
          if (target?.closest("button, a, input, textarea, select, [data-no-swipe='true']")) return;
          // Desktop clicks should never feel like swipes. For mouse pointers we only
          // support swipe actions via horizontal trackpad scroll (wheel deltaX).
          if (event.pointerType === "mouse") return;
          // Prevent nested SwipeRevealRow parents from starting a competing gesture.
          event.stopPropagation();
          setSwiping(false);
          swipingRef.current = false;
          gesture.current = {
            startX: event.clientX,
            startY: event.clientY,
            startOffset: isOpen ? TOPIC_ACTION_REVEAL_PX : 0,
            pointerType: event.pointerType,
          };
          try {
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          } catch {
            // ok
          }
        }}
        onPointerMove={(event) => {
          const g = gesture.current;
          if (!g) return;
          if (g.pointerType === "mouse") return;
          const dx = event.clientX - g.startX;
          const dy = event.clientY - g.startY;
          if (!swipingRef.current) {
            if (Math.abs(dx) < 12) return;
            if (Math.abs(dx) < Math.abs(dy) * 1.25) return;
            swipingRef.current = true;
            setSwiping(true);
            if (openId !== rowId) setOpenId(rowId);
          }
          event.preventDefault();
          event.stopPropagation();
          const next = clamp(g.startOffset - dx, 0, TOPIC_ACTION_REVEAL_PX);
          scheduleOffset(next);
        }}
        onPointerUp={(event) => {
          const g = gesture.current;
          gesture.current = null;
          const wasSwiping = swipingRef.current;
          swipingRef.current = false;
          try {
            (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
          } catch {
            // ok
          }
          if (rafRef.current != null) {
            window.cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          if (!g) return;
          if (!wasSwiping) return;
          // If actions were already open, require only a small swipe-back to close them.
          const threshold = g.startOffset > 0 ? TOPIC_ACTION_REVEAL_PX * 0.9 : TOPIC_ACTION_REVEAL_PX * 0.35;
          const shouldOpen = dragOffsetRef.current > threshold;
          setOpenId(shouldOpen ? rowId : null);
          setDragOffset(0);
          dragOffsetRef.current = 0;
          pendingOffsetRef.current = 0;
          setSwiping(false);
        }}
        onPointerCancel={() => {
          gesture.current = null;
          swipingRef.current = false;
          if (rafRef.current != null) {
            window.cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          if (wheelEndTimerRef.current != null) {
            window.clearTimeout(wheelEndTimerRef.current);
            wheelEndTimerRef.current = null;
          }
          setDragOffset(0);
          dragOffsetRef.current = 0;
          pendingOffsetRef.current = 0;
          setSwiping(false);
        }}
        className={cn(
          "relative will-change-transform",
          swiping ? "" : "transition-transform duration-200 ease-out"
        )}
        style={{ transform: `translate3d(-${effectiveOffset}px,0,0)`, touchAction: "pan-y" }}
      >
        {children}
      </div>
    </div>
  );
}

function normalizeHexColor(value: string | undefined | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

function hexToRgb(hex: string) {
  const normalized = normalizeHexColor(hex) ?? "#4EA1FF";
  const raw = normalized.slice(1);
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function rgba(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function colorFromSeed(seed: string, palette: string[]) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % palette.length;
  return palette[index];
}

function pickAlternatingColor(base: string, previous: string | null, index: number, palette: string[]) {
  const normalized = normalizeHexColor(base) ?? palette[index % palette.length];
  if (!previous || normalized !== previous) return normalized;
  const start = palette.indexOf(normalized);
  const nextIndex = start >= 0 ? (start + 1) % palette.length : (index + 1) % palette.length;
  return palette[nextIndex];
}

function topicGlowStyle(color: string, index: number, expanded: boolean): CSSProperties {
  const band = index % 2 === 0;
  const topAlpha = expanded ? (band ? 0.25 : 0.19) : band ? 0.18 : 0.14;
  const lowAlpha = expanded ? (band ? 0.13 : 0.09) : band ? 0.09 : 0.07;
  return {
    background: `linear-gradient(155deg, ${rgba(color, topAlpha)}, rgba(16,19,24,0.90) 48%, ${rgba(color, lowAlpha)})`,
    boxShadow: `0 0 0 1px ${rgba(color, expanded ? 0.28 : 0.2)}, 0 14px 34px ${rgba(color, expanded ? 0.15 : 0.1)}`,
  };
}

function taskGlowStyle(color: string, index: number, expanded: boolean): CSSProperties {
  const band = index % 2 === 0;
  const topAlpha = expanded ? (band ? 0.27 : 0.2) : band ? 0.19 : 0.15;
  const lowAlpha = expanded ? (band ? 0.14 : 0.1) : band ? 0.1 : 0.08;
  return {
    background: `linear-gradient(145deg, ${rgba(color, topAlpha)}, rgba(20,24,31,0.86) 52%, ${rgba(color, lowAlpha)})`,
    boxShadow: `0 0 0 1px ${rgba(color, expanded ? 0.3 : 0.2)}, 0 10px 26px ${rgba(color, expanded ? 0.17 : 0.1)}`,
  };
}

type UrlState = {
  search: string;
  raw: boolean;
  density: MessageDensity;
  done: boolean;
  status: string;
  page: number;
  topics: string[];
  tasks: string[];
};

function getInitialUrlState(basePath: string): UrlState {
  if (typeof window === "undefined") {
    return { search: "", raw: false, density: "compact", done: false, status: "all", page: 1, topics: [], tasks: [] };
  }
  const url = new URL(window.location.href);
  const params = url.searchParams;
  const segments = url.pathname.startsWith(basePath)
    ? url.pathname.slice(basePath.length).split("/").filter(Boolean)
    : [];
  const parsedTopics: string[] = [];
  const parsedTasks: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const key = segments[i];
    const value = segments[i + 1];
    if (!value) continue;
    if (key === "topic") {
      parsedTopics.push(decodeSlugId(value));
      i += 1;
    } else if (key === "task") {
      parsedTasks.push(decodeSlugId(value));
      i += 1;
    }
  }
  let nextTopics = parsedTopics;
  let nextTasks = parsedTasks;
  if (nextTopics.length === 0) {
    nextTopics = params.getAll("topic").map((value) => decodeSlugId(value)).filter(Boolean);
  }
  if (nextTasks.length === 0) {
    nextTasks = params.getAll("task").map((value) => decodeSlugId(value)).filter(Boolean);
  }
  if (nextTopics.length === 0) {
    const legacyTopics = params.get("topics")?.split(",").filter(Boolean) ?? [];
    nextTopics = legacyTopics.map((value) => decodeSlugId(value)).filter(Boolean);
  }
  if (nextTasks.length === 0) {
    const legacyTasks = params.get("tasks")?.split(",").filter(Boolean) ?? [];
    nextTasks = legacyTasks.map((value) => decodeSlugId(value)).filter(Boolean);
  }
  const densityParam = (params.get("density") ?? "").trim().toLowerCase();
  const density: MessageDensity = densityParam === "comfortable" ? "comfortable" : "compact";
  return {
    search: params.get("q") ?? "",
    raw: params.get("raw") === "1",
    density,
    done: params.get("done") === "1",
    status: params.get("status") ?? "all",
    page: Math.max(1, Number(params.get("page") ?? 1)),
    topics: nextTopics,
    tasks: nextTasks,
  };
}

export function UnifiedView({ basePath = "/u" }: { basePath?: string } = {}) {
  const { token, tokenRequired } = useAppConfig();
  const { topics, tasks, logs, drafts, openclawTyping, hydrated, setTopics, setTasks, setLogs } = useDataStore();
  const readOnly = tokenRequired && !token;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const scrollMemory = useRef<Record<string, number>>({});
  const restoreScrollOnNextSyncRef = useRef(false);
  const [initialUrlState] = useState(() => getInitialUrlState(basePath));
  const twoColumn = useLocalStorageItem("clawboard.unified.twoColumn") === "true";
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set(initialUrlState.topics));
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set(initialUrlState.tasks));
  // Topic chat should feel "always there"; default to expanded for any expanded topic.
  const [expandedTopicChats, setExpandedTopicChats] = useState<Set<string>>(new Set(initialUrlState.topics));
  const [showRaw, setShowRaw] = useState(initialUrlState.raw);
  const [messageDensity, setMessageDensity] = useState<MessageDensity>(initialUrlState.density);
  const [search, setSearch] = useState(initialUrlState.search);
  const [showDone, setShowDone] = useState(initialUrlState.done);
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>(
    isTaskStatusFilter(initialUrlState.status) ? initialUrlState.status : "all"
  );
  const [showViewOptions, setShowViewOptions] = useState(false);
  const toggleTwoColumn = () => {
    setLocalStorageItem("clawboard.unified.twoColumn", twoColumn ? "false" : "true");
  };
  // Per-chat "oldest visible index" into that chat's log list.
  // Keyed by chat scroller keys (e.g. `topic:${topicId}`, `task:${taskId}`).
  const [chatHistoryStarts, setChatHistoryStarts] = useState<Record<string, number>>({});
  // Local "OpenClaw is responding" signal so the UI doesn't depend entirely on the gateway
  // returning a long-lived request for typing events.
  const [awaitingAssistant, setAwaitingAssistant] = useState<Record<string, { sentAt: string; requestId?: string }>>(
    {}
  );
  const [moveTaskId, setMoveTaskId] = useState<string | null>(null);
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [topicNameDraft, setTopicNameDraft] = useState("");
  const [topicColorDraft, setTopicColorDraft] = useState("#FF8A4A");
  const [topicTagsDraft, setTopicTagsDraft] = useState("");
  const [newTopicDraftOpen, setNewTopicDraftOpen] = useState(false);
  const { value: newTopicNameDraft, setValue: setNewTopicNameDraft } = usePersistentDraft("draft:new-topic:name", {
    fallback: "",
  });
  const { value: newTopicColorDraft, setValue: setNewTopicColorDraft } = usePersistentDraft("draft:new-topic:color", {
    fallback: TOPIC_FALLBACK_COLORS[0],
  });
  const { value: newTopicTagsDraft, setValue: setNewTopicTagsDraft } = usePersistentDraft("draft:new-topic:tags", {
    fallback: "",
  });
  const [newTopicError, setNewTopicError] = useState<string | null>(null);
  const [newTopicSaving, setNewTopicSaving] = useState(false);
  const [taskNameDraft, setTaskNameDraft] = useState("");
  const [taskColorDraft, setTaskColorDraft] = useState("#4EA1FF");
  const [taskTagsDraft, setTaskTagsDraft] = useState("");
  const [renameSavingKey, setRenameSavingKey] = useState<string | null>(null);
  const [deleteArmedKey, setDeleteArmedKey] = useState<string | null>(null);
  const [deleteInFlightKey, setDeleteInFlightKey] = useState<string | null>(null);
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});
  const [page, setPage] = useState(initialUrlState.page);
  const [isSticky, setIsSticky] = useState(false);
  const committedSearch = useRef(initialUrlState.search);
  const [topicBumpAt, setTopicBumpAt] = useState<Record<string, number>>({});
  const [taskBumpAt, setTaskBumpAt] = useState<Record<string, number>>({});
  const bumpTimers = useRef<Map<string, number>>(new Map());
  const [activeComposer, setActiveComposer] = useState<
    | { kind: "topic"; topicId: string }
    | { kind: "task"; topicId: string; taskId: string }
    | null
  >(null);
  const [autoFocusTask, setAutoFocusTask] = useState<{ topicId: string; taskId: string } | null>(null);
  const [autoFocusTopicId, setAutoFocusTopicId] = useState<string | null>(null);
  const prevTaskByLogId = useRef<Map<string, string | null>>(new Map());
  const activeChatKeyRef = useRef<string | null>(null);
  const activeChatAtBottomRef = useRef(true);
  const chatLastSeenRef = useRef<Map<string, string>>(new Map());
  const chatScrollers = useRef<Map<string, HTMLElement>>(new Map());
  const chatAtBottomRef = useRef<Map<string, boolean>>(new Map());
  const chatLoadOlderCooldownRef = useRef<Map<string, number>>(new Map());
  const typingAliasRef = useRef<Map<string, { sourceSessionKey: string; createdAt: number }>>(new Map());
  const [pendingMessages, setPendingMessages] = useState<
    Array<{
      localId: string;
      requestId?: string;
      sessionKey: string;
      message: string;
      attachments?: AttachmentLike[];
      createdAt: string;
      status: "sending" | "sent" | "failed";
      error?: string;
    }>
  >([]);
  const composerHandlesRef = useRef<Map<string, BoardChatComposerHandle>>(new Map());
  const prevPendingAttachmentsRef = useRef<Map<string, AttachmentLike[]>>(new Map());
  const [chatTopFade, setChatTopFade] = useState<Record<string, boolean>>({});
  const [chatBottomFade, setChatBottomFade] = useState<Record<string, boolean>>({});

  const CHAT_AUTO_SCROLL_THRESHOLD_PX = 160;
  const topicAutosaveTimerRef = useRef<number | null>(null);
  const taskAutosaveTimerRef = useRef<number | null>(null);
  const skipTopicAutosaveRef = useRef(false);
  const skipTaskAutosaveRef = useRef(false);
  const recentBoardSendAtRef = useRef<Map<string, number>>(new Map());

  const scheduleScrollChatToBottom = useCallback(
    (key: string, attempts = 8) => {
      if (typeof window === "undefined") return;
      const trimmed = (key ?? "").trim();
      if (!trimmed) return;
      let remaining = Math.max(1, attempts);
      const tick = () => {
        remaining -= 1;
        const scroller = chatScrollers.current.get(trimmed);
        if (scroller) {
          scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
          activeChatAtBottomRef.current = true;
          chatAtBottomRef.current.set(trimmed, true);
          return;
        }
        if (remaining <= 0) return;
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    },
    []
  );

  const computeChatStart = (state: Record<string, number>, key: string, len: number, initialLimit: number) => {
    const maxStart = Math.max(0, len - 1);
    const has = Object.prototype.hasOwnProperty.call(state, key);
    const raw = has ? Number(state[key]) : len - initialLimit;
    const value = Number.isFinite(raw) ? Math.floor(raw) : 0;
    return clamp(value, 0, maxStart);
  };

  const loadOlderChat = useCallback(
    (chatKey: string, step: number, len: number, initialLimit: number) => {
      if (typeof window === "undefined") return;
      const key = (chatKey ?? "").trim();
      if (!key) return;
      const scroller = chatScrollers.current.get(key) ?? null;
      const beforeTop = scroller?.scrollTop ?? 0;
      const beforeHeight = scroller?.scrollHeight ?? 0;

      setChatHistoryStarts((prev) => {
        const current = computeChatStart(prev, key, len, initialLimit);
        const nextStart = Math.max(0, current - Math.max(1, Math.floor(step)));
        if (nextStart >= current) return prev;
        return { ...prev, [key]: nextStart };
      });

      if (!scroller) return;
      window.requestAnimationFrame(() => {
        const node = chatScrollers.current.get(key);
        if (!node) return;
        const afterHeight = node.scrollHeight;
        const delta = afterHeight - beforeHeight;
        node.scrollTop = beforeTop + delta;
      });
    },
    [setChatHistoryStarts]
  );

  const isSessionResponding = useCallback(
    (sessionKey: string) => {
      const key = String(sessionKey ?? "").trim();
      if (!key) return false;
      if (openclawTyping[key]?.typing) return true;
      if (Object.prototype.hasOwnProperty.call(awaitingAssistant, key)) return true;
      const alias = typingAliasRef.current.get(key);
      if (!alias) return false;
      if (Date.now() - alias.createdAt > 30 * 60 * 1000) {
        typingAliasRef.current.delete(key);
        return false;
      }
      const sourceKey = alias.sourceSessionKey;
      if (openclawTyping[sourceKey]?.typing) return true;
      return Object.prototype.hasOwnProperty.call(awaitingAssistant, sourceKey);
    },
    [awaitingAssistant, openclawTyping]
  );

  const prevExpandedTaskIdsRef = useRef<Set<string>>(new Set());
  const prevExpandedTopicChatIdsRef = useRef<Set<string>>(new Set());

  const [draggingTopicId, setDraggingTopicId] = useState<string | null>(null);
  const [topicDropTargetId, setTopicDropTargetId] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [draggingTaskTopicId, setDraggingTaskTopicId] = useState<string | null>(null);
  const [taskDropTargetId, setTaskDropTargetId] = useState<string | null>(null);
  const [topicSwipeOpenId, setTopicSwipeOpenId] = useState<string | null>(null);
  const [taskSwipeOpenId, setTaskSwipeOpenId] = useState<string | null>(null);
  const [newTaskDraftByTopicId, setNewTaskDraftByTopicId] = useState<Record<string, string>>({});
  const newTaskDraftEditedAtRef = useRef<Map<string, number>>(new Map());
  const [newTaskSavingKey, setNewTaskSavingKey] = useState<string | null>(null);
  const topicPointerReorder = useRef<{
    pointerId: number;
    draggedId: string;
    pinned: boolean;
    orderedIds: string[];
  } | null>(null);
  const taskPointerReorder = useRef<{
    pointerId: number;
    draggedId: string;
    pinned: boolean;
    scopeTopicId: string | null;
    orderedIds: string[];
  } | null>(null);

  useEffect(() => {
    if (topicSwipeOpenId) setTaskSwipeOpenId(null);
  }, [topicSwipeOpenId]);

  useEffect(() => {
    if (taskSwipeOpenId) setTopicSwipeOpenId(null);
  }, [taskSwipeOpenId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const now = Date.now();
    const topicIds = topics.map((topic) => topic.id);
    const keys = ["unassigned", ...topicIds];
    setNewTaskDraftByTopicId((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of keys) {
        const draftKey = `draft:new-task:${id}`;
        const best = readBestDraftValue(draftKey, drafts[draftKey] ?? null, "");
        const editedAt = newTaskDraftEditedAtRef.current.get(id) ?? 0;
        if (now - editedAt < 1500) continue;
        const hasPrev = Object.prototype.hasOwnProperty.call(next, id);
        const prevValue = hasPrev ? String(next[id] ?? "") : "";
        if (!hasPrev && !best) continue;
        if (prevValue === best) continue;
        next[id] = best;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [drafts, topics]);

  const moveInArray = useCallback(<T,>(items: T[], from: number, to: number) => {
    if (from === to) return items;
    if (from < 0 || to < 0) return items;
    if (from >= items.length || to >= items.length) return items;
    const next = items.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  }, []);

  const setChatScroller = useCallback((key: string, node: HTMLElement | null) => {
    if (!key) return;
    if (node) {
      chatScrollers.current.set(key, node);
      const remaining = node.scrollHeight - (node.scrollTop + node.clientHeight);
      chatAtBottomRef.current.set(key, remaining <= CHAT_AUTO_SCROLL_THRESHOLD_PX);
      return;
    }
    chatScrollers.current.delete(key);
    chatAtBottomRef.current.delete(key);
  }, []);

  const updateActiveChatAtBottom = useCallback(() => {
    const key = activeChatKeyRef.current;
    if (!key) {
      activeChatAtBottomRef.current = false;
      return;
    }
    const scroller = chatScrollers.current.get(key);
    if (!scroller) {
      activeChatAtBottomRef.current = false;
      return;
    }
    const remaining = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    activeChatAtBottomRef.current = remaining <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    const nextKey = !activeComposer
      ? null
      : activeComposer.kind === "topic"
        ? `topic:${activeComposer.topicId}`
        : `task:${activeComposer.taskId}`;
    activeChatKeyRef.current = nextKey;
    updateActiveChatAtBottom();
  }, [activeComposer, updateActiveChatAtBottom]);

  // Hide unclassified logs from the unified view by default.
  // Use ?raw=1 to include everything (raw / debugging view).
  const visibleLogs = useMemo(() => {
    if (showRaw) return logs;
    return logs.filter((entry) => (entry.classificationStatus ?? "pending") === "classified");
  }, [logs, showRaw]);

  const currentUrlKey = useCallback(() => {
    if (typeof window === "undefined") return basePath;
    return `${window.location.pathname}${window.location.search}`;
  }, [basePath]);

  useEffect(() => {
    const handle = () => {
      setIsSticky(window.scrollY > 12);
    };
    handle();
    window.addEventListener("scroll", handle, { passive: true });
    return () => window.removeEventListener("scroll", handle);
  }, []);

  useEffect(() => {
    const timers = bumpTimers.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const store = () => {
      scrollMemory.current[currentUrlKey()] = window.scrollY;
    };
    store();
    window.addEventListener("scroll", store, { passive: true });
    return () => window.removeEventListener("scroll", store);
	  }, [currentUrlKey]);

  const bumpKey = (kind: "topic" | "task", id: string) => `${kind}:${id}`;

  const markBumped = useCallback(
    (kind: "topic" | "task", id: string) => {
      const now = Date.now();
      const key = bumpKey(kind, id);

      if (bumpTimers.current.has(key)) {
        window.clearTimeout(bumpTimers.current.get(key)!);
        bumpTimers.current.delete(key);
      }

      if (kind === "topic") {
        setTopicBumpAt((prev) => ({ ...prev, [id]: now }));
      } else {
        setTaskBumpAt((prev) => ({ ...prev, [id]: now }));
      }

      const timer = window.setTimeout(() => {
        bumpTimers.current.delete(key);
        if (kind === "topic") {
          setTopicBumpAt((prev) => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        } else {
          setTaskBumpAt((prev) => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }
      }, NEW_ITEM_BUMP_MS);
      bumpTimers.current.set(key, timer);
    },
    []
  );

	  const expandedTopicsSafe = useMemo(() => {
	    const topicIds = new Set(topics.map((topic) => topic.id));
	    if (tasks.some((task) => !task.topicId)) {
	      topicIds.add("unassigned");
	    }
	    return new Set([...expandedTopics].filter((id) => topicIds.has(id)));
	  }, [expandedTopics, topics, tasks]);

  const expandedTasksSafe = useMemo(() => {
    const taskIds = new Set(tasks.map((task) => task.id));
    return new Set([...expandedTasks].filter((id) => taskIds.has(id)));
  }, [expandedTasks, tasks]);

  const expandedTopicChatsSafe = useMemo(() => {
    const topicIds = new Set(topics.map((topic) => topic.id));
    return new Set([...expandedTopicChats].filter((id) => topicIds.has(id)));
  }, [expandedTopicChats, topics]);

  const tasksByTopic = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = task.topicId ?? "unassigned";
      const list = map.get(key) ?? [];
      list.push(task);
      map.set(key, list);
    }
    const now = Date.now();
    for (const list of map.values()) {
      list.sort((a, b) => {
        const aBump = taskBumpAt[a.id] ?? 0;
        const bBump = taskBumpAt[b.id] ?? 0;
        const aBoosted = aBump > 0 && now - aBump < NEW_ITEM_BUMP_MS;
        const bBoosted = bBump > 0 && now - bBump < NEW_ITEM_BUMP_MS;
        if (aBoosted !== bBoosted) return aBoosted ? -1 : 1;
        if (aBoosted && bBoosted && aBump !== bBump) return bBump - aBump;

        const ap = Boolean(a.pinned);
        const bp = Boolean(b.pinned);
        if (ap && !bp) return -1;
        if (!ap && bp) return 1;
        const as = typeof a.sortIndex === "number" ? a.sortIndex : 0;
        const bs = typeof b.sortIndex === "number" ? b.sortIndex : 0;
        if (as !== bs) return as - bs;
        return a.updatedAt < b.updatedAt ? 1 : -1;
      });
    }
    return map;
  }, [taskBumpAt, tasks]);

  const logsByTask = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const entry of visibleLogs) {
      if (!entry.taskId) continue;
      const list = map.get(entry.taskId) ?? [];
      list.push(entry);
      map.set(entry.taskId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    return map;
  }, [visibleLogs]);

  const logsByTopic = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const entry of visibleLogs) {
      if (!entry.topicId) continue;
      const list = map.get(entry.topicId) ?? [];
      list.push(entry);
      map.set(entry.topicId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    return map;
  }, [visibleLogs]);

  // Full logs map (includes pending) used for active Topic/Task chat panes.
  const logsByTaskAll = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const entry of logs) {
      if (!entry.taskId) continue;
      const list = map.get(entry.taskId) ?? [];
      list.push(entry);
      map.set(entry.taskId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    }
    return map;
  }, [logs]);

  const logsByTopicAll = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const entry of logs) {
      if (!entry.topicId) continue;
      const list = map.get(entry.topicId) ?? [];
      list.push(entry);
      map.set(entry.topicId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    }
    return map;
  }, [logs]);

  const normalizedSearch = search.trim().toLowerCase();
  const topicReorderEnabled = !readOnly && normalizedSearch.length === 0 && statusFilter === "all";
  const taskReorderEnabled = topicReorderEnabled && showDone;

  const chatKeyFromSessionKey = useCallback((sessionKey: string) => {
    const key = (sessionKey ?? "").trim();
    if (key.startsWith(BOARD_TOPIC_SESSION_PREFIX)) {
      const topicId = key.slice(BOARD_TOPIC_SESSION_PREFIX.length).trim();
      return topicId ? `topic:${topicId}` : "";
    }
    if (key.startsWith(BOARD_TASK_SESSION_PREFIX)) {
      const rest = key.slice(BOARD_TASK_SESSION_PREFIX.length).trim();
      const parts = rest.split(":", 2);
      const taskId = parts.length === 2 ? parts[1].trim() : "";
      return taskId ? `task:${taskId}` : "";
    }
    return "";
  }, []);

  const markRecentBoardSend = useCallback((sessionKey: string) => {
    const key = (sessionKey ?? "").trim();
    if (!key) return;
    const now = Date.now();
    const map = recentBoardSendAtRef.current;
    map.set(key, now);
    for (const [k, ts] of map) {
      if (now - ts > 10 * 60 * 1000) map.delete(k);
    }
  }, []);

  const getChatLastLogId = useCallback(
    (key: string) => {
      const trimmed = (key ?? "").trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("task:")) {
        const taskId = trimmed.slice("task:".length).trim();
        if (!taskId) return "";
        const rows = logsByTaskAll.get(taskId) ?? [];
        const last = rows.length > 0 ? rows[rows.length - 1] : null;
        return last?.id ?? "";
      }
      if (trimmed.startsWith("topic:")) {
        const topicId = trimmed.slice("topic:".length).trim();
        if (!topicId) return "";
        const rows = logsByTopicAll.get(topicId) ?? [];
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const entry = rows[i];
          if (!entry) continue;
          if (!entry.taskId) return entry.id;
        }
        return "";
      }
      return "";
    },
    [logsByTaskAll, logsByTopicAll]
  );

  useEffect(() => {
    if (pendingMessages.length === 0) return;
    const norm = (value: string) => String(value || "").trim().replace(/\s+/g, " ");
    setPendingMessages((prev) => {
      if (prev.length === 0) return prev;
      return prev.filter((pending) => {
        const pSession = pending.sessionKey;
        const pMessage = norm(pending.message);
        const pRequest = (pending.requestId ?? "").trim();
        const pTs = Date.parse(pending.createdAt);
        const matches = logs.some((entry) => {
          if ((entry.agentId ?? "").toLowerCase() !== "user") return false;
          if (String(entry.source?.sessionKey ?? "").trim() !== pSession) return false;
          const req = String(entry.source?.requestId ?? "").trim();
          if (pRequest && req && req === pRequest) return true;
          if (pRequest) return false;
          if (norm(entry.content ?? "") !== pMessage) return false;
          const eTs = Date.parse(entry.createdAt);
          if (!Number.isFinite(pTs) || !Number.isFinite(eTs)) return false;
          return Math.abs(eTs - pTs) <= 15_000;
        });
        return !matches;
      });
    });
  }, [logs, pendingMessages.length]);

  useEffect(() => {
    const sessions = Object.keys(awaitingAssistant);
    if (sessions.length === 0) return;
    const now = Date.now();
    const latestAssistantBySession = new Map<string, string>();
    const terminalRequestIds = new Set<string>();

    for (const entry of logs) {
      const sessionKey = String(entry.source?.sessionKey ?? "").trim();
      if (sessionKey) {
        const agentId = String(entry.agentId ?? "").trim().toLowerCase();
        if (agentId === "assistant" && entry.type === "conversation") {
          const ts = entry.createdAt;
          const prev = latestAssistantBySession.get(sessionKey) ?? "";
          if (!prev || ts > prev) latestAssistantBySession.set(sessionKey, ts);
        }
      }
      const reqId = String(entry.source?.requestId ?? "").trim();
      if (reqId) {
        const agentId = String(entry.agentId ?? "").trim().toLowerCase();
        if (agentId === "system") terminalRequestIds.add(reqId);
      }
    }

    setAwaitingAssistant((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [sessionKey, info] of Object.entries(prev)) {
        const sentAtMs = Date.parse(info.sentAt);
        if (Number.isFinite(sentAtMs) && now - sentAtMs > 10 * 60 * 1000) {
          changed = true;
          continue;
        }
        if (info.requestId && terminalRequestIds.has(info.requestId)) {
          changed = true;
          continue;
        }
        const assistantAt = latestAssistantBySession.get(sessionKey);
        if (assistantAt && assistantAt > info.sentAt) {
          changed = true;
          continue;
        }
        next[sessionKey] = info;
      }
      return changed ? next : prev;
    });
  }, [awaitingAssistant, logs]);

  useEffect(() => {
    const prev = prevPendingAttachmentsRef.current;
    const next = new Map<string, AttachmentLike[]>();
    for (const msg of pendingMessages) {
      next.set(msg.localId, msg.attachments ?? []);
    }
    for (const [localId, atts] of prev.entries()) {
      if (next.has(localId)) continue;
      for (const att of atts) {
        if (!att.previewUrl) continue;
        try {
          URL.revokeObjectURL(att.previewUrl);
        } catch {
          // ignore
        }
      }
    }
    prevPendingAttachmentsRef.current = next;
  }, [pendingMessages]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const hasFiles = (dt: DataTransfer | null) => {
      if (!dt) return false;
      const types = Array.from(dt.types ?? []);
      return types.includes("Files");
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      // Prevent the browser from navigating away (opening the file).
      event.preventDefault();
    };

    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();

      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;

      const active = activeComposer;
      const session =
        active?.kind === "topic"
          ? topicSessionKey(active.topicId)
          : active?.kind === "task"
            ? taskSessionKey(active.topicId, active.taskId)
            : "";
      const handle = session ? composerHandlesRef.current.get(session) : null;
      if (handle) {
        handle.addFiles(files);
        handle.focus();
      }
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [activeComposer]);

  useEffect(() => {
    if (normalizedSearch) return;
    for (const [key, scroller] of chatScrollers.current.entries()) {
      const lastId = getChatLastLogId(key);
      if (!lastId) continue;
      const prev = chatLastSeenRef.current.get(key) ?? "";
      chatLastSeenRef.current.set(key, lastId);
      if (!prev || prev === lastId) continue;
      const atBottom = chatAtBottomRef.current.get(key) ?? false;
      if (!atBottom) continue;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
      chatAtBottomRef.current.set(key, true);
    }
  }, [getChatLastLogId, logs, normalizedSearch]);

  const semanticLimits = useMemo(
    () => ({
      topics: Math.min(Math.max(topics.length, 120), 500),
      tasks: Math.min(Math.max(tasks.length, 240), 1200),
      logs: Math.min(Math.max(visibleLogs.length, 800), 4000),
    }),
    [topics.length, tasks.length, visibleLogs.length]
  );

  const semanticRefreshKey = useMemo(() => {
    const latestTopic = topics.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    const latestTask = tasks.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    const latestLog = visibleLogs.reduce((acc, item) => {
      const stamp = item.updatedAt || item.createdAt || "";
      return stamp > acc ? stamp : acc;
    }, "");
    return `${topics.length}:${tasks.length}:${visibleLogs.length}:${latestTopic}:${latestTask}:${latestLog}:${statusFilter}:${showDone ? 1 : 0}:${showRaw ? 1 : 0}`;
  }, [showDone, showRaw, statusFilter, tasks, topics, visibleLogs]);

  const semanticSearch = useSemanticSearch({
    query: normalizedSearch,
    includePending: showRaw,
    limitTopics: semanticLimits.topics,
    limitTasks: semanticLimits.tasks,
    limitLogs: semanticLimits.logs,
    refreshKey: semanticRefreshKey,
  });

  const semanticForQuery = useMemo(() => {
    if (!semanticSearch.data) return null;
    const resultQuery = semanticSearch.data.query.trim().toLowerCase();
    if (!resultQuery || resultQuery !== normalizedSearch) return null;
    return semanticSearch.data;
  }, [normalizedSearch, semanticSearch.data]);

  const semanticTopicIds = useMemo(() => new Set(semanticForQuery?.matchedTopicIds ?? []), [semanticForQuery]);
  const semanticTaskIds = useMemo(() => new Set(semanticForQuery?.matchedTaskIds ?? []), [semanticForQuery]);
  const semanticLogIds = useMemo(() => new Set(semanticForQuery?.matchedLogIds ?? []), [semanticForQuery]);
  const semanticTopicScores = useMemo(
    () => new Map((semanticForQuery?.topics ?? []).map((item) => [item.id, Number(item.score) || 0])),
    [semanticForQuery]
  );

  const matchesLogSearch = useCallback((entry: LogEntry) => {
    if (!normalizedSearch) return true;
    if (semanticForQuery) {
      return semanticLogIds.has(entry.id);
    }
    const haystack = `${entry.summary ?? ""} ${entry.content ?? ""} ${entry.raw ?? ""}`.toLowerCase();
    return haystack.includes(normalizedSearch);
  }, [normalizedSearch, semanticForQuery, semanticLogIds]);

  // For active chat panes we always allow a lexical fallback, even when semantic search is enabled,
  // so newly appended (pending) messages still appear immediately.
  const matchesLogSearchChat = useCallback(
    (entry: LogEntry) => {
      if (!normalizedSearch) return true;
      const haystack = `${entry.summary ?? ""} ${entry.content ?? ""} ${entry.raw ?? ""}`.toLowerCase();
      if (semanticForQuery) {
        return semanticLogIds.has(entry.id) || haystack.includes(normalizedSearch);
      }
      return haystack.includes(normalizedSearch);
    },
    [normalizedSearch, semanticForQuery, semanticLogIds]
  );

  const matchesTaskSearch = useCallback((task: Task) => {
    if (!normalizedSearch) return true;
    if (semanticForQuery) {
      if (semanticTaskIds.has(task.id)) return true;
      const logMatches = logsByTask.get(task.id)?.some((entry) => semanticLogIds.has(entry.id));
      return Boolean(logMatches);
    }
    if (task.title.toLowerCase().includes(normalizedSearch)) return true;
    const logMatches = logsByTask.get(task.id)?.some(matchesLogSearch);
    return Boolean(logMatches);
  }, [logsByTask, matchesLogSearch, normalizedSearch, semanticForQuery, semanticLogIds, semanticTaskIds]);

  const matchesStatusFilter = useCallback(
    (task: Task) => {
      if (!normalizedSearch) {
        const until = (task.snoozedUntil ?? "").trim();
        if (until) {
          const stamp = Date.parse(until);
          if (Number.isFinite(stamp) && stamp > Date.now()) return false;
        }
      }
      if (statusFilter !== "all") return task.status === statusFilter;
      if (!showDone && task.status === "done") return false;
      return true;
    },
    [normalizedSearch, showDone, statusFilter]
  );

  const orderedTopics = useMemo(() => {
    const now = Date.now();
    const base = [...topics]
      .map((topic) => ({
        ...topic,
        lastActivity: logsByTopic.get(topic.id)?.[0]?.createdAt ?? topic.updatedAt,
      }))
      .sort((a, b) => {
        const aBump = topicBumpAt[a.id] ?? 0;
        const bBump = topicBumpAt[b.id] ?? 0;
        const aBoosted = aBump > 0 && now - aBump < NEW_ITEM_BUMP_MS;
        const bBoosted = bBump > 0 && now - bBump < NEW_ITEM_BUMP_MS;
        if (aBoosted !== bBoosted) return aBoosted ? -1 : 1;
        if (aBoosted && bBoosted && aBump !== bBump) return bBump - aBump;

        if (normalizedSearch && semanticForQuery) {
          const aScore = semanticTopicScores.get(a.id) ?? 0;
          const bScore = semanticTopicScores.get(b.id) ?? 0;
          if (aScore !== bScore) return bScore - aScore;
        }
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        const as = typeof a.sortIndex === "number" ? a.sortIndex : 0;
        const bs = typeof b.sortIndex === "number" ? b.sortIndex : 0;
        if (as !== bs) return as - bs;
        return a.lastActivity < b.lastActivity ? 1 : -1;
      });

    const filtered = base.filter((topic) => {
      if (!normalizedSearch && (topic.status ?? "active") === "paused") return false;
      const taskList = tasksByTopic.get(topic.id) ?? [];
      if (statusFilter !== "all") {
        return taskList.some((task) => matchesStatusFilter(task) && matchesTaskSearch(task));
      }
      if (!normalizedSearch) return true;
      if (semanticForQuery) {
        if (semanticTopicIds.has(topic.id)) return true;
        if (taskList.some((task) => matchesStatusFilter(task) && matchesTaskSearch(task))) return true;
        const topicLogs = logsByTopic.get(topic.id) ?? [];
        return topicLogs.some((entry) => semanticLogIds.has(entry.id));
      }
      const topicHit = `${topic.name} ${topic.description ?? ""}`.toLowerCase().includes(normalizedSearch);
      if (topicHit) return true;
      if (taskList.some((task) => matchesStatusFilter(task) && matchesTaskSearch(task))) return true;
      const topicLogs = logsByTopic.get(topic.id) ?? [];
      return topicLogs.some(matchesLogSearch);
    });

    if (tasksByTopic.has("unassigned")) {
      filtered.push({
        id: "unassigned",
        name: "Unassigned",
        description: "Tasks without a topic.",
        pinned: false,
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "active",
        priority: "low",
        tags: [],
        parentId: null,
      });
    }

    return filtered;
  }, [
    topics,
    topicBumpAt,
    logsByTopic,
    matchesLogSearch,
    matchesStatusFilter,
    matchesTaskSearch,
    normalizedSearch,
    semanticForQuery,
    semanticLogIds,
    semanticTopicIds,
    semanticTopicScores,
    statusFilter,
    tasksByTopic,
  ]);

  const pageSize = 10;
  const pageCount = Math.ceil(orderedTopics.length / pageSize);
  const safePage = pageCount <= 1 ? 1 : Math.min(page, pageCount);
  const pagedTopics = pageCount > 1 ? orderedTopics.slice((safePage - 1) * pageSize, safePage * pageSize) : orderedTopics;

  const topicDisplayColors = useMemo(() => {
    const map = new Map<string, string>();
    let previous: string | null = null;
    pagedTopics.forEach((topic, index) => {
      const seedColor = normalizeHexColor(topic.color) ?? colorFromSeed(`topic:${topic.id}:${topic.name}`, TOPIC_FALLBACK_COLORS);
      const color = pickAlternatingColor(seedColor, previous, index, TOPIC_FALLBACK_COLORS);
      map.set(topic.id, color);
      previous = color;
    });
    return map;
  }, [pagedTopics]);

  const taskDisplayColors = useMemo(() => {
    const map = new Map<string, string>();
    pagedTopics.forEach((topic) => {
      const taskList = tasksByTopic.get(topic.id) ?? [];
      let previous: string | null = null;
      taskList.forEach((task, index) => {
        const seedColor = normalizeHexColor(task.color) ?? colorFromSeed(`task:${task.id}:${task.title}`, TASK_FALLBACK_COLORS);
        const color = pickAlternatingColor(seedColor, previous, index, TASK_FALLBACK_COLORS);
        map.set(task.id, color);
        previous = color;
      });
    });
    return map;
  }, [pagedTopics, tasksByTopic]);

  const writeHeaders = useMemo(() => ({ "Content-Type": "application/json" }), []);

  const setRenameError = useCallback((key: string, message?: string) => {
    setRenameErrors((prev) => {
      const next = { ...prev };
      if (message) {
        next[key] = message;
      } else {
        delete next[key];
      }
      return next;
    });
  }, []);

  const requestEmbeddingRefresh = useCallback(async (payload: { kind: "topic" | "task"; id: string; text: string; topicId?: string | null }) => {
    try {
      await apiFetch(
        "/api/reindex",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify(payload),
        },
        token
      );
    } catch {
      // Best-effort only; DB update remains source of truth.
    }
  }, [token, writeHeaders]);

  const updateTask = async (taskId: string, updates: Partial<Task>) => {
    if (readOnly) return;
    const current = tasks.find((task) => task.id === taskId);
    if (!current) return;
    const res = await apiFetch(
      "/api/tasks",
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ ...current, ...updates }),
      },
      token
    );

    if (!res.ok) {
      return;
    }

    const updated = (await res.json().catch(() => null)) as Task | null;
    setTasks((prev) =>
      prev.map((task) =>
        task.id === taskId
          ? {
              ...task,
              ...(updated ?? updates),
              updatedAt: updated?.updatedAt ?? new Date().toISOString(),
            }
          : task
      )
    );
  };

  const persistTopicOrder = useCallback(async (orderedIds: string[]) => {
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
          headers: writeHeaders,
          body: JSON.stringify({ orderedIds }),
        },
        token
      );
      if (!res.ok) {
        throw new Error(`Failed to reorder topics (${res.status}).`);
      }
    } catch (err) {
      setTopics(snapshot);
      console.error(err);
    }
  }, [readOnly, setTopics, token, topics, writeHeaders]);

  const beginPointerTopicReorder = useCallback(
    (event: React.PointerEvent, topic: Topic) => {
      if (readOnly || !topicReorderEnabled) return;
      if (topic.id === "unassigned") return;
      if ("button" in event && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setTopicSwipeOpenId(null);

      const pinned = Boolean(topic.pinned);
      const initialVisibleIds = orderedTopics
        .filter((t) => t.id !== "unassigned" && Boolean(t.pinned) === pinned)
        .map((t) => t.id);
      if (initialVisibleIds.length < 2) return;

      setDraggingTopicId(topic.id);
      setTopicDropTargetId(null);
      topicPointerReorder.current = {
        pointerId: event.pointerId,
        draggedId: topic.id,
        pinned,
        orderedIds: initialVisibleIds,
      };
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // ok
      }
    },
    [orderedTopics, readOnly, topicReorderEnabled]
  );

  const updatePointerTopicReorder = useCallback(
    (event: React.PointerEvent) => {
      const state = topicPointerReorder.current;
      if (!state) return;
      if (event.pointerId !== state.pointerId) return;
      event.preventDefault();

      const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const row = el?.closest?.("[data-topic-card-id]") as HTMLElement | null;
      const targetId = (row?.getAttribute("data-topic-card-id") ?? "").trim();
      if (!targetId) return;
      if (targetId === state.draggedId) return;

      const targetTopic = topics.find((t) => t.id === targetId);
      if (!targetTopic) return;
      if (Boolean(targetTopic.pinned) !== state.pinned) return;

      const from = state.orderedIds.indexOf(state.draggedId);
      const to = state.orderedIds.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return;

      const next = moveInArray(state.orderedIds, from, to);
      state.orderedIds = next;
      setTopicDropTargetId(targetId);

      // Optimistically reflect the new order.
      const indexById = new Map(next.map((id, idx) => [id, idx]));
      setTopics((prev) =>
        prev.map((t) => {
          const idx = indexById.get(t.id);
          if (typeof idx !== "number") return t;
          if (t.sortIndex === idx) return t;
          return { ...t, sortIndex: idx };
        })
      );
    },
    [moveInArray, setTopics, topics]
  );

  const endPointerTopicReorder = useCallback(() => {
    const state = topicPointerReorder.current;
    topicPointerReorder.current = null;
    if (!state) return;
    setDraggingTopicId(null);
    setTopicDropTargetId(null);
    void persistTopicOrder(state.orderedIds);
  }, [persistTopicOrder]);

  const beginPointerTaskReorder = useCallback(
    (event: React.PointerEvent, task: Task, scopeTopicId: string | null, scopeTasks: Task[]) => {
      if (readOnly || !taskReorderEnabled) return;
      if ("button" in event && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const orderedIds = scopeTasks.map((t) => t.id);
      if (orderedIds.length < 2) return;

      setDraggingTaskId(task.id);
      setDraggingTaskTopicId(scopeTopicId ?? "unassigned");
      setTaskDropTargetId(null);
      taskPointerReorder.current = {
        pointerId: event.pointerId,
        draggedId: task.id,
        pinned: Boolean(task.pinned),
        scopeTopicId,
        orderedIds,
      };
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // ok
      }
    },
    [readOnly, taskReorderEnabled]
  );

  const updatePointerTaskReorder = useCallback(
    (event: React.PointerEvent) => {
      const state = taskPointerReorder.current;
      if (!state) return;
      if (event.pointerId !== state.pointerId) return;
      event.preventDefault();

      const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const row = el?.closest?.("[data-task-card-id]") as HTMLElement | null;
      const targetId = (row?.getAttribute("data-task-card-id") ?? "").trim();
      if (!targetId) return;
      if (targetId === state.draggedId) return;

      const targetTask = tasks.find((t) => t.id === targetId);
      if (!targetTask) return;
      const targetScope = targetTask.topicId ?? null;
      if (targetScope !== state.scopeTopicId) return;
      if (Boolean(targetTask.pinned) !== state.pinned) return;

      const from = state.orderedIds.indexOf(state.draggedId);
      const to = state.orderedIds.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return;

      const next = moveInArray(state.orderedIds, from, to);
      state.orderedIds = next;
      setTaskDropTargetId(targetId);

      const indexById = new Map(next.map((id, idx) => [id, idx]));
      setTasks((prev) =>
        prev.map((t) => {
          const inScope = state.scopeTopicId ? t.topicId === state.scopeTopicId : !t.topicId;
          if (!inScope) return t;
          const idx = indexById.get(t.id);
          if (typeof idx !== "number") return t;
          if (t.sortIndex === idx) return t;
          return { ...t, sortIndex: idx };
        })
      );
    },
    [moveInArray, setTasks, tasks]
  );

  const persistTaskOrder = useCallback(async (scopeTopicId: string | null, orderedIds: string[]) => {
    if (readOnly) return;
    const snapshot = tasks;
    const indexById = new Map(orderedIds.map((id, idx) => [id, idx]));
    setTasks((prev) =>
      prev.map((task) => {
        const inScope = (scopeTopicId ? task.topicId === scopeTopicId : !task.topicId);
        if (!inScope) return task;
        const idx = indexById.get(task.id);
        if (typeof idx !== "number") return task;
        if (task.sortIndex === idx) return task;
        return { ...task, sortIndex: idx };
      })
    );
    try {
      const res = await apiFetch(
        "/api/tasks/reorder",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({ topicId: scopeTopicId, orderedIds }),
        },
        token
      );
      if (!res.ok) {
        throw new Error(`Failed to reorder tasks (${res.status}).`);
      }
    } catch (err) {
      setTasks(snapshot);
      console.error(err);
    }
  }, [readOnly, setTasks, tasks, token, writeHeaders]);

  const endPointerTaskReorder = useCallback(() => {
    const state = taskPointerReorder.current;
    taskPointerReorder.current = null;
    if (!state) return;
    setDraggingTaskId(null);
    setDraggingTaskTopicId(null);
    setTaskDropTargetId(null);
    void persistTaskOrder(state.scopeTopicId, state.orderedIds);
  }, [persistTaskOrder]);

  const saveTopicRename = useCallback(async (topic: Topic, options?: { close?: boolean }) => {
    const shouldClose = options?.close !== false;
    const renameKey = `topic:${topic.id}`;
    const nextName = topicNameDraft.trim();
    const currentColor =
      normalizeHexColor(topic.color) ??
      topicDisplayColors.get(topic.id) ??
      colorFromSeed(`topic:${topic.id}:${topic.name}`, TOPIC_FALLBACK_COLORS);
    const nextColor = normalizeHexColor(topicColorDraft) ?? currentColor;
    const nextTags = parseTags(topicTagsDraft);
    const currentTags = (topic.tags ?? []).map((t) => String(t || "").trim()).filter(Boolean);
    const nameChanged = nextName !== topic.name;
    const colorChanged = nextColor !== normalizeHexColor(topic.color);
    const tagsChanged = nextTags.join("|") !== currentTags.join("|");
    if (readOnly) return;
    if (!nextName) {
      setRenameError(renameKey, "Topic name cannot be empty.");
      return;
    }
    if (!nameChanged && !colorChanged && !tagsChanged) {
      if (shouldClose) {
        setEditingTopicId(null);
        setTopicNameDraft("");
        setTopicColorDraft(currentColor);
        setTopicTagsDraft(formatTags(currentTags));
        setDeleteArmedKey(null);
      }
      setRenameError(renameKey);
      return;
    }
    setRenameSavingKey(renameKey);
    setRenameError(renameKey);
    try {
      const res = await apiFetch(
        "/api/topics",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({
            id: topic.id,
            name: nameChanged ? nextName : topic.name,
            color: nextColor,
            tags: tagsChanged ? nextTags : currentTags,
          }),
        },
        token
      );
      if (!res.ok) {
        setRenameError(renameKey, "Failed to rename topic.");
        return;
      }
      const updated = (await res.json().catch(() => null)) as Topic | null;
      if (updated?.id) {
        // Treat the rename endpoint as a partial update; keep local pinned/status metadata stable.
        setTopics((prev) =>
          prev.map((item) =>
            item.id === topic.id
              ? {
                  ...item,
                  name: (updated.name || "").trim() || (nameChanged ? nextName : item.name),
                  color: normalizeHexColor(updated.color) ?? nextColor,
                  tags: Array.isArray(updated.tags) ? updated.tags : tagsChanged ? nextTags : item.tags,
                  updatedAt: updated.updatedAt ?? new Date().toISOString(),
                }
              : item
          )
        );
        if (nameChanged) {
          await requestEmbeddingRefresh({
            kind: "topic",
            id: updated.id,
            text: updated.name || nextName,
          });
        }
      } else {
        setTopics((prev) =>
          prev.map((item) =>
            item.id === topic.id
              ? { ...item, name: nameChanged ? nextName : topic.name, color: nextColor, updatedAt: new Date().toISOString() }
              : item
          )
        );
        if (nameChanged) {
          await requestEmbeddingRefresh({ kind: "topic", id: topic.id, text: nextName });
        }
      }
      if (shouldClose) {
        setEditingTopicId(null);
        setTopicNameDraft("");
        setTopicColorDraft(currentColor);
        setTopicTagsDraft("");
        setDeleteArmedKey(null);
      }
      setRenameError(renameKey);
    } finally {
      setRenameSavingKey(null);
    }
  }, [
    readOnly,
    requestEmbeddingRefresh,
    setRenameError,
    setTopics,
    token,
    topicColorDraft,
    topicDisplayColors,
    topicNameDraft,
    topicTagsDraft,
    writeHeaders,
  ]);

  const saveTaskRename = useCallback(async (task: Task, options?: { close?: boolean }) => {
    const shouldClose = options?.close !== false;
    const renameKey = `task:${task.id}`;
    const nextTitle = taskNameDraft.trim();
    const currentColor =
      normalizeHexColor(task.color) ??
      taskDisplayColors.get(task.id) ??
      colorFromSeed(`task:${task.id}:${task.title}`, TASK_FALLBACK_COLORS);
    const nextColor = normalizeHexColor(taskColorDraft) ?? currentColor;
    const nextTags = parseTags(taskTagsDraft);
    const currentTags = (task.tags ?? []).map((t) => String(t || "").trim()).filter(Boolean);
    const titleChanged = nextTitle !== task.title;
    const colorChanged = nextColor !== normalizeHexColor(task.color);
    const tagsChanged = nextTags.join("|") !== currentTags.join("|");
    if (readOnly) return;
    if (!nextTitle) {
      setRenameError(renameKey, "Task name cannot be empty.");
      return;
    }
    if (!titleChanged && !colorChanged && !tagsChanged) {
      if (shouldClose) {
        setEditingTaskId(null);
        setTaskNameDraft("");
        setTaskColorDraft(currentColor);
        setTaskTagsDraft(formatTags(currentTags));
        setMoveTaskId(null);
        setDeleteArmedKey(null);
      }
      setRenameError(renameKey);
      return;
    }
    setRenameSavingKey(renameKey);
    setRenameError(renameKey);
    try {
      const res = await apiFetch(
        "/api/tasks",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({
            id: task.id,
            title: titleChanged ? nextTitle : task.title,
            color: nextColor,
            topicId: task.topicId,
            tags: tagsChanged ? nextTags : currentTags,
          }),
        },
        token
      );
      if (!res.ok) {
        setRenameError(renameKey, "Failed to rename task.");
        return;
      }
      const updated = (await res.json().catch(() => null)) as Task | null;
      if (updated?.id) {
        // Treat the rename endpoint as a partial update; keep local pinned/status metadata stable.
        setTasks((prev) =>
          prev.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  title: (updated.title || "").trim() || (titleChanged ? nextTitle : item.title),
                  color: normalizeHexColor(updated.color) ?? nextColor,
                  topicId: updated.topicId ?? item.topicId,
                  tags: Array.isArray(updated.tags) ? updated.tags : tagsChanged ? nextTags : item.tags,
                  updatedAt: updated.updatedAt ?? new Date().toISOString(),
                }
              : item
          )
        );
        if (titleChanged) {
          await requestEmbeddingRefresh({
            kind: "task",
            id: updated.id,
            topicId: updated.topicId,
            text: updated.title || nextTitle,
          });
        }
      } else {
        setTasks((prev) =>
          prev.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  title: titleChanged ? nextTitle : task.title,
                  color: nextColor,
                  updatedAt: new Date().toISOString(),
                }
              : item
          )
        );
        if (titleChanged) {
          await requestEmbeddingRefresh({
            kind: "task",
            id: task.id,
            topicId: task.topicId,
            text: nextTitle,
          });
        }
      }
      if (shouldClose) {
        setEditingTaskId(null);
        setTaskNameDraft("");
        setTaskColorDraft(currentColor);
        setTaskTagsDraft("");
        setMoveTaskId(null);
        setDeleteArmedKey(null);
      }
      setRenameError(renameKey);
    } finally {
      setRenameSavingKey(null);
    }
  }, [
    readOnly,
    requestEmbeddingRefresh,
    setRenameError,
    setTasks,
    taskColorDraft,
    taskDisplayColors,
    taskNameDraft,
    taskTagsDraft,
    token,
    writeHeaders,
  ]);

  const createTopic = () => {
    if (readOnly) return;
    setEditingTaskId(null);
    setTaskNameDraft("");
    setTaskColorDraft(TASK_FALLBACK_COLORS[0]);
    setEditingTopicId(null);
    setTopicNameDraft("");
    setTopicTagsDraft("");
    setNewTopicDraftOpen(true);
    setNewTopicError(null);
    setDeleteArmedKey(null);
  };

  useEffect(() => {
    if (editingTopicId) {
      skipTopicAutosaveRef.current = true;
      return;
    }
    if (topicAutosaveTimerRef.current != null) {
      window.clearTimeout(topicAutosaveTimerRef.current);
      topicAutosaveTimerRef.current = null;
    }
  }, [editingTopicId]);

  useEffect(() => {
    if (editingTaskId) {
      skipTaskAutosaveRef.current = true;
      return;
    }
    if (taskAutosaveTimerRef.current != null) {
      window.clearTimeout(taskAutosaveTimerRef.current);
      taskAutosaveTimerRef.current = null;
    }
  }, [editingTaskId]);

  useEffect(() => {
    return () => {
      if (topicAutosaveTimerRef.current != null) window.clearTimeout(topicAutosaveTimerRef.current);
      if (taskAutosaveTimerRef.current != null) window.clearTimeout(taskAutosaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (readOnly) return;
    if (!editingTopicId) return;
    const topic = topics.find((item) => item.id === editingTopicId);
    if (!topic) return;
    if (skipTopicAutosaveRef.current) {
      skipTopicAutosaveRef.current = false;
      return;
    }
    if (!topicNameDraft.trim()) return;
    if (topicAutosaveTimerRef.current != null) window.clearTimeout(topicAutosaveTimerRef.current);
    topicAutosaveTimerRef.current = window.setTimeout(() => {
      void saveTopicRename(topic, { close: false });
    }, 650);
    return () => {
      if (topicAutosaveTimerRef.current != null) window.clearTimeout(topicAutosaveTimerRef.current);
      topicAutosaveTimerRef.current = null;
    };
  }, [editingTopicId, readOnly, saveTopicRename, topicNameDraft, topics]);

  useEffect(() => {
    if (readOnly) return;
    if (!editingTaskId) return;
    const task = tasks.find((item) => item.id === editingTaskId);
    if (!task) return;
    if (skipTaskAutosaveRef.current) {
      skipTaskAutosaveRef.current = false;
      return;
    }
    if (!taskNameDraft.trim()) return;
    if (taskAutosaveTimerRef.current != null) window.clearTimeout(taskAutosaveTimerRef.current);
    taskAutosaveTimerRef.current = window.setTimeout(() => {
      void saveTaskRename(task, { close: false });
    }, 650);
    return () => {
      if (taskAutosaveTimerRef.current != null) window.clearTimeout(taskAutosaveTimerRef.current);
      taskAutosaveTimerRef.current = null;
    };
  }, [editingTaskId, readOnly, saveTaskRename, taskNameDraft, tasks]);

  const createTask = async (scopeTopicId: string | null, title: string) => {
    if (readOnly) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    const draftKey = scopeTopicId ?? "unassigned";
    setNewTaskSavingKey(draftKey);
    try {
      const res = await apiFetch(
        "/api/tasks",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({
            title: trimmed,
            topicId: scopeTopicId,
            status: "todo",
          }),
        },
        token
      );
      if (!res.ok) return;
      const created = (await res.json().catch(() => null)) as Task | null;
      if (!created?.id) return;
      setTasks((prev) => (prev.some((item) => item.id === created.id) ? prev : [created, ...prev]));
      markBumped("task", created.id);

      setExpandedTopics((prev) => {
        const next = new Set(prev);
        next.add(scopeTopicId ?? "unassigned");
        return next;
      });
      setExpandedTopicChats((prev) => {
        const next = new Set(prev);
        if (scopeTopicId) next.add(scopeTopicId);
        return next;
      });

      setNewTaskDraftByTopicId((prev) => ({ ...prev, [draftKey]: "" }));
      newTaskDraftEditedAtRef.current.delete(draftKey);
      queueDraftUpsert(`draft:new-task:${draftKey}`, "");
    } finally {
      setNewTaskSavingKey((prev) => (prev === draftKey ? null : prev));
    }
  };

  const patchTopic = useCallback(
    async (topicId: string, patch: Partial<Topic>) => {
      if (readOnly) return;
      const current = topics.find((item) => item.id === topicId);
      if (!current) return;
      const snapshot = topics;
      const optimisticTs = new Date().toISOString();
      setTopics((prev) => prev.map((row) => (row.id === topicId ? { ...row, ...patch, updatedAt: optimisticTs } : row)));
      try {
        const res = await apiFetch(
          "/api/topics",
          {
            method: "POST",
            headers: writeHeaders,
            // TopicUpsert requires a name, even for partial updates.
            body: JSON.stringify({ id: topicId, name: patch.name ?? current.name, ...patch }),
          },
          token
        );
        if (!res.ok) throw new Error(`Failed to update topic (${res.status}).`);
        const updated = (await res.json().catch(() => null)) as Topic | null;
        if (updated?.id) {
          setTopics((prev) => prev.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)));
        }
      } catch (err) {
        setTopics(snapshot);
        console.error(err);
      }
    },
    [readOnly, setTopics, token, topics, writeHeaders]
  );

  const deleteUnassignedTasks = async () => {
    if (readOnly) return;
    const deleteKey = "topic:unassigned";
    const unassignedTasks = tasks.filter((task) => !task.topicId);
    if (unassignedTasks.length === 0) return;
    setDeleteInFlightKey(deleteKey);
    setRenameError(deleteKey);
    try {
      const removed = new Set<string>();
      for (const task of unassignedTasks) {
        const res = await apiFetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" }, token);
        if (!res.ok) continue;
        const payload = (await res.json().catch(() => null)) as { deleted?: boolean } | null;
        if (payload?.deleted) removed.add(task.id);
      }
      if (removed.size === 0) {
        setRenameError(deleteKey, "Failed to clear unassigned tasks.");
        return;
      }
      const updatedAt = new Date().toISOString();
      setTasks((prev) => prev.filter((item) => !removed.has(item.id)));
      setLogs((prev) =>
        prev.map((item) => (item.taskId && removed.has(item.taskId) ? { ...item, taskId: null, updatedAt } : item))
      );
      const nextTasks = Array.from(expandedTasksSafe).filter((id) => !removed.has(id));
      setExpandedTasks(new Set(nextTasks));
      pushUrl({ tasks: nextTasks }, "replace");
      setDeleteArmedKey(null);
      setRenameError(deleteKey);
    } finally {
      setDeleteInFlightKey(null);
    }
  };

  const deleteTopic = async (topic: Topic) => {
    const deleteKey = `topic:${topic.id}`;
    if (readOnly) return;
    if (topic.id === "unassigned") {
      await deleteUnassignedTasks();
      return;
    }
    setDeleteInFlightKey(deleteKey);
    setRenameError(deleteKey);
    try {
      const res = await apiFetch(`/api/topics/${encodeURIComponent(topic.id)}`, { method: "DELETE" }, token);
      if (!res.ok) {
        setRenameError(deleteKey, "Failed to delete topic.");
        return;
      }
      const payload = (await res.json().catch(() => null)) as { deleted?: boolean } | null;
      if (!payload?.deleted) {
        setRenameError(deleteKey, "Topic not found.");
        return;
      }
      const updatedAt = new Date().toISOString();
      setTopics((prev) => prev.filter((item) => item.id !== topic.id));
      setTasks((prev) =>
        prev.map((item) => (item.topicId === topic.id ? { ...item, topicId: null, updatedAt } : item))
      );
      setLogs((prev) =>
        prev.map((item) => (item.topicId === topic.id ? { ...item, topicId: null, updatedAt } : item))
      );
      const nextTopics = Array.from(expandedTopicsSafe).filter((id) => id !== topic.id);
      setExpandedTopics(new Set(nextTopics));
      setExpandedTopicChats((prev) => {
        const next = new Set(prev);
        next.delete(topic.id);
        return next;
      });
      pushUrl({ topics: nextTopics }, "replace");
      setEditingTopicId(null);
      setTopicNameDraft("");
      setDeleteArmedKey(null);
      setRenameError(deleteKey);
    } finally {
      setDeleteInFlightKey(null);
    }
  };

  const deleteTask = async (task: Task) => {
    const deleteKey = `task:${task.id}`;
    if (readOnly) return;
    setDeleteInFlightKey(deleteKey);
    setRenameError(deleteKey);
    try {
      const res = await apiFetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" }, token);
      if (!res.ok) {
        setRenameError(deleteKey, "Failed to delete task.");
        return;
      }
      const payload = (await res.json().catch(() => null)) as { deleted?: boolean } | null;
      if (!payload?.deleted) {
        setRenameError(deleteKey, "Task not found.");
        return;
      }
      const updatedAt = new Date().toISOString();
      setTasks((prev) => prev.filter((item) => item.id !== task.id));
      setLogs((prev) =>
        prev.map((item) => (item.taskId === task.id ? { ...item, taskId: null, updatedAt } : item))
      );
      const nextTasks = Array.from(expandedTasksSafe).filter((id) => id !== task.id);
      setExpandedTasks(new Set(nextTasks));
      pushUrl({ tasks: nextTasks }, "replace");
      setMoveTaskId((prev) => (prev === task.id ? null : prev));
      setEditingTaskId(null);
      setTaskNameDraft("");
      setDeleteArmedKey(null);
      setRenameError(deleteKey);
    } finally {
      setDeleteInFlightKey(null);
    }
  };

  const expandAll = () => {
    setExpandedTopics(new Set(orderedTopics.map((topic) => topic.id)));
    setExpandedTasks(new Set(tasks.map((task) => task.id)));
    setExpandedTopicChats(new Set(orderedTopics.map((topic) => topic.id)));
  };

  const collapseAll = () => {
    setExpandedTopics(new Set());
    setExpandedTasks(new Set());
    setExpandedTopicChats(new Set());
  };

  const toggleTopicExpanded = (topicId: string) => {
    const next = new Set(expandedTopicsSafe);
    const nextChats = new Set(expandedTopicChatsSafe);
    if (next.has(topicId)) {
      next.delete(topicId);
      nextChats.delete(topicId);
    } else {
      next.add(topicId);
      nextChats.add(topicId);
      scheduleScrollChatToBottom(`topic:${topicId}`);
    }
    setExpandedTopics(next);
    setExpandedTopicChats(nextChats);
    pushUrl({ topics: Array.from(next) });
  };

  const toggleTaskExpanded = (taskId: string) => {
    const next = new Set(expandedTasksSafe);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
      scheduleScrollChatToBottom(`task:${taskId}`);
    }
    setExpandedTasks(next);
    pushUrl({ tasks: Array.from(next) });
  };

  const toggleTopicChatExpanded = (topicId: string) => {
    const next = new Set(expandedTopicChatsSafe);
    if (next.has(topicId)) {
      next.delete(topicId);
    } else {
      next.add(topicId);
      scheduleScrollChatToBottom(`topic:${topicId}`);
    }
    setExpandedTopicChats(next);
  };

  const toggleDoneVisibility = () => {
    const next = !showDone;
    setShowDone(next);
    const nextStatus = !next && statusFilter === "done" ? "all" : statusFilter;
    if (nextStatus !== statusFilter) {
      setStatusFilter(nextStatus);
    }
    setPage(1);
    pushUrl({ done: next ? "1" : "0", status: nextStatus, page: "1" });
  };

  const toggleRawVisibility = () => {
    const next = !showRaw;
    setShowRaw(next);
    pushUrl({ raw: next ? "1" : "0" });
  };

  const toggleMessageDensity = () => {
    const next: MessageDensity = messageDensity === "compact" ? "comfortable" : "compact";
    setMessageDensity(next);
    pushUrl({ density: next });
  };

  const updateStatusFilter = (nextValue: string) => {
    const nextStatus = isTaskStatusFilter(nextValue) ? nextValue : "all";
    setStatusFilter(nextStatus);
    const mustShowDone = nextStatus === "done";
    if (mustShowDone && !showDone) {
      setShowDone(true);
    }
    setPage(1);
    pushUrl({ status: nextStatus, done: mustShowDone || showDone ? "1" : "0", page: "1" });
  };

  const toggleExpandAll = () => {
    const allTopics = orderedTopics.map((topic) => topic.id);
    const allTasks = tasks.map((task) => task.id);
    const hasAnyExpandable = allTopics.length > 0 || allTasks.length > 0;
    const allExpanded =
      hasAnyExpandable &&
      expandedTopicsSafe.size === allTopics.length &&
      expandedTasksSafe.size === allTasks.length &&
      expandedTopicChatsSafe.size === allTopics.length;
    if (allExpanded) {
      collapseAll();
      pushUrl({ topics: [], tasks: [] });
      return;
    }
    expandAll();
    pushUrl({ topics: allTopics, tasks: allTasks });
  };

  const allowToggle = (target: HTMLElement | null) => {
    if (!target) return true;
    return !target.closest("a, button, input, select, textarea, option");
  };

  const resolveTopicId = useCallback(
    (value: string) => {
      if (!value) return "";
      const raw = decodeSlugId(value);
      if (topics.some((topic) => topic.id === raw)) return raw;
      const slug = value.includes("--") ? value.slice(0, value.lastIndexOf("--")) : value;
      const match = topics.find((topic) => slugify(topic.name) === slug);
      return match?.id ?? raw;
    },
    [topics]
  );

  const resolveTaskId = useCallback(
    (value: string) => {
      if (!value) return "";
      const raw = decodeSlugId(value);
      if (tasks.some((task) => task.id === raw)) return raw;
      const slug = value.includes("--") ? value.slice(0, value.lastIndexOf("--")) : value;
      const match = tasks.find((task) => slugify(task.title) === slug);
      return match?.id ?? raw;
    },
    [tasks]
  );

  const encodeTopicParam = useCallback(
    (topicId: string) => {
      const topic = topics.find((item) => item.id === topicId);
      return topic ? encodeTopicSlug(topic) : topicId;
    },
    [topics]
  );

  const encodeTaskParam = useCallback(
    (taskId: string) => {
      const task = tasks.find((item) => item.id === taskId);
      return task ? encodeTaskSlug(task) : taskId;
    },
    [tasks]
  );

  const parseSegments = (segments: string[]) => {
    const topics: string[] = [];
    const tasks: string[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const key = segments[i];
      const value = segments[i + 1];
      if (!value) continue;
      if (key === "topic") {
        topics.push(value);
        i += 1;
      } else if (key === "task") {
        tasks.push(value);
        i += 1;
      }
    }
    return { topics, tasks };
  };

  const syncFromUrl = useCallback(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const segments = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length).split("/").filter(Boolean)
      : [];
    const parsed = parseSegments(segments);
    const hasPathSelections = parsed.topics.length > 0 || parsed.tasks.length > 0;
    const nextSearch = params.get("q") ?? "";
    const nextRaw = params.get("raw") === "1";
    const densityParam = (params.get("density") ?? "").trim().toLowerCase();
    const nextDensity: MessageDensity = densityParam === "comfortable" ? "comfortable" : "compact";
    const nextShowDone = params.get("done") === "1";
    const nextStatusRaw = params.get("status") ?? "all";
    const nextStatus = isTaskStatusFilter(nextStatusRaw) ? nextStatusRaw : "all";
    const nextPage = Math.max(1, Number(params.get("page") ?? 1));
    let nextTopics = hasPathSelections
      ? parsed.topics.map((value) => resolveTopicId(value)).filter(Boolean)
      : params
          .getAll("topic")
          .map((value) => resolveTopicId(value))
          .filter(Boolean);
    let nextTasks = hasPathSelections
      ? parsed.tasks.map((value) => resolveTaskId(value)).filter(Boolean)
      : params
          .getAll("task")
          .map((value) => resolveTaskId(value))
          .filter(Boolean);
    if (nextTopics.length === 0) {
      const legacyTopics = params.get("topics")?.split(",").filter(Boolean) ?? [];
      nextTopics = legacyTopics.map((value) => resolveTopicId(value)).filter(Boolean);
    }
    if (nextTasks.length === 0) {
      const legacyTasks = params.get("tasks")?.split(",").filter(Boolean) ?? [];
      nextTasks = legacyTasks.map((value) => resolveTaskId(value)).filter(Boolean);
    }

    setSearch(nextSearch);
    committedSearch.current = nextSearch;
    setShowRaw(nextRaw);
    setMessageDensity(nextDensity);
    setStatusFilter(nextStatus);
    setShowDone(nextShowDone || nextStatus === "done");
    setPage(Number.isNaN(nextPage) ? 1 : nextPage);
    setExpandedTopics(new Set(nextTopics));
    setExpandedTasks(new Set(nextTasks));
    // Topic chat is expanded by default for any expanded topic.
    setExpandedTopicChats(new Set(nextTopics));
    if (params.get("focus") === "1" && params.get("chat") === "1" && nextTasks.length === 0 && nextTopics.length > 0) {
      // When entering via left nav, take the user straight to the topic chat composer.
      setAutoFocusTopicId(nextTopics[0] ?? null);
    }

    if (restoreScrollOnNextSyncRef.current) {
      restoreScrollOnNextSyncRef.current = false;
      const key = `${url.pathname}${url.search}`;
      const y = scrollMemory.current[key];
      if (typeof y === "number") {
        window.requestAnimationFrame(() => {
          window.scrollTo({ top: y, left: 0, behavior: "auto" });
        });
      }
    }
  }, [basePath, resolveTaskId, resolveTopicId]);

  useEffect(() => {
    const handlePop = () => {
      restoreScrollOnNextSyncRef.current = true;
      syncFromUrl();
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [syncFromUrl]);

  // Next router navigation (router.push / Link) does not trigger popstate.
  // Sync our internal expanded state when pathname/search params change.
  useEffect(() => {
    syncFromUrl();
  }, [pathname, searchParams, syncFromUrl]);

  useEffect(() => {
    if (!autoFocusTopicId) return;
    const chatKey = `topic:${autoFocusTopicId}`;
    activeChatKeyRef.current = chatKey;
    activeChatAtBottomRef.current = true;
    scheduleScrollChatToBottom(chatKey);
  }, [autoFocusTopicId, scheduleScrollChatToBottom]);

  useEffect(() => {
    // When panes open (via URL sync, expand-all, or user toggles), start scrolled to latest.
    const prevTasks = prevExpandedTaskIdsRef.current;
    for (const taskId of expandedTasksSafe) {
      if (!prevTasks.has(taskId)) scheduleScrollChatToBottom(`task:${taskId}`);
    }
    prevExpandedTaskIdsRef.current = new Set(expandedTasksSafe);
  }, [expandedTasksSafe, scheduleScrollChatToBottom]);

  useEffect(() => {
    const prevTopics = prevExpandedTopicChatIdsRef.current;
    for (const topicId of expandedTopicChatsSafe) {
      if (!prevTopics.has(topicId)) scheduleScrollChatToBottom(`topic:${topicId}`);
    }
    prevExpandedTopicChatIdsRef.current = new Set(expandedTopicChatsSafe);
  }, [expandedTopicChatsSafe, scheduleScrollChatToBottom]);

  useEffect(() => {
    if (!hydrated) return;
    // Initialize per-chat history windows once we have the initial snapshot so the
    // "loaded messages" window doesn't slide forward as new logs append.
    setChatHistoryStarts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const taskId of expandedTasksSafe) {
        const key = chatKeyForTask(taskId);
        if (Object.prototype.hasOwnProperty.call(prev, key)) continue;
        const all = logsByTaskAll.get(taskId) ?? [];
        const start = Math.max(0, all.length - TASK_TIMELINE_LIMIT);
        next[key] = start;
        changed = true;
      }
      for (const topicId of expandedTopicChatsSafe) {
        if (topicId === "unassigned") continue;
        const key = chatKeyForTopic(topicId);
        if (Object.prototype.hasOwnProperty.call(prev, key)) continue;
        const allTopic = logsByTopicAll.get(topicId) ?? [];
        const all = allTopic.filter((entry) => !entry.taskId);
        const start = Math.max(0, all.length - TOPIC_TIMELINE_LIMIT);
        next[key] = start;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [expandedTasksSafe, expandedTopicChatsSafe, hydrated, logsByTaskAll, logsByTopicAll]);

  const pushUrl = useCallback(
    (
      overrides: Partial<Record<"q" | "raw" | "done" | "status" | "page" | "density", string>> & {
        topics?: string[];
        tasks?: string[];
      },
      mode: "push" | "replace" = "push"
    ) => {
      const params = new URLSearchParams();
      const nextSearch = overrides.q ?? search;
      const nextRaw = overrides.raw ?? (showRaw ? "1" : "0");
      const nextDensity = overrides.density ?? messageDensity;
      const nextDone = overrides.done ?? (showDone ? "1" : "0");
      const nextStatus = overrides.status ?? statusFilter;
      const nextPage = overrides.page ?? String(safePage);
      const nextTopics = overrides.topics ?? Array.from(expandedTopicsSafe);
      const nextTasks = overrides.tasks ?? Array.from(expandedTasksSafe);

      if (nextSearch) params.set("q", nextSearch);
      if (nextRaw === "1") params.set("raw", "1");
      // Compact is the default; only persist when the user explicitly chooses comfortable.
      if (nextDensity === "comfortable") params.set("density", "comfortable");
      if (nextDone === "1") params.set("done", "1");
      if (nextStatus !== "all") params.set("status", nextStatus);
      if (nextPage && nextPage !== "1") params.set("page", nextPage);
      const segments: string[] = [];
      for (const topicId of nextTopics) {
        segments.push("topic", encodeTopicParam(topicId));
      }
      for (const taskId of nextTasks) {
        segments.push("task", encodeTaskParam(taskId));
      }

      const trimmedBase =
        basePath.endsWith("/") && basePath.length > 1 ? basePath.slice(0, -1) : basePath;
      const nextPath = segments.length > 0 ? `${trimmedBase}/${segments.join("/")}` : trimmedBase;
      const query = params.toString();
      const nextUrl = query ? `${nextPath}?${query}` : nextPath;
      if (typeof window === "undefined") return;
      const currentKey = currentUrlKey();
      scrollMemory.current[currentKey] = window.scrollY;
      scrollMemory.current[nextUrl] = window.scrollY;
      if (currentKey === nextUrl) return;
      if (mode === "replace") {
        window.history.replaceState({ clawboard: true }, "", nextUrl);
      } else {
        window.history.pushState({ clawboard: true }, "", nextUrl);
      }
    },
    [
      currentUrlKey,
      encodeTaskParam,
      encodeTopicParam,
      expandedTasksSafe,
      expandedTopicsSafe,
      safePage,
      search,
      messageDensity,
      showDone,
      showRaw,
      statusFilter,
      basePath,
    ]
  );

  const submitNewTopicDraft = useCallback(async () => {
    if (readOnly) return null;
    const nextName = newTopicNameDraft.trim();
    const nextColor = normalizeHexColor(newTopicColorDraft) ?? TOPIC_FALLBACK_COLORS[0];
    const nextTags = parseTags(newTopicTagsDraft);
    if (!nextName) {
      setNewTopicError("Topic name cannot be empty.");
      return null;
    }
    if (newTopicSaving) return null;
    setNewTopicSaving(true);
    setNewTopicError(null);
    try {
      const res = await apiFetch(
        "/api/topics",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({ name: nextName, color: nextColor, tags: nextTags }),
        },
        token
      );
      if (!res.ok) {
        setNewTopicError("Failed to create topic.");
        return null;
      }
      const created = (await res.json().catch(() => null)) as Topic | null;
      if (!created?.id) {
        setNewTopicError("Failed to create topic.");
        return null;
      }

      setTopics((prev) => (prev.some((item) => item.id === created.id) ? prev : [created, ...prev]));
      markBumped("topic", created.id);

      setPage(1);
      setExpandedTopics((prev) => new Set(prev).add(created.id));
      setExpandedTopicChats((prev) => new Set(prev).add(created.id));
      pushUrl({ topics: Array.from(new Set([...expandedTopicsSafe, created.id])), page: "1" }, "replace");

      setNewTopicDraftOpen(false);
      setNewTopicNameDraft("");
      setNewTopicColorDraft(TOPIC_FALLBACK_COLORS[0]);
      setNewTopicTagsDraft("");
      setNewTopicError(null);
      setAutoFocusTopicId(created.id);
      return created;
    } finally {
      setNewTopicSaving(false);
    }
  }, [
    expandedTopicsSafe,
    markBumped,
    newTopicColorDraft,
    newTopicNameDraft,
    newTopicSaving,
    newTopicTagsDraft,
    pushUrl,
    readOnly,
    setExpandedTopicChats,
    setExpandedTopics,
    setNewTopicColorDraft,
    setNewTopicNameDraft,
    setNewTopicTagsDraft,
    setPage,
    setTopics,
    token,
    writeHeaders,
  ]);

  // Auto-promote topic chat into a task when classifier patches a topic-scoped log with taskId.
  // This keeps the "continue chatting" UX deterministic: once a task exists, new sends should target
  // the task sessionKey so future turns attach immediately.
  useEffect(() => {
    const prev = prevTaskByLogId.current;
    let promotion: { topicId: string; taskId: string; sessionKey: string } | null = null;

    for (const entry of logs) {
      const hadPrev = prev.has(entry.id);
      const prevTask = prev.get(entry.id) ?? null;
      const nextTask = entry.taskId ?? null;
      if (!promotion && hadPrev && prevTask == null && nextTask != null) {
        const sessionKey = String(entry.source?.sessionKey ?? "").trim();
        if (sessionKey.startsWith(BOARD_TOPIC_SESSION_PREFIX)) {
          const topicId = sessionKey.slice(BOARD_TOPIC_SESSION_PREFIX.length).trim();
          if (topicId) promotion = { topicId, taskId: nextTask, sessionKey };
        }
      }
      prev.set(entry.id, nextTask);
    }

    if (prev.size > Math.max(5000, logs.length * 2)) {
      const alive = new Set(logs.map((e) => e.id));
      for (const id of prev.keys()) {
        if (!alive.has(id)) prev.delete(id);
      }
    }

    if (!promotion) return;
    const sentAt = recentBoardSendAtRef.current.get(promotion.sessionKey) ?? 0;
    if (!sentAt || Date.now() - sentAt > 30 * 60 * 1000) return;
    recentBoardSendAtRef.current.delete(promotion.sessionKey);

    setExpandedTopics((prevSet) => {
      const next = new Set(prevSet);
      next.add(promotion.topicId);
      return next;
    });
    setExpandedTasks((prevSet) => {
      const next = new Set(prevSet);
      next.add(promotion.taskId);
      return next;
    });
    setAutoFocusTask({ topicId: promotion.topicId, taskId: promotion.taskId });
    // If the classifier promotes a topic session into a task mid-turn, keep "typing" and
    // response indicators visible in the new task chat even though the underlying sessionKey
    // for this turn was topic-scoped.
    typingAliasRef.current.set(taskSessionKey(promotion.topicId, promotion.taskId), {
      sourceSessionKey: topicSessionKey(promotion.topicId),
      createdAt: Date.now(),
    });
    // Ensure the newly promoted task chat opens scrolled to the latest messages
    // without forcing a window scroll.
    const promotedChatKey = `task:${promotion.taskId}`;
    activeChatKeyRef.current = promotedChatKey;
    activeChatAtBottomRef.current = true;
    scheduleScrollChatToBottom(promotedChatKey);

    const nextTopics = Array.from(new Set([...expandedTopicsSafe, promotion.topicId]));
    const nextTasks = Array.from(new Set([...expandedTasksSafe, promotion.taskId]));
    pushUrl({ topics: nextTopics, tasks: nextTasks }, "replace");
  }, [expandedTasksSafe, expandedTopicsSafe, logs, pushUrl, scheduleScrollChatToBottom]);



  return (
    <div className="space-y-6">
      <div
        className={cn(
          "sticky top-0 z-30 -mx-6 space-y-3 px-6 pb-3 pt-4 transition",
          isSticky
            ? "border-b border-[rgb(var(--claw-border))] bg-[rgba(12,14,18,0.9)] backdrop-blur"
            : "bg-transparent"
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={search}
            onChange={(event) => {
              const value = event.target.value;
              setSearch(value);
              setPage(1);
              pushUrl({ q: value, page: "1" }, "replace");
            }}
            onBlur={() => {
              if (committedSearch.current !== search) {
                committedSearch.current = search;
                pushUrl({ q: search });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                committedSearch.current = search;
                pushUrl({ q: search });
              }
            }}
            placeholder="Search topics, tasks, or messages"
            className="min-w-[240px] flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowViewOptions((prev) => !prev)}
            aria-expanded={showViewOptions}
          >
            {showViewOptions ? "Hide options" : "View options"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className={cn(twoColumn ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
            onClick={toggleTwoColumn}
            title={twoColumn ? "Switch to single column" : "Switch to two columns"}
          >
            {twoColumn ? "1 column" : "2 column"}
          </Button>
        </div>
        {showViewOptions && (
          <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(14,17,22,0.92)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={statusFilter}
                onChange={(event) => updateStatusFilter(event.target.value)}
                className="max-w-[190px]"
              >
                <option value="all">All statuses</option>
                <option value="todo">To Do</option>
                <option value="doing">Doing</option>
                <option value="blocked">Blocked</option>
                <option value="done">Done</option>
              </Select>
              <Button
                variant="secondary"
                size="sm"
                className={cn(showDone ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                onClick={toggleDoneVisibility}
              >
                {showDone ? "Hide done" : "Show done"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className={cn(showRaw ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                onClick={toggleRawVisibility}
              >
                {showRaw ? "Hide full messages" : "Show full messages"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className={cn(messageDensity === "compact" ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                onClick={toggleMessageDensity}
              >
                {messageDensity === "compact" ? "Comfortable view" : "Compact view"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className={cn(
                  (orderedTopics.length > 0 || tasks.length > 0) &&
                    expandedTopicsSafe.size === orderedTopics.length &&
                    expandedTasksSafe.size === tasks.length
                    ? "border-[rgba(255,90,45,0.5)]"
                    : "opacity-85"
                )}
                onClick={toggleExpandAll}
              >
                {(orderedTopics.length > 0 || tasks.length > 0) &&
                expandedTopicsSafe.size === orderedTopics.length &&
                expandedTasksSafe.size === tasks.length
                  ? "Collapse all"
                  : "Expand all"}
              </Button>
            </div>
          </div>
        )}
        {readOnly && (
          <span className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add token to move tasks.</span>
        )}
        {normalizedSearch && (
          <span className="text-xs text-[rgb(var(--claw-muted))]">
            {semanticSearch.loading
              ? "Searching memory index…"
              : semanticForQuery
                ? `Semantic search (${semanticForQuery.mode})`
                : semanticSearch.error
                  ? "Semantic search unavailable, using local match fallback."
                  : "Searching…"}
          </span>
        )}
      </div>

      <div className="space-y-4">
        {!readOnly && (
          <div className="flex items-center justify-start">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                createTopic();
              }}
            >
              + New topic
            </Button>
          </div>
        )}
        {!readOnly && newTopicDraftOpen && (
          <div
            className="rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] bg-[linear-gradient(145deg,rgba(28,32,40,0.6),rgba(16,19,24,0.5))] p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.25)] backdrop-blur"
            onBlur={(event) => {
              const next = event.relatedTarget as HTMLElement | null;
              if (next && event.currentTarget.contains(next)) return;
              if (newTopicSaving) return;
              if (newTopicNameDraft.trim()) {
                void submitNewTopicDraft();
              } else {
                setNewTopicDraftOpen(false);
                setNewTopicError(null);
              }
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">New topic</div>
              {newTopicSaving ? (
                <span className="text-xs text-[rgb(var(--claw-muted))]">Creating…</span>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input
                data-testid="new-topic-name"
                value={newTopicNameDraft}
                autoFocus
                onChange={(event) => setNewTopicNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitNewTopicDraft();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setNewTopicDraftOpen(false);
                    setNewTopicError(null);
                  }
                }}
                placeholder="Topic name"
                className="h-9 w-[260px] max-w-[70vw]"
                disabled={newTopicSaving}
              />
              <Input
                value={newTopicTagsDraft}
                onChange={(event) => setNewTopicTagsDraft(event.target.value)}
                placeholder="Tags (comma separated)"
                className="h-9 w-[240px] max-w-[70vw]"
                disabled={newTopicSaving}
              />
              <label className="flex h-9 items-center gap-2 rounded-full border border-[rgb(var(--claw-border))] px-2 text-[10px] uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">
                Color
                <input
                  type="color"
                  value={newTopicColorDraft}
                  disabled={newTopicSaving}
                  onChange={(event) => {
                    const next = normalizeHexColor(event.target.value);
                    if (next) setNewTopicColorDraft(next);
                  }}
                  className="h-6 w-7 cursor-pointer rounded border border-[rgb(var(--claw-border))] bg-transparent p-0 disabled:cursor-not-allowed"
                />
              </label>
              <Button
                size="sm"
                variant="secondary"
                disabled={newTopicSaving || !newTopicNameDraft.trim() || !normalizeHexColor(newTopicColorDraft)}
                onClick={() => void submitNewTopicDraft()}
              >
                Create
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={newTopicSaving}
                onClick={() => {
                  setNewTopicDraftOpen(false);
                  setNewTopicError(null);
                }}
              >
                Cancel
              </Button>
            </div>
            {newTopicError ? <p className="mt-2 text-xs text-[rgb(var(--claw-warning))]">{newTopicError}</p> : null}
          </div>
        )}
        <div className={cn(twoColumn ? "grid gap-4 md:grid-cols-2" : "space-y-4")}>
        {pagedTopics.map((topic, topicIndex) => {
          const topicId = topic.id;
          const isUnassigned = topicId === "unassigned";
          const deleteKey = `topic:${topic.id}`;
          const taskList = tasksByTopic.get(topicId) ?? [];
          const openCount = taskList.filter((task) => task.status !== "done").length;
          const doingCount = taskList.filter((task) => task.status === "doing").length;
          const blockedCount = taskList.filter((task) => task.status === "blocked").length;
          const lastActivity = logsByTopic.get(topicId)?.[0]?.createdAt ?? topic.updatedAt;
          const topicLogsAll = logsByTopicAll.get(topicId) ?? [];
          const topicChatAllLogs = topicLogsAll.filter((entry) => !entry.taskId && matchesLogSearchChat(entry));
          const topicChatBlurb = deriveChatHeaderBlurb(topicChatAllLogs);
          const showTasks = true;
          const isExpanded = expandedTopicsSafe.has(topicId);
          const topicChatExpanded = expandedTopicChatsSafe.has(topicId);
          const topicChatKey = chatKeyForTopic(topicId);
          const topicChatStart = normalizedSearch
            ? 0
            : computeChatStart(chatHistoryStarts, topicChatKey, topicChatAllLogs.length, TOPIC_TIMELINE_LIMIT);
          const topicChatLogs = topicChatAllLogs.slice(topicChatStart);
          const topicChatTruncated = !normalizedSearch && topicChatStart > 0;
          const topicColor =
            topicDisplayColors.get(topicId) ??
            normalizeHexColor(topic.color) ??
            colorFromSeed(`topic:${topic.id}:${topic.name}`, TOPIC_FALLBACK_COLORS);

          const swipeActions = isUnassigned ? null : (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (readOnly) return;
                  setTopicSwipeOpenId(null);
                  const isPaused = (topic.status ?? "active") === "paused";
                  if (isPaused) {
                    void patchTopic(topicId, { status: "active", snoozedUntil: null });
                    return;
                  }
                  const until = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
                  void patchTopic(topicId, { status: "paused", snoozedUntil: until });
                }}
                disabled={readOnly}
                className={cn(
                  "min-w-[72px] rounded-[var(--radius-sm)] border px-3 text-xs font-semibold transition",
                  "border-[rgba(77,171,158,0.55)] text-[rgb(var(--claw-accent-2))] hover:bg-[rgba(77,171,158,0.14)]",
                  readOnly ? "opacity-60" : ""
                )}
              >
                {(topic.status ?? "active") === "paused" ? "UNSNOOZE" : "SNOOZE"}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (readOnly) return;
                  setTopicSwipeOpenId(null);
                  const isArchived = (topic.status ?? "active") === "archived";
                  void patchTopic(topicId, { status: isArchived ? "active" : "archived", snoozedUntil: null });
                }}
                disabled={readOnly}
                className={cn(
                  "min-w-[72px] rounded-[var(--radius-sm)] border px-3 text-xs font-semibold transition",
                  "border-[rgba(234,179,8,0.55)] text-[rgb(var(--claw-warning))] hover:bg-[rgba(234,179,8,0.14)]",
                  readOnly ? "opacity-60" : ""
                )}
              >
                {(topic.status ?? "active") === "archived" ? "UNARCH" : "ARCHIVE"}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (readOnly) return;
                  setTopicSwipeOpenId(null);
                  const ok = window.confirm(`Delete topic \"${topic.name}\"? This cannot be undone.`);
                  if (!ok) return;
                  setDeleteArmedKey(null);
                  void deleteTopic(topic);
                }}
                disabled={readOnly}
                className={cn(
                  "min-w-[72px] rounded-[var(--radius-sm)] border px-3 text-xs font-semibold transition",
                  "border-[rgba(239,68,68,0.6)] text-[rgb(var(--claw-danger))] hover:bg-[rgba(239,68,68,0.12)]",
                  readOnly ? "opacity-60" : ""
                )}
              >
                DELETE
              </button>
            </>
          );

          const card = (
            <div
              key={topicId}
              data-topic-card-id={topicId}
              className={cn(
                "rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] p-5 transition-colors duration-300",
                draggingTopicId && topicDropTargetId === topicId ? "border-[rgba(255,90,45,0.55)]" : ""
              )}
              style={topicGlowStyle(topicColor, topicIndex, isExpanded)}
            >
              <div
                role="button"
                tabIndex={0}
	                className="flex flex-wrap items-start justify-between gap-4 text-left"
	                onClick={(event) => {
	                  if (!allowToggle(event.target as HTMLElement)) return;
	                  toggleTopicExpanded(topicId);
	                }}
			                onDragEnter={(event) => {
			                  if (!topicReorderEnabled) return;
			                  if (isUnassigned) return;
			                  const dragged = draggingTopicId;
		                  if (!dragged || dragged === topicId) return;
		                  const draggedTopic = topics.find((item) => item.id === dragged);
		                  if (!draggedTopic) return;
		                  if (Boolean(draggedTopic.pinned) !== Boolean(topic.pinned)) return;
		                  event.preventDefault();
		                  setTopicDropTargetId(topicId);
		                }}
		                onDragOver={(event) => {
		                  if (!topicReorderEnabled) return;
		                  if (isUnassigned) return;
		                  const dragged = draggingTopicId;
		                  if (!dragged || dragged === topicId) return;
		                  const draggedTopic = topics.find((item) => item.id === dragged);
		                  if (!draggedTopic) return;
		                  if (Boolean(draggedTopic.pinned) !== Boolean(topic.pinned)) return;
		                  event.preventDefault();
		                  event.dataTransfer.dropEffect = "move";
		                }}
		                onDrop={(event) => {
		                  if (!topicReorderEnabled) return;
		                  if (isUnassigned) return;
		                  event.preventDefault();
		                  const dragged = (draggingTopicId ?? event.dataTransfer.getData("text/plain") ?? "").trim();
		                  if (!dragged || dragged === topicId) return;
		                  const draggedTopic = topics.find((item) => item.id === dragged);
		                  if (!draggedTopic) return;
		                  if (Boolean(draggedTopic.pinned) !== Boolean(topic.pinned)) return;
		                  const order = orderedTopics.filter((item) => item.id !== "unassigned").map((item) => item.id);
		                  const from = order.indexOf(dragged);
		                  const to = order.indexOf(topicId);
		                  const next = moveInArray(order, from, to);
		                  setDraggingTopicId(null);
		                  setTopicDropTargetId(null);
		                  void persistTopicOrder(next);
		                }}
		                aria-expanded={isExpanded}
		              >
	                <div>
	                  <div className="flex items-center gap-2">
		                    <button
		                      type="button"
		                      data-testid={`reorder-topic-${topic.id}`}
		                      aria-label="Reorder topic"
                        data-no-swipe="true"
		                      title={
		                        isUnassigned
		                          ? "Unassigned is a virtual bucket."
		                          : readOnly
		                              ? "Read-only mode. Add token in Setup to reorder."
	                            : topicReorderEnabled
	                              ? "Drag to reorder topics"
	                              : "Clear search and set Status=All to reorder"
	                      }
		                        disabled={readOnly || isUnassigned || !topicReorderEnabled}
		                        draggable={!readOnly && !isUnassigned && topicReorderEnabled}
		                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => beginPointerTopicReorder(event, topic)}
                        onPointerMove={(event) => updatePointerTopicReorder(event)}
                        onPointerUp={() => endPointerTopicReorder()}
                        onPointerCancel={() => endPointerTopicReorder()}
		                        onDragStart={(event) => {
		                          if (readOnly || isUnassigned || !topicReorderEnabled) {
		                            event.preventDefault();
		                            return;
		                          }
	                        event.dataTransfer.effectAllowed = "move";
	                        event.dataTransfer.setData("text/plain", topicId);
	                        setDraggingTopicId(topicId);
	                        setTopicDropTargetId(null);
	                      }}
	                      onDragEnd={() => {
	                        setDraggingTopicId(null);
	                        setTopicDropTargetId(null);
	                      }}
	                      className={cn(
	                        "flex h-7 w-7 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] transition",
	                        readOnly || isUnassigned || !topicReorderEnabled
	                          ? "cursor-not-allowed opacity-50"
	                          : "cursor-grab hover:border-[rgba(255,90,45,0.3)] hover:text-[rgb(var(--claw-text))] active:cursor-grabbing"
		                        )}
		                      >
		                        <GripIcon />
		                      </button>
		                    {editingTopicId === topic.id ? (
		                      <div className="flex flex-wrap items-center gap-2">
		                        <Input
		                          data-testid={`rename-topic-input-${topic.id}`}
		                          value={topicNameDraft}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setTopicNameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void saveTopicRename(topic);
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setEditingTopicId(null);
                              setTopicNameDraft("");
                              setDeleteArmedKey(null);
                              setRenameError(`topic:${topic.id}`);
                            }
                          }}
		                          placeholder="Rename topic"
		                          className="h-9 w-[260px] max-w-[70vw]"
		                        />
		                        <Input
		                          value={topicTagsDraft}
		                          onClick={(event) => event.stopPropagation()}
		                          onChange={(event) => setTopicTagsDraft(event.target.value)}
		                          placeholder="Tags (comma separated)"
		                          className="h-9 w-[240px] max-w-[70vw]"
		                        />
		                        <label
		                          className="flex h-9 items-center gap-2 rounded-full border border-[rgb(var(--claw-border))] px-2 text-[10px] uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]"
		                          onClick={(event) => event.stopPropagation()}
		                        >
                          Color
                          <input
                            data-testid={`rename-topic-color-${topic.id}`}
                            type="color"
                            value={topicColorDraft}
                            disabled={readOnly}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => {
                              const next = normalizeHexColor(event.target.value);
                              if (next) setTopicColorDraft(next);
                            }}
                            className="h-6 w-7 cursor-pointer rounded border border-[rgb(var(--claw-border))] bg-transparent p-0 disabled:cursor-not-allowed"
                          />
                        </label>
                        <Button
                          data-testid={`save-topic-rename-${topic.id}`}
                          size="sm"
                          variant="secondary"
                          disabled={
                            readOnly ||
                            renameSavingKey === `topic:${topic.id}` ||
                            !topicNameDraft.trim() ||
                            !normalizeHexColor(topicColorDraft)
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            void saveTopicRename(topic);
                          }}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
		                          onClick={(event) => {
		                            event.stopPropagation();
		                            setEditingTopicId(null);
		                            setTopicNameDraft("");
		                            setTopicColorDraft(topicColor);
		                            setTopicTagsDraft("");
		                            setDeleteArmedKey(null);
		                            setRenameError(`topic:${topic.id}`);
		                          }}
		                        >
                          Cancel
                        </Button>
                        {deleteArmedKey === deleteKey ? (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                              disabled={readOnly || deleteInFlightKey === deleteKey}
                              onClick={(event) => {
                                event.stopPropagation();
                                void deleteTopic(topic);
                              }}
                            >
                              {deleteInFlightKey === deleteKey
                                ? isUnassigned
                                  ? "Clearing..."
                                  : "Deleting..."
                                : isUnassigned
                                  ? "Confirm clear"
                                  : "Confirm delete"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDeleteArmedKey(null);
                              }}
                            >
                              Keep
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[rgb(var(--claw-danger))]"
                            disabled={readOnly}
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteArmedKey(deleteKey);
                              setRenameError(deleteKey);
                            }}
                          >
                            {isUnassigned ? "Clear unassigned" : "Delete"}
                          </Button>
                        )}
			              </div>
                    ) : (
                      <>
                        <h2 className="text-lg font-semibold">{topic.name}</h2>
                        <button
                          type="button"
                          data-testid={`rename-topic-${topic.id}`}
                          aria-label={`Rename topic ${topic.name}`}
                          title={
                            topic.id === "unassigned"
                              ? "Unassigned is a virtual bucket."
                              : readOnly
                                ? "Read-only mode. Add token in Setup to rename."
                                : "Rename topic"
                          }
                          disabled={readOnly || topic.id === "unassigned"}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (readOnly || topic.id === "unassigned") return;
                            setEditingTaskId(null);
                            setTaskNameDraft("");
                            setTaskColorDraft(TASK_FALLBACK_COLORS[0]);
                            setEditingTopicId(topic.id);
                            setTopicNameDraft(topic.name);
                            setTopicColorDraft(topicColor);
                            setTopicTagsDraft(formatTags(topic.tags));
                            setDeleteArmedKey(null);
                            setRenameError(`topic:${topic.id}`);
                          }}
                          className={cn(
                            "flex h-7 w-7 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] transition",
                            readOnly || topic.id === "unassigned"
                              ? "cursor-not-allowed opacity-60"
                              : "cursor-pointer hover:border-[rgba(255,90,45,0.3)] hover:text-[rgb(var(--claw-text))]"
                          )}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                          </svg>
                        </button>
                      </>
                    )}
                    <PinToggle
                      topic={topic}
                      size="sm"
                      onToggled={(nextPinned) =>
                        setTopics((prev) =>
                          prev.map((item) =>
                            item.id === topic.id ? { ...item, pinned: nextPinned, updatedAt: new Date().toISOString() } : item
                          )
                        )
                      }
                    />
                  </div>
                  {renameErrors[`topic:${topic.id}`] && (
                    <p className="mt-1 text-xs text-[rgb(var(--claw-warning))]">{renameErrors[`topic:${topic.id}`]}</p>
                  )}
                  {isExpanded && <p className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{topic.description}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[rgb(var(--claw-muted))]">
                    <span>{taskList.length} tasks</span>
                    <span>{openCount} open</span>
                    {isExpanded && <span>{doingCount} doing</span>}
                    {isExpanded && <span>{blockedCount} blocked</span>}
                    <span>Last activity {formatRelativeTime(lastActivity)}</span>
                  </div>
                </div>
	                <button
	                  type="button"
	                  aria-label={isExpanded ? `Collapse topic ${topic.name}` : `Expand topic ${topic.name}`}
	                  title={isExpanded ? "Collapse" : "Expand"}
	                  onClick={(event) => {
	                    event.stopPropagation();
	                    toggleTopicExpanded(topicId);
	                  }}
	                  className={cn(
	                    "flex h-9 w-9 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-lg text-[rgb(var(--claw-muted))] transition",
	                    "hover:border-[rgba(255,90,45,0.3)] hover:text-[rgb(var(--claw-text))]"
	                  )}
	                >
		                  {isExpanded ? "▾" : "▸"}
		                </button>
		              </div>
	
	              {isExpanded && showTasks && (
		                <div className="mt-4 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          value={newTaskDraftByTopicId[topicId === "unassigned" ? "unassigned" : topicId] ?? ""}
                          onChange={(event) => {
                            const key = topicId === "unassigned" ? "unassigned" : topicId;
                            const next = event.target.value;
                            newTaskDraftEditedAtRef.current.set(key, Date.now());
                            setNewTaskDraftByTopicId((prev) => ({ ...prev, [key]: next }));
                            queueDraftUpsert(`draft:new-task:${key}`, next);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            const key = topicId === "unassigned" ? "unassigned" : topicId;
                            const scopeTopicId = topicId === "unassigned" ? null : topicId;
                            const draft = newTaskDraftByTopicId[key] ?? "";
                            void createTask(scopeTopicId, draft);
                          }}
                          placeholder="Add a task…"
                          disabled={readOnly || newTaskSavingKey === (topicId === "unassigned" ? "unassigned" : topicId)}
                          className="h-9 min-w-[220px] flex-1 text-sm"
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={readOnly || newTaskSavingKey === (topicId === "unassigned" ? "unassigned" : topicId)}
                          onClick={() => {
                            const key = topicId === "unassigned" ? "unassigned" : topicId;
                            const scopeTopicId = topicId === "unassigned" ? null : topicId;
                            const draft = newTaskDraftByTopicId[key] ?? "";
                            void createTask(scopeTopicId, draft);
                          }}
                        >
                          {newTaskSavingKey === (topicId === "unassigned" ? "unassigned" : topicId) ? "Adding..." : "+ Task"}
                        </Button>
                        {readOnly ? (
                          <span className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add token in Setup to add tasks.</span>
                        ) : null}
                      </div>
	                  {taskList.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No tasks yet.</p>}
	                  {taskList
	                    .filter((task) => {
	                      if (!matchesStatusFilter(task)) return false;
                      return matchesTaskSearch(task);
                    })
                    .map((task, taskIndex) => {
                      if (normalizedSearch && !matchesTaskSearch(task) && !`${topic.name} ${topic.description ?? ""}`.toLowerCase().includes(normalizedSearch)) {
                        return null;
                      }
                      const taskLogs = logsByTaskAll.get(task.id) ?? [];
                      const taskExpanded = expandedTasksSafe.has(task.id);
                      const taskColor =
                        taskDisplayColors.get(task.id) ??
                        normalizeHexColor(task.color) ??
                        colorFromSeed(`task:${task.id}:${task.title}`, TASK_FALLBACK_COLORS);
                      const taskSnoozedUntil = (task.snoozedUntil ?? "").trim();
                      const taskSnoozedStamp = taskSnoozedUntil ? Date.parse(taskSnoozedUntil) : Number.NaN;
                      const taskIsSnoozed = Number.isFinite(taskSnoozedStamp) && taskSnoozedStamp > Date.now();
                      const taskSwipeActions = (
                        <>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (readOnly) return;
                              setTaskSwipeOpenId(null);
                              if (taskIsSnoozed) {
                                void updateTask(task.id, { snoozedUntil: null });
                                return;
                              }
                              const until = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
                              void updateTask(task.id, { snoozedUntil: until });
                            }}
                            disabled={readOnly}
                            className={cn(
                              "min-w-[72px] rounded-[var(--radius-sm)] border px-3 text-xs font-semibold transition",
                              "border-[rgba(77,171,158,0.55)] text-[rgb(var(--claw-accent-2))] hover:bg-[rgba(77,171,158,0.14)]",
                              readOnly ? "opacity-60" : ""
                            )}
                          >
                            {taskIsSnoozed ? "UNSNOOZE" : "SNOOZE"}
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (readOnly) return;
                              setTaskSwipeOpenId(null);
                              const isArchived = task.status === "done";
                              void updateTask(task.id, { status: isArchived ? "todo" : "done", snoozedUntil: null });
                            }}
                            disabled={readOnly}
                            className={cn(
                              "min-w-[72px] rounded-[var(--radius-sm)] border px-3 text-xs font-semibold transition",
                              "border-[rgba(234,179,8,0.55)] text-[rgb(var(--claw-warning))] hover:bg-[rgba(234,179,8,0.14)]",
                              readOnly ? "opacity-60" : ""
                            )}
                          >
                            {task.status === "done" ? "UNARCH" : "ARCHIVE"}
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (readOnly) return;
                              setTaskSwipeOpenId(null);
                              const ok = window.confirm(`Delete task \"${task.title}\"? This cannot be undone.`);
                              if (!ok) return;
                              setDeleteArmedKey(null);
                              void deleteTask(task);
                            }}
                            disabled={readOnly}
                            className={cn(
                              "min-w-[72px] rounded-[var(--radius-sm)] border px-3 text-xs font-semibold transition",
                              "border-[rgba(239,68,68,0.6)] text-[rgb(var(--claw-danger))] hover:bg-[rgba(239,68,68,0.12)]",
                              readOnly ? "opacity-60" : ""
                            )}
                          >
                            DELETE
                          </button>
                        </>
                      );
                      const taskChatAllLogs = taskLogs.filter(matchesLogSearchChat);
                      const taskChatBlurb = deriveChatHeaderBlurb(taskChatAllLogs);
                      const taskChatKey = chatKeyForTask(task.id);
                      const start = normalizedSearch
                        ? 0
                        : computeChatStart(chatHistoryStarts, taskChatKey, taskChatAllLogs.length, TASK_TIMELINE_LIMIT);
                      const limitedLogs = taskChatAllLogs.slice(start);
                      const truncated = !normalizedSearch && start > 0;
	                      return (
                          <SwipeRevealRow
                            key={task.id}
                            rowId={task.id}
                            openId={taskSwipeOpenId}
                            setOpenId={setTaskSwipeOpenId}
                            actions={taskSwipeActions}
                          >
		                        <div
                              data-task-card-id={task.id}
		                          className={cn(
		                            "rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] p-4 transition-colors duration-300",
		                            draggingTaskId && taskDropTargetId === task.id ? "border-[rgba(77,171,158,0.55)]" : ""
		                          )}
		                          style={taskGlowStyle(taskColor, taskIndex, taskExpanded)}
		                        >
                          <div
                            role="button"
                            tabIndex={0}
	                            className="flex flex-wrap items-center justify-between gap-3 text-left"
	                            onClick={(event) => {
	                              if (!allowToggle(event.target as HTMLElement)) return;
	                              toggleTaskExpanded(task.id);
	                            }}
		                            onDragEnter={(event) => {
		                              if (!taskReorderEnabled) return;
		                              const dragged = draggingTaskId;
		                              if (!dragged || dragged === task.id) return;
	                              if (draggingTaskTopicId !== topicId) return;
	                              const draggedTask = taskList.find((item) => item.id === dragged);
	                              if (!draggedTask) return;
	                              if (Boolean(draggedTask.pinned) !== Boolean(task.pinned)) return;
	                              event.preventDefault();
	                              setTaskDropTargetId(task.id);
	                            }}
	                            onDragOver={(event) => {
	                              if (!taskReorderEnabled) return;
	                              const dragged = draggingTaskId;
	                              if (!dragged || dragged === task.id) return;
	                              if (draggingTaskTopicId !== topicId) return;
	                              const draggedTask = taskList.find((item) => item.id === dragged);
	                              if (!draggedTask) return;
	                              if (Boolean(draggedTask.pinned) !== Boolean(task.pinned)) return;
	                              event.preventDefault();
	                              event.dataTransfer.dropEffect = "move";
	                            }}
	                            onDrop={(event) => {
	                              if (!taskReorderEnabled) return;
	                              event.preventDefault();
	                              const dragged = (draggingTaskId ?? event.dataTransfer.getData("text/plain") ?? "").trim();
	                              if (!dragged || dragged === task.id) return;
	                              if (draggingTaskTopicId !== topicId) return;
	                              const draggedTask = taskList.find((item) => item.id === dragged);
	                              if (!draggedTask) return;
	                              if (Boolean(draggedTask.pinned) !== Boolean(task.pinned)) return;
	                              const order = taskList.map((item) => item.id);
	                              const from = order.indexOf(dragged);
	                              const to = order.indexOf(task.id);
	                              const next = moveInArray(order, from, to);
	                              setDraggingTaskId(null);
	                              setDraggingTaskTopicId(null);
	                              setTaskDropTargetId(null);
	                              void persistTaskOrder(topicId === "unassigned" ? null : topicId, next);
	                            }}
	                            aria-expanded={taskExpanded}
	                          >
	                          <div>
		                            <div className="flex items-center gap-2 text-sm font-semibold">
		                              <button
		                                type="button"
		                                data-testid={`reorder-task-${task.id}`}
		                                aria-label="Reorder task"
		                                title={
		                                  readOnly
		                                    ? "Read-only mode. Add token in Setup to reorder."
		                                    : taskReorderEnabled
		                                      ? "Drag to reorder tasks"
		                                      : "Clear search, set Status=All, and show done tasks to reorder"
		                                }
		                                disabled={readOnly || !taskReorderEnabled}
		                                draggable={!readOnly && taskReorderEnabled}
		                                onClick={(event) => event.stopPropagation()}
                                    onPointerDown={(event) =>
                                      beginPointerTaskReorder(event, task, topicId === "unassigned" ? null : topicId, taskList)
                                    }
                                    onPointerMove={(event) => updatePointerTaskReorder(event)}
                                    onPointerUp={() => endPointerTaskReorder()}
                                    onPointerCancel={() => endPointerTaskReorder()}
		                                onDragStart={(event) => {
		                                  if (readOnly || !taskReorderEnabled) {
		                                    event.preventDefault();
		                                    return;
		                                  }
	                                  event.dataTransfer.effectAllowed = "move";
	                                  event.dataTransfer.setData("text/plain", task.id);
	                                  setDraggingTaskId(task.id);
	                                  setDraggingTaskTopicId(topicId);
	                                  setTaskDropTargetId(null);
	                                }}
	                                onDragEnd={() => {
	                                  setDraggingTaskId(null);
	                                  setDraggingTaskTopicId(null);
	                                  setTaskDropTargetId(null);
	                                }}
		                                className={cn(
		                                  "flex h-7 w-7 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] transition",
		                                  readOnly || !taskReorderEnabled
		                                    ? "cursor-not-allowed opacity-50"
		                                    : "cursor-grab hover:border-[rgba(77,171,158,0.4)] hover:text-[rgb(var(--claw-text))] active:cursor-grabbing"
		                                )}
		                              >
		                                <GripIcon />
		                              </button>
		                              {editingTaskId === task.id ? (
		                                <div className="flex flex-wrap items-center gap-2">
		                                  <Input
		                                    data-testid={`rename-task-input-${task.id}`}
		                                    value={taskNameDraft}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={(event) => setTaskNameDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        void saveTaskRename(task);
                                      }
                                      if (event.key === "Escape") {
                                        event.preventDefault();
                                        setEditingTaskId(null);
                                        setTaskNameDraft("");
                                        setMoveTaskId(null);
                                        setDeleteArmedKey(null);
                                        setRenameError(`task:${task.id}`);
                                      }
                                    }}
		                                    placeholder="Rename task"
		                                    className="h-9 w-[280px] max-w-[68vw]"
		                                  />
		                                  <Input
		                                    value={taskTagsDraft}
		                                    onClick={(event) => event.stopPropagation()}
		                                    onChange={(event) => setTaskTagsDraft(event.target.value)}
		                                    placeholder="Tags (comma separated)"
		                                    className="h-9 w-[240px] max-w-[68vw]"
		                                  />
		                                  <Select
		                                    data-testid={`task-status-${task.id}`}
		                                    value={task.status}
                                    disabled={readOnly}
                                    className="h-9 w-[128px] text-xs"
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={(event) => {
                                      event.stopPropagation();
                                      const nextStatus = event.target.value as Task["status"];
                                      if (nextStatus !== task.status) {
                                        void updateTask(task.id, { status: nextStatus });
                                      }
                                    }}
                                  >
                                    <option value="todo">To Do</option>
                                    <option value="doing">Doing</option>
                                    <option value="blocked">Blocked</option>
                                    <option value="done">Done</option>
                                  </Select>
                                  <label
                                    className="flex h-9 items-center gap-2 rounded-full border border-[rgb(var(--claw-border))] px-2 text-[10px] uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    Color
                                    <input
                                      data-testid={`rename-task-color-${task.id}`}
                                      type="color"
                                      value={taskColorDraft}
                                      disabled={readOnly}
                                      onClick={(event) => event.stopPropagation()}
                                      onChange={(event) => {
                                        const next = normalizeHexColor(event.target.value);
                                        if (next) setTaskColorDraft(next);
                                      }}
                                      className="h-6 w-7 cursor-pointer rounded border border-[rgb(var(--claw-border))] bg-transparent p-0 disabled:cursor-not-allowed"
                                    />
                                  </label>
                                  {moveTaskId !== task.id ? (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={readOnly}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setMoveTaskId(task.id);
                                      }}
                                    >
                                      Move
                                    </Button>
                                  ) : (
                                    <>
                                      <Select
                                        value={task.topicId ?? ""}
                                        onChange={async (event) => {
                                          event.stopPropagation();
                                          await updateTask(task.id, { topicId: event.target.value || null });
                                          setMoveTaskId(null);
                                        }}
                                        className="h-9 w-auto min-w-[180px] max-w-[240px] text-xs"
                                        disabled={readOnly}
                                        onClick={(event) => event.stopPropagation()}
                                      >
                                        <option value="">Unassigned</option>
                                        {topics.map((topicOption) => (
                                          <option key={topicOption.id} value={topicOption.id}>
                                            {topicOption.name}
                                          </option>
                                        ))}
                                      </Select>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setMoveTaskId(null);
                                        }}
                                      >
                                        Cancel move
                                      </Button>
                                    </>
                                  )}
                                  <Button
                                    data-testid={`save-task-rename-${task.id}`}
                                    size="sm"
                                    variant="secondary"
                                    disabled={
                                      readOnly ||
                                      renameSavingKey === `task:${task.id}` ||
                                      !taskNameDraft.trim() ||
                                      !normalizeHexColor(taskColorDraft)
                                    }
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void saveTaskRename(task);
                                    }}
                                  >
                                    Save
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
		                                    onClick={(event) => {
		                                      event.stopPropagation();
		                                      setEditingTaskId(null);
		                                      setTaskNameDraft("");
		                                      setTaskColorDraft(taskColor);
		                                      setTaskTagsDraft("");
		                                      setMoveTaskId(null);
		                                      setDeleteArmedKey(null);
		                                      setRenameError(`task:${task.id}`);
		                                    }}
		                                  >
                                    Cancel
                                  </Button>
                                  {deleteArmedKey === `task:${task.id}` ? (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="secondary"
                                        className="border-[rgba(239,68,68,0.45)] text-[rgb(var(--claw-danger))]"
                                        disabled={readOnly || deleteInFlightKey === `task:${task.id}`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void deleteTask(task);
                                        }}
                                      >
                                        {deleteInFlightKey === `task:${task.id}` ? "Deleting..." : "Confirm delete"}
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setDeleteArmedKey(null);
                                        }}
                                      >
                                        Keep
                                      </Button>
                                    </>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="text-[rgb(var(--claw-danger))]"
                                      disabled={readOnly}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setDeleteArmedKey(`task:${task.id}`);
                                        setRenameError(`task:${task.id}`);
                                      }}
                                    >
                                      Delete
                                    </Button>
                                  )}
                                </div>
                              ) : (
                                <>
                                  <span>{task.title}</span>
                                  <button
                                    type="button"
                                    data-testid={`rename-task-${task.id}`}
                                    aria-label={`Rename task ${task.title}`}
                                    title={readOnly ? "Read-only mode. Add token in Setup to rename." : "Rename task"}
                                    disabled={readOnly}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (readOnly) return;
                                      setEditingTopicId(null);
                                      setTopicNameDraft("");
                                      setTopicColorDraft(TOPIC_FALLBACK_COLORS[0]);
                                      setEditingTaskId(task.id);
                                      setTaskNameDraft(task.title);
                                      setTaskColorDraft(taskColor);
                                      setTaskTagsDraft(formatTags(task.tags));
                                      setMoveTaskId(null);
                                      setDeleteArmedKey(null);
                                      setRenameError(`task:${task.id}`);
                                    }}
                                    className={cn(
                                      "flex h-7 w-7 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] transition",
                                      readOnly
                                        ? "cursor-not-allowed opacity-60"
                                        : "cursor-pointer hover:border-[rgba(255,90,45,0.3)] hover:text-[rgb(var(--claw-text))]"
                                    )}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                      <path d="M12 20h9" />
                                      <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                                    </svg>
                                  </button>
                                </>
                              )}
                              <TaskPinToggle
                                task={task}
                                size="sm"
                                onToggled={(nextPinned) =>
                                  setTasks((prev) =>
                                    prev.map((item) =>
                                      item.id === task.id ? { ...item, pinned: nextPinned, updatedAt: new Date().toISOString() } : item
                                    )
                                  )
                                }
                              />
                            </div>
                            {renameErrors[`task:${task.id}`] && (
                              <div className="mt-1 text-xs text-[rgb(var(--claw-warning))]">{renameErrors[`task:${task.id}`]}</div>
                            )}
                            <div className="mt-1 text-xs text-[rgb(var(--claw-muted))]">
                              {taskExpanded ? "Updated" : "Last touch"} {formatRelativeTime(task.updatedAt)}
                            </div>
                          </div>
	                          <div className="flex items-center gap-2">
	                            <StatusPill tone={STATUS_TONE[task.status]} label={STATUS_LABELS[task.status] ?? task.status} />
	                            {isSessionResponding(taskSessionKey(topicId, task.id)) ? (
	                              <span title="OpenClaw responding" className="inline-flex items-center">
	                                <TypingDots />
	                              </span>
	                            ) : null}
	                            <button
	                              type="button"
	                              aria-label={taskExpanded ? `Collapse task ${task.title}` : `Expand task ${task.title}`}
	                              title={taskExpanded ? "Collapse" : "Expand"}
	                              onClick={(event) => {
	                                event.stopPropagation();
	                                toggleTaskExpanded(task.id);
	                              }}
	                              className={cn(
	                                "flex h-9 w-9 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-lg text-[rgb(var(--claw-muted))] transition",
	                                "hover:border-[rgba(77,171,158,0.45)] hover:text-[rgb(var(--claw-text))]"
	                              )}
	                            >
	                              {taskExpanded ? "▾" : "▸"}
	                            </button>
	                          </div>
		                        </div>
			                        {taskExpanded && (
			                          <div className="mt-4 pt-3">
				                              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
				                                <div className="flex min-w-0 items-center gap-2">
				                                  <div className="shrink-0 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">
				                                    TASK CHAT
				                                  </div>
				                                  {isSessionResponding(taskSessionKey(topicId, task.id)) ? (
				                                    <TypingDots />
				                                  ) : null}
				                                  {taskChatBlurb ? (
				                                    <>
				                                      <span className="text-xs text-[rgba(var(--claw-muted),0.55)]">·</span>
				                                      <div
				                                        className="min-w-0 max-w-[56ch] truncate text-xs text-[rgba(var(--claw-muted),0.9)]"
				                                        title={taskChatBlurb.full}
				                                      >
				                                        {taskChatBlurb.clipped}
				                                      </div>
				                                    </>
				                                  ) : null}
				                                </div>
				                                <div className="flex items-center gap-2">
				                                  {truncated ? (
				                                    <Button
				                                      size="sm"
			                                      variant="secondary"
			                                      onClick={() =>
			                                        loadOlderChat(taskChatKey, TASK_TIMELINE_LIMIT, taskChatAllLogs.length, TASK_TIMELINE_LIMIT)
			                                      }
			                                    >
			                                      Load older
			                                    </Button>
			                                  ) : null}
			                                  <span className="text-xs text-[rgb(var(--claw-muted))]">{taskChatAllLogs.length} entries</span>
			                                </div>
			                              </div>
		                              {taskChatAllLogs.length === 0 ? (
		                                <p className="mb-3 text-sm text-[rgb(var(--claw-muted))]">No messages yet.</p>
		                              ) : null}
                                <div className="relative">
                                  <div
                                    className={cn(
                                      "pointer-events-none absolute left-0 right-0 top-0 z-10 h-8 bg-[linear-gradient(to_bottom,rgb(var(--claw-panel)/0.55),rgb(var(--claw-panel)/0.16)_55%,rgb(var(--claw-panel)/0.0))] backdrop-blur-[1px] transition-opacity duration-200 ease-out",
                                      chatTopFade[`task:${task.id}`] ? "opacity-100" : "opacity-0"
                                    )}
                                  />
                                  <div
                                    className={cn(
                                      "pointer-events-none absolute left-0 right-0 bottom-0 z-10 h-10 bg-[linear-gradient(to_top,rgb(var(--claw-panel)/0.42),rgb(var(--claw-panel)/0.12)_55%,rgb(var(--claw-panel)/0.0))] backdrop-blur-[1px] transition-opacity duration-200 ease-out",
                                      chatBottomFade[`task:${task.id}`] ? "opacity-100" : "opacity-0"
                                    )}
                                  />
                                  <div
                                    ref={(node) => {
                                      const key = `task:${task.id}`;
                                      setChatScroller(key, node);
                                      if (node && typeof window !== "undefined") {
                                        window.requestAnimationFrame(() => {
                                          const showTop = node.scrollTop > 2;
                                          const remaining = node.scrollHeight - (node.scrollTop + node.clientHeight);
                                          const showBottom = remaining > 2;
                                          setChatTopFade((prev) =>
                                            prev[key] === showTop ? prev : { ...prev, [key]: showTop }
                                          );
                                          setChatBottomFade((prev) =>
                                            prev[key] === showBottom ? prev : { ...prev, [key]: showBottom }
                                          );
                                        });
                                      }
                                    }}
                                    onScroll={(event) => {
                                      const key = `task:${task.id}`;
                                      const node = event.currentTarget;
                                      const showTop = node.scrollTop > 2;
                                      const remaining = node.scrollHeight - (node.scrollTop + node.clientHeight);
                                      const showBottom = remaining > 2;
                                      chatAtBottomRef.current.set(key, remaining <= CHAT_AUTO_SCROLL_THRESHOLD_PX);
                                      setChatTopFade((prev) =>
                                        prev[key] === showTop ? prev : { ...prev, [key]: showTop }
                                      );
                                      setChatBottomFade((prev) =>
                                        prev[key] === showBottom ? prev : { ...prev, [key]: showBottom }
                                      );
                                      if (!normalizedSearch && truncated && node.scrollTop <= 28) {
                                        const now = Date.now();
                                        const last = chatLoadOlderCooldownRef.current.get(key) ?? 0;
                                        if (now - last > 350) {
                                          chatLoadOlderCooldownRef.current.set(key, now);
                                          loadOlderChat(key, TASK_TIMELINE_LIMIT, taskChatAllLogs.length, TASK_TIMELINE_LIMIT);
                                        }
                                      }
                                      if (activeChatKeyRef.current === key) updateActiveChatAtBottom();
                                    }}
                                    className="overflow-y-auto pr-1"
                                    style={{
                                      // Keep the composer visible while allowing long conversations to scroll within the chat pane.
                                      maxHeight: "max(240px, calc(100dvh - var(--claw-header-h, 0px) - 360px))",
                                    }}
                                  >
                                    <LogList
                                      logs={limitedLogs}
                                      topics={topics}
                                      tasks={tasks}
                                      scopeTopicId={topicId}
                                      scopeTaskId={task.id}
                                      showFilters={false}
                                      showRawToggle={false}
                                      showDensityToggle={false}
                                      showRawAll={showRaw}
                                      messageDensity={messageDensity}
                                      allowNotes
                                      variant="chat"
                                      enableNavigation={false}
                                    />
                                  </div>
                                </div>
				                              {/* Load more moved into the chat header (top-right). */}
				                              {!isUnassigned && (
				                                <>
				                                  {pendingMessages
				                                    .filter((pending) => pending.sessionKey === taskSessionKey(topicId, task.id))
				                                    .map((pending) => (
				                                      <div key={pending.localId} className="py-1">
				                                        <div className="flex justify-end">
				                                          <div className="w-full max-w-[78%]">
				                                            <div
				                                              className={cn(
				                                                "rounded-[20px] border px-4 py-3 text-sm leading-relaxed",
				                                                pending.status === "failed" ? "opacity-90" : "",
				                                                "border-[rgba(36,145,255,0.35)] bg-[rgba(36,145,255,0.16)] text-[rgb(var(--claw-text))]"
				                                              )}
				                                            >
                                              {pending.attachments && pending.attachments.length > 0 ? (
                                                <AttachmentStrip attachments={pending.attachments} className="mt-0 mb-3" />
                                              ) : null}
                                              <Markdown>{pending.message}</Markdown>
				                                            </div>
				                                            <div className="mt-1 text-right text-[10px] text-[rgba(148,163,184,0.9)]">
				                                              {pending.status === "sending"
				                                                ? "Sending…"
				                                                : pending.status === "sent"
				                                                  ? "Sent"
				                                                  : pending.error
				                                                    ? pending.error
				                                                    : "Failed to send."}
				                                            </div>
				                                          </div>
				                                        </div>
				                                      </div>
				                                    ))}
				                                  {isSessionResponding(taskSessionKey(topicId, task.id)) ? (
				                                    <div className="py-1">
				                                      <div className="flex justify-start">
				                                        <div className="w-full max-w-[78%]">
				                                          <div className="rounded-[20px] border border-[rgba(255,255,255,0.12)] bg-[rgba(20,24,31,0.8)] px-4 py-3 text-sm text-[rgb(var(--claw-text))]">
				                                            <div className="flex items-center gap-2">
				                                              <span className="text-xs text-[rgba(148,163,184,0.9)]">OpenClaw</span>
				                                              <TypingDots />
				                                            </div>
				                                          </div>
				                                        </div>
				                                      </div>
				                                    </div>
				                                  ) : null}
				                                <BoardChatComposer
                                      ref={(node) => {
                                        const key = taskSessionKey(topicId, task.id);
                                        if (node) composerHandlesRef.current.set(key, node);
                                        else composerHandlesRef.current.delete(key);
                                      }}
			                                  sessionKey={taskSessionKey(topicId, task.id)}
			                                  className="mt-4"
			                                  variant="seamless"
			                                  placeholder={`Message ${task.title}…`}
			                                  onFocus={() => {
			                                    setActiveComposer({ kind: "task", topicId, taskId: task.id });
			                                  }}
			                                  onBlur={() =>
			                                    setActiveComposer((prev) =>
			                                      prev?.kind === "task" && prev.taskId === task.id ? null : prev
			                                    )
			                                  }
			                                  autoFocus={autoFocusTask?.taskId === task.id}
			                                  onAutoFocusApplied={() =>
			                                    setAutoFocusTask((prev) => (prev?.taskId === task.id ? null : prev))
			                                  }
			                                  onSendUpdate={(event) => {
			                                    if (!event) return;
			                                    markRecentBoardSend(event.sessionKey);
			                                    if (event.phase === "sending") {
			                                      setAwaitingAssistant((prev) => ({
			                                        ...prev,
			                                        [event.sessionKey]: { sentAt: event.createdAt },
			                                      }));
			                                      setPendingMessages((prev) => [
			                                        ...prev.filter((item) => item.localId !== event.localId),
			                                        {
			                                          localId: event.localId,
			                                          sessionKey: event.sessionKey,
			                                          message: event.message,
			                                          attachments: event.attachments,
			                                          createdAt: event.createdAt,
			                                          status: "sending",
			                                        },
			                                      ]);
			                                    } else if (event.phase === "queued") {
			                                      setAwaitingAssistant((prev) => ({
			                                        ...prev,
			                                        [event.sessionKey]: { sentAt: event.createdAt, requestId: event.requestId },
			                                      }));
			                                      setPendingMessages((prev) =>
			                                        prev.map((item) =>
			                                          item.localId === event.localId
			                                            ? { ...item, requestId: event.requestId, status: "sent" }
			                                            : item
			                                        )
			                                      );
			                                    } else if (event.phase === "failed") {
			                                      setAwaitingAssistant((prev) => {
			                                        if (!Object.prototype.hasOwnProperty.call(prev, event.sessionKey)) return prev;
			                                        const next = { ...prev };
			                                        delete next[event.sessionKey];
			                                        return next;
			                                      });
			                                      setPendingMessages((prev) =>
			                                        prev.map((item) =>
			                                          item.localId === event.localId
			                                            ? { ...item, status: "failed", error: event.error }
			                                            : item
			                                        )
			                                      );
			                                    }
			                                    const chatKey = chatKeyFromSessionKey(event.sessionKey);
			                                    if (chatKey) {
			                                      activeChatKeyRef.current = chatKey;
			                                      activeChatAtBottomRef.current = true;
			                                      scheduleScrollChatToBottom(chatKey);
			                                    }
			                                  }}
			                                  testId={`task-chat-composer-${task.id}`}
				                                />
				                                </>
				                              )}
			                          </div>
			                        )}
			                      </div>
                          </SwipeRevealRow>
                    );
                    })}
	                  {/* Intentionally omit "No tasks match your filters." to keep topic cards visually tight. */}

                  {!isUnassigned && (
                    <div
                      className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] p-4 transition-colors duration-300"
                      style={taskGlowStyle(topicColor, taskList.length, topicChatExpanded)}
                    >
                      <div
                        role="button"
                        tabIndex={0}
	                        className="flex flex-wrap items-center justify-between gap-3 text-left"
	                        onClick={(event) => {
	                          if (!allowToggle(event.target as HTMLElement)) return;
	                          toggleTopicChatExpanded(topicId);
	                        }}
	                        aria-expanded={topicChatExpanded}
	                      >
			                        <div className="min-w-0">
			                          <div className="flex min-w-0 items-center gap-2">
			                            <div className="shrink-0 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">
			                              TOPIC CHAT
			                            </div>
			                            {isSessionResponding(topicSessionKey(topicId)) ? <TypingDots /> : null}
			                            {topicChatBlurb ? (
			                              <>
			                                <span className="text-xs text-[rgba(var(--claw-muted),0.55)]">·</span>
			                                <div
			                                  className="min-w-0 max-w-[56ch] truncate text-xs text-[rgba(var(--claw-muted),0.9)]"
			                                  title={topicChatBlurb.full}
			                                >
			                                  {topicChatBlurb.clipped}
			                                </div>
			                              </>
			                            ) : null}
			                          </div>
			                          <div className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{topicChatAllLogs.length} entries</div>
			                        </div>
				                        <button
				                          type="button"
				                          data-testid={`toggle-topic-chat-${topicId}`}
			                          aria-label={topicChatExpanded ? `Collapse topic chat for ${topic.name}` : `Expand topic chat for ${topic.name}`}
			                          title={topicChatExpanded ? "Collapse" : "Expand"}
			                          onClick={(event) => {
			                            event.stopPropagation();
			                            toggleTopicChatExpanded(topicId);
			                          }}
			                          className={cn(
			                            "flex h-9 w-9 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-lg text-[rgb(var(--claw-muted))] transition",
			                            "hover:border-[rgba(255,90,45,0.3)] hover:text-[rgb(var(--claw-text))]"
			                          )}
			                        >
			                          {topicChatExpanded ? "▾" : "▸"}
			                        </button>
		                      </div>
		                      {topicChatExpanded && (
		                        <div className="mt-4 pt-3">
				                        <div className="mb-3 flex items-center justify-end gap-2">
				                          {topicChatTruncated ? (
				                            <Button
				                              size="sm"
				                              variant="secondary"
				                              onClick={(event) => {
				                                event.stopPropagation();
				                                event.preventDefault();
				                                loadOlderChat(topicChatKey, TOPIC_TIMELINE_LIMIT, topicChatAllLogs.length, TOPIC_TIMELINE_LIMIT);
				                              }}
				                            >
				                              Load older
				                            </Button>
				                          ) : null}
				                          <span className="text-xs text-[rgb(var(--claw-muted))]">{topicChatAllLogs.length} entries</span>
				                        </div>
		                          {topicChatAllLogs.length === 0 ? (
		                            <p className="mb-3 text-sm text-[rgb(var(--claw-muted))]">No messages yet.</p>
		                          ) : null}
		                          <div className="relative">
		                            <div
		                              className={cn(
		                                // Subtle iMessage-style fade when there is scroll content above/below.
		                                "pointer-events-none absolute left-0 right-0 top-0 z-10 h-8 bg-[linear-gradient(to_bottom,rgb(var(--claw-panel)/0.55),rgb(var(--claw-panel)/0.16)_55%,rgb(var(--claw-panel)/0.0))] backdrop-blur-[1px] transition-opacity duration-200 ease-out",
		                                chatTopFade[`topic:${topicId}`] ? "opacity-100" : "opacity-0"
		                              )}
		                            />
                                <div
                                  className={cn(
                                    "pointer-events-none absolute left-0 right-0 bottom-0 z-10 h-10 bg-[linear-gradient(to_top,rgb(var(--claw-panel)/0.42),rgb(var(--claw-panel)/0.12)_55%,rgb(var(--claw-panel)/0.0))] backdrop-blur-[1px] transition-opacity duration-200 ease-out",
                                    chatBottomFade[`topic:${topicId}`] ? "opacity-100" : "opacity-0"
                                  )}
                                />
		                            <div
		                              ref={(node) => {
		                                const key = `topic:${topicId}`;
		                                setChatScroller(key, node);
		                                if (node && typeof window !== "undefined") {
		                                  window.requestAnimationFrame(() => {
		                                    const showTop = node.scrollTop > 2;
		                                    const remaining = node.scrollHeight - (node.scrollTop + node.clientHeight);
		                                    const showBottom = remaining > 2;
		                                    setChatTopFade((prev) =>
		                                      prev[key] === showTop ? prev : { ...prev, [key]: showTop }
		                                    );
		                                    setChatBottomFade((prev) =>
		                                      prev[key] === showBottom ? prev : { ...prev, [key]: showBottom }
		                                    );
		                                  });
		                                }
		                              }}
		                              onScroll={(event) => {
		                                const key = `topic:${topicId}`;
		                                const node = event.currentTarget;
		                                const showTop = node.scrollTop > 2;
		                                const remaining = node.scrollHeight - (node.scrollTop + node.clientHeight);
		                                const showBottom = remaining > 2;
		                                chatAtBottomRef.current.set(key, remaining <= CHAT_AUTO_SCROLL_THRESHOLD_PX);
		                                setChatTopFade((prev) =>
		                                  prev[key] === showTop ? prev : { ...prev, [key]: showTop }
		                                );
		                                setChatBottomFade((prev) =>
		                                  prev[key] === showBottom ? prev : { ...prev, [key]: showBottom }
		                                );
		                                if (!normalizedSearch && topicChatTruncated && node.scrollTop <= 28) {
		                                  const now = Date.now();
		                                  const last = chatLoadOlderCooldownRef.current.get(key) ?? 0;
		                                  if (now - last > 350) {
		                                    chatLoadOlderCooldownRef.current.set(key, now);
		                                    loadOlderChat(key, TOPIC_TIMELINE_LIMIT, topicChatAllLogs.length, TOPIC_TIMELINE_LIMIT);
		                                  }
		                                }
		                                if (activeChatKeyRef.current === key) updateActiveChatAtBottom();
		                              }}
		                              className="overflow-y-auto pr-1"
		                              style={{
		                                maxHeight: "max(240px, calc(100dvh - var(--claw-header-h, 0px) - 320px))",
		                              }}
		                            >
		                              <LogList
		                                logs={topicChatLogs}
		                                topics={topics}
		                                tasks={tasks}
		                                scopeTopicId={topicId}
		                                scopeTaskId={null}
		                                showFilters={false}
		                                showRawToggle={false}
		                                showDensityToggle={false}
		                                showRawAll={showRaw}
		                                messageDensity={messageDensity}
		                                allowNotes
		                                variant="chat"
		                                enableNavigation={false}
		                              />
		                            </div>
		                          </div>
		                          {/* Load more moved into the chat header (top-right). */}
		                          {pendingMessages
		                            .filter((pending) => pending.sessionKey === topicSessionKey(topicId))
		                            .map((pending) => (
		                              <div key={pending.localId} className="py-1">
		                                <div className="flex justify-end">
		                                  <div className="w-full max-w-[78%]">
		                                    <div
		                                      className={cn(
		                                        "rounded-[20px] border px-4 py-3 text-sm leading-relaxed",
		                                        pending.status === "failed" ? "opacity-90" : "",
		                                        "border-[rgba(36,145,255,0.35)] bg-[rgba(36,145,255,0.16)] text-[rgb(var(--claw-text))]"
		                                      )}
		                                    >
                                          {pending.attachments && pending.attachments.length > 0 ? (
                                            <AttachmentStrip attachments={pending.attachments} className="mt-0 mb-3" />
                                          ) : null}
                                          <Markdown>{pending.message}</Markdown>
		                                    </div>
		                                    <div className="mt-1 text-right text-[10px] text-[rgba(148,163,184,0.9)]">
		                                      {pending.status === "sending"
		                                        ? "Sending…"
		                                        : pending.status === "sent"
		                                          ? "Sent"
		                                          : pending.error
		                                            ? pending.error
		                                            : "Failed to send."}
		                                    </div>
		                                  </div>
		                                </div>
		                              </div>
		                            ))}
		                          {isSessionResponding(topicSessionKey(topicId)) ? (
		                            <div className="py-1">
		                              <div className="flex justify-start">
		                                <div className="w-full max-w-[78%]">
		                                  <div className="rounded-[20px] border border-[rgba(255,255,255,0.12)] bg-[rgba(20,24,31,0.8)] px-4 py-3 text-sm text-[rgb(var(--claw-text))]">
		                                    <div className="flex items-center gap-2">
		                                      <span className="text-xs text-[rgba(148,163,184,0.9)]">OpenClaw</span>
		                                      <TypingDots />
		                                    </div>
		                                  </div>
		                                </div>
		                              </div>
		                            </div>
		                          ) : null}
		                          <BoardChatComposer
                                ref={(node) => {
                                  const key = topicSessionKey(topicId);
                                  if (node) composerHandlesRef.current.set(key, node);
                                  else composerHandlesRef.current.delete(key);
                                }}
		                            sessionKey={topicSessionKey(topicId)}
		                            className="mt-4"
		                            variant="seamless"
		                            placeholder={`Message ${topic.name}…`}
		                            onFocus={() => {
		                              setActiveComposer({ kind: "topic", topicId });
		                            }}
		                            onBlur={() =>
		                              setActiveComposer((prev) =>
		                                prev?.kind === "topic" && prev.topicId === topicId ? null : prev
		                              )
		                            }
		                            onSendUpdate={(event) => {
		                              if (!event) return;
		                              markRecentBoardSend(event.sessionKey);
		                              if (event.phase === "sending") {
		                                setAwaitingAssistant((prev) => ({
		                                  ...prev,
		                                  [event.sessionKey]: { sentAt: event.createdAt },
		                                }));
		                                setPendingMessages((prev) => [
		                                  ...prev.filter((item) => item.localId !== event.localId),
		                                  {
		                                    localId: event.localId,
		                                    sessionKey: event.sessionKey,
		                                    message: event.message,
		                                    attachments: event.attachments,
		                                    createdAt: event.createdAt,
		                                    status: "sending",
		                                  },
		                                ]);
		                              } else if (event.phase === "queued") {
		                                setAwaitingAssistant((prev) => ({
		                                  ...prev,
		                                  [event.sessionKey]: { sentAt: event.createdAt, requestId: event.requestId },
		                                }));
		                                setPendingMessages((prev) =>
		                                  prev.map((item) =>
		                                    item.localId === event.localId
		                                      ? { ...item, requestId: event.requestId, status: "sent" }
		                                      : item
		                                  )
		                                );
		                              } else if (event.phase === "failed") {
		                                setAwaitingAssistant((prev) => {
		                                  if (!Object.prototype.hasOwnProperty.call(prev, event.sessionKey)) return prev;
		                                  const next = { ...prev };
		                                  delete next[event.sessionKey];
		                                  return next;
		                                });
		                                setPendingMessages((prev) =>
		                                  prev.map((item) =>
		                                    item.localId === event.localId
		                                      ? { ...item, status: "failed", error: event.error }
		                                      : item
		                                  )
		                                );
		                              }
		                              const chatKey = chatKeyFromSessionKey(event.sessionKey);
		                              if (chatKey) {
		                                activeChatKeyRef.current = chatKey;
		                                activeChatAtBottomRef.current = true;
		                                scheduleScrollChatToBottom(chatKey);
		                              }
		                            }}
		                            autoFocus={autoFocusTopicId === topicId}
		                            onAutoFocusApplied={() =>
		                              setAutoFocusTopicId((prev) => (prev === topicId ? null : prev))
		                            }
		                            testId={`topic-chat-composer-${topicId}`}
		                          />
		                        </div>
		                      )}
		                    </div>
	                  )}
                </div>
	              )}
	            </div>
	          );

          if (isUnassigned) return card;
          return (
            <SwipeRevealRow
              key={topicId}
              rowId={topicId}
              openId={topicSwipeOpenId}
              setOpenId={setTopicSwipeOpenId}
              actions={swipeActions}
            >
              {card}
            </SwipeRevealRow>
          );
	        })}
        </div>
      </div>

      {pageCount > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-4 py-3 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">
          <span>
            Page {safePage} of {pageCount}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const next = Math.max(1, safePage - 1);
                setPage(next);
                pushUrl({ page: String(next) });
              }}
              disabled={safePage === 1}
            >
              Prev
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const next = Math.min(pageCount, safePage + 1);
                setPage(next);
                pushUrl({ page: String(next) });
              }}
              disabled={safePage === pageCount}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
