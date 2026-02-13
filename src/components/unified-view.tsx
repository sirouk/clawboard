"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { LogEntry, Task, Topic } from "@/lib/types";
import { Button, Input, SearchInput, Select, StatusPill } from "@/components/ui";
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
import {
  BoardChatComposer,
  type BoardChatComposerHandle,
  type BoardChatComposerSendEvent,
} from "@/components/board-chat-composer";
import { BOARD_TASK_SESSION_PREFIX, BOARD_TOPIC_SESSION_PREFIX, taskSessionKey, topicSessionKey } from "@/lib/board-session";
import { Markdown } from "@/components/markdown";
import { AttachmentStrip, type AttachmentLike } from "@/components/attachments";
import { queueDraftUpsert, readBestDraftValue, usePersistentDraft } from "@/lib/drafts";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";
import { SnoozeModal } from "@/components/snooze-modal";
import { useUnifiedExpansionState } from "@/components/unified-view-state";
import { getInitialUnifiedUrlState, parseUnifiedUrlState } from "@/components/unified-view-url-state";

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

const TASK_STATUS_OPTIONS: Task["status"][] = ["todo", "doing", "blocked", "done"];
const TASK_STATUS_FILTERS = ["all", "todo", "doing", "blocked", "done"] as const;
type TaskStatusFilter = (typeof TASK_STATUS_FILTERS)[number];

const isTaskStatusFilter = (value: string): value is TaskStatusFilter =>
  TASK_STATUS_FILTERS.includes(value as TaskStatusFilter);

const TOPIC_VIEW_KEY = "clawboard.unified.topicView";
const SHOW_SNOOZED_TASKS_KEY = "clawboard.unified.showSnoozedTasks";
const UNSNOOZED_TOPICS_KEY = "clawboard.unified.unsnoozedTopics";
const UNSNOOZED_TASKS_KEY = "clawboard.unified.unsnoozedTasks";

const TOPIC_VIEWS = ["active", "snoozed", "archived", "all"] as const;
type TopicView = (typeof TOPIC_VIEWS)[number];
const isTopicView = (value: string): value is TopicView => TOPIC_VIEWS.includes(value as TopicView);

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

const TOPIC_ACTION_REVEAL_PX = 272;
// New Topics/Tasks should float to the very top immediately after creation.
// Keep that priority for a long window so "something else happening" displaces it,
// instead of the item unexpectedly dropping due to time passing mid-session.
const NEW_ITEM_BUMP_MS = 24 * 60 * 60 * 1000;

const DEFAULT_UNIFIED_TOPICS_PAGE_SIZE = 50;
const UNIFIED_TOPICS_PAGE_SIZE = (() => {
  const raw = String(process.env.NEXT_PUBLIC_CLAWBOARD_UNIFIED_TOPICS_PAGE_SIZE ?? "").trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_UNIFIED_TOPICS_PAGE_SIZE;
  const value = Math.floor(parsed);
  if (value <= 0) return DEFAULT_UNIFIED_TOPICS_PAGE_SIZE;
  // Keep a hard cap so accidental env values don't DoS the UI.
  return Math.min(value, 200);
})();

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

const CRON_EVENT_SOURCE_CHANNELS = new Set(["cron-event"]);

function isCronEventLog(entry: LogEntry) {
  const channel = String(entry.source?.channel ?? "")
    .trim()
    .toLowerCase();
  return CRON_EVENT_SOURCE_CHANNELS.has(channel);
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
    <div className="relative overflow-x-hidden overflow-y-visible rounded-[var(--radius-lg)]">
      {showActions ? (
        <div
          className="absolute inset-0 flex items-stretch justify-end gap-2 bg-[rgba(10,12,16,0.18)] p-1 transition-opacity"
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
          "relative",
          (swiping || effectiveOffset > 0) ? "will-change-transform" : "",
          swiping || isOpen ? "z-20" : "",
          swiping ? "" : "transition-transform duration-200 ease-out"
        )}
        style={{
          ...(effectiveOffset > 0 ? { transform: `translate3d(-${effectiveOffset}px,0,0)` } : {}),
          touchAction: "pan-y",
        }}
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

function mobileOverlaySurfaceStyle(color: string): CSSProperties {
  return {
    // Use an opaque base so board content never bleeds through fullscreen chat layers.
    backgroundColor: "rgb(10,12,16)",
    backgroundImage: `linear-gradient(180deg, ${rgba(color, 0.3)} 0%, rgba(12,14,18,0.95) 38%, rgba(12,14,18,0.99) 100%)`,
  };
}

function mobileOverlayHeaderStyle(color: string): CSSProperties {
  return {
    background: `linear-gradient(180deg, ${rgba(color, 0.36)} 0%, rgba(12,14,18,0.9) 76%)`,
    borderColor: rgba(color, 0.34),
  };
}

function mobileOverlayCloseButtonStyle(color: string): CSSProperties {
  return {
    background: `linear-gradient(180deg, ${rgba(color, 0.42)} 0%, rgba(14,17,22,0.84) 100%)`,
    borderColor: rgba(color, 0.48),
  };
}

function parseTopicPayload(value: unknown): Topic | null {
  if (!value || typeof value !== "object") return null;
  const direct = value as Partial<Topic>;
  if (typeof direct.id === "string" && direct.id.trim()) return direct as Topic;
  const nested = (value as { topic?: unknown }).topic;
  if (!nested || typeof nested !== "object") return null;
  const topic = nested as Partial<Topic>;
  if (typeof topic.id !== "string" || !topic.id.trim()) return null;
  return topic as Topic;
}

function parseTaskPayload(value: unknown): Task | null {
  if (!value || typeof value !== "object") return null;
  const direct = value as Partial<Task>;
  if (typeof direct.id === "string" && direct.id.trim()) return direct as Task;
  const nested = (value as { task?: unknown }).task;
  if (!nested || typeof nested !== "object") return null;
  const task = nested as Partial<Task>;
  if (typeof task.id !== "string" || !task.id.trim()) return null;
  return task as Task;
}

export function UnifiedView({ basePath = "/u" }: { basePath?: string } = {}) {
  const { token, tokenRequired } = useAppConfig();
  const { topics, tasks, logs, drafts, openclawTyping, hydrated, setTopics, setTasks, setLogs } = useDataStore();
  const readOnly = tokenRequired && !token;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const scrollMemory = useRef<Record<string, number>>({});
  const restoreScrollOnNextSyncRef = useRef(false);
  const suppressNextUrlSyncRef = useRef(false);
  const [initialUrlState] = useState(() => getInitialUnifiedUrlState(basePath));
  const twoColumn = useLocalStorageItem("clawboard.unified.twoColumn") === "true";
  const storedTopicView = (useLocalStorageItem(TOPIC_VIEW_KEY) ?? "").trim().toLowerCase();
  const topicView: TopicView = isTopicView(storedTopicView) ? storedTopicView : "active";
  const showSnoozedTasks = useLocalStorageItem(SHOW_SNOOZED_TASKS_KEY) === "true";
  const unsnoozedTopicsRaw = useLocalStorageItem(UNSNOOZED_TOPICS_KEY) ?? "{}";
  const unsnoozedTasksRaw = useLocalStorageItem(UNSNOOZED_TASKS_KEY) ?? "{}";
  const [mdUp, setMdUp] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(min-width: 768px)").matches;
  });
  const {
    state: expansionState,
    setExpandedTopics,
    setExpandedTasks,
    setExpandedTopicChats,
    setMobileLayer,
    setMobileChatTarget,
  } = useUnifiedExpansionState(initialUrlState.topics, initialUrlState.tasks);
  const { expandedTopics, expandedTasks, expandedTopicChats, mobileLayer, mobileChatTarget } = expansionState;
  const showTwoColumns = twoColumn && mdUp;
  const unsnoozedTopicBadges = useMemo<Record<string, number>>(() => {
    try {
      const parsed = JSON.parse(String(unsnoozedTopicsRaw || "{}")) as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      const raw = parsed as Record<string, unknown>;
      const next: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw)) {
        const id = String(key || "").trim();
        if (!id) continue;
        const ts = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        next[id] = ts;
      }
      return next;
    } catch {
      return {};
    }
  }, [unsnoozedTopicsRaw]);
  const unsnoozedTaskBadges = useMemo<Record<string, number>>(() => {
    try {
      const parsed = JSON.parse(String(unsnoozedTasksRaw || "{}")) as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      const raw = parsed as Record<string, unknown>;
      const next: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw)) {
        const id = String(key || "").trim();
        if (!id) continue;
        const ts = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        next[id] = ts;
      }
      return next;
    } catch {
      return {};
    }
  }, [unsnoozedTasksRaw]);
  const [showRaw, setShowRaw] = useState(initialUrlState.raw);
  const [messageDensity, setMessageDensity] = useState<MessageDensity>(initialUrlState.density);
  const [search, setSearch] = useState(initialUrlState.search);
  const [showDone, setShowDone] = useState(initialUrlState.done);
  const [revealSelection, setRevealSelection] = useState(initialUrlState.reveal);
  const [revealedTopicIds, setRevealedTopicIds] = useState<string[]>(initialUrlState.topics);
  const [revealedTaskIds, setRevealedTaskIds] = useState<string[]>(initialUrlState.tasks);
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>(
    isTaskStatusFilter(initialUrlState.status) ? initialUrlState.status : "all"
  );
  const [showViewOptions, setShowViewOptions] = useState(false);
  const [snoozeTarget, setSnoozeTarget] = useState<
    | { kind: "topic"; topicId: string; label: string }
    | { kind: "task"; topicId: string; taskId: string; label: string }
    | null
  >(null);
  const toggleTwoColumn = () => {
    setLocalStorageItem("clawboard.unified.twoColumn", twoColumn ? "false" : "true");
  };

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    const sync = () => setMdUp(mql.matches);
    sync();
    try {
      mql.addEventListener("change", sync);
      return () => mql.removeEventListener("change", sync);
    } catch {
      mql.addListener(sync);
      return () => mql.removeListener(sync);
    }
  }, []);

  useEffect(() => {
    if (mdUp) {
      setMobileLayer("board");
      setMobileChatTarget(null);
    }
  }, [mdUp, setMobileChatTarget, setMobileLayer]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (mdUp || mobileLayer !== "chat") return;
    const root = document.documentElement;
    const body = document.body;
    const lockY = window.scrollY;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPosition = body.style.position;
    const previousBodyTop = body.style.top;
    const previousBodyLeft = body.style.left;
    const previousBodyRight = body.style.right;
    const previousBodyWidth = body.style.width;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${lockY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    return () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.position = previousBodyPosition;
      body.style.top = previousBodyTop;
      body.style.left = previousBodyLeft;
      body.style.right = previousBodyRight;
      body.style.width = previousBodyWidth;
      window.scrollTo({ top: lockY, left: 0, behavior: "auto" });
    };
  }, [mdUp, mobileLayer]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const root = document.documentElement;
    if (mdUp || mobileLayer !== "chat") {
      root.style.removeProperty("--claw-mobile-vh");
      return;
    }

    const viewport = window.visualViewport;
    const syncViewportHeight = () => {
      const height = viewport?.height ?? window.innerHeight;
      root.style.setProperty("--claw-mobile-vh", `${Math.round(height)}px`);
    };

    syncViewportHeight();
    window.addEventListener("resize", syncViewportHeight);
    window.addEventListener("orientationchange", syncViewportHeight);
    viewport?.addEventListener("resize", syncViewportHeight);

    return () => {
      window.removeEventListener("resize", syncViewportHeight);
      window.removeEventListener("orientationchange", syncViewportHeight);
      viewport?.removeEventListener("resize", syncViewportHeight);
      root.style.removeProperty("--claw-mobile-vh");
    };
  }, [mdUp, mobileLayer]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (!mdUp && mobileLayer === "chat") {
      root.setAttribute("data-claw-mobile-layer", "chat");
      return () => {
        if (root.getAttribute("data-claw-mobile-layer") === "chat") {
          root.removeAttribute("data-claw-mobile-layer");
        }
      };
    }
    if (root.getAttribute("data-claw-mobile-layer") === "chat") {
      root.removeAttribute("data-claw-mobile-layer");
    }
  }, [mdUp, mobileLayer]);

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
  const [statusMenuTaskId, setStatusMenuTaskId] = useState<string | null>(null);
  const [statusMenuPosition, setStatusMenuPosition] = useState<{
    top: number;
    left: number;
    openUp: boolean;
  } | null>(null);
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
  const mobileDoneCollapseTaskIdRef = useRef<string | null>(null);
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
  const [chatJumpToBottom, setChatJumpToBottom] = useState<Record<string, boolean>>({});
  const chatLastScrollTopRef = useRef<Map<string, number>>(new Map());

  const CHAT_AUTO_SCROLL_THRESHOLD_PX = 24;
  const topicAutosaveTimerRef = useRef<number | null>(null);
  const taskAutosaveTimerRef = useRef<number | null>(null);
  const skipTopicAutosaveRef = useRef(false);
  const skipTaskAutosaveRef = useRef(false);

  const positionStatusMenu = useCallback((taskId: string) => {
    if (typeof window === "undefined") return;
    const trigger = document.querySelector<HTMLElement>(`[data-testid='task-status-trigger-${taskId}']`);
    if (!trigger) {
      setStatusMenuTaskId(null);
      setStatusMenuPosition(null);
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const menuWidth = 170;
    const rowHeight = 34;
    const menuHeight = Math.max(48, (TASK_STATUS_OPTIONS.length - 1) * rowHeight + 12);
    const gap = 8;
    const viewportPadding = 8;

    const openUp = window.innerHeight - rect.bottom < menuHeight + gap + viewportPadding && rect.top > menuHeight + gap;
    const top = openUp ? rect.top - gap : rect.bottom + gap;
    const left = clamp(rect.right - menuWidth, viewportPadding, window.innerWidth - menuWidth - viewportPadding);

    setStatusMenuPosition({ top, left, openUp });
  }, []);

  const openStatusMenu = useCallback(
    (taskId: string) => {
      setStatusMenuTaskId(taskId);
      positionStatusMenu(taskId);
    },
    [positionStatusMenu]
  );

  useEffect(() => {
    if (!statusMenuTaskId) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-task-status-menu]")) return;
      setStatusMenuTaskId(null);
      setStatusMenuPosition(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setStatusMenuTaskId(null);
        setStatusMenuPosition(null);
      }
    };

    const onReposition = () => {
      if (!statusMenuTaskId) return;
      positionStatusMenu(statusMenuTaskId);
    };

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [positionStatusMenu, statusMenuTaskId]);
  const recentBoardSendAtRef = useRef<Map<string, number>>(new Map());
  const chatHistoryLoadedOlderRef = useRef<Set<string>>(new Set());

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
    if (has && value <= 0 && len > initialLimit && !chatHistoryLoadedOlderRef.current.has(key)) {
      return clamp(len - initialLimit, 0, maxStart);
    }
    return clamp(value, 0, maxStart);
  };

  const loadOlderChat = useCallback(
    (chatKey: string, step: number, len: number, initialLimit: number) => {
      if (typeof window === "undefined") return;
      const key = (chatKey ?? "").trim();
      if (!key) return;
      chatHistoryLoadedOlderRef.current.add(key);
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
      const firstAttach = !chatScrollers.current.has(key);
      chatScrollers.current.set(key, node);
      const remaining = node.scrollHeight - (node.scrollTop + node.clientHeight);
      const atBottom = remaining <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
      chatAtBottomRef.current.set(key, atBottom);
      setChatJumpToBottom((prev) => (prev[key] === !atBottom ? prev : { ...prev, [key]: !atBottom }));
      chatLastScrollTopRef.current.set(key, node.scrollTop);

      // Desktop + mobile parity: when a chat pane mounts, start at the latest message
      // so new incoming messages stay in-view without requiring a manual page scroll.
      if (firstAttach) {
        window.requestAnimationFrame(() => {
          const current = chatScrollers.current.get(key);
          if (!current) return;
          current.scrollTo({ top: current.scrollHeight, behavior: "auto" });
          chatAtBottomRef.current.set(key, true);
          chatLastScrollTopRef.current.set(key, current.scrollTop);
          setChatJumpToBottom((prev) => (prev[key] === false ? prev : { ...prev, [key]: false }));
        });
      }
      return;
    }
    chatScrollers.current.delete(key);
    chatAtBottomRef.current.delete(key);
    setChatJumpToBottom((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    chatLastScrollTopRef.current.delete(key);
  }, []);

  // Keep ref callbacks stable per key. Inline `ref={(node) => ...}` creates a new function each render,
  // which makes React call the previous ref with null and the next ref with the node every time,
  // and that can cascade into infinite update loops if the ref handler sets state.
  const chatScrollerRefCallbacks = useRef<Map<string, (node: HTMLElement | null) => void>>(new Map());
  const getChatScrollerRef = useCallback(
    (key: string) => {
      const existing = chatScrollerRefCallbacks.current.get(key);
      if (existing) return existing;
      const cb = (node: HTMLElement | null) => {
        setChatScroller(key, node);
        if (node && typeof window !== "undefined") {
          window.requestAnimationFrame(() => {
            const showTop = node.scrollTop > 2;
            setChatTopFade((prev) => (prev[key] === showTop ? prev : { ...prev, [key]: showTop }));
          });
        }
      };
      chatScrollerRefCallbacks.current.set(key, cb);
      return cb;
    },
    [setChatScroller]
  );

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
    return logs.filter(
      (entry) => (entry.classificationStatus ?? "pending") === "classified" && !isCronEventLog(entry)
    );
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

  const prevTopicStatusRef = useRef<Map<string, { status: string; snoozedUntil: string | null }>>(new Map());
  const prevTaskSnoozeRef = useRef<Map<string, string | null>>(new Map());

  useEffect(() => {
    const prev = prevTopicStatusRef.current;
    const next = new Map<string, { status: string; snoozedUntil: string | null }>();
    const additions: string[] = [];
    for (const topic of topics) {
      let status = String(topic.status ?? "active").trim().toLowerCase();
      if (status === "paused") status = "snoozed";
      const snoozedUntil = (topic.snoozedUntil ?? null) ? String(topic.snoozedUntil) : null;
      next.set(topic.id, { status, snoozedUntil });
      const before = prev.get(topic.id);
      if (!before) continue;
      if (before.status === "snoozed" && status === "active") {
        additions.push(topic.id);
      }
    }
    prevTopicStatusRef.current = next;

    if (additions.length === 0) return;
    const stamp = Date.now();
    const updated: Record<string, number> = { ...unsnoozedTopicBadges };
    for (const id of additions) {
      updated[id] = stamp;
      markBumped("topic", id);
    }
    setLocalStorageItem(UNSNOOZED_TOPICS_KEY, JSON.stringify(updated));
  }, [markBumped, topics, unsnoozedTopicBadges]);

  useEffect(() => {
    const prev = prevTaskSnoozeRef.current;
    const next = new Map<string, string | null>();
    const additions: string[] = [];
    for (const task of tasks) {
      const snoozedUntil = (task.snoozedUntil ?? null) ? String(task.snoozedUntil) : null;
      next.set(task.id, snoozedUntil);
      const before = prev.get(task.id);
      if (!before) continue;
      if (before && !snoozedUntil) {
        // Snoozed -> unsnoozed (worker or activity).
        additions.push(task.id);
      }
    }
    prevTaskSnoozeRef.current = next;

    if (additions.length === 0) return;
    const stamp = Date.now();
    const updated: Record<string, number> = { ...unsnoozedTaskBadges };
    for (const id of additions) {
      updated[id] = stamp;
      markBumped("task", id);
    }
    setLocalStorageItem(UNSNOOZED_TASKS_KEY, JSON.stringify(updated));
  }, [markBumped, tasks, unsnoozedTaskBadges]);

  const dismissUnsnoozedTopicBadge = useCallback(
    (topicId: string) => {
      const id = String(topicId || "").trim();
      if (!id) return;
      if (!Object.prototype.hasOwnProperty.call(unsnoozedTopicBadges, id)) return;
      const updated: Record<string, number> = { ...unsnoozedTopicBadges };
      delete updated[id];
      setLocalStorageItem(UNSNOOZED_TOPICS_KEY, JSON.stringify(updated));
    },
    [unsnoozedTopicBadges]
  );

  const dismissUnsnoozedTaskBadge = useCallback(
    (taskId: string) => {
      const id = String(taskId || "").trim();
      if (!id) return;
      if (!Object.prototype.hasOwnProperty.call(unsnoozedTaskBadges, id)) return;
      const updated: Record<string, number> = { ...unsnoozedTaskBadges };
      delete updated[id];
      setLocalStorageItem(UNSNOOZED_TASKS_KEY, JSON.stringify(updated));
    },
    [unsnoozedTaskBadges]
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

  // Keep topic chat strictly coupled to topic expansion: if a topic is collapsed
  // by any code path, its chat must collapse too.
  useEffect(() => {
    setExpandedTopicChats((prev) => {
      const allowed = new Set(expandedTopicsSafe);
      const next = new Set(Array.from(prev).filter((id) => allowed.has(id)));
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [expandedTopicsSafe, setExpandedTopicChats]);

  const taskTopicById = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      map.set(task.id, task.topicId ?? "unassigned");
    }
    return map;
  }, [tasks]);

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
      if (!showRaw && isCronEventLog(entry)) continue;
      if (!entry.taskId) continue;
      const list = map.get(entry.taskId) ?? [];
      list.push(entry);
      map.set(entry.taskId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    }
    return map;
  }, [logs, showRaw]);

  const logsByTopicAll = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const entry of logs) {
      if (!showRaw && isCronEventLog(entry)) continue;
      if (!entry.topicId) continue;
      const list = map.get(entry.topicId) ?? [];
      list.push(entry);
      map.set(entry.topicId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    }
    return map;
  }, [logs, showRaw]);

  const normalizedSearch = search.trim().toLowerCase();
  const topicReorderEnabled = !readOnly && normalizedSearch.length === 0 && statusFilter === "all";
  const taskReorderEnabled = topicReorderEnabled;

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

  const handleComposerSendUpdate = useCallback(
    (event: BoardChatComposerSendEvent | undefined) => {
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
            item.localId === event.localId ? { ...item, requestId: event.requestId, status: "sent" } : item
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
          prev.map((item) => (item.localId === event.localId ? { ...item, status: "failed", error: event.error } : item))
        );
      }
      const chatKey = chatKeyFromSessionKey(event.sessionKey);
      if (chatKey) {
        activeChatKeyRef.current = chatKey;
        activeChatAtBottomRef.current = true;
        scheduleScrollChatToBottom(chatKey);
      }
    },
    [chatKeyFromSessionKey, markRecentBoardSend, scheduleScrollChatToBottom]
  );

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

  useLayoutEffect(() => {
    if (normalizedSearch) return;

    for (const [key] of chatScrollers.current.entries()) {
      const lastId = getChatLastLogId(key);
      if (!lastId) continue;

      // Keep the chat pinned to the bottom while the user is at the bottom.
      // This matters for streaming updates where the last log id stays the same
      // but its rendered height keeps growing.
      const atBottom = chatAtBottomRef.current.get(key) ?? false;
      const prevLastId = chatLastSeenRef.current.get(key) ?? "";
      chatLastSeenRef.current.set(key, lastId);

      if (!atBottom) continue;

      // Use the shared scheduler so we hit the true bottom even as the last message grows over
      // a few frames (common with streaming). This avoids leaving partial messages visible.
      activeChatAtBottomRef.current = true;
      scheduleScrollChatToBottom(key, prevLastId && prevLastId !== lastId ? 4 : 8);
      chatAtBottomRef.current.set(key, true);
      setChatJumpToBottom((prev) => (prev[key] === false ? prev : { ...prev, [key]: false }));
    }
  }, [getChatLastLogId, logs, normalizedSearch, scheduleScrollChatToBottom]);

  const semanticLimits = useMemo(
    () => ({
      topics: Math.min(Math.max(topics.length, 60), 120),
      tasks: Math.min(Math.max(tasks.length, 120), 240),
      logs: Math.min(Math.max(visibleLogs.length, 180), 320),
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
    if (revealSelection && revealedTaskIds.includes(task.id)) return true;
    if (!normalizedSearch) return true;
    if (semanticForQuery) {
      if (semanticTaskIds.has(task.id)) return true;
      const logMatches = logsByTask.get(task.id)?.some((entry) => semanticLogIds.has(entry.id));
      return Boolean(logMatches);
    }
    if (task.title.toLowerCase().includes(normalizedSearch)) return true;
    const logMatches = logsByTask.get(task.id)?.some(matchesLogSearch);
    return Boolean(logMatches);
  }, [logsByTask, matchesLogSearch, normalizedSearch, revealSelection, revealedTaskIds, semanticForQuery, semanticLogIds, semanticTaskIds]);

  const matchesStatusFilter = useCallback(
    (task: Task) => {
      if (revealSelection && revealedTaskIds.includes(task.id)) return true;
      if (!normalizedSearch && !showSnoozedTasks) {
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
    [normalizedSearch, revealSelection, revealedTaskIds, showDone, showSnoozedTasks, statusFilter]
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
      if (revealSelection && revealedTopicIds.includes(topic.id)) return true;
      const effectiveView: TopicView = normalizedSearch ? "all" : topicView;
      let topicStatus = String(topic.status ?? "active").trim().toLowerCase();
      if (topicStatus === "paused") topicStatus = "snoozed";
      if (effectiveView === "active") {
        if (topicStatus !== "active") return false;
      } else if (effectiveView === "snoozed") {
        if (topicStatus !== "snoozed") return false;
      } else if (effectiveView === "archived") {
        if (topicStatus !== "archived") return false;
      }
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
      const effectiveView: TopicView = normalizedSearch ? "all" : topicView;
      if (effectiveView !== "snoozed" && effectiveView !== "archived") {
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
    revealSelection,
    revealedTopicIds,
    statusFilter,
    topicView,
    tasksByTopic,
  ]);

  const pageSize = UNIFIED_TOPICS_PAGE_SIZE;
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

    const updated = parseTaskPayload(await res.json().catch(() => null));
    const nextStatus = String(updated?.status ?? updates.status ?? current.status).trim().toLowerCase();
    const transitionedToDone = nextStatus === "done" && String(current.status ?? "").trim().toLowerCase() !== "done";
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
    if (!mdUp && transitionedToDone) {
      suppressNextUrlSyncRef.current = true;
      mobileDoneCollapseTaskIdRef.current = taskId;
      setExpandedTasks((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      if (mobileLayer === "chat" && mobileChatTarget?.kind === "task" && mobileChatTarget.taskId === taskId) {
        setMobileLayer("board");
        setMobileChatTarget(null);
      }
    }
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
      const updated = parseTopicPayload(await res.json().catch(() => null));
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
      const updated = parseTaskPayload(await res.json().catch(() => null));
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
      const created = parseTaskPayload(await res.json().catch(() => null));
      if (!created?.id) return;
      const resolvedTopicId = (created.topicId ?? scopeTopicId ?? "").trim();
      setTasks((prev) => (prev.some((item) => item.id === created.id) ? prev : [created, ...prev]));
      markBumped("task", created.id);

      setExpandedTopics((prev) => {
        const next = new Set(prev);
        next.add(resolvedTopicId || "unassigned");
        return next;
      });
      setExpandedTasks((prev) => {
        const next = new Set(prev);
        next.add(created.id);
        return next;
      });
      const nextTopics = new Set(expandedTopicsSafe);
      nextTopics.add(resolvedTopicId || "unassigned");
      const nextTasks = new Set(expandedTasksSafe);
      nextTasks.add(created.id);
      pushUrl({ topics: Array.from(nextTopics), tasks: Array.from(nextTasks), page: "1" }, "replace");
      if (resolvedTopicId) {
        setAutoFocusTask({ topicId: resolvedTopicId, taskId: created.id });
      }

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
        const updated = parseTopicPayload(await res.json().catch(() => null));
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
    let nextTasks = new Set(expandedTasksSafe);
    if (next.has(topicId)) {
      next.delete(topicId);
      nextChats.delete(topicId);
      // Auto-collapse child tasks when parent topic collapses.
      const topicTaskIds = new Set((tasksByTopic.get(topicId) ?? []).map((task) => task.id));
      if (topicTaskIds.size > 0) {
        nextTasks = new Set(Array.from(nextTasks).filter((id) => !topicTaskIds.has(id)));
      }
    } else {
      next.add(topicId);
    }
    setExpandedTopics(next);
    setExpandedTopicChats(nextChats);
    setExpandedTasks(nextTasks);
    pushUrl({ topics: Array.from(next), tasks: Array.from(nextTasks) });
  };

  const openMobileTaskChat = useCallback(
    (topicId: string, taskId: string) => {
      setMobileChatTarget({ kind: "task", topicId, taskId });
      setMobileLayer("chat");
      setExpandedTopics((prev) => {
        if (prev.has(topicId)) return prev;
        const next = new Set(prev);
        next.add(topicId);
        return next;
      });
      setExpandedTasks((prev) => {
        if (prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.add(taskId);
        return next;
      });
      scheduleScrollChatToBottom(`task:${taskId}`);
    },
    [scheduleScrollChatToBottom, setExpandedTasks, setExpandedTopics, setMobileChatTarget, setMobileLayer]
  );

  const openMobileTopicChat = useCallback(
    (topicId: string) => {
      setMobileChatTarget({ kind: "topic", topicId });
      setMobileLayer("chat");
      setExpandedTopics((prev) => {
        if (prev.has(topicId)) return prev;
        const next = new Set(prev);
        next.add(topicId);
        return next;
      });
      setExpandedTopicChats((prev) => {
        if (prev.has(topicId)) return prev;
        const next = new Set(prev);
        next.add(topicId);
        return next;
      });
      scheduleScrollChatToBottom(`topic:${topicId}`);
    },
    [scheduleScrollChatToBottom, setExpandedTopicChats, setExpandedTopics, setMobileChatTarget, setMobileLayer]
  );

  const closeMobileChatLayer = useCallback(() => {
    const target = mobileChatTarget;
    if (target?.kind === "task") {
      setExpandedTasks((prev) => {
        if (!prev.has(target.taskId)) return prev;
        const next = new Set(prev);
        next.delete(target.taskId);
        return next;
      });
    } else if (target?.kind === "topic") {
      setExpandedTopicChats((prev) => {
        if (!prev.has(target.topicId)) return prev;
        const next = new Set(prev);
        next.delete(target.topicId);
        return next;
      });
      setExpandedTopics((prev) => {
        if (!prev.has(target.topicId)) return prev;
        const next = new Set(prev);
        next.delete(target.topicId);
        return next;
      });
    }
    setMobileLayer("board");
    setMobileChatTarget(null);
  }, [
    mobileChatTarget,
    setExpandedTasks,
    setExpandedTopicChats,
    setExpandedTopics,
    setMobileChatTarget,
    setMobileLayer,
  ]);

  useEffect(() => {
    if (mdUp) return;
    if (mobileLayer !== "chat") return;
    if (!mobileChatTarget) return;

    const topicVisible = orderedTopics.some((topic) => topic.id === mobileChatTarget.topicId);
    if (mobileChatTarget.kind === "topic") {
      if (!topicVisible) {
        closeMobileChatLayer();
      }
      return;
    }

    const activeTask = tasks.find((task) => task.id === mobileChatTarget.taskId);
    const taskVisible =
      !!activeTask &&
      (activeTask.topicId ?? "unassigned") === mobileChatTarget.topicId &&
      matchesStatusFilter(activeTask) &&
      matchesTaskSearch(activeTask) &&
      topicVisible;

    if (taskVisible) return;

    closeMobileChatLayer();
  }, [
    closeMobileChatLayer,
    matchesStatusFilter,
    matchesTaskSearch,
    mdUp,
    mobileChatTarget,
    mobileLayer,
    orderedTopics,
    tasks,
  ]);

  const toggleTaskExpanded = (topicId: string, taskId: string) => {
    if (!mdUp) {
      const isTaskTarget =
        mobileLayer === "chat" && mobileChatTarget?.kind === "task" && mobileChatTarget.taskId === taskId;
      if (!isTaskTarget) {
        setExpandedTopics((prev) => {
          if (prev.has(topicId)) return prev;
          const next = new Set(prev);
          next.add(topicId);
          return next;
        });
        setExpandedTasks((prev) => {
          if (prev.has(taskId)) return prev;
          const next = new Set(prev);
          next.add(taskId);
          return next;
        });
        openMobileTaskChat(topicId, taskId);
        pushUrl({
          topics: Array.from(new Set([...expandedTopicsSafe, topicId])),
          tasks: Array.from(new Set([...expandedTasksSafe, taskId])),
        });
        return;
      }
    }

    const next = new Set(expandedTasksSafe);
    const nextTopics = new Set(expandedTopicsSafe);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
      nextTopics.add(topicId);
      scheduleScrollChatToBottom(`task:${taskId}`);
      if (!mdUp) {
        openMobileTaskChat(topicId, taskId);
      }
    }
    setExpandedTopics(nextTopics);
    setExpandedTasks(next);
    pushUrl({ topics: Array.from(nextTopics), tasks: Array.from(next) });
  };

  const toggleTopicChatExpanded = (topicId: string) => {
    const next = new Set(expandedTopicChatsSafe);
    if (next.has(topicId)) {
      next.delete(topicId);
    } else {
      next.add(topicId);
      scheduleScrollChatToBottom(`topic:${topicId}`);
      if (!mdUp) {
        openMobileTopicChat(topicId);
      }
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

  const syncFromUrl = useCallback(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const rawDefaultWhenMissing = window.matchMedia("(min-width: 768px)").matches;
    const parsedState = parseUnifiedUrlState(url, {
      basePath,
      resolveTopicId,
      resolveTaskId,
      rawParseMode: "one-only",
      rawDefaultWhenMissing,
      taskTopicById,
    });
    const nextStatusRaw = parsedState.status ?? "all";
    const nextStatus = isTaskStatusFilter(nextStatusRaw) ? nextStatusRaw : "all";
    const nextTopics = parsedState.topics;
    const nextTasks = parsedState.tasks;
    const nextRevealSelection = parsedState.reveal;

    setSearch(parsedState.search);
    committedSearch.current = parsedState.search;
    setShowRaw(parsedState.raw);
    setMessageDensity(parsedState.density);
    setStatusFilter(nextStatus);
    setShowDone(parsedState.done || nextStatus === "done");
    setRevealSelection(nextRevealSelection);
    setRevealedTopicIds(nextTopics);
    setRevealedTaskIds(nextTasks);
    setPage(parsedState.page);
    setExpandedTopics(new Set(nextTopics));
    setExpandedTasks(new Set(nextTasks));
    // Do not auto-open topic chat from topic expansion/url sync.
    // Keep only chats that were already open and still belong to expanded topics.
    setExpandedTopicChats((prev) => {
      const allowed = new Set(nextTopics);
      return new Set(Array.from(prev).filter((id) => allowed.has(id)));
    });
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
  }, [basePath, resolveTaskId, resolveTopicId, setExpandedTasks, setExpandedTopicChats, setExpandedTopics, taskTopicById]);

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
    if (suppressNextUrlSyncRef.current) {
      suppressNextUrlSyncRef.current = false;
      return;
    }
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
        if (all.length <= TASK_TIMELINE_LIMIT) continue;
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
        if (all.length <= TOPIC_TIMELINE_LIMIT) continue;
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
        reveal?: string;
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
      const nextReveal = overrides.reveal ?? (revealSelection ? "1" : "0");

      if (nextSearch) params.set("q", nextSearch);
      if (nextRaw === "1") params.set("raw", "1");
      // Compact is the default; only persist when the user explicitly chooses comfortable.
      if (nextDensity === "comfortable") params.set("density", "comfortable");
      if (nextDone === "1") params.set("done", "1");
      if (nextStatus !== "all") params.set("status", nextStatus);
      if (nextPage && nextPage !== "1") params.set("page", nextPage);
      if (nextReveal === "1") params.set("reveal", "1");
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
      revealSelection,
      showDone,
      showRaw,
      statusFilter,
      basePath,
    ]
  );

  useEffect(() => {
    const taskId = mobileDoneCollapseTaskIdRef.current;
    if (!taskId) return;
    mobileDoneCollapseTaskIdRef.current = null;
    const nextTasks = Array.from(expandedTasksSafe).filter((id) => id !== taskId);
    pushUrl({ tasks: nextTasks }, "replace");
  }, [expandedTasksSafe, pushUrl]);

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
      const created = parseTopicPayload(await res.json().catch(() => null));
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
  }, [expandedTasksSafe, expandedTopicsSafe, logs, pushUrl, scheduleScrollChatToBottom, setExpandedTasks, setExpandedTopics]);



  return (
    <div className="space-y-4">
      <div
        className={cn(
          "sticky top-0 z-30 -mx-3 space-y-2 px-3 pb-2 pt-2 transition sm:-mx-4 sm:px-4 sm:pb-2.5 sm:pt-2.5 md:-mx-6 md:space-y-3 md:px-6 md:pb-3 md:pt-4",
          mobileLayer === "chat" ? "max-md:hidden" : "",
          isSticky
            ? "border-b border-[rgb(var(--claw-border))] bg-[rgba(12,14,18,0.9)] backdrop-blur"
            : "bg-transparent"
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={(event) => {
              const value = event.target.value;
              setSearch(value);
              setPage(1);
              pushUrl({ q: value, page: "1" }, "replace");
            }}
            onClear={() => {
              setSearch("");
              setPage(1);
              committedSearch.current = "";
              pushUrl({ q: "", page: "1" }, "replace");
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
            className="min-w-0 flex-1 md:min-w-[240px]"
          />
          <Button
            variant="secondary"
            size="sm"
            className="max-md:h-9 max-md:px-3 max-md:text-xs"
            onClick={() => setShowViewOptions((prev) => !prev)}
            aria-expanded={showViewOptions}
          >
            {showViewOptions ? "Hide options" : "View options"}
          </Button>
        </div>
        {showViewOptions && (
          <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(14,17,22,0.92)] p-2.5 md:p-3">
            <div className="flex flex-wrap items-center gap-1.5 md:gap-2">
              <Button
                variant="secondary"
                size="sm"
                className={cn(twoColumn ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                onClick={toggleTwoColumn}
                title={twoColumn ? "Switch to single column" : "Switch to two columns"}
              >
                {twoColumn ? "1 column" : "2 column"}
              </Button>
	              <Select
	                value={topicView}
	                onChange={(event) => {
	                  setLocalStorageItem(TOPIC_VIEW_KEY, event.target.value);
	                  setPage(1);
	                  pushUrl({ page: "1" }, "replace");
	                }}
	                className="max-w-[190px]"
	              >
	                <option value="active">Active topics</option>
	                <option value="snoozed">Snoozed topics</option>
	                <option value="archived">Archived topics</option>
	                <option value="all">All topics</option>
	              </Select>
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
	                className={cn(showSnoozedTasks ? "border-[rgba(77,171,158,0.55)]" : "opacity-85")}
	                onClick={() => {
	                  setLocalStorageItem(SHOW_SNOOZED_TASKS_KEY, showSnoozedTasks ? "false" : "true");
	                }}
	              >
	                {showSnoozedTasks ? "Hide snoozed tasks" : "Show snoozed tasks"}
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

      <div className="space-y-3 max-md:space-y-2.5">
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
            className="rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] bg-[linear-gradient(145deg,rgba(28,32,40,0.6),rgba(16,19,24,0.5))] p-3.5 shadow-[0_0_0_1px_rgba(0,0,0,0.25)] backdrop-blur md:p-4"
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
        {(() => {
          const topicCards = pagedTopics.map((topic, topicIndex) => {
          const topicId = topic.id;
          const isUnassigned = topicId === "unassigned";
          const deleteKey = `topic:${topic.id}`;
          const taskList = tasksByTopic.get(topicId) ?? [];
          const openCount = taskList.filter((task) => task.status !== "done").length;
          const doingCount = taskList.filter((task) => task.status === "doing").length;
	          const blockedCount = taskList.filter((task) => task.status === "blocked").length;
	          const lastActivity = logsByTopic.get(topicId)?.[0]?.createdAt ?? topic.updatedAt;
	          const hasUnsnoozedBadge = Object.prototype.hasOwnProperty.call(unsnoozedTopicBadges, topicId);
	          const topicLogsAll = logsByTopicAll.get(topicId) ?? [];
	          const topicChatAllLogs = topicLogsAll.filter((entry) => !entry.taskId && matchesLogSearchChat(entry));
	          const topicChatBlurb = deriveChatHeaderBlurb(topicChatAllLogs);
	          const showTasks = true;
	          const isExpanded = expandedTopicsSafe.has(topicId);
	          const topicChatKey = chatKeyForTopic(topicId);
	          const topicChatFullscreen =
	            !mdUp &&
	            mobileLayer === "chat" &&
	            mobileChatTarget?.kind === "topic" &&
	            mobileChatTarget.topicId === topicId;
	          const topicChatExpanded = topicChatFullscreen || expandedTopicChatsSafe.has(topicId);
	          const mobileChatTopicId =
	            mobileLayer === "chat"
              ? mobileChatTarget?.kind === "task"
                ? mobileChatTarget.topicId
                : mobileChatTarget?.topicId
              : null;
          if (!mdUp && mobileLayer === "chat" && mobileChatTopicId && mobileChatTopicId !== topicId) {
            return null;
          }
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
		                  const normalizedStatus = String(topic.status ?? "active").trim().toLowerCase();
		                  const isSnoozed = normalizedStatus === "snoozed" || normalizedStatus === "paused";
		                  if (isSnoozed) {
		                    void patchTopic(topicId, { status: "active", snoozedUntil: null });
		                    return;
		                  }
		                  setSnoozeTarget({ kind: "topic", topicId, label: topic.name });
		                }}
	                disabled={readOnly}
	                className={cn(
	                  "inline-flex h-full min-w-[80px] items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] border px-3.5 py-2 text-xs font-semibold leading-none tracking-[0.04em] transition",
	                  "border-[rgba(77,171,158,0.55)] text-[rgb(var(--claw-accent-2))] hover:bg-[rgba(77,171,158,0.14)]",
                  readOnly ? "opacity-60" : ""
                )}
              >
	                {(() => {
	                  const normalizedStatus = String(topic.status ?? "active").trim().toLowerCase();
	                  const isSnoozed = normalizedStatus === "snoozed" || normalizedStatus === "paused";
	                  return isSnoozed ? "UNSNOOZE" : "SNOOZE";
	                })()}
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
                  "inline-flex h-full min-w-[80px] items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] border px-3.5 py-2 text-xs font-semibold leading-none tracking-[0.04em] transition",
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
                  "inline-flex h-full min-w-[80px] items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] border px-3.5 py-2 text-xs font-semibold leading-none tracking-[0.04em] transition",
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
                "border border-[rgb(var(--claw-border))] p-4 transition-colors duration-300 md:p-5",
                topicChatFullscreen
                  ? "fixed inset-0 z-[1400] m-0 flex h-[var(--claw-mobile-vh)] flex-col overflow-hidden rounded-none border-0 p-0"
                  : "relative rounded-[var(--radius-lg)]",
                // Mobile UX: keep the topic header visible and scroll the expanded body when it would
                // exceed the viewport.
                //
                // NOTE: Don't set overflow/max-height on the outer card; it can make the expanded
                // state feel like a clipped "box". Constrain the scroll region instead.
                isExpanded && !topicChatFullscreen
                  ? "max-md:sticky max-md:top-[calc(var(--claw-header-h,0px)+8px)] max-md:flex max-md:flex-col"
                  : "",
                draggingTopicId && topicDropTargetId === topicId ? "border-[rgba(255,90,45,0.55)]" : ""
              )}
              style={topicChatFullscreen ? mobileOverlaySurfaceStyle(topicColor) : topicGlowStyle(topicColor, topicIndex, isExpanded)}
            >
              <div
                role="button"
                tabIndex={0}
                className={cn(
                  "flex items-start justify-between gap-3 text-left",
                  topicChatFullscreen ? "hidden" : "",
                  editingTopicId === topic.id ? "flex-wrap" : "flex-nowrap",
                  isExpanded && !topicChatFullscreen
                    ? "max-md:sticky max-md:top-0 max-md:z-10"
                    : ""
                )}
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
		                <div className="min-w-0">
		                  <div className="flex min-w-0 items-center gap-2">
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
	                        <h2 className="truncate text-base font-semibold md:text-lg">{topic.name}</h2>
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
		                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-[rgb(var(--claw-muted))] sm:text-xs">
	                    <span>{taskList.length} tasks</span>
	                    <span>{openCount} open</span>
	                    {isExpanded && <span>{doingCount} doing</span>}
	                    {isExpanded && <span>{blockedCount} blocked</span>}
	                    {hasUnsnoozedBadge ? (
	                      <button
	                        type="button"
	                        onClick={(event) => {
	                          event.stopPropagation();
	                          dismissUnsnoozedTopicBadge(topicId);
	                        }}
	                        title="Dismiss UNSNOOZED"
	                        className="inline-flex items-center gap-2 rounded-full border border-[rgba(77,171,158,0.55)] bg-[rgba(77,171,158,0.12)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[rgb(var(--claw-accent-2))] transition hover:bg-[rgba(77,171,158,0.18)]"
	                      >
	                        UNSNOOZED
	                      </button>
	                    ) : (
	                      <span>Last activity {formatRelativeTime(lastActivity)}</span>
	                    )}
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
		                    "flex h-8 w-8 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-base text-[rgb(var(--claw-muted))] transition",
		                    "hover:border-[rgba(255,90,45,0.3)] hover:text-[rgb(var(--claw-text))]"
		                  )}
	                >
		                  {isExpanded ? "▾" : "▸"}
		                </button>
		              </div>
	
		              {isExpanded && showTasks && (
		                <div
                      data-testid={`topic-expanded-body-${topicId}`}
	                      className={cn(
		                        topicChatFullscreen
                              ? "mt-0 flex min-h-0 flex-1 flex-col"
                              : "mt-3 space-y-3 max-md:pb-2"
		                      )}
	                    >
                      {!topicChatFullscreen ? (
                        <>
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
                      if (
                        !mdUp &&
                        mobileLayer === "chat" &&
                        mobileChatTarget?.kind === "task" &&
                        mobileChatTarget.taskId !== task.id
                      ) {
                        return null;
                      }
	                      if (normalizedSearch && !matchesTaskSearch(task) && !`${topic.name} ${topic.description ?? ""}`.toLowerCase().includes(normalizedSearch)) {
	                        return null;
	                      }
	                      const taskLogs = logsByTaskAll.get(task.id) ?? [];
                      const taskChatFullscreen =
                        !mdUp &&
                        mobileLayer === "chat" &&
                        mobileChatTarget?.kind === "task" &&
                        mobileChatTarget.taskId === task.id;
                      const taskExpanded = taskChatFullscreen || expandedTasksSafe.has(task.id);
	                      const taskColor =
	                        taskDisplayColors.get(task.id) ??
	                        normalizeHexColor(task.color) ??
	                        colorFromSeed(`task:${task.id}:${task.title}`, TASK_FALLBACK_COLORS);
	                      const taskSnoozedUntil = (task.snoozedUntil ?? "").trim();
	                      const taskSnoozedStamp = taskSnoozedUntil ? Date.parse(taskSnoozedUntil) : Number.NaN;
	                      const taskIsSnoozed = Number.isFinite(taskSnoozedStamp) && taskSnoozedStamp > Date.now();
	                      const hasUnsnoozedTaskBadge = Object.prototype.hasOwnProperty.call(unsnoozedTaskBadges, task.id);
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
	                              setSnoozeTarget({ kind: "task", topicId, taskId: task.id, label: task.title });
	                            }}
	                            disabled={readOnly}
	                            className={cn(
	                              "inline-flex h-full min-w-[80px] items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] border px-3.5 py-2 text-xs font-semibold leading-none tracking-[0.04em] transition",
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
                              "inline-flex h-full min-w-[80px] items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] border px-3.5 py-2 text-xs font-semibold leading-none tracking-[0.04em] transition",
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
                              "inline-flex h-full min-w-[80px] items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] border px-3.5 py-2 text-xs font-semibold leading-none tracking-[0.04em] transition",
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
		                            "border border-[rgb(var(--claw-border))] p-3.5 transition-colors duration-300 sm:p-4",
                                taskChatFullscreen
                                  ? "fixed inset-0 z-[1400] m-0 flex h-[var(--claw-mobile-vh)] flex-col overflow-hidden rounded-none border-0 p-0"
                                  : "relative rounded-[var(--radius-md)]",
		                            draggingTaskId && taskDropTargetId === task.id ? "border-[rgba(77,171,158,0.55)]" : "",
                                statusMenuTaskId === task.id ? "z-40" : ""
		                          )}
		                          style={taskChatFullscreen ? mobileOverlaySurfaceStyle(taskColor) : taskGlowStyle(taskColor, taskIndex, taskExpanded)}
		                        >
                          <div
                            role="button"
                            tabIndex={0}
                            className={cn(
                              "flex items-center justify-between gap-2.5 text-left",
                              taskChatFullscreen ? "hidden" : "",
                              editingTaskId === task.id ? "flex-wrap" : "flex-nowrap",
                              taskExpanded
                                ? "max-md:sticky max-md:top-0 max-md:z-10 max-md:-mx-4 max-md:border-b max-md:border-[rgb(var(--claw-border))] max-md:px-4 max-md:py-2.5 max-md:backdrop-blur"
                                : ""
                            )}
                            style={!mdUp && taskExpanded ? mobileOverlayHeaderStyle(taskColor) : undefined}
                            onClick={(event) => {
                              if (!allowToggle(event.target as HTMLElement)) return;
                              toggleTaskExpanded(topicId, task.id);
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
		                          <div className="min-w-0">
			                            <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
		                              <button
		                                type="button"
		                                data-testid={`reorder-task-${task.id}`}
		                                aria-label="Reorder task"
		                                title={
		                                  readOnly
		                                    ? "Read-only mode. Add token in Setup to reorder."
		                                    : taskReorderEnabled
		                                      ? "Drag to reorder tasks"
		                                      : "Clear search and set Status=All to reorder"
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
	                                  <span className="truncate">{task.title}</span>
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
	                              {hasUnsnoozedTaskBadge ? (
	                                <button
	                                  type="button"
	                                  onClick={(event) => {
	                                    event.stopPropagation();
	                                    dismissUnsnoozedTaskBadge(task.id);
	                                  }}
	                                  title="Dismiss UNSNOOZED"
	                                  className="inline-flex items-center gap-2 rounded-full border border-[rgba(77,171,158,0.55)] bg-[rgba(77,171,158,0.12)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[rgb(var(--claw-accent-2))] transition hover:bg-[rgba(77,171,158,0.18)]"
	                                >
	                                  UNSNOOZED
	                                </button>
	                              ) : (
	                                <>
	                                  {taskExpanded ? "Updated" : "Last touch"} {formatRelativeTime(task.updatedAt)}
	                                </>
	                              )}
	                            </div>
	                          </div>
	                          <div className="flex items-center gap-2">
	                            {isSessionResponding(taskSessionKey(topicId, task.id)) ? (
	                              <span title="OpenClaw responding" className="inline-flex items-center">
	                                <TypingDots />
	                              </span>
	                            ) : null}
                              <div className="relative" data-task-status-menu>
                                <button
                                  type="button"
                                  data-testid={`task-status-trigger-${task.id}`}
                                  disabled={readOnly}
                                  aria-haspopup="menu"
                                  aria-expanded={statusMenuTaskId === task.id}
                                  title={readOnly ? "Read only" : "Change status"}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (readOnly) return;
                                    if (statusMenuTaskId === task.id) {
                                      setStatusMenuTaskId(null);
                                      setStatusMenuPosition(null);
                                      return;
                                    }
                                    openStatusMenu(task.id);
                                  }}
                                  onKeyDown={(event) => {
                                    if (readOnly) return;
                                    if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " ") return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    openStatusMenu(task.id);
                                    window.requestAnimationFrame(() => {
                                      const first = document.querySelector<HTMLElement>(
                                        `[data-testid='task-status-option-${task.id}-0']`
                                      );
                                      first?.focus();
                                    });
                                  }}
                                  className={cn(
                                    "inline-flex items-center gap-2 rounded-full border border-transparent px-1 py-0.5 transition",
                                    readOnly
                                      ? "cursor-not-allowed opacity-70"
                                      : "hover:border-[rgba(148,163,184,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(77,171,158,0.35)]"
                                  )}
                                >
                                  <StatusPill tone={STATUS_TONE[task.status]} label={STATUS_LABELS[task.status] ?? task.status} />
                                  {!readOnly ? (
                                    <span className="text-xs text-[rgb(var(--claw-muted))]">▾</span>
                                  ) : null}
                                </button>
                                {statusMenuTaskId === task.id && !readOnly && statusMenuPosition && typeof document !== "undefined"
                                  ? createPortal(
                                      <div
                                        role="menu"
                                        data-task-status-menu
                                        data-testid={`task-status-menu-${task.id}`}
                                        className="fixed z-[1200] min-w-[170px] rounded-xl border border-[rgba(148,163,184,0.28)] bg-[rgba(16,19,24,0.96)] p-1.5 shadow-[0_14px_35px_rgba(0,0,0,0.4)] backdrop-blur"
                                        style={{
                                          top: statusMenuPosition.top,
                                          left: statusMenuPosition.left,
                                          transform: statusMenuPosition.openUp ? "translateY(-100%)" : undefined,
                                        }}
                                        onClick={(event) => event.stopPropagation()}
                                      >
                                        {TASK_STATUS_OPTIONS.filter((status) => status !== task.status).map((status, index, all) => (
                                          <button
                                            key={status}
                                            type="button"
                                            role="menuitem"
                                            data-testid={`task-status-option-${task.id}-${index}`}
                                            onClick={() => {
                                              setStatusMenuTaskId(null);
                                              setStatusMenuPosition(null);
                                              void updateTask(task.id, { status });
                                            }}
                                            onKeyDown={(event) => {
                                              if (event.key === "Escape") {
                                                event.preventDefault();
                                                setStatusMenuTaskId(null);
                                                setStatusMenuPosition(null);
                                                const trigger = document.querySelector<HTMLElement>(
                                                  `[data-testid='task-status-trigger-${task.id}']`
                                                );
                                                trigger?.focus();
                                                return;
                                              }
                                              if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
                                              event.preventDefault();
                                              const nextIndex =
                                                event.key === "Home"
                                                  ? 0
                                                  : event.key === "End"
                                                    ? all.length - 1
                                                    : event.key === "ArrowDown"
                                                      ? (index + 1) % all.length
                                                      : (index - 1 + all.length) % all.length;
                                              const next = document.querySelector<HTMLElement>(
                                                `[data-testid='task-status-option-${task.id}-${nextIndex}']`
                                              );
                                              next?.focus();
                                            }}
                                            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs text-[rgb(var(--claw-text))] transition hover:bg-[rgba(77,171,158,0.15)] focus-visible:bg-[rgba(77,171,158,0.15)] focus-visible:outline-none"
                                          >
                                            <span>{STATUS_LABELS[status] ?? status}</span>
                                            <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--claw-muted))]" />
                                          </button>
                                        ))}
                                      </div>,
                                      document.body
                                    )
                                  : null}
                              </div>
	                            <button
	                              type="button"
	                              aria-label={taskExpanded ? `Collapse task ${task.title}` : `Expand task ${task.title}`}
	                              title={taskExpanded ? "Collapse" : "Expand"}
	                              onClick={(event) => {
	                                event.stopPropagation();
	                                toggleTaskExpanded(topicId, task.id);
	                              }}
		                              className={cn(
		                                "flex h-8 w-8 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-base text-[rgb(var(--claw-muted))] transition",
		                                "hover:border-[rgba(77,171,158,0.45)] hover:text-[rgb(var(--claw-text))]"
		                              )}
	                            >
	                              {taskExpanded ? "▾" : "▸"}
	                            </button>
	                          </div>
		                        </div>
			                        {taskExpanded && (
			                          <div
                              className={cn(
                                "mt-2.5 pt-2",
                                taskChatFullscreen
                                  ? "mt-0 flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none px-4 pb-5 pt-[calc(env(safe-area-inset-top)+2.7rem)]"
                                  : ""
                              )}
                              style={taskChatFullscreen ? mobileOverlaySurfaceStyle(taskColor) : undefined}
                            >
                              {taskChatFullscreen ? (
                                <button
                                  type="button"
	                                  className="absolute left-3 top-[calc(env(safe-area-inset-top)+0.5rem)] z-20 inline-flex h-8 w-8 items-center justify-center rounded-full border text-base text-[rgb(var(--claw-text))] backdrop-blur"
                                  style={mobileOverlayCloseButtonStyle(taskColor)}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    closeMobileChatLayer();
                                  }}
                                  aria-label="Close chat"
                                  title="Close chat"
                                >
                                  ✕
                                </button>
                              ) : null}
						                              <div
                                        className={cn(
                                          taskChatFullscreen
                                            ? "mb-2 space-y-1"
                                            : "mb-2.5 flex flex-wrap items-center justify-between gap-2"
                                        )}
                                      >
                                        {taskChatFullscreen ? (
                                          <div className="flex min-w-0 items-start justify-between gap-2">
                                            <div data-testid={`task-chat-context-${task.id}`} className="min-w-0 flex-1 pr-2">
                                              <div className="flex min-w-0 items-center gap-1.5">
                                                <div className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">
                                                  TASK CHAT
                                                </div>
                                                {isSessionResponding(taskSessionKey(topicId, task.id)) ? <TypingDots /> : null}
                                              </div>
                                              <nav
                                                aria-label="Task chat context"
                                                data-testid={`task-chat-breadcrumb-${task.id}`}
                                                className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-[rgb(var(--claw-muted))]"
                                              >
                                                <span className="shrink-0 uppercase tracking-[0.14em]">Topic</span>
                                                <span className="min-w-0 max-w-[30vw] truncate font-medium text-[rgb(var(--claw-text))]">
                                                  {topic.name}
                                                </span>
                                                <span className="shrink-0 text-[rgba(var(--claw-muted),0.65)]">/</span>
                                                <span className="shrink-0 uppercase tracking-[0.14em]">Task</span>
                                                <span className="min-w-0 max-w-[48vw] break-words font-medium leading-tight text-[rgb(var(--claw-text))]">
                                                  {task.title}
                                                </span>
                                              </nav>
                                            </div>
                                            <div className="flex min-w-[108px] items-center justify-end">
                                              <Select
                                                data-testid={`task-chat-status-${task.id}`}
                                                value={task.status}
                                                className="h-8 w-[108px] min-w-[108px] max-w-[108px] shrink-0 rounded-full text-[11px]"
                                                onClick={(event) => {
                                                  event.stopPropagation();
                                                }}
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
                                            </div>
                                          </div>
                                        ) : (
                                          <div className="flex min-w-0 items-center gap-2">
                                            <div className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">
                                              TASK CHAT
                                            </div>
                                            {isSessionResponding(taskSessionKey(topicId, task.id)) ? <TypingDots /> : null}
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
                                        )}
                                        <div
                                          data-testid={`task-chat-controls-${task.id}`}
                                          className={cn(
                                            "flex flex-nowrap items-center gap-2",
                                            taskChatFullscreen ? "w-full justify-end" : "justify-end"
                                          )}
                                        >
                                          <div className="flex flex-nowrap items-center justify-end gap-2">
                                            <span
                                              data-testid={`task-chat-entries-${task.id}`}
                                              className="shrink-0 whitespace-nowrap text-xs text-[rgb(var(--claw-muted))]"
                                            >
                                              {taskChatAllLogs.length} entries
                                            </span>
                                            {truncated ? (
                                              <Button
                                                size="sm"
                                                variant="secondary"
                                                onClick={() =>
                                                  loadOlderChat(taskChatKey, TASK_TIMELINE_LIMIT, taskChatAllLogs.length, TASK_TIMELINE_LIMIT)
                                                }
                                                className="order-last shrink-0 whitespace-nowrap"
                                              >
                                                Load older
                                              </Button>
                                            ) : null}
                                          </div>
                                        </div>
                                      </div>
		                              {taskChatAllLogs.length === 0 &&
                              !pendingMessages.some((pending) => pending.sessionKey === taskSessionKey(topicId, task.id)) &&
                              !isSessionResponding(taskSessionKey(topicId, task.id)) ? (
		                                <p className="mb-3 text-sm text-[rgb(var(--claw-muted))]">No messages yet.</p>
		                              ) : null}
	                                <div className={cn("relative", taskChatFullscreen ? "min-h-0 flex flex-1 flex-col" : "")}>
	                                  <div
	                                    className={cn(
	                                      "pointer-events-none absolute left-0 right-0 top-0 z-10 h-8 bg-[linear-gradient(to_bottom,rgb(var(--claw-panel)/0.78),rgb(var(--claw-panel)/0.38)_52%,rgb(var(--claw-panel)/0.0))] shadow-[0_14px_18px_rgba(0,0,0,0.22)] transition-opacity duration-200 ease-out",
	                                      chatTopFade[`task:${task.id}`] ? "opacity-100" : "opacity-0"
	                                    )}
	                                  />
	                                  {chatJumpToBottom[`task:${task.id}`] ? (
	                                    <button
	                                      type="button"
	                                      className={cn(
	                                        "absolute bottom-2 left-1/2 z-20 -translate-x-1/2",
	                                        "rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(14,17,22,0.72)] px-3 py-1.5",
	                                        "text-[11px] font-semibold uppercase tracking-[0.18em] text-[rgba(148,163,184,0.95)]",
	                                        "shadow-[0_12px_26px_rgba(0,0,0,0.28)] backdrop-blur",
	                                        "transition hover:border-[rgba(255,90,45,0.38)] hover:text-[rgb(var(--claw-text))]"
	                                      )}
	                                      onClick={(event) => {
	                                        event.preventDefault();
	                                        event.stopPropagation();
	                                        const chatKey = `task:${task.id}`;
	                                        activeChatAtBottomRef.current = true;
	                                        scheduleScrollChatToBottom(chatKey);
	                                      }}
	                                      aria-label="Jump to latest messages"
	                                      title="Jump to latest"
	                                    >
	                                      Jump to latest ↓
	                                    </button>
	                                  ) : null}
		                                  <div
		                                    data-testid={`task-chat-scroll-${task.id}`}
		                                    ref={getChatScrollerRef(`task:${task.id}`)}
		                                    onScroll={(event) => {
		                                      const key = `task:${task.id}`;
		                                      const node = event.currentTarget;
		                                      const showTop = node.scrollTop > 2;
	                                      const remaining = node.scrollHeight - (node.scrollTop + node.clientHeight);
	                                      const atBottom = remaining <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
	                                      chatAtBottomRef.current.set(key, atBottom);

	                                      const prevTop = chatLastScrollTopRef.current.get(key) ?? node.scrollTop;
	                                      const delta = node.scrollTop - prevTop;
	                                      chatLastScrollTopRef.current.set(key, node.scrollTop);
	                                      // UX: hide the jump-to-latest button while the user scrolls UP (reading history).
	                                      // Only show it again when scrolling DOWN and not at bottom.
	                                      const shouldShowJump = !atBottom && delta > 0;
	                                      setChatJumpToBottom((prev) =>
	                                        prev[key] === shouldShowJump ? prev : { ...prev, [key]: shouldShowJump }
	                                      );
	                                      setChatTopFade((prev) =>
	                                        prev[key] === showTop ? prev : { ...prev, [key]: showTop }
	                                      );
	                                      if (activeChatKeyRef.current === key) updateActiveChatAtBottom();
                                    }}
                                    className={cn(
                                      "overflow-y-auto pr-1",
                                      taskChatFullscreen
                                        ? "min-h-0 flex-1 overflow-y-auto overscroll-contain"
                                        : ""
                                    )}
                                    style={
                                      taskChatFullscreen
                                        ? undefined
                                        : {
                                            // Keep the composer visible while allowing long conversations to scroll within the chat pane.
	                                            maxHeight: "max(240px, calc(100dvh - var(--claw-header-h, 0px) - 300px))",
	                                          }
	                                    }
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
                                      {!isUnassigned
                                        ? pendingMessages
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
                                                    <div className="mt-1 flex items-center justify-end gap-2 text-[10px] text-[rgba(148,163,184,0.9)]">
                                                      <button
                                                        type="button"
                                                        className="rounded-full border border-[rgba(255,255,255,0.10)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[rgba(148,163,184,0.9)] transition hover:border-[rgba(255,90,45,0.35)] hover:text-[rgb(var(--claw-text))]"
                                                        onClick={(event) => {
                                                          event.preventDefault();
                                                          event.stopPropagation();
                                                          void navigator.clipboard?.writeText?.(pending.message ?? "");
                                                        }}
                                                        title="Copy message"
                                                      >
                                                        Copy
                                                      </button>
                                                      <span>
                                                        {pending.status === "sending"
                                                          ? "Sending…"
                                                          : pending.status === "sent"
                                                            ? "Sent"
                                                            : pending.error
                                                              ? pending.error
                                                              : "Failed to send."}
                                                      </span>
                                                    </div>
                                                  </div>
                                                </div>
                                              </div>
                                            ))
                                        : null}
                                      {!isUnassigned && isSessionResponding(taskSessionKey(topicId, task.id)) ? (
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
                                      {/* Keep a small tail spacer for chat breathing room without wasting viewport height. */}
                                      <div aria-hidden className={taskChatFullscreen ? "h-2" : "h-12"} />
	                                  </div>
	                                </div>
					                              {/* Load more moved into the chat header (top-right). */}
					                              {!isUnassigned && (
					                                <>
					                                <BoardChatComposer
	                                      ref={(node) => {
	                                        const key = taskSessionKey(topicId, task.id);
	                                        if (node) composerHandlesRef.current.set(key, node);
                                        else composerHandlesRef.current.delete(key);
                                      }}
			                                  sessionKey={taskSessionKey(topicId, task.id)}
			                                  className={cn(
                                        "mt-4",
                                        taskChatFullscreen
                                          ? "max-md:mt-0.5 max-md:shrink-0 max-md:border-t max-md:border-[rgba(255,255,255,0.08)] max-md:bg-[rgba(11,13,18,0.86)] max-md:px-1 max-md:pb-0 max-md:pt-1 max-md:backdrop-blur"
                                          : ""
                                      )}
			                                  variant="seamless"
			                                  dense={taskChatFullscreen}
			                                  placeholder={`Message ${task.title}…`}
			                                  onFocus={() => {
			                                    setActiveComposer({ kind: "task", topicId, taskId: task.id });
			                                    if (!taskChatFullscreen) {
			                                      const chatKey = `task:${task.id}`;
			                                      activeChatAtBottomRef.current = true;
			                                      scheduleScrollChatToBottom(chatKey);
			                                      setChatJumpToBottom((prev) =>
			                                        prev[chatKey] === false ? prev : { ...prev, [chatKey]: false }
			                                      );
			                                    }
			                                  }}
			                                  onBlur={() =>
			                                    setActiveComposer((prev) =>
			                                      prev?.kind === "task" && prev.taskId === task.id ? null : prev
			                                    )
			                                  }
			                                  autoFocus={autoFocusTask?.topicId === topicId && autoFocusTask?.taskId === task.id}
			                                  onAutoFocusApplied={() =>
			                                    setAutoFocusTask((prev) =>
			                                      prev?.topicId === topicId && prev?.taskId === task.id ? null : prev
			                                    )
			                                  }
			                                  onSendUpdate={handleComposerSendUpdate}
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
                        </>
                      ) : null}

	                  {!isUnassigned && (
	                    <div
	                      className={cn(
                          "border border-[rgb(var(--claw-border))] transition-colors duration-300",
                          topicChatFullscreen
                            ? "flex min-h-0 flex-1 flex-col rounded-none border-0 p-0"
                            : "rounded-[var(--radius-md)] p-4"
                        )}
	                      style={topicChatFullscreen ? mobileOverlaySurfaceStyle(topicColor) : taskGlowStyle(topicColor, taskList.length, topicChatExpanded)}
	                    >
                      <div
                        role="button"
                        tabIndex={0}
		                        className={cn(
                          "flex items-center justify-between gap-2.5 text-left",
                          !mdUp && mobileLayer === "chat" ? "max-md:hidden" : ""
                        )}
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
				                            "flex h-8 w-8 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-base text-[rgb(var(--claw-muted))] transition",
				                            "hover:border-[rgba(255,90,45,0.3)] hover:text-[rgb(var(--claw-text))]"
				                          )}
			                        >
			                          {topicChatExpanded ? "▾" : "▸"}
			                        </button>
		                      </div>
		                      {topicChatExpanded && (
		                        <div
                              className={cn(
                                "mt-2.5 pt-2",
                                topicChatFullscreen
                                  ? "mt-0 flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none px-4 pb-5 pt-[calc(env(safe-area-inset-top)+2.7rem)]"
                                  : ""
                              )}
                              style={topicChatFullscreen ? mobileOverlaySurfaceStyle(topicColor) : undefined}
                            >
                              {topicChatFullscreen ? (
                                <button
                                  type="button"
	                                  className="absolute left-3 top-[calc(env(safe-area-inset-top)+0.5rem)] z-20 inline-flex h-8 w-8 items-center justify-center rounded-full border text-base text-[rgb(var(--claw-text))] backdrop-blur"
                                  style={mobileOverlayCloseButtonStyle(topicColor)}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    closeMobileChatLayer();
                                  }}
                                  aria-label="Close chat"
                                  title="Close chat"
                                >
                                  ✕
                                </button>
                              ) : null}
						                        <div className={cn("mb-2", topicChatFullscreen ? "space-y-1" : "flex items-center justify-end gap-2")}>
                                      {topicChatFullscreen ? (
                                        <div data-testid={`topic-chat-context-${topicId}`} className="pr-10">
                                          <div className="flex min-w-0 items-center gap-1.5">
                                            <div className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">
                                              TOPIC CHAT
                                            </div>
                                            {isSessionResponding(topicSessionKey(topicId)) ? <TypingDots /> : null}
                                          </div>
                                          <nav
                                            aria-label="Topic chat context"
                                            data-testid={`topic-chat-breadcrumb-${topicId}`}
                                            className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-[rgb(var(--claw-muted))]"
                                          >
                                            <span className="shrink-0 uppercase tracking-[0.14em]">Topic</span>
                                            <span className="min-w-0 max-w-[62vw] truncate font-medium text-[rgb(var(--claw-text))]">
                                              {topic.name}
                                            </span>
                                          </nav>
                                        </div>
                                      ) : null}
                                      <div
                                        data-testid={`topic-chat-controls-${topicId}`}
                                        className={cn(
                                          "flex flex-nowrap items-center gap-2",
                                          topicChatFullscreen ? "w-full justify-end" : "justify-end"
                                        )}
                                      >
                                        <span
                                          data-testid={`topic-chat-entries-${topicId}`}
                                          className="shrink-0 whitespace-nowrap text-xs text-[rgb(var(--claw-muted))]"
                                        >
                                          {topicChatAllLogs.length} entries
                                        </span>
                                        {topicChatTruncated ? (
                                          <Button
                                            size="sm"
                                            variant="secondary"
                                            className="order-last shrink-0 whitespace-nowrap"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              event.preventDefault();
                                              loadOlderChat(topicChatKey, TOPIC_TIMELINE_LIMIT, topicChatAllLogs.length, TOPIC_TIMELINE_LIMIT);
                                            }}
                                          >
                                            Load older
                                          </Button>
                                        ) : null}
                                      </div>
					                        </div>
			                          {topicChatAllLogs.length === 0 &&
                              !pendingMessages.some((pending) => pending.sessionKey === topicSessionKey(topicId)) &&
                              !isSessionResponding(topicSessionKey(topicId)) ? (
			                            <p className="mb-3 text-sm text-[rgb(var(--claw-muted))]">No messages yet.</p>
			                          ) : null}
			                          <div className={cn("relative", topicChatFullscreen ? "min-h-0 flex flex-1 flex-col" : "")}>
			                            <div
			                              className={cn(
			                                // Subtle iMessage-style fade when there is scroll content above/below.
			                                "pointer-events-none absolute left-0 right-0 top-0 z-10 h-8 bg-[linear-gradient(to_bottom,rgb(var(--claw-panel)/0.78),rgb(var(--claw-panel)/0.38)_52%,rgb(var(--claw-panel)/0.0))] shadow-[0_14px_18px_rgba(0,0,0,0.22)] transition-opacity duration-200 ease-out",
			                                chatTopFade[`topic:${topicId}`] ? "opacity-100" : "opacity-0"
			                              )}
			                            />
			                            {chatJumpToBottom[`topic:${topicId}`] ? (
			                              <button
			                                type="button"
			                                className={cn(
			                                  "absolute bottom-2 left-1/2 z-20 -translate-x-1/2",
			                                  "rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(14,17,22,0.72)] px-3 py-1.5",
			                                  "text-[11px] font-semibold uppercase tracking-[0.18em] text-[rgba(148,163,184,0.95)]",
			                                  "shadow-[0_12px_26px_rgba(0,0,0,0.28)] backdrop-blur",
			                                  "transition hover:border-[rgba(255,90,45,0.38)] hover:text-[rgb(var(--claw-text))]"
			                                )}
			                                onClick={(event) => {
			                                  event.preventDefault();
			                                  event.stopPropagation();
			                                  const chatKey = `topic:${topicId}`;
			                                  activeChatAtBottomRef.current = true;
			                                  scheduleScrollChatToBottom(chatKey);
			                                }}
			                                aria-label="Jump to latest messages"
			                                title="Jump to latest"
			                              >
			                                Jump to latest ↓
			                              </button>
			                            ) : null}
				                            <div
				                              data-testid={`topic-chat-scroll-${topicId}`}
		                              ref={getChatScrollerRef(`topic:${topicId}`)}
				                              onScroll={(event) => {
				                                const key = `topic:${topicId}`;
				                                const node = event.currentTarget;
				                                const showTop = node.scrollTop > 2;
			                                const remaining = node.scrollHeight - (node.scrollTop + node.clientHeight);
			                                const atBottom = remaining <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
			                                chatAtBottomRef.current.set(key, atBottom);

			                                  const prevTop = chatLastScrollTopRef.current.get(key) ?? node.scrollTop;
			                                  const delta = node.scrollTop - prevTop;
			                                  chatLastScrollTopRef.current.set(key, node.scrollTop);
    			                                // UX: hide the jump-to-latest button while the user scrolls UP (reading history).
			                                // Only show it again when scrolling DOWN and not at bottom.
			                                const shouldShowJump = !atBottom && delta > 0;
			                                setChatJumpToBottom((prev) =>
			                                  prev[key] === shouldShowJump ? prev : { ...prev, [key]: shouldShowJump }
			                                );
			                                setChatTopFade((prev) =>
			                                  prev[key] === showTop ? prev : { ...prev, [key]: showTop }
			                                );
			                                if (activeChatKeyRef.current === key) updateActiveChatAtBottom();
		                              }}
		                              className={cn(
		                                "overflow-y-auto pr-1",
		                                topicChatFullscreen
		                                  ? "min-h-0 flex-1 overflow-y-auto overscroll-contain"
		                                  : ""
		                              )}
		                              style={
		                                topicChatFullscreen
		                                  ? undefined
		                                  : {
			                                      maxHeight: "max(240px, calc(100dvh - var(--claw-header-h, 0px) - 280px))",
			                                    }
			                              }
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
                                                <div className="mt-1 flex items-center justify-end gap-2 text-[10px] text-[rgba(148,163,184,0.9)]">
                                                  <button
                                                    type="button"
                                                    className="rounded-full border border-[rgba(255,255,255,0.10)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[rgba(148,163,184,0.9)] transition hover:border-[rgba(255,90,45,0.35)] hover:text-[rgb(var(--claw-text))]"
                                                    onClick={(event) => {
                                                      event.preventDefault();
                                                      event.stopPropagation();
                                                      void navigator.clipboard?.writeText?.(pending.message ?? "");
                                                    }}
                                                    title="Copy message"
                                                  >
                                                    Copy
                                                  </button>
                                                  <span>
                                                    {pending.status === "sending"
                                                      ? "Sending…"
                                                      : pending.status === "sent"
                                                        ? "Sent"
                                                        : pending.error
                                                          ? pending.error
                                                          : "Failed to send."}
                                                  </span>
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
                                      {/* Keep a small tail spacer for chat breathing room without wasting viewport height. */}
                                      <div aria-hidden className={topicChatFullscreen ? "h-2" : "h-12"} />
			                            </div>
			                          </div>
			                          {/* Load more moved into the chat header (top-right). */}
			                          <BoardChatComposer
			                                ref={(node) => {
			                                  const key = topicSessionKey(topicId);
                                  if (node) composerHandlesRef.current.set(key, node);
                                  else composerHandlesRef.current.delete(key);
                                }}
		                            sessionKey={topicSessionKey(topicId)}
		                            className={cn(
                                "mt-4",
                                topicChatFullscreen
                                  ? "max-md:mt-0.5 max-md:shrink-0 max-md:border-t max-md:border-[rgba(255,255,255,0.08)] max-md:bg-[rgba(11,13,18,0.86)] max-md:px-1 max-md:pb-0 max-md:pt-1 max-md:backdrop-blur"
                                  : ""
                              )}
		                            variant="seamless"
		                            dense={topicChatFullscreen}
		                            placeholder={`Message ${topic.name}…`}
		                            onFocus={() => {
		                              setActiveComposer({ kind: "topic", topicId });
		                              if (!topicChatFullscreen) {
		                                const chatKey = `topic:${topicId}`;
		                                activeChatAtBottomRef.current = true;
		                                scheduleScrollChatToBottom(chatKey);
		                                setChatJumpToBottom((prev) =>
		                                  prev[chatKey] === false ? prev : { ...prev, [chatKey]: false }
		                                );
		                              }
		                            }}
		                            onBlur={() =>
		                              setActiveComposer((prev) =>
		                                prev?.kind === "topic" && prev.topicId === topicId ? null : prev
		                              )
		                            }
		                            onSendUpdate={handleComposerSendUpdate}
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
	        });

          if (!showTwoColumns) {
            return <div className="space-y-4">{topicCards}</div>;
          }

          const leftColumn: ReactNode[] = [];
          const rightColumn: ReactNode[] = [];
          topicCards.forEach((node, idx) => {
            (idx % 2 === 0 ? leftColumn : rightColumn).push(node);
          });

          return (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-4">{leftColumn}</div>
              <div className="space-y-4">{rightColumn}</div>
            </div>
          );
        })()}
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

      <SnoozeModal
        open={Boolean(snoozeTarget)}
        title={snoozeTarget?.kind === "task" ? "Snooze task" : "Snooze topic"}
        subtitle="Hide it until the chosen time. Any new activity will bring it back early."
        entityLabel={snoozeTarget?.label ?? null}
        onClose={() => setSnoozeTarget(null)}
        onSnooze={async (untilIso) => {
          const target = snoozeTarget;
          if (!target) return;
          if (target.kind === "topic") {
            await patchTopic(target.topicId, { status: "snoozed", snoozedUntil: untilIso });
            return;
          }
          await updateTask(target.taskId, { snoozedUntil: untilIso });
        }}
      />
    </div>
  );
}
