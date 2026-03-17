"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { LogEntry, OpenClawWorkspace, Space, Task, Topic, TopicStatus } from "@/lib/types";
import { Button, Input, Select, StatusPill, TextArea } from "@/components/ui";
import { LogList } from "@/components/log-list";
import { formatRelativeTime } from "@/lib/format";
import { useAppConfig, useOpenClawWorkspaces } from "@/components/providers";

import { decodeSlugId, encodeTopicSlug, slugify } from "@/lib/slug";
import { cn } from "@/lib/cn";
import { apiFetch } from "@/lib/api";
import { queueableApiMutation } from "@/lib/write-queue";
import { useDataStore } from "@/components/data-provider";
import { useSemanticSearch } from "@/lib/use-semantic-search";
import { mergeLogs } from "@/lib/live-utils";
import {
  isAgentConversationChatLog,
  isChatNoiseLog,
  isMeaningfulToolingOrSystemChatLog,
  isToolingOrSystemChatLog,
} from "@/lib/chat-log-visibility";
import {
  BoardChatComposer,
  type BoardChatComposerHandle,
  type BoardChatComposerSendEvent,
} from "@/components/board-chat-composer";
import {
  effectiveLogTopicId as effectiveBoardTopicId,
  BOARD_TOPIC_SESSION_PREFIX,
  normalizeBoardSessionKey,
  topicSessionKey,
  taskSessionKey,
} from "@/lib/board-session";
import {
  chatKeyForTask,
  parseStringMap,
} from "@/lib/attention-state";
import { Markdown } from "@/components/markdown";
import { AttachmentStrip, type AttachmentLike } from "@/components/attachments";
import { usePersistentDraft } from "@/lib/drafts";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";
import { randomId } from "@/lib/id";
import { buildSpaceVisibilityRevision, resolveSpaceVisibilityFromViewer } from "@/lib/space-visibility";
import { SnoozeModal } from "@/components/snooze-modal";
import { useUnifiedExpansionState } from "@/components/unified-view-state";
import { getInitialUnifiedUrlState, parseUnifiedUrlState } from "@/components/unified-view-url-state";
import { workspaceDirDisplay, workspaceRoute } from "@/lib/openclaw-workspaces";
import { buildLatestTopicTouchById, deriveAttentionTopicIds, topicLastTouchedAt } from "@/lib/topic-attention";
import { compareByBoardOrder, optimisticTopSortIndex } from "@/lib/topic-order";

const STATUS_TONE: Record<string, "muted" | "accent" | "accent2" | "warning" | "success"> = {
  active: "accent2",
  todo: "muted",
  doing: "accent",
  blocked: "warning",
  done: "success",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  todo: "To Do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

const TASK_STATUS_OPTIONS: TopicStatus[] = ["active", "todo", "doing", "blocked", "done"];
const TASK_STATUS_FILTERS = ["all", "todo", "doing", "blocked", "done"] as const;
type TaskStatusFilter = (typeof TASK_STATUS_FILTERS)[number];

const isTaskStatusFilter = (value: string): value is TaskStatusFilter =>
  TASK_STATUS_FILTERS.includes(value as TaskStatusFilter);

const TOPIC_VIEW_KEY = "clawboard.unified.topicView";
const SHOW_SNOOZED_TASKS_KEY = "clawboard.unified.showSnoozedTasks";
const FILTERS_DRAWER_OPEN_KEY = "clawboard.unified.filtersDrawerOpen";
const FILTERS_DRAWER_OPEN_DEFAULT = false;
const ACTIVE_SPACE_KEY = "clawboard.space.active";
const BOARD_LAST_URL_KEY = "clawboard.board.lastUrl";
const WORKSPACE_ATTENTION_SEEN_KEY = "clawboard.unified.workspaceAttentionSeenAt";
const DEFERRED_CHAT_COUNTS_REFRESH_MS = 1_200;
const DEFERRED_THREAD_HYDRATION_MS = 900;

const TOPIC_VIEWS = ["active", "snoozed", "archived", "all"] as const;
type TopicView = (typeof TOPIC_VIEWS)[number];
const isTopicView = (value: string): value is TopicView => TOPIC_VIEWS.includes(value as TopicView);
type TopicEditFocusTarget = "name" | "tags" | "color";

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

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.48-8.49" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("h-3.5 w-3.5", className)}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn("h-3.5 w-3.5", className)}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function isStopSlashCommand(input: string) {
  const normalized = String(input ?? "").trim().toLowerCase();
  return normalized === "/stop" || normalized === "/abort";
}

function inferMimeTypeFromName(fileName: string) {
  const lower = (fileName ?? "").trim().toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop() ?? "" : "";
  const mapping: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    json: "application/json",
    csv: "text/csv",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    webm: "audio/webm",
    ogg: "audio/ogg",
  };
  return mapping[ext] ?? "";
}

const TASK_TIMELINE_LIMIT = 2;
type MessageDensity = "comfortable" | "compact";
const TOPIC_FALLBACK_COLORS = [
  "#FF1744",
  "#FF3D00",
  "#FF6D00",
  "#FF9100",
  "#FFAB00",
  "#FFC400",
  "#FFD600",
  "#AEEA00",
  "#76FF03",
  "#64DD17",
  "#00E676",
  "#00C853",
  "#1DE9B6",
  "#00E5FF",
  "#00B8D4",
  "#00B0FF",
  "#0091EA",
  "#2979FF",
  "#3D5AFE",
  "#536DFE",
  "#651FFF",
  "#7C4DFF",
  "#AA00FF",
  "#D500F9",
  "#E040FB",
  "#F50057",
  "#FF4081",
  "#FF6E6E",
  "#FF7F50",
  "#FF8F00",
  "#C6FF00",
  "#69F0AE",
  "#64FFDA",
  "#18FFFF",
  "#40C4FF",
  "#82B1FF",
  "#B388FF",
  "#EA80FC",
  "#FF80AB",
  "#FF5252",
];
const TASK_FALLBACK_COLORS = [
  "#00E5FF",
  "#18FFFF",
  "#64FFDA",
  "#69F0AE",
  "#B2FF59",
  "#EEFF41",
  "#FFFF00",
  "#FFD740",
  "#FFAB40",
  "#FF9100",
  "#FF6D00",
  "#FF5252",
  "#FF1744",
  "#F50057",
  "#FF4081",
  "#E040FB",
  "#D500F9",
  "#B388FF",
  "#7C4DFF",
  "#536DFE",
  "#3D5AFE",
  "#448AFF",
  "#40C4FF",
  "#00B0FF",
  "#00E676",
  "#00C853",
  "#64DD17",
  "#AEEA00",
  "#C6FF00",
  "#FFEA00",
  "#FFC400",
  "#FF8A65",
  "#FF7043",
  "#FF9E80",
  "#80D8FF",
  "#84FFFF",
  "#A7FFEB",
  "#CCFF90",
  "#EA80FC",
  "#FF8A80",
];

const TOPIC_ACTION_REVEAL_PX = 288;
// New Topics/Tasks should float to the very top immediately after creation.
// Keep that priority for a long window so "something else happening" displaces it,
// instead of the item unexpectedly dropping due to time passing mid-session.
const NEW_ITEM_BUMP_MS = 24 * 60 * 60 * 1000;

const DEFAULT_UNIFIED_TOPICS_PAGE_SIZE = 50;
const UNIFIED_COMPOSER_MAX_HEIGHT_PX = 560;

type UnifiedComposerTarget =
  | { kind: "topic"; topicId: string };
type UnifiedComposerAttachment = AttachmentLike & { file: File };
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

function parseEnvSeconds(raw: string | undefined, fallbackSeconds: number, minSeconds: number, maxSeconds: number) {
  const parsed = Number(String(raw ?? "").trim());
  if (!Number.isFinite(parsed)) return fallbackSeconds;
  const value = Math.floor(parsed);
  return Math.max(minSeconds, Math.min(maxSeconds, value));
}

// Backward-compatible fallbacks for installs that have not added these NEXT_PUBLIC settings yet.
// Prefer setting explicit values in `.env`/deploy config for predictable long-running behavior.
const OPENCLAW_RESPONDING_OPTIMISTIC_REQUEST_TTL_MS =
  parseEnvSeconds(process.env.NEXT_PUBLIC_OPENCLAW_OPTIMISTIC_REQUEST_TTL_SECONDS, 12 * 60 * 60, 60, 30 * 24 * 60 * 60) *
  1000;
const OPENCLAW_RESPONDING_OPTIMISTIC_NO_REQUEST_TTL_MS =
  parseEnvSeconds(
    process.env.NEXT_PUBLIC_OPENCLAW_OPTIMISTIC_NO_REQUEST_TTL_SECONDS,
    10 * 60,
    30,
    7 * 24 * 60 * 60
  ) * 1000;
const OPENCLAW_PROMOTION_SIGNAL_WINDOW_MS =
  parseEnvSeconds(
    process.env.NEXT_PUBLIC_OPENCLAW_PROMOTION_SIGNAL_WINDOW_SECONDS,
    30 * 60,
    60,
    30 * 24 * 60 * 60
  ) * 1000;
const OPENCLAW_TYPING_ALIAS_INACTIVE_RETENTION_MS =
  parseEnvSeconds(
    process.env.NEXT_PUBLIC_OPENCLAW_TYPING_ALIAS_INACTIVE_RETENTION_SECONDS,
    30 * 60,
    60,
    30 * 24 * 60 * 60
  ) * 1000;
const OPENCLAW_THREAD_WORK_ACTIVE_TTL_MS =
  parseEnvSeconds(
    process.env.NEXT_PUBLIC_OPENCLAW_THREAD_WORK_ACTIVE_TTL_SECONDS,
    20 * 60,
    30,
    12 * 60 * 60
  ) * 1000;
const OPENCLAW_THREAD_WORK_INACTIVE_OVERRIDE_TTL_MS =
  parseEnvSeconds(
    process.env.NEXT_PUBLIC_OPENCLAW_THREAD_WORK_INACTIVE_OVERRIDE_TTL_SECONDS,
    2 * 60,
    10,
    30 * 60
  ) * 1000;
const OPENCLAW_NON_USER_ACTIVITY_TTL_MS =
  parseEnvSeconds(
    process.env.NEXT_PUBLIC_OPENCLAW_NON_USER_ACTIVITY_TTL_SECONDS,
    2 * 60,
    10,
    30 * 60
  ) * 1000;
const OPENCLAW_ORCHESTRATION_ACTIVE_TTL_MS =
  parseEnvSeconds(
    process.env.NEXT_PUBLIC_OPENCLAW_ORCHESTRATION_ACTIVE_TTL_SECONDS,
    20 * 60,
    30,
    12 * 60 * 60
  ) * 1000;

const SEARCH_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "so",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "this",
  "to",
  "we",
  "with",
  "you",
  "your",
]);
const SEARCH_QUERY_MAX_TERMS = 20;
const SEARCH_QUERY_LONG_MAX_TERMS = 32;
const SEARCH_QUERY_LONG_TRIGGER_CHARS = 220;
const SEARCH_QUERY_LONG_TRIGGER_TERMS = 24;
const SEARCH_QUERY_LEXICAL_MAX_CHARS = 260;
const SEARCH_QUERY_SEMANTIC_MAX_CHARS = 640;

type UnifiedSearchPlan = {
  raw: string;
  normalized: string;
  lexicalQuery: string;
  semanticQuery: string;
  terms: string[];
  phraseShards: string[];
  isLong: boolean;
};

type SemanticConfidenceOptions = {
  absoluteFloor: number;
  relativeFloor: number;
  maxCount: number;
};

type ScoredSemanticMatch = {
  id: string;
  score: number;
  sessionBoosted?: boolean;
};

type LogChatCountsPayload = {
  topicChatCounts?: Record<string, number>;
};

function tokenizeSearchQuery(query: string, maxTerms: number) {
  const normalized = String(query ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/_:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];
  const stats = new Map<string, { count: number; firstIndex: number }>();
  let tokenIndex = 0;
  for (const token of normalized.split(/\s+/)) {
    const term = token.trim().replace(/^[:/_-]+|[:/_-]+$/g, "");
    if (term.length < 2) continue;
    if (SEARCH_QUERY_STOPWORDS.has(term)) continue;
    const stat = stats.get(term);
    if (stat) {
      stat.count += 1;
    } else {
      stats.set(term, { count: 1, firstIndex: tokenIndex });
    }
    tokenIndex += 1;
  }
  const ranked = Array.from(stats.entries())
    .map(([term, stat]) => {
      const lengthBoost = Math.min(0.55, Math.max(0, term.length - 2) * 0.045);
      const freqBoost = Math.min(0.45, Math.max(0, stat.count - 1) * 0.16);
      const shapeBoost = /[0-9/:_-]/.test(term) ? 0.2 : 0;
      const earlyBoost = Math.max(0, 0.28 - Math.min(0.28, stat.firstIndex / 120));
      const score = 1 + lengthBoost + freqBoost + shapeBoost + earlyBoost;
      return { term, score, firstIndex: stat.firstIndex, count: stat.count };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.count !== a.count) return b.count - a.count;
      if (a.firstIndex !== b.firstIndex) return a.firstIndex - b.firstIndex;
      return a.term.localeCompare(b.term);
    });
  return ranked.slice(0, Math.max(1, maxTerms)).map((item) => item.term);
}

function extractPhraseShards(rawQuery: string, maxShards = 2) {
  const normalized = String(rawQuery ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return [];
  const sentences = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const shards: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length < 18) continue;
    const clipped = sentence.slice(0, 180).trim();
    if (!clipped) continue;
    if (shards.includes(clipped)) continue;
    shards.push(clipped);
    if (shards.length >= maxShards) break;
  }
  if (shards.length === 0 && normalized.length >= 40) {
    shards.push(normalized.slice(0, 180).trim());
  }
  return shards.slice(0, maxShards);
}

function buildUnifiedSearchPlan(rawQuery: string): UnifiedSearchPlan {
  const raw = String(rawQuery ?? "").replace(/\s+/g, " ").trim();
  const normalized = raw.toLowerCase();
  if (!normalized) {
    return {
      raw: "",
      normalized: "",
      lexicalQuery: "",
      semanticQuery: "",
      terms: [],
      phraseShards: [],
      isLong: false,
    };
  }

  const rankedTerms = tokenizeSearchQuery(normalized, SEARCH_QUERY_LONG_MAX_TERMS);
  const isLong =
    normalized.length >= SEARCH_QUERY_LONG_TRIGGER_CHARS || rankedTerms.length >= SEARCH_QUERY_LONG_TRIGGER_TERMS;
  const terms = rankedTerms.slice(0, isLong ? SEARCH_QUERY_LONG_MAX_TERMS : SEARCH_QUERY_MAX_TERMS);
  const lexicalQuery = (
    isLong
      ? (terms.slice(0, SEARCH_QUERY_MAX_TERMS).join(" ").trim() || normalized.slice(0, SEARCH_QUERY_LEXICAL_MAX_CHARS))
      : normalized
  )
    .slice(0, SEARCH_QUERY_LEXICAL_MAX_CHARS)
    .trim();
  const phraseShards = isLong ? extractPhraseShards(raw, 3) : [];
  const semanticParts = [
    ...phraseShards.slice(0, 2),
    terms.slice(0, SEARCH_QUERY_LONG_MAX_TERMS).join(" ").trim(),
  ].filter(Boolean);
  const semanticQuery = (isLong ? semanticParts.join(" ").trim() : normalized)
    .slice(0, SEARCH_QUERY_SEMANTIC_MAX_CHARS)
    .trim();
  const semanticEffective = semanticQuery || lexicalQuery || normalized;
  return {
    raw,
    normalized,
    lexicalQuery: lexicalQuery || normalized,
    semanticQuery: semanticEffective,
    terms,
    phraseShards,
    isLong,
  };
}

function pickConfidentSemanticIds(
  matches: readonly ScoredSemanticMatch[] | undefined,
  options: SemanticConfidenceOptions
) {
  const ranked = (matches ?? [])
    .map((item) => ({
      id: String(item.id ?? "").trim(),
      score: Number(item.score) || 0,
      sessionBoosted: item.sessionBoosted === true,
    }))
    .filter((item) => item.id && (item.sessionBoosted || item.score > 0))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.sessionBoosted !== b.sessionBoosted) return a.sessionBoosted ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

  if (ranked.length === 0) return new Set<string>();

  const topScore = ranked[0]?.score ?? 0;
  const floor = Math.max(options.absoluteFloor, topScore * options.relativeFloor);
  const ids = new Set<string>();

  for (const item of ranked.slice(0, Math.max(1, options.maxCount))) {
    if (!item.sessionBoosted && item.score < floor) continue;
    ids.add(item.id);
  }

  if (ids.size === 0 && ranked[0]?.id) {
    ids.add(ranked[0].id);
  }

  return ids;
}

function matchesSearchText(haystackRaw: string, plan: UnifiedSearchPlan) {
  const haystack = String(haystackRaw ?? "").toLowerCase();
  if (!plan.normalized) return true;
  if (haystack.includes(plan.normalized)) return true;
  if (plan.lexicalQuery && haystack.includes(plan.lexicalQuery)) return true;
  if (plan.phraseShards.some((shard) => shard.length >= 20 && haystack.includes(shard))) return true;
  if (plan.terms.length === 0) return false;
  let hits = 0;
  for (const term of plan.terms) {
    if (!haystack.includes(term)) continue;
    hits += 1;
  }
  const requiredHits = plan.isLong
    ? Math.min(3, Math.max(1, Math.ceil(plan.terms.length * 0.14)))
    : plan.terms.length <= 2
      ? plan.terms.length
      : plan.terms.length <= 5
        ? 2
        : 3;
  return hits >= requiredHits;
}

function scoreSearchText(haystackRaw: string, plan: UnifiedSearchPlan) {
  const haystack = String(haystackRaw ?? "").toLowerCase();
  if (!plan.normalized || !haystack) return 0;

  let score = 0;
  if (haystack.includes(plan.normalized)) {
    score += 3;
  } else if (plan.lexicalQuery && haystack.includes(plan.lexicalQuery)) {
    score += 2.4;
  }

  for (const shard of plan.phraseShards) {
    if (shard.length < 20) continue;
    if (!haystack.includes(shard)) continue;
    score += 1.2;
  }

  let hits = 0;
  let weightedHits = 0;
  for (const term of plan.terms) {
    if (!haystack.includes(term)) continue;
    hits += 1;
    weightedHits += Math.min(0.85, 0.34 + Math.max(0, term.length - 2) * 0.045);
  }

  if (hits > 0) {
    score += Math.min(2.6, weightedHits);
    score += Math.min(0.9, hits / Math.max(1, plan.terms.length));
  }

  if (score > 0 && haystack.startsWith(plan.normalized)) {
    score += 0.35;
  }

  return Number(score.toFixed(4));
}

function describeSemanticSearchMode(mode: string) {
  const normalized = String(mode ?? "").trim().toLowerCase();
  if (!normalized) return "smart search";
  if (normalized.includes("qdrant") || normalized.includes("semantic")) return "smart search";
  if (normalized.includes("bm25") || normalized.includes("lexical")) return "keyword search";
  return "smart search";
}

function isTruthyFlag(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function isFalseFlag(value: unknown) {
  return value === false || value === "false" || value === 0 || value === "0";
}

const ORCHESTRATION_TERMINAL_RUN_STATUSES = new Set(["done", "failed", "cancelled"]);
const ORCHESTRATION_KNOWN_RUN_STATUSES = new Set(["running", "stalled", "done", "failed", "cancelled"]);

type SessionOrchestrationWork = {
  active: boolean;
  requestId?: string;
  updatedAt: string;
};

type SessionThreadWorkSignal = {
  active: boolean;
  requestId?: string;
  reason?: string;
  updatedAt: string;
};

type SessionNonUserActivity = {
  updatedAt: string;
  requestId?: string;
};

function parseIsoMs(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function resolveThreadWorkSignal(
  signal: SessionThreadWorkSignal | undefined,
  params: { latestOtherSignalMs: number; nowMs: number }
): boolean | undefined {
  if (!signal) return undefined;
  const { latestOtherSignalMs, nowMs } = params;
  const signalMs = parseIsoMs(signal.updatedAt);
  if (!Number.isFinite(signalMs)) return undefined;
  const ageMs = nowMs - signalMs;
  const ttlMs = signal.active ? OPENCLAW_THREAD_WORK_ACTIVE_TTL_MS : OPENCLAW_THREAD_WORK_INACTIVE_OVERRIDE_TTL_MS;
  if (ageMs < 0 || ageMs > ttlMs) return undefined;
  if (!signal.active && Number.isFinite(latestOtherSignalMs) && latestOtherSignalMs > signalMs) return undefined;
  return signal.active;
}

function isTerminalSystemRequestEvent(entry: LogEntry) {
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  if (agentId !== "system") return false;
  const type = String(entry.type ?? "").trim().toLowerCase();
  if (type !== "system") return false;
  const source = (entry.source && typeof entry.source === "object" ? entry.source : {}) as Record<string, unknown>;
  if (isTruthyFlag(source.watchdogMissingAssistant)) return false;
  if (isFalseFlag(source.requestTerminal)) return false;
  return true;
}

function compareLogCreatedAtAsc(a: LogEntry, b: LogEntry) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  // Stable, deterministic tiebreaker for entries that share the same createdAt.
  // Prefer idempotencyKey (present on history-synced entries) so same-second
  // messages from the gateway maintain a consistent order across renders.
  const aKey = a.idempotencyKey ?? a.id;
  const bKey = b.idempotencyKey ?? b.id;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function compareLogCreatedAtDesc(a: LogEntry, b: LogEntry) {
  return compareLogCreatedAtAsc(b, a);
}

function normalizeOpenClawRequestId(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!text.toLowerCase().startsWith("occhat-")) return text;
  const base = text.split(":", 1)[0]?.trim() ?? "";
  return base || text;
}

function requestIdForLogEntry(entry: LogEntry) {
  const source = (entry.source && typeof entry.source === "object" ? entry.source : {}) as Record<string, unknown>;
  const requestId = normalizeOpenClawRequestId(source.requestId);
  if (requestId) return requestId;
  return normalizeOpenClawRequestId(source.messageId);
}

function isNonUserActivityChatLog(entry: LogEntry) {
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  if (!agentId || agentId === "user" || agentId === "assistant") return false;
  if (isTerminalSystemRequestEvent(entry)) return false;
  if (isChatNoiseLog(entry)) return false;
  if (isMeaningfulToolingOrSystemChatLog(entry)) return true;
  return String(entry.type ?? "").trim().toLowerCase() === "conversation";
}

function buildRecentNonUserActivityIndex(logs: LogEntry[]): Record<string, SessionNonUserActivity> {
  const out: Record<string, SessionNonUserActivity> = {};
  for (const entry of logs) {
    if (!isNonUserActivityChatLog(entry)) continue;
    const sessionKey = normalizeBoardSessionKey(entry.source?.sessionKey);
    if (!sessionKey) continue;
    // Use createdAt to avoid classifer/status patch churn on updatedAt from
    // falsely re-marking old sessions as recently active.
    const stamp = String(entry.createdAt ?? "").trim();
    if (!stamp) continue;
    const stampMs = parseIsoMs(stamp);
    const current = out[sessionKey];
    const currentMs = parseIsoMs(current?.updatedAt);
    if (
      Number.isFinite(currentMs) &&
      Number.isFinite(stampMs) &&
      stampMs < currentMs
    ) {
      continue;
    }
    if (Number.isFinite(currentMs) && !Number.isFinite(stampMs)) continue;
    const requestId = requestIdForLogEntry(entry);
    out[sessionKey] = {
      updatedAt: stamp,
      requestId: requestId || current?.requestId || undefined,
    };
  }
  return out;
}

function normalizeOrchestrationRunStatus(value: unknown) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!status) return "";
  return ORCHESTRATION_KNOWN_RUN_STATUSES.has(status) ? status : "";
}

function inferOrchestrationRunStatus(entry: LogEntry, source: Record<string, unknown>, previousStatus: string) {
  const direct = normalizeOrchestrationRunStatus(source.runStatus);
  if (direct) return direct;

  const eventType = String(source.eventType ?? "").trim().toLowerCase();
  if (eventType === "run_created") return "running";
  if (eventType !== "run_status_changed") return previousStatus || "running";

  const haystack = `${String(entry.summary ?? "")} ${String(entry.content ?? "")}`.toLowerCase();
  if (haystack.includes("cancelled")) return "cancelled";
  if (haystack.includes("failed")) return "failed";
  if (haystack.includes("stalled")) return "stalled";
  if (haystack.includes("done")) return "done";
  return previousStatus || "running";
}

function buildOrchestrationThreadWorkIndex(logs: LogEntry[]): Record<string, SessionOrchestrationWork> {
  const byRun = new Map<
    string,
    {
      status: string;
      requestId?: string;
      updatedAt: string;
      updatedAtMs: number;
      sessionKeys: Set<string>;
    }
  >();
  const ascending = [...logs].sort(compareLogCreatedAtAsc);

  for (const entry of ascending) {
    const source = (entry.source && typeof entry.source === "object" ? entry.source : {}) as Record<string, unknown>;
    if (!isTruthyFlag(source.orchestration)) continue;
    const runId = String(source.runId ?? "").trim();
    if (!runId) continue;

    const next = byRun.get(runId) ?? {
      status: "running",
      requestId: undefined,
      updatedAt: "",
      updatedAtMs: Number.NEGATIVE_INFINITY,
      sessionKeys: new Set<string>(),
    };

    const sourceSessionKey = normalizeBoardSessionKey(String(source.sessionKey ?? ""));
    if (sourceSessionKey) next.sessionKeys.add(sourceSessionKey);

    const boardTopicId = String(source.boardScopeTopicId ?? entry.topicId ?? "").trim();
    const boardTaskId = String(source.boardScopeTaskId ?? "").trim();
    if (boardTopicId) {
      next.sessionKeys.add(taskSessionKey(boardTopicId, boardTaskId || boardTopicId));
    }

    const requestId = normalizeOpenClawRequestId(source.requestId ?? source.messageId);
    if (requestId) next.requestId = requestId;

    next.status = inferOrchestrationRunStatus(entry, source, next.status);
    // Use createdAt so unrelated row updates (classification/status patches)
    // do not keep old orchestration runs "fresh" forever.
    const stamp = String(entry.createdAt ?? "").trim();
    const stampMs = Date.parse(stamp);
    const normalizedStampMs = Number.isFinite(stampMs) ? stampMs : Number.NEGATIVE_INFINITY;
    if (!next.updatedAt || normalizedStampMs >= next.updatedAtMs) {
      next.updatedAt = stamp;
      next.updatedAtMs = normalizedStampMs;
    }

    byRun.set(runId, next);
  }

  type SessionAgg = {
    active: boolean;
    latestAnyAt: string;
    latestAnyMs: number;
    latestAnyRequestId?: string;
    latestActiveMs: number;
    latestActiveRequestId?: string;
  };

  const bySession = new Map<string, SessionAgg>();
  for (const runState of byRun.values()) {
    const active = !ORCHESTRATION_TERMINAL_RUN_STATUSES.has(runState.status);
    for (const sessionKey of runState.sessionKeys) {
      const key = normalizeBoardSessionKey(sessionKey);
      if (!key) continue;
      const agg = bySession.get(key) ?? {
        active: false,
        latestAnyAt: "",
        latestAnyMs: Number.NEGATIVE_INFINITY,
        latestAnyRequestId: undefined,
        latestActiveMs: Number.NEGATIVE_INFINITY,
        latestActiveRequestId: undefined,
      };

      agg.active = agg.active || active;
      if (runState.updatedAtMs >= agg.latestAnyMs) {
        agg.latestAnyMs = runState.updatedAtMs;
        agg.latestAnyAt = runState.updatedAt;
        agg.latestAnyRequestId = runState.requestId || agg.latestAnyRequestId;
      }
      if (active && runState.updatedAtMs >= agg.latestActiveMs) {
        agg.latestActiveMs = runState.updatedAtMs;
        agg.latestActiveRequestId = runState.requestId || agg.latestActiveRequestId;
      }
      bySession.set(key, agg);
    }
  }

  const out: Record<string, SessionOrchestrationWork> = {};
  for (const [sessionKey, agg] of bySession.entries()) {
    out[sessionKey] = {
      active: agg.active,
      requestId: agg.latestActiveRequestId || agg.latestAnyRequestId,
      updatedAt: agg.latestAnyAt,
    };
  }
  return out;
}

function normalizeTagValue(value: string) {
  const lowered = String(value ?? "").toLowerCase();
  const withDashes = lowered.replace(/\s+/g, "-");
  const stripped = withDashes.replace(/[^a-z0-9-]/g, "");
  return stripped.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeTagKey(value: string) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("system:")) {
    const suffix = raw.split(":", 2)[1]?.trim() ?? "";
    return suffix ? `system:${suffix}` : "system";
  }
  const withDashes = raw.replace(/\s+/g, "-");
  const stripped = withDashes.replace(/[^a-z0-9:_-]/g, "");
  return stripped.replace(/:{2,}/g, ":").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function cleanTagLabel(value: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function dedupeTagLabels(values: Iterable<string>) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const label = cleanTagLabel(raw);
    const key = normalizeTagKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= 32) break;
  }
  return out;
}

function friendlySegmentLabel(value: string) {
  const segment = String(value ?? "").trim().toLowerCase();
  if (!segment) return "";
  const devSuffix = segment.match(/^([a-z]{2})dev$/);
  if (devSuffix) return `${devSuffix[1].toUpperCase()}Dev`;
  if (/^[a-z]{1,2}$/.test(segment)) return segment.toUpperCase();
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

function friendlyTagLabel(value: string) {
  const normalized = normalizeTagValue(value);
  if (!normalized) return "";
  return normalized
    .split("-")
    .filter(Boolean)
    .map((segment) => friendlySegmentLabel(segment))
    .join(" ");
}

function parseTags(text: string) {
  return dedupeTagLabels(String(text ?? "").split(","));
}

function formatTags(tags: string[] | undefined | null) {
  return dedupeTagLabels(tags ?? []).join(", ");
}

function splitTagDraft(text: string, options?: { treatLastSegmentAsQuery?: boolean }) {
  const raw = String(text ?? "");
  const trailingComma = /,\s*$/.test(raw);
  const parts = raw.split(",");
  const treatLastSegmentAsQuery = options?.treatLastSegmentAsQuery !== false;
  const hasQuery = treatLastSegmentAsQuery && !trailingComma;
  const committedRaw = hasQuery ? parts.slice(0, -1) : parts;
  const committed = dedupeTagLabels(committedRaw);
  const query = hasQuery ? cleanTagLabel(parts[parts.length - 1] ?? "") : "";
  const queryKey = hasQuery ? normalizeTagKey(query) : "";
  return { committed, query, queryKey };
}

function isTagDraftPending(text: string) {
  return Boolean(splitTagDraft(text).queryKey);
}

function applyTagSuggestionToDraft(text: string, suggestion: string) {
  const { committed } = splitTagDraft(text);
  const next = dedupeTagLabels([...committed, suggestion]);
  return next.length > 0 ? `${next.join(", ")}, ` : "";
}

function commitTagDraftEntry(text: string) {
  const { committed, query } = splitTagDraft(text);
  const next = dedupeTagLabels(query ? [...committed, query] : committed);
  return next.length > 0 ? `${next.join(", ")}, ` : "";
}

function tagSuggestionsForDraft(text: string, options: string[]) {
  const { committed, queryKey } = splitTagDraft(text);
  if (!queryKey) return [] as string[];
  const committedSet = new Set(committed.map((entry) => normalizeTagKey(entry)).filter(Boolean));
  return options
    .map((candidate) => {
      const label = cleanTagLabel(candidate);
      const key = normalizeTagKey(label);
      if (!key || committedSet.has(key) || !key.includes(queryKey)) return null;
      const exact = key === queryKey ? 0 : 1;
      const prefix = key.startsWith(queryKey) ? 0 : 1;
      return { label, key, exact, prefix, length: key.length };
    })
    .filter((item): item is { label: string; key: string; exact: number; prefix: number; length: number } => Boolean(item))
    .sort((a, b) => a.exact - b.exact || a.prefix - b.prefix || a.length - b.length || a.key.localeCompare(b.key) || a.label.localeCompare(b.label))
    .map((item) => item.label)
    .slice(0, 8);
}

function spaceIdFromTagLabel(value: string) {
  let text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (text.startsWith("system:")) return null;
  if (text.startsWith("space:")) text = text.split(":", 2)[1]?.trim() ?? "";
  const slug = text
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || slug === "default" || slug === "global" || slug === "all" || slug === "all-spaces") {
    return null;
  }
  return `space-${slug}`;
}

function topicSpaceIds(topic: Pick<Topic, "spaceId" | "tags"> | null | undefined) {
  const ids = new Set<string>();
  for (const rawTag of topic?.tags ?? []) {
    const fromTag = spaceIdFromTagLabel(String(rawTag ?? ""));
    if (fromTag) ids.add(fromTag);
  }
  const primary = String(topic?.spaceId ?? "").trim();
  if (primary && primary !== "space-default") ids.add(primary);
  return Array.from(ids);
}

function topicMatchesSelectedSpace(
  topic: Pick<Topic, "spaceId" | "tags"> | null | undefined,
  selectedSpaceId: string
) {
  const normalized = String(selectedSpaceId ?? "").trim();
  if (!normalized) return true;
  return topicSpaceIds(topic).includes(normalized);
}

function prioritizedTopicSpaceIds(topic: Pick<Topic, "spaceId" | "tags"> | null | undefined) {
  const ids = new Set<string>();
  const primary = String(topic?.spaceId ?? "").trim();
  if (primary && primary !== "space-default") ids.add(primary);
  for (const rawTag of topic?.tags ?? []) {
    const fromTag = spaceIdFromTagLabel(String(rawTag ?? ""));
    if (fromTag) ids.add(fromTag);
  }
  return Array.from(ids);
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
    .map((segment) => friendlySegmentLabel(segment))
    .join(" ");
}

function displaySpaceName(space: Pick<Space, "id" | "name">) {
  const id = String(space?.id ?? "").trim();
  const raw = String(space?.name ?? "").trim();
  if (!raw) return deriveSpaceName(id);
  const friendly = friendlyTagLabel(raw);
  return friendly || deriveSpaceName(id);
}

const CHAT_HEADER_BLURB_LIMIT = 56;

function stripTransportNoise(value: string) {
  let text = (value ?? "").replace(/\r\n?/g, "\n").trim();
  text = text.replace(
    /(?:\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]|\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\])\s*/gi,
    " ",
  );
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

function countVisibleChatLogEntries(entries: LogEntry[], showToolCalls: boolean) {
  if (showToolCalls) return entries.length;
  let count = 0;
  for (const entry of entries) {
    if (!isChatNoiseLog(entry) && !isToolingOrSystemChatLog(entry)) count += 1;
  }
  return count;
}

function countToolingOrSystemChatLogEntries(entries: LogEntry[]) {
  let count = 0;
  for (const entry of entries) {
    if (isMeaningfulToolingOrSystemChatLog(entry)) count += 1;
  }
  return count;
}

function formatToolingOrSystemCallCountLabel(count: number) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  return `${total} tool/system${total === 1 ? " call" : " calls"}`;
}

function countTrailingHiddenToolCallsAwaitingAgent(entries: LogEntry[]) {
  let seenUserMessage = false;
  let agentResponded = false;
  let hiddenToolCount = 0;

  for (const entry of entries) {
    if (isChatNoiseLog(entry)) continue;
    const type = String(entry.type ?? "").trim().toLowerCase();
    const agentId = String(entry.agentId ?? "").trim().toLowerCase();
    if (type === "conversation" && agentId === "user") {
      seenUserMessage = true;
      agentResponded = false;
      hiddenToolCount = 0;
      continue;
    }
    if (!seenUserMessage || agentResponded) continue;
    if (isAgentConversationChatLog(entry)) {
      agentResponded = true;
      continue;
    }
    if (isMeaningfulToolingOrSystemChatLog(entry)) hiddenToolCount += 1;
  }

  return seenUserMessage && !agentResponded ? hiddenToolCount : 0;
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

function normalizeAgentToken(value: string | undefined | null) {
  return String(value ?? "").trim().toLowerCase();
}

function stringArraysEqual(a: string[], b: string[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function stringSetMatchesArray(set: Set<string>, values: string[]) {
  if (set.size !== values.length) return false;
  for (const value of values) {
    if (!set.has(value)) return false;
  }
  return true;
}

function hasActiveTextSelectionWithin(root: HTMLElement | null) {
  if (!root || typeof window === "undefined") return false;
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return false;
  if (!selection.toString().trim()) return false;
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  if (anchorNode && root.contains(anchorNode)) return true;
  if (focusNode && root.contains(focusNode)) return true;
  return false;
}

function deriveTaskWorkspaceAttention(
  entries: LogEntry[],
  workspaceByAgentId: Map<string, OpenClawWorkspace>,
  sessionKey: string,
  seenByKey: Record<string, string>
) {
  const normalizedSessionKey = normalizeBoardSessionKey(sessionKey);
  if (!normalizedSessionKey) return null;

  let latestAny: { workspace: OpenClawWorkspace; agentId: string; activityAt: string; sessionKey: string } | null = null;
  let latestCoding: { workspace: OpenClawWorkspace; agentId: string; activityAt: string; sessionKey: string } | null = null;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const agentId = normalizeAgentToken(entry.agentId);
    if (!agentId || agentId === "user" || agentId === "assistant" || agentId === "system" || agentId === "toolresult") {
      continue;
    }
    if (isChatNoiseLog(entry)) continue;
    const entryType = String(entry.type ?? "").trim().toLowerCase();
    const authenticActivity = isMeaningfulToolingOrSystemChatLog(entry) || entryType === "conversation";
    if (!authenticActivity) continue;
    const workspace = workspaceByAgentId.get(agentId);
    if (!workspace?.ideUrl) continue;
    const activityAt = String(entry.createdAt ?? "").trim();
    if (!activityAt) continue;
    const candidate = { workspace, agentId, activityAt, sessionKey: normalizedSessionKey };
    if (!latestAny) latestAny = candidate;
    if (agentId === "coding") {
      latestCoding = candidate;
    }
    if (latestAny && latestCoding) {
      break;
    }
  }

  const candidates = [latestCoding, latestAny].filter(
    (candidate, index, list): candidate is NonNullable<typeof candidate> =>
      Boolean(candidate) &&
      list.findIndex(
        (other) =>
          other?.agentId === candidate?.agentId &&
          other?.activityAt === candidate?.activityAt &&
          other?.sessionKey === candidate?.sessionKey
      ) === index
  );
  const target = candidates.find((candidate) => {
    const seenKey = `${candidate.sessionKey}::${candidate.agentId}`;
    return seenByKey[seenKey] !== candidate.activityAt;
  });
  if (!target) return null;
  const agentName = String(target.workspace.agentName || "").trim() || target.agentId;
  const label = target.agentId === "coding" ? "Open coding workspace" : `Open ${agentName} workspace`;
  const hint = target.agentId === "coding" ? "Recent coding activity" : `Recent ${agentName} workspace activity`;
  return { ...target, label, hint };
}

function SwipeRevealRow({
  rowId,
  openId,
  setOpenId,
  actions,
  anchorLabel,
  children,
  disabled = false,
}: {
  rowId: string;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  actions: ReactNode;
  anchorLabel?: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const allowSwipe = !disabled;
  const isOpen = allowSwipe && openId === rowId;
  const gesture = useRef<{
    startX: number;
    startY: number;
    startOffset: number;
    pointerType: string;
    pointerId: number;
    captureNode: HTMLElement | null;
  } | null>(null);
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

  const effectiveOffset = !allowSwipe ? 0 : swiping ? dragOffset : isOpen ? TOPIC_ACTION_REVEAL_PX : 0;
  const actionsOpacity = clamp(effectiveOffset / TOPIC_ACTION_REVEAL_PX, 0, 1);
  const showActions = allowSwipe && actionsOpacity > 0.01;
  const showAnchorLabel =
    allowSwipe && Boolean((anchorLabel ?? "").trim()) && (isOpen || swiping || effectiveOffset > 8);

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
    if (!allowSwipe) return;
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
  }, [allowSwipe, rowId, setOpenId]);

  const handlePointerDown = allowSwipe
    ? (event: React.PointerEvent<HTMLDivElement>) => {
        if ("button" in event && event.button !== 0) return;
        const target = event.target as HTMLElement | null;

        // Desktop clicks should never feel like swipes. For mouse pointers we only
        // support swipe actions via horizontal trackpad scroll (wheel deltaX).
        if (event.pointerType === "mouse") return;

        // When the row is closed, ignore gesture starts on interactive controls.
        // When it's open, allow the user to begin a swipe-to-close even if their thumb
        // is on the action buttons (as long as they actually swipe).
        if (!isOpen && target?.closest("button, a, input, textarea, select, [data-no-swipe='true']")) return;

        // Prevent nested SwipeRevealRow parents (topic row) from starting a competing gesture
        // when we start on a child row (task row).
        event.stopPropagation();

        setSwiping(false);
        swipingRef.current = false;
        gesture.current = {
          startX: event.clientX,
          startY: event.clientY,
          startOffset: isOpen ? TOPIC_ACTION_REVEAL_PX : 0,
          pointerType: event.pointerType,
          pointerId: event.pointerId,
          captureNode: event.currentTarget as HTMLElement,
        };
      }
    : undefined;

  const handlePointerMove = allowSwipe
    ? (event: React.PointerEvent<HTMLDivElement>) => {
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
          // Prevent nested SwipeRevealRow parents from starting a competing gesture.
          event.stopPropagation();
          // Capture the pointer once we know it's a swipe so we keep receiving move/up.
          try {
            g.captureNode?.setPointerCapture(g.pointerId);
          } catch {
            // ok
          }
        }
        event.preventDefault();
        event.stopPropagation();
        const next = clamp(g.startOffset - dx, 0, TOPIC_ACTION_REVEAL_PX);
        scheduleOffset(next);
      }
    : undefined;

  const handlePointerUp = allowSwipe
    ? (event: React.PointerEvent<HTMLDivElement>) => {
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
      }
    : undefined;

  const handlePointerCancel = allowSwipe
    ? () => {
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
      }
    : undefined;

  return (
    <div
      className="relative overflow-x-clip rounded-[var(--radius-lg)]"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onContextMenu={
        allowSwipe
          ? (event) => {
              const target = event.target as HTMLElement | null;
              // Keep native context menus for explicitly interactive controls,
              // but still allow desktop right-click-open inside no-swipe containers
              // like Topic chat timelines.
              if (target?.closest("button, a, input, textarea, select")) return;
              if (hasActiveTextSelectionWithin(event.currentTarget)) return;
              if (typeof window !== "undefined" && !window.matchMedia("(min-width: 768px)").matches) return;
              event.preventDefault();
              event.stopPropagation();
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
              setSwiping(false);
              setDragOffset(0);
              dragOffsetRef.current = 0;
              pendingOffsetRef.current = 0;
              if (openId !== rowId) setOpenId(rowId);
            }
          : undefined
      }
      style={{ touchAction: allowSwipe ? "pan-y" : "auto" }}
    >
      {showActions ? (
        <div
          className="absolute inset-0 flex items-stretch gap-2 bg-[rgba(10,12,16,0.18)] p-1 transition-opacity"
          style={{ opacity: actionsOpacity }}
        >
          {showAnchorLabel ? (
            <div className="pointer-events-none flex min-w-0 flex-1 items-center">
              <div className="max-w-full rounded-[var(--radius-md)] border border-[rgba(255,255,255,0.14)] bg-[rgba(9,11,15,0.72)] px-2.5 py-1.5 text-[11px] font-semibold leading-tight text-[rgb(var(--claw-text))] shadow-[0_8px_18px_rgba(0,0,0,0.26)] backdrop-blur">
                <span className="block whitespace-normal break-words">{anchorLabel}</span>
              </div>
            </div>
          ) : null}
          <div className="ml-auto flex items-stretch gap-2">{actions}</div>
        </div>
      ) : null}
      <div
        onClickCapture={
          allowSwipe
            ? (event) => {
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
              }
            : undefined
        }
        onWheel={
          allowSwipe
            ? (event) => {
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
              }
            : undefined
        }
        className={cn(
          "relative",
          allowSwipe && (swiping || effectiveOffset > 0) ? "will-change-transform" : "",
          allowSwipe && (swiping || isOpen) ? "z-20" : "",
          allowSwipe && swiping ? "" : "transition-transform duration-200 ease-out"
        )}
        style={{
          ...(effectiveOffset > 0 ? { transform: `translate3d(-${effectiveOffset}px,0,0)` } : {}),
          touchAction: allowSwipe ? "pan-y" : "auto",
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

function compatTaskLogKey(entry: Pick<LogEntry, "topicId">) {
  return String(entry.topicId ?? "").trim();
}

function hashString(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function colorFromSeed(seed: string, palette: string[]) {
  const index = Math.abs(hashString(seed)) % palette.length;
  return palette[index];
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

function hueDistanceDegrees(a: number, b: number) {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function normalizePalette(palette: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of palette) {
    const normalized = normalizeHexColor(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
  }
  if (next.length === 0) next.push("#4EA1FF");
  return next;
}

function stablePaletteOrder(palette: string[], seed: string) {
  const normalized = normalizePalette(palette);
  return normalized.sort((a, b) => {
    const ah = hashString(`${seed}:${a}`);
    const bh = hashString(`${seed}:${b}`);
    if (ah !== bh) return ah - bh;
    return a.localeCompare(b);
  });
}

function colorDist(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  const rgbDist =
    Math.sqrt((ra.r - rb.r) ** 2 + (ra.g - rb.g) ** 2 + (ra.b - rb.b) ** 2) / Math.sqrt(255 ** 2 * 3);
  const ha = rgbToHsl(ra);
  const hb = rgbToHsl(rb);
  const hueDist = hueDistanceDegrees(ha.h, hb.h) / 180;
  const satDist = Math.abs(ha.s - hb.s);
  const lightDist = Math.abs(ha.l - hb.l);
  return clamp(rgbDist * 0.56 + hueDist * 0.28 + satDist * 0.11 + lightDist * 0.05, 0, 1);
}

function colorVibrancy(color: string) {
  const { s, l } = rgbToHsl(hexToRgb(color));
  const satScore = clamp((s - 0.38) / 0.62, 0, 1);
  const lightScore = 1 - clamp(Math.abs(l - 0.56) / 0.44, 0, 1);
  return satScore * 0.7 + lightScore * 0.3;
}

function pickVibrantDistinctColor({
  palette,
  seed,
  primaryAvoid = [],
  secondaryAvoid = [],
  usageCount,
}: {
  palette: string[];
  seed: string;
  primaryAvoid?: string[];
  secondaryAvoid?: string[];
  usageCount?: Map<string, number>;
}) {
  const candidates = stablePaletteOrder(palette, seed);
  const primary = Array.from(
    new Set(primaryAvoid.map((color) => normalizeHexColor(color)).filter(Boolean) as string[])
  );
  const secondary = Array.from(
    new Set(secondaryAvoid.map((color) => normalizeHexColor(color)).filter(Boolean) as string[])
  );

  let best = candidates[0] ?? "#4EA1FF";
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const minPrimary = primary.length > 0 ? Math.min(...primary.map((color) => colorDist(candidate, color))) : 1;
    const avgPrimary =
      primary.length > 0 ? primary.reduce((sum, color) => sum + colorDist(candidate, color), 0) / primary.length : minPrimary;
    const minSecondary =
      secondary.length > 0 ? Math.min(...secondary.map((color) => colorDist(candidate, color))) : minPrimary;
    const vibrancy = colorVibrancy(candidate);
    const usagePenalty = usageCount ? usageCount.get(candidate) ?? 0 : 0;
    const jitter = (Math.abs(hashString(`jitter:${seed}:${candidate}`)) % 1000) / 10000;
    const primaryCollisionPenalty = minPrimary < 0.22 ? (0.22 - minPrimary) * 18 : 0;
    const secondaryCollisionPenalty = minSecondary < 0.14 ? (0.14 - minSecondary) * 9 : 0;
    const score =
      minPrimary * 8.4 +
      avgPrimary * 1.9 +
      minSecondary * 2.4 +
      vibrancy * 1.1 -
      usagePenalty * 2.6 -
      primaryCollisionPenalty -
      secondaryCollisionPenalty +
      jitter;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function uniqueNormalizedColors(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(values.map((value) => normalizeHexColor(value)).filter(Boolean) as string[])
  );
}

function sortTopicsForColorAssignment(topics: Topic[], seed: string, visibleTopicIds: string[] = []) {
  const visibleSet = new Set(visibleTopicIds);
  const scopeSizes = new Map<string, number>();
  for (const topic of topics) {
    const keys = new Set(topicColorScopeKeys(topic));
    for (const key of keys) {
      scopeSizes.set(key, (scopeSizes.get(key) ?? 0) + 1);
    }
  }

  return [...topics].sort((a, b) => {
    const aVisible = visibleSet.has(a.id) ? 1 : 0;
    const bVisible = visibleSet.has(b.id) ? 1 : 0;
    if (aVisible !== bVisible) return bVisible - aVisible;

    const aScopeDensity = Math.max(...topicColorScopeKeys(a).map((key) => scopeSizes.get(key) ?? 0), 0);
    const bScopeDensity = Math.max(...topicColorScopeKeys(b).map((key) => scopeSizes.get(key) ?? 0), 0);
    if (aScopeDensity !== bScopeDensity) return bScopeDensity - aScopeDensity;

    const aHash = hashString(`${seed}:${a.id}`);
    const bHash = hashString(`${seed}:${b.id}`);
    if (aHash !== bHash) return aHash - bHash;
    return a.id.localeCompare(b.id);
  });
}

function topicGlowStyle(color: string, index: number, expanded: boolean): CSSProperties {
  const band = index % 2 === 0;
  const topAlpha = expanded ? (band ? 0.25 : 0.19) : band ? 0.18 : 0.14;
  const lowAlpha = expanded ? (band ? 0.13 : 0.09) : band ? 0.09 : 0.07;
  return {
    background: `linear-gradient(155deg, ${rgba(color, topAlpha)}, rgba(16,19,24,0.90) 48%, ${rgba(color, lowAlpha)})`,
    boxShadow: `0 0 0 1px ${rgba(color, expanded ? 0.28 : 0.2)}, 0 14px 34px ${rgba(color, expanded ? 0.15 : 0.1)}`,
    // clip-path clips content to the card bounds (like overflow-hidden) without
    // creating a new scroll container, so position:sticky still works on the header.
    ...(expanded ? { clipPath: "inset(0 round var(--radius-lg))" } : undefined),
  };
}

function mobileOverlaySurfaceStyle(color: string): CSSProperties {
  return {
    // Use an opaque base so board content never bleeds through fullscreen chat layers.
    backgroundColor: "rgb(10,12,16)",
    backgroundImage: `linear-gradient(180deg, ${rgba(color, 0.3)} 0%, rgba(12,14,18,0.95) 38%, rgba(12,14,18,0.99) 100%)`,
  };
}

function stickyTaskHeaderStyle(color: string, index: number): CSSProperties {
  const band = index % 2 === 0;
  return {
    backgroundColor: band ? "rgb(12, 15, 19)" : "rgb(14, 17, 22)",
    borderBottom: `1px solid ${rgba(color, 0.08)}`,
  };
}

function chatTopMaskStyle(enabled: boolean): CSSProperties | undefined {
  if (!enabled) return undefined;
  const mask = "linear-gradient(to bottom, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.72) 10px, rgba(0,0,0,1) 18px, rgba(0,0,0,1) 100%)";
  return {
    WebkitMaskImage: mask,
    maskImage: mask,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
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
  const topic = parseTopicPayload(value);
  if (!topic) return null;
  return {
    ...topic,
    title: topic.name,
    topicId: topic.id,
  };
}

function normalizeCountMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) continue;
    out[key] = Math.max(0, Math.floor(parsed));
  }
  return out;
}

function resolveChatEntryCount(aggregateCount: number | undefined, loadedCount: number) {
  const loaded = Math.max(0, Math.floor(Number(loadedCount) || 0));
  const aggregate = Number.isFinite(Number(aggregateCount))
    ? Math.max(0, Math.floor(Number(aggregateCount)))
    : 0;
  return Math.max(aggregate, loaded);
}

function formatChatEntryCountLabel(
  aggregateCount: number | undefined,
  loadedCount: number,
  countsHydrated: boolean
) {
  const hasAggregate = Number.isFinite(Number(aggregateCount));
  const loaded = Math.max(0, Math.floor(Number(loadedCount) || 0));
  if (!countsHydrated && !hasAggregate && loaded === 0) return "... entries";
  return `${resolveChatEntryCount(aggregateCount, loaded)} entries`;
}

function topicColorScopeKeys(topic: Pick<Topic, "spaceId" | "tags"> | null | undefined) {
  const ids = topicSpaceIds(topic);
  return ids.length > 0 ? ids : ["space-default"];
}

export function ColorShuffleTrigger({
  topics,
  visibleTopicIds,
  onTopicsUpdate,
  token,
}: {
  topics: Topic[];
  visibleTopicIds: string[];
  onTopicsUpdate: (topics: Topic[]) => void;
  token?: string;
}) {
  const [shuffling, setShuffling] = useState(false);

  const shuffle = async () => {
    if (shuffling) return;
    setShuffling(true);

    try {
      const runSeed = randomId();
      const topicColorById = new Map<string, string>();
      const topicUsage = new Map<string, number>();
      const topicColorsBySpace = new Map<string, string[]>();
      const allAssigned: string[] = [];

      const registerTopicColor = (topic: Topic, rawColor: string) => {
        const color = normalizeHexColor(rawColor) ?? "#4EA1FF";
        topicColorById.set(topic.id, color);
        topicUsage.set(color, (topicUsage.get(color) ?? 0) + 1);
        for (const scopeKey of topicColorScopeKeys(topic)) {
          const existing = topicColorsBySpace.get(scopeKey) ?? [];
          existing.push(color);
          topicColorsBySpace.set(scopeKey, existing);
        }
        allAssigned.push(color);
      };

      const topicOrder = sortTopicsForColorAssignment(topics, `${runSeed}:topics`, visibleTopicIds);
      for (const topic of topicOrder) {
        const scopeKeys = topicColorScopeKeys(topic);
        const sameSpaceColors = uniqueNormalizedColors(
          scopeKeys.flatMap((scopeKey) => topicColorsBySpace.get(scopeKey) ?? [])
        );
        const visibleColors = uniqueNormalizedColors(
          visibleTopicIds.map((topicId) => topicColorById.get(topicId))
        );
        const color = pickVibrantDistinctColor({
          palette: TOPIC_FALLBACK_COLORS,
          seed: `${runSeed}:topic:${topic.id}:${topic.name}`,
          primaryAvoid: [...sameSpaceColors, ...visibleColors],
          secondaryAvoid: allAssigned,
          usageCount: topicUsage,
        });
        registerTopicColor(topic, color);
      }

      const nextTopics = topics.map((topic) => {
        const color = topicColorById.get(topic.id) ?? normalizeHexColor(topic.color) ?? "#4EA1FF";
        return { ...topic, color };
      });

      for (const topic of nextTopics) {
        await apiFetch(
          `/api/topics/${encodeURIComponent(topic.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ color: topic.color }),
          },
          token
        );
      }
      onTopicsUpdate(nextTopics);
    } finally {
      setShuffling(false);
    }
  };

  return (
    <Button 
      variant="secondary" 
      size="sm" 
      onClick={shuffle} 
      disabled={shuffling}
      className="gap-2"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <path d="M4 4h7m-7 4h7m-7 4h7m4-8l3 3m0 0l3-3m-3 3v12" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      {shuffling ? "Shuffling..." : "Shuffle Board Colors"}
    </Button>
  );
}

export function UnifiedView({ basePath = "/u", active = true }: { basePath?: string; active?: boolean } = {}) {
  const { token, tokenRequired } = useAppConfig();
  const { workspaces } = useOpenClawWorkspaces();
  const {
    spaces: storeSpaces,
    topics: storeTopics,
    topicTags: storeTopicTags,
    tasks: storeTasks,
    logs: storeLogs,
    openclawTyping,
    openclawThreadWork,
    hydrated,
    setTopics,
    setTasks,
    setLogs,
    unsnoozedTopicBadges,
    unsnoozedTaskBadges,
    chatSeenByKey,
    markChatSeen: markChatSeenInStore,
    dismissUnsnoozedTopicBadge,
    dismissUnsnoozedTaskBadge,
    sseConnected,
  } = useDataStore();
  const readOnly = tokenRequired && !token;
  const workspaceByAgentId = useMemo(
    () => new Map(workspaces.map((workspace) => [normalizeAgentToken(workspace.agentId), workspace])),
    [workspaces]
  );
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const scrollMemory = useRef<Record<string, number>>({});
  const restoreScrollOnNextSyncRef = useRef(false);
  const skipNextUrlSyncUrlRef = useRef<string | null>(null);
  const [initialUrlState] = useState(() => getInitialUnifiedUrlState(basePath));
  const twoColumn = useLocalStorageItem("clawboard.unified.twoColumn") !== "false";
  const filtersDrawerOpenStored = useLocalStorageItem(FILTERS_DRAWER_OPEN_KEY);
  const filtersDrawerOpen =
    filtersDrawerOpenStored === null ? FILTERS_DRAWER_OPEN_DEFAULT : filtersDrawerOpenStored === "true";
  const workspaceAttentionSeenRaw = useLocalStorageItem(WORKSPACE_ATTENTION_SEEN_KEY) ?? "{}";
  const storedTopicView = (useLocalStorageItem(TOPIC_VIEW_KEY) ?? "").trim().toLowerCase();
  const topicView: TopicView = isTopicView(storedTopicView) ? storedTopicView : "active";
  const showSnoozedTasks = useLocalStorageItem(SHOW_SNOOZED_TASKS_KEY) === "true";
  const activeSpaceIdStored = (useLocalStorageItem(ACTIVE_SPACE_KEY) ?? "").trim();
  const workspaceAttentionSeenByKey = useMemo(
    () => parseStringMap(workspaceAttentionSeenRaw),
    [workspaceAttentionSeenRaw]
  );
  // Component is ssr:false (dynamic import), so we can read the real viewport synchronously
  // on first render and avoid the false→true layout shift that re-renders the two-column layout.
  const [mdUp, setMdUp] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches);
  const {
    state: expansionState,
    setExpandedTopics,
    setExpandedTasks,
    setMobileLayer,
    setMobileChatTarget,
  } = useUnifiedExpansionState(initialUrlState.topics, initialUrlState.tasks);
  const { expandedTopics, expandedTasks, mobileLayer, mobileChatTarget } = expansionState;
  const showTwoColumns = twoColumn && mdUp;
  const showFullMessagesRaw = useLocalStorageItem("clawboard.display.showFullMessages");
  const showRaw = showFullMessagesRaw !== "false";
  const [messageDensity, setMessageDensity] = useState<MessageDensity>(initialUrlState.density);
  const showToolCallsRaw = useLocalStorageItem("clawboard.display.showToolCalls");
  const showToolCalls = showToolCallsRaw === "true";
  const [showDone, setShowDone] = useState(initialUrlState.done);
  const [revealSelection, setRevealSelection] = useState(initialUrlState.reveal);
  const [revealedTopicIds, setRevealedTopicIds] = useState<string[]>(initialUrlState.topics);
  const [revealedTaskIds, setRevealedTaskIds] = useState<string[]>(initialUrlState.tasks);
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>(
    isTaskStatusFilter(initialUrlState.status) ? initialUrlState.status : "all"
  );
  const [snoozeTarget, setSnoozeTarget] = useState<
    | { kind: "topic"; topicId: string; label: string }
    | { kind: "task"; topicId: string; taskId: string; label: string }
    | null
  >(null);
  const toggleTwoColumn = () => {
    setLocalStorageItem("clawboard.unified.twoColumn", twoColumn ? "false" : "true");
  };
  const markWorkspaceAttentionSeen = useCallback(
    (
      attention:
        | {
            agentId: string;
            activityAt: string;
            sessionKey: string;
          }
        | null
        | undefined
    ) => {
      const normalizedSessionKey = normalizeBoardSessionKey(attention?.sessionKey);
      const agentId = normalizeAgentToken(attention?.agentId);
      const activityAt = String(attention?.activityAt ?? "").trim();
      if (!normalizedSessionKey || !agentId || !activityAt) return;
      const seenKey = `${normalizedSessionKey}::${agentId}`;
      if (workspaceAttentionSeenByKey[seenKey] === activityAt) return;
      setLocalStorageItem(
        WORKSPACE_ATTENTION_SEEN_KEY,
        JSON.stringify({
          ...workspaceAttentionSeenByKey,
          [seenKey]: activityAt,
        })
      );
    },
    [workspaceAttentionSeenByKey]
  );
  const toggleFiltersDrawer = () => {
    setLocalStorageItem(FILTERS_DRAWER_OPEN_KEY, filtersDrawerOpen ? "false" : "true");
  };

  const spaces = useMemo(() => {
    const byId = new Map<string, Space>();
    const topicSpaceIdsSet = new Set<string>();
    for (const topic of storeTopics) {
      for (const id of topicSpaceIds(topic)) topicSpaceIdsSet.add(id);
    }
    for (const space of storeSpaces) {
      const id = String(space?.id ?? "").trim();
      if (!id) continue;
      if (id === "space-default") continue;
      if (!topicSpaceIdsSet.has(id)) continue;
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
  }, [storeSpaces, storeTopics]);

  const spaceFromUrl = useMemo(() => (new URLSearchParams(searchParamsKey).get("space") ?? "").trim(), [searchParamsKey]);
  const spaceQueryInitializedRef = useRef(false);
  const selectedSpaceId = useMemo(() => {
    if (!activeSpaceIdStored) return "";
    if (spaces.some((space) => space.id === activeSpaceIdStored)) return activeSpaceIdStored;
    return "";
  }, [activeSpaceIdStored, spaces]);

  const allowedSpaceIds = useMemo(() => {
    if (spaces.length === 0) return [] as string[];
    if (!selectedSpaceId) return [] as string[];
    const source = spaces.find((space) => space.id === selectedSpaceId);
    const out = [selectedSpaceId];
    for (const candidate of spaces) {
      if (candidate.id === selectedSpaceId) continue;
      const enabled = resolveSpaceVisibilityFromViewer(source, candidate);
      if (enabled) out.push(candidate.id);
    }
    return out;
  }, [selectedSpaceId, spaces]);
  const spaceVisibilityRevision = useMemo(() => buildSpaceVisibilityRevision(spaces), [spaces]);

  const spaceNameById = useMemo(() => {
    const entries = spaces.map((space) => [space.id, String(space.name ?? "").trim() || deriveSpaceName(space.id)] as const);
    return new Map<string, string>(entries);
  }, [spaces]);
  const availableSpaceIds = useMemo(() => new Set(spaces.map((space) => space.id)), [spaces]);

  const storeTopicById = useMemo(() => new Map(storeTopics.map((topic) => [topic.id, topic])), [storeTopics]);

  const topics = useMemo(() => {
    if (!selectedSpaceId) return storeTopics;
    return storeTopics.filter((topic) => topicMatchesSelectedSpace(topic, selectedSpaceId));
  }, [selectedSpaceId, storeTopics]);

  const tasks = useMemo(() => {
    if (!selectedSpaceId) return storeTasks;
    return storeTasks.filter((task) => {
      const taskSpace = String(task.spaceId ?? "").trim();
      if (taskSpace && taskSpace !== "space-default") return taskSpace === selectedSpaceId;
      if (taskSpace === "space-default") return false;
      if (task.topicId) {
        const parent = storeTopicById.get(task.topicId);
        if (!parent) return false;
        return topicMatchesSelectedSpace(parent, selectedSpaceId);
      }
      return false;
    });
  }, [selectedSpaceId, storeTasks, storeTopicById]);

  const logs = storeLogs;
  const [taskChatCountById, setTaskChatCountById] = useState<Record<string, number>>({});
  const [chatCountsHydrated, setChatCountsHydrated] = useState(false);
  const chatCountsRequestSeqRef = useRef(0);
  const logChangeFingerprint = useMemo(() => {
    let newest = "";
    for (const entry of logs) {
      const stamp = String(entry.updatedAt ?? entry.createdAt ?? "").trim();
      if (stamp && stamp > newest) newest = stamp;
    }
    return `${logs.length}:${newest}`;
  }, [logs]);

  const refreshChatCounts = useCallback(async () => {
    const requestSeq = chatCountsRequestSeqRef.current + 1;
    chatCountsRequestSeqRef.current = requestSeq;

    const params = new URLSearchParams();
    const scopedSpaceId = String(selectedSpaceId ?? "").trim();
    if (scopedSpaceId) params.set("spaceId", scopedSpaceId);
    const query = params.toString();
    const url = query ? `/api/log/chat-counts?${query}` : "/api/log/chat-counts";

    try {
      const response = await apiFetch(url, { cache: "no-store" }, token);
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as LogChatCountsPayload | null;
      if (requestSeq !== chatCountsRequestSeqRef.current) return;
      setTaskChatCountById(normalizeCountMap(payload?.topicChatCounts));
      setChatCountsHydrated(true);
    } catch {
      // Best-effort: keep existing counts when aggregate endpoint is unavailable.
    }
  }, [selectedSpaceId, token]);

  useEffect(() => {
    // Mark as non-urgent so the board doesn't flash empty while the new counts load.
    startTransition(() => {
      setChatCountsHydrated(false);
      setTaskChatCountById({});
    });
  }, [selectedSpaceId]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      void refreshChatCounts();
    }, DEFERRED_CHAT_COUNTS_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [hydrated, refreshChatCounts]);

  useEffect(() => {
    if (!hydrated) return;
    if (!chatCountsHydrated) return;
    const timer = window.setTimeout(() => {
      void refreshChatCounts();
    }, DEFERRED_CHAT_COUNTS_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [chatCountsHydrated, hydrated, logChangeFingerprint, refreshChatCounts]);

  useEffect(() => {
    if (spaceQueryInitializedRef.current) return;
    spaceQueryInitializedRef.current = true;
    if (!spaceFromUrl) return;
    if (spaceFromUrl === activeSpaceIdStored) return;
    setLocalStorageItem(ACTIVE_SPACE_KEY, spaceFromUrl);
  }, [activeSpaceIdStored, spaceFromUrl]);
  useEffect(() => {
    if (!hydrated) return;
    if (!activeSpaceIdStored) return;
    if (selectedSpaceId) return;
    setLocalStorageItem(ACTIVE_SPACE_KEY, "");
  }, [activeSpaceIdStored, hydrated, selectedSpaceId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!active) return;
    if (!(pathname === basePath || pathname.startsWith(`${basePath}/`))) return;
    const next = `${window.location.pathname}${window.location.search}`;
    if (!next.startsWith("/u")) return;
    setLocalStorageItem(BOARD_LAST_URL_KEY, next);
  }, [active, basePath, pathname, searchParamsKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!active) return;
    if (!(pathname === "/u" || pathname.startsWith("/u"))) return;
    if (spaceFromUrl && !activeSpaceIdStored && !selectedSpaceId) return;
    const url = new URL(window.location.href);
    const current = (url.searchParams.get("space") ?? "").trim();
    if (selectedSpaceId) {
      if (current === selectedSpaceId) return;
      url.searchParams.set("space", selectedSpaceId);
    } else {
      if (!current) return;
      url.searchParams.delete("space");
    }
    const query = url.searchParams.toString();
    const nextUrl = `${url.pathname}${query ? `?${query}` : ""}${url.hash || ""}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [active, activeSpaceIdStored, pathname, selectedSpaceId, spaceFromUrl]);

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

  // Per-chat "oldest visible index" — retained for loadOlderChat references but
  // no longer used for default truncation (all messages are shown).
  const [, setChatHistoryStarts] = useState<Record<string, number>>({});
  // Local "OpenClaw is responding" signal so the UI doesn't depend entirely on the gateway
  // returning a long-lived request for typing events.
  const [awaitingAssistant, setAwaitingAssistant] = useState<Record<string, { sentAt: string; requestId?: string }>>(
    {}
  );
  const [moveTaskId, setMoveTaskId] = useState<string | null>(null);
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [topicEditMode, setTopicEditMode] = useState<TopicEditFocusTarget>("name");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [statusMenuTopicId, setStatusMenuTopicId] = useState<string | null>(null);
  const [statusMenuTaskId, setStatusMenuTaskId] = useState<string | null>(null);
  const [topicStatusMenuPosition, setTopicStatusMenuPosition] = useState<{
    top: number;
    left: number;
    openUp: boolean;
  } | null>(null);
  const [topicColorMenuPosition, setTopicColorMenuPosition] = useState<{
    top: number;
    left: number;
    openUp: boolean;
  } | null>(null);
  const [statusMenuPosition, setStatusMenuPosition] = useState<{
    top: number;
    left: number;
    openUp: boolean;
  } | null>(null);
  const [topicNameDraft, setTopicNameDraft] = useState("");
  const [topicColorDraft, setTopicColorDraft] = useState("#FF8A4A");
  const [topicTagsDraft, setTopicTagsDraft] = useState("");
  const [topicTagsPendingEntry, setTopicTagsPendingEntry] = useState(false);
  const topicNameInputRef = useRef<HTMLInputElement | null>(null);
  const topicTagsInputRef = useRef<HTMLInputElement | null>(null);
  const topicColorInputRef = useRef<HTMLInputElement | null>(null);
  const topicEditFocusTargetRef = useRef<TopicEditFocusTarget>("name");
  const topicEditLongPressTimerRef = useRef<number | null>(null);
  const deferredTopicTagsDraft = useDeferredValue(topicTagsDraft);
  const { value: unifiedComposerDraft, setValue: setUnifiedComposerDraft } = usePersistentDraft("draft:unified:composer", {
    fallback: "",
  });
  const [unifiedComposerSearchActive, setUnifiedComposerSearchActive] = useState(false);
  const [unifiedComposerAttachments, setUnifiedComposerAttachments] = useState<UnifiedComposerAttachment[]>([]);
  const [unifiedComposerBusy, setUnifiedComposerBusy] = useState(false);
  const [unifiedComposerError, setUnifiedComposerError] = useState<string | null>(null);
  const [unifiedCancelNotice, setUnifiedCancelNotice] = useState<string | null>(null);
  const [composerTarget, setComposerTarget] = useState<UnifiedComposerTarget | null>(null);
  const unifiedComposerFileRef = useRef<HTMLInputElement | null>(null);
  const unifiedComposerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const unifiedComposerBoxRef = useRef<HTMLDivElement | null>(null);
  const unifiedComposerAttachmentsRef = useRef<UnifiedComposerAttachment[]>([]);
  const unifiedComposerFocusNudgeCleanupRef = useRef<(() => void) | null>(null);
  const revokeUnifiedPreviewUrls = useCallback((attachments: UnifiedComposerAttachment[]) => {
    for (const attachment of attachments) {
      if (!attachment.previewUrl) continue;
      try {
        URL.revokeObjectURL(attachment.previewUrl);
      } catch {
        // ignore
      }
    }
  }, []);
  const clearUnifiedComposerAttachments = useCallback(() => {
    setUnifiedComposerAttachments((prev) => {
      revokeUnifiedPreviewUrls(prev);
      return [];
    });
  }, [revokeUnifiedPreviewUrls]);
  const addUnifiedComposerFiles = useCallback((incoming: File[] | FileList) => {
    const files = Array.from(incoming ?? []);
    if (files.length === 0) return;
    setUnifiedComposerAttachments((prev) => {
      const next = [...prev];
      const seen = new Set(next.map((attachment) => `${attachment.fileName}:${attachment.sizeBytes}:${attachment.mimeType}`));
      for (const file of files) {
        const fileName = (file.name || "attachment").trim() || "attachment";
        const inferredMimeType = inferMimeTypeFromName(fileName);
        const mimeType = (file.type || inferredMimeType || "application/octet-stream").toLowerCase();
        const sizeBytes = file.size ?? 0;
        const key = `${fileName}:${sizeBytes}:${mimeType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const previewUrl =
          mimeType.startsWith("image/") && typeof window !== "undefined" ? URL.createObjectURL(file) : undefined;
        next.push({ file, fileName, mimeType, sizeBytes, previewUrl });
      }
      return next;
    });
  }, []);
  useEffect(() => {
    unifiedComposerAttachmentsRef.current = unifiedComposerAttachments;
  }, [unifiedComposerAttachments]);
  useEffect(() => {
    return () => {
      revokeUnifiedPreviewUrls(unifiedComposerAttachmentsRef.current);
      unifiedComposerAttachmentsRef.current = [];
    };
  }, [revokeUnifiedPreviewUrls]);
  useLayoutEffect(() => {
    const el = unifiedComposerTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const minH = mdUp ? 42 : 38;
    const nextHeight = Math.min(Math.max(el.scrollHeight, minH), UNIFIED_COMPOSER_MAX_HEIGHT_PX);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > UNIFIED_COMPOSER_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [unifiedComposerDraft, mdUp]);

  const clearUnifiedComposerFocusNudge = useCallback(() => {
    const cleanup = unifiedComposerFocusNudgeCleanupRef.current;
    if (!cleanup) return;
    unifiedComposerFocusNudgeCleanupRef.current = null;
    cleanup();
  }, []);

  const startUnifiedComposerFocusNudge = useCallback(() => {
    if (typeof window === "undefined" || mdUp) return;
    clearUnifiedComposerFocusNudge();

    const node = unifiedComposerBoxRef.current ?? unifiedComposerTextareaRef.current;
    if (!node) return;

    let attempts = 0;
    const nudgeIntoView = () => {
      const input = unifiedComposerTextareaRef.current;
      if (!input || document.activeElement !== input) return;
      attempts += 1;
      try {
        node.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
      } catch {
        node.scrollIntoView();
      }
      if (attempts >= 4) clearUnifiedComposerFocusNudge();
    };

    const viewport = window.visualViewport;
    const onViewportShift = () => nudgeIntoView();
    const t1 = window.setTimeout(nudgeIntoView, 90);
    const t2 = window.setTimeout(nudgeIntoView, 180);
    const t3 = window.setTimeout(nudgeIntoView, 300);
    viewport?.addEventListener("resize", onViewportShift);
    window.addEventListener("orientationchange", onViewportShift);

    unifiedComposerFocusNudgeCleanupRef.current = () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      viewport?.removeEventListener("resize", onViewportShift);
      window.removeEventListener("orientationchange", onViewportShift);
    };

    nudgeIntoView();
  }, [clearUnifiedComposerFocusNudge, mdUp]);

  useEffect(() => {
    return () => {
      clearUnifiedComposerFocusNudge();
    };
  }, [clearUnifiedComposerFocusNudge]);

  useEffect(() => {
    if (!composerTarget) return;
    const exists = topics.some((topic) => topic.id === composerTarget.topicId);
    if (!exists) setComposerTarget(null);
  }, [composerTarget, topics]);

  const knownTopicTagOptions = useMemo(() => {
    return dedupeTagLabels(storeTopicTags ?? []).sort(
      (a, b) => normalizeTagKey(a).localeCompare(normalizeTagKey(b)) || a.localeCompare(b)
    );
  }, [storeTopicTags]);
  const [taskNameDraft, setTaskNameDraft] = useState("");
  const [taskColorDraft, setTaskColorDraft] = useState("#4EA1FF");
  const [taskTagsDraft, setTaskTagsDraft] = useState("");
  const [taskTagsPendingEntry, setTaskTagsPendingEntry] = useState(false);
  const deferredTaskTagsDraft = useDeferredValue(taskTagsDraft);
  const topicRenameTagSuggestions = useMemo(
    () => (topicTagsPendingEntry ? tagSuggestionsForDraft(deferredTopicTagsDraft, knownTopicTagOptions) : []),
    [deferredTopicTagsDraft, knownTopicTagOptions, topicTagsPendingEntry]
  );
  const topicRenameTagListboxId = useId();
  const [topicRenameActiveSuggestionIndex, setTopicRenameActiveSuggestionIndex] = useState(0);
  const [activeTopicTagField, setActiveTopicTagField] = useState<"rename-topic" | null>(null);
  const taskRenameTagSuggestions = useMemo(
    () => (taskTagsPendingEntry ? tagSuggestionsForDraft(deferredTaskTagsDraft, knownTopicTagOptions) : []),
    [deferredTaskTagsDraft, knownTopicTagOptions, taskTagsPendingEntry]
  );
  const taskRenameTagListboxId = useId();
  const [taskRenameActiveSuggestionIndex, setTaskRenameActiveSuggestionIndex] = useState(0);
  const [activeTaskTagField, setActiveTaskTagField] = useState<"rename-task" | null>(null);
  const [renameSavingKey, setRenameSavingKey] = useState<string | null>(null);
  const [deleteArmedKey, setDeleteArmedKey] = useState<string | null>(null);
  const [deleteInFlightKey, setDeleteInFlightKey] = useState<string | null>(null);
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});
  const [page, setPage] = useState(initialUrlState.page);
  const [topicBumpAt, setTopicBumpAt] = useState<Record<string, number>>({});
  const [taskBumpAt, setTaskBumpAt] = useState<Record<string, number>>({});
  const bumpTimers = useRef<Map<string, number>>(new Map());
  const mobileDoneCollapseTaskIdRef = useRef<string | null>(null);
  const [mobileForcedCollapsedTaskIds, setMobileForcedCollapsedTaskIds] = useState<Set<string>>(() => new Set());
  const patchedTopicColorsRef = useRef<Set<string>>(new Set());
  const topicRenameTagMenuOpen = activeTopicTagField === "rename-topic" && topicRenameTagSuggestions.length > 0;
  const taskRenameTagMenuOpen = activeTaskTagField === "rename-task" && taskRenameTagSuggestions.length > 0;
  useEffect(() => {
    if (!topicRenameTagMenuOpen) {
      setTopicRenameActiveSuggestionIndex(0);
      return;
    }
    setTopicRenameActiveSuggestionIndex((prev) => {
      if (prev < topicRenameTagSuggestions.length) return prev;
      return 0;
    });
  }, [topicRenameTagMenuOpen, topicRenameTagSuggestions.length]);
  useEffect(() => {
    if (!taskRenameTagMenuOpen) {
      setTaskRenameActiveSuggestionIndex(0);
      return;
    }
    setTaskRenameActiveSuggestionIndex((prev) => {
      if (prev < taskRenameTagSuggestions.length) return prev;
      return 0;
    });
  }, [taskRenameTagMenuOpen, taskRenameTagSuggestions.length]);
  const applyTopicRenameTagSuggestion = useCallback((suggestion: string) => {
    setTopicTagsDraft((prev) => applyTagSuggestionToDraft(prev, suggestion));
    setTopicTagsPendingEntry(false);
    setTopicRenameActiveSuggestionIndex(0);
  }, []);
  const commitPendingTopicTagDraft = useCallback(() => {
    setTopicTagsDraft((prev) => commitTagDraftEntry(prev));
    setTopicTagsPendingEntry(false);
    setTopicRenameActiveSuggestionIndex(0);
  }, []);
  const applyTaskRenameTagSuggestion = useCallback((suggestion: string) => {
    setTaskTagsDraft((prev) => applyTagSuggestionToDraft(prev, suggestion));
    setTaskTagsPendingEntry(false);
    setTaskRenameActiveSuggestionIndex(0);
  }, []);
  const commitPendingTaskTagDraft = useCallback(() => {
    setTaskTagsDraft((prev) => commitTagDraftEntry(prev));
    setTaskTagsPendingEntry(false);
    setTaskRenameActiveSuggestionIndex(0);
  }, []);
  const [activeComposer, setActiveComposer] = useState<{ kind: "task"; topicId: string; taskId: string } | null>(null);
  const [autoFocusTask, setAutoFocusTask] = useState<{ topicId: string; taskId: string } | null>(null);
  const [chatMetaExpandEpoch, setChatMetaExpandEpoch] = useState(0);
  const [chatMetaCollapseEpoch, setChatMetaCollapseEpoch] = useState(1);
  const activeChatKeyRef = useRef<string | null>(null);
  const activeChatAtBottomRef = useRef(true);
  const topicCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const taskChatShellRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const topicScrollAnchorRef = useRef<{ topicId: string; top: number } | null>(null);
  const chatLastSeenRef = useRef<Map<string, string>>(new Map());
  const chatScrollers = useRef<Map<string, HTMLElement>>(new Map());
  const chatAtBottomRef = useRef<Map<string, boolean>>(new Map());
  const typingAliasRef = useRef<Map<string, { sourceSessionKey: string; createdAt: number }>>(new Map());
  const chatRespondingRef = useRef<Map<string, boolean>>(new Map());
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
      debugHint?: string;
    }>
  >([]);
  const composerHandlesRef = useRef<Map<string, BoardChatComposerHandle>>(new Map());
  const prevPendingAttachmentsRef = useRef<Map<string, AttachmentLike[]>>(new Map());
  const [chatTopFade, setChatTopFade] = useState<Record<string, boolean>>({});
  const [chatJumpToBottom, setChatJumpToBottom] = useState<Record<string, boolean>>({});
  const chatLastScrollTopRef = useRef<Map<string, number>>(new Map());
  const taskLogHydratedRef = useRef<Set<string>>(new Set());
  const taskLogHydratingRef = useRef<Set<string>>(new Set());
  const chatHistoryLoadingOlderRef = useRef<Set<string>>(new Set());

  const CHAT_AUTO_SCROLL_THRESHOLD_PX = 24;
  const CHAT_STICKY_PIN_INTERVAL_MS = 140;
  const topicAutosaveTimerRef = useRef<number | null>(null);
  const taskAutosaveTimerRef = useRef<number | null>(null);
  const skipTopicAutosaveRef = useRef(false);
  const skipTaskAutosaveRef = useRef(false);
  const followTopicAcrossSpacesRef = useRef<(topic: Pick<Topic, "id" | "spaceId" | "tags">) => void>(() => {});

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

  const positionTopicStatusMenu = useCallback((topicId: string) => {
    if (typeof window === "undefined") return;
    const trigger = document.querySelector<HTMLElement>(`[data-testid='topic-status-trigger-${topicId}']`);
    if (!trigger) {
      setStatusMenuTopicId(null);
      setTopicStatusMenuPosition(null);
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

    setTopicStatusMenuPosition({ top, left, openUp });
  }, []);

  const openStatusMenu = useCallback(
    (taskId: string) => {
      setStatusMenuTaskId(taskId);
      positionStatusMenu(taskId);
    },
    [positionStatusMenu]
  );

  const openTopicStatusMenu = useCallback(
    (topicId: string) => {
      setStatusMenuTopicId(topicId);
      positionTopicStatusMenu(topicId);
    },
    [positionTopicStatusMenu]
  );

  const positionTopicColorMenu = useCallback((topicId: string) => {
    if (typeof window === "undefined") return;
    const trigger = document.querySelector<HTMLElement>(`[data-testid='topic-color-trigger-${topicId}']`);
    if (!trigger) {
      setTopicColorMenuPosition(null);
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const menuWidth = 212;
    const menuHeight = 132;
    const gap = 8;
    const viewportPadding = 8;

    const openUp = window.innerHeight - rect.bottom < menuHeight + gap + viewportPadding && rect.top > menuHeight + gap;
    const top = openUp ? rect.top - gap : rect.bottom + gap;
    const left = clamp(rect.right - menuWidth, viewportPadding, window.innerWidth - menuWidth - viewportPadding);

    setTopicColorMenuPosition({ top, left, openUp });
  }, []);

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

  useEffect(() => {
    if (!statusMenuTopicId) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-topic-status-menu]")) return;
      setStatusMenuTopicId(null);
      setTopicStatusMenuPosition(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setStatusMenuTopicId(null);
        setTopicStatusMenuPosition(null);
      }
    };

    const onReposition = () => {
      if (!statusMenuTopicId) return;
      positionTopicStatusMenu(statusMenuTopicId);
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
  }, [positionTopicStatusMenu, statusMenuTopicId]);

  useEffect(() => {
    if (!(editingTopicId && topicEditMode === "color")) {
      setTopicColorMenuPosition((prev) => prev === null ? prev : null);
      return;
    }

    const closeTopicColorMenu = () => {
      const topic = topics.find((entry) => entry.id === editingTopicId);
      if (!topic) return;
      const currentColor =
        normalizeHexColor(topic.color) ??
        colorFromSeed(`topic:${topic.id}:${topic.name}`, TOPIC_FALLBACK_COLORS);
      setEditingTopicId(null);
      setTopicEditMode("name");
      setTopicNameDraft("");
      setTopicColorDraft(currentColor);
      setTopicTagsDraft("");
      setTopicTagsPendingEntry(false);
      setActiveTopicTagField(null);
      setDeleteArmedKey(null);
      setRenameErrors((prev) => {
        const next = { ...prev };
        delete next[`topic:${topic.id}`];
        return next;
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-topic-color-menu]")) return;
      closeTopicColorMenu();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeTopicColorMenu();
    };

    const onReposition = () => {
      if (!editingTopicId) return;
      positionTopicColorMenu(editingTopicId);
    };

    positionTopicColorMenu(editingTopicId);
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
  }, [editingTopicId, positionTopicColorMenu, topicEditMode, topics]);
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

  const focusTaskComposer = useCallback(
    (
      topicId: string,
      taskId: string,
      options?: { attempts?: number; reveal?: boolean; behavior?: ScrollBehavior; block?: ScrollLogicalPosition }
    ) => {
      if (typeof window === "undefined") return;
      const sessionKey = taskSessionKey(topicId, taskId);
      if (!sessionKey) return;
      const attempts = Math.max(1, options?.attempts ?? 18);
      const reveal = options?.reveal ?? true;
      const behavior = options?.behavior ?? "auto";
      const block = options?.block ?? "end";

      let remaining = attempts;
      const tick = () => {
        const handle = composerHandlesRef.current.get(sessionKey);
        if (handle) {
          handle.focus({ reveal, behavior, block });
          return;
        }
        remaining -= 1;
        if (remaining <= 0) return;
        window.requestAnimationFrame(tick);
      };

      window.requestAnimationFrame(tick);
    },
    []
  );

  const computeDefaultChatStart = (
    logs: LogEntry[] | undefined,
    initialLimit: number,
    showToolCallsInChat: boolean
  ) => {
    const all = logs ?? [];
    if (all.length === 0) return 0;
    let fallback = Math.max(0, all.length - initialLimit);
    if (!showToolCallsInChat) {
      let visibleCount = 0;
      fallback = 0;
      for (let i = all.length - 1; i >= 0; i -= 1) {
        if (!isChatNoiseLog(all[i]) && !isToolingOrSystemChatLog(all[i])) visibleCount += 1;
        fallback = i;
        if (visibleCount >= initialLimit) break;
      }
    }
    // Snap back to the nearest user-message boundary at or before fallback.
    // This ensures the visible slice always starts at the beginning of a user turn,
    // never mid-turn at an orphaned assistant or action entry.
    for (let i = fallback; i >= 0; i -= 1) {
      const eType = String(all[i].type ?? "").trim().toLowerCase();
      const eAgent = String(all[i].agentId ?? "").trim().toLowerCase();
      if (eType === "conversation" && eAgent === "user") return i;
    }
    return fallback;
  };

  const computeChatStart = useCallback(
    (
      state: Record<string, number>,
      key: string,
      len: number,
      initialLimit: number,
      logs?: LogEntry[],
      showToolCallsInChat = true
    ) => {
      const maxStart = Math.max(0, len - 1);
      const has = Object.prototype.hasOwnProperty.call(state, key);
      const defaultStart = computeDefaultChatStart(logs, initialLimit, showToolCallsInChat);
      const raw = has ? Number(state[key]) : defaultStart;
      const value = Number.isFinite(raw) ? Math.floor(raw) : 0;
      return clamp(value, 0, maxStart);
    },
    []
  );

  const computeOlderChatStart = useCallback((logs: LogEntry[] | undefined, currentStart: number, userTurns: number) => {
    const all = logs ?? [];
    if (all.length === 0) return 0;
    const normalizedCurrentStart = clamp(Math.floor(currentStart), 0, Math.max(0, all.length - 1));
    if (normalizedCurrentStart <= 0) return 0;

    let remainingTurns = Math.max(1, Math.floor(userTurns));
    for (let i = normalizedCurrentStart - 1; i >= 0; i -= 1) {
      const entry = all[i];
      const type = String(entry.type ?? "").trim().toLowerCase();
      const agentId = String(entry.agentId ?? "").trim().toLowerCase();
      if (type === "conversation" && agentId === "user") {
        remainingTurns -= 1;
        if (remainingTurns <= 0) return i;
      }
    }
    return 0;
  }, []);

  const loadOlderChat = useCallback(
    (chatKey: string, userTurns: number, logs: LogEntry[] | undefined, initialLimit: number) => {
      if (typeof window === "undefined") return;
      const key = (chatKey ?? "").trim();
      if (!key) return;
      const allLogs = logs ?? [];
      const len = allLogs.length;
      if (len <= 0) return;
      if (chatHistoryLoadingOlderRef.current.has(key)) return;
      chatHistoryLoadingOlderRef.current.add(key);
      chatHistoryLoadedOlderRef.current.add(key);
      let changed = false;

      setChatHistoryStarts((prev) => {
        const current = computeChatStart(prev, key, len, initialLimit, allLogs);
        const nextStart = computeOlderChatStart(allLogs, current, userTurns);
        if (nextStart >= current) return prev;
        changed = true;
        return { ...prev, [key]: nextStart };
      });

      // Release the debounce guard after a frame so the browser's overflow-anchor
      // has finished adjusting scroll position before we allow the next load.
      // We deliberately do NOT set scrollTop here — the container's overflow-anchor: auto
      // behaviour maintains the current content's visual position without cancelling
      // the user's scroll momentum.
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          chatHistoryLoadingOlderRef.current.delete(key);
        }, changed ? 90 : 0);
      });
    },
    [computeChatStart, computeOlderChatStart, setChatHistoryStarts]
  );

  const derivedAwaitingAssistant = useMemo<Record<string, { sentAt: string; requestId?: string }>>(() => {
    type PendingRequest = { requestId: string; sentAt: string; sentAtMs: number };
    const pendingBySession = new Map<string, PendingRequest[]>();
    const assistantByRequestId = new Set<string>();
    const terminalByRequestId = new Set<string>();
    const anonymousAssistantBySession = new Map<string, number[]>();

    const parseMs = (stamp: string) => {
      const value = Date.parse(stamp);
      return Number.isFinite(value) ? value : 0;
    };

    for (const entry of logs) {
      const sessionKey = normalizeBoardSessionKey(entry.source?.sessionKey);
      if (!sessionKey) continue;

      const agentId = String(entry.agentId ?? "")
        .trim()
        .toLowerCase();
      const requestId = String(entry.source?.requestId ?? "").trim();

      if (agentId === "user" && entry.type === "conversation" && requestId) {
        const requests = pendingBySession.get(sessionKey) ?? [];
        requests.push({
          requestId,
          sentAt: entry.createdAt,
          sentAtMs: parseMs(entry.createdAt),
        });
        pendingBySession.set(sessionKey, requests);
        continue;
      }

      if (agentId === "assistant" && entry.type === "conversation") {
        if (requestId) {
          assistantByRequestId.add(requestId);
        } else {
          const anonymous = anonymousAssistantBySession.get(sessionKey) ?? [];
          const assistantAtMs = parseMs(entry.createdAt);
          if (assistantAtMs > 0) anonymous.push(assistantAtMs);
          anonymousAssistantBySession.set(sessionKey, anonymous);
        }
        continue;
      }

      if (requestId && isTerminalSystemRequestEvent(entry)) terminalByRequestId.add(requestId);
    }

    const derived: Record<string, { sentAt: string; requestId?: string }> = {};
    for (const [sessionKey, requests] of pendingBySession.entries()) {
      const ordered = [...requests].sort((a, b) => a.sentAtMs - b.sentAtMs);
      const anonymous = [...(anonymousAssistantBySession.get(sessionKey) ?? [])].sort((a, b) => a - b);
      let anonymousIdx = 0;
      const unresolved: PendingRequest[] = [];

      for (const req of ordered) {
        if (assistantByRequestId.has(req.requestId) || terminalByRequestId.has(req.requestId)) {
          continue;
        }

        while (anonymousIdx < anonymous.length && anonymous[anonymousIdx] < req.sentAtMs) {
          anonymousIdx += 1;
        }
        if (anonymousIdx < anonymous.length) {
          anonymousIdx += 1;
          continue;
        }

        unresolved.push(req);
      }

      if (unresolved.length === 0) continue;
      const latest = unresolved[unresolved.length - 1];
      derived[sessionKey] = { sentAt: latest.sentAt, requestId: latest.requestId };
    }

    return derived;
  }, [logs]);

  const effectiveAwaitingAssistant = useMemo<Record<string, { sentAt: string; requestId?: string }>>(() => {
    const merged: Record<string, { sentAt: string; requestId?: string }> = { ...derivedAwaitingAssistant };
    for (const [sessionKey, info] of Object.entries(awaitingAssistant)) {
      if (Object.prototype.hasOwnProperty.call(merged, sessionKey)) continue;
      merged[sessionKey] = info;
    }
    return merged;
  }, [awaitingAssistant, derivedAwaitingAssistant]);

  const orchestrationThreadWorkBySession = useMemo(
    () => buildOrchestrationThreadWorkIndex(logs),
    [logs]
  );
  const recentNonUserActivityBySession = useMemo(
    () => buildRecentNonUserActivityIndex(logs),
    [logs]
  );

  const isSessionResponding = useCallback(
    (sessionKey: string) => {
      const key = normalizeBoardSessionKey(sessionKey);
      if (!key) return false;
      const nowMs = Date.now();
      const typing = openclawTyping[key];
      const awaiting = effectiveAwaitingAssistant[key];
      const hasLocalOptimisticAwaiting = Object.prototype.hasOwnProperty.call(awaitingAssistant, key);
      const orchestrationWork = orchestrationThreadWorkBySession[key];
      const orchestrationWorkMs = parseIsoMs(orchestrationWork?.updatedAt);
      const hasFreshOrchestrationWork =
        Boolean(orchestrationWork?.active) &&
        Number.isFinite(orchestrationWorkMs) &&
        nowMs - orchestrationWorkMs >= 0 &&
        nowMs - orchestrationWorkMs <= OPENCLAW_ORCHESTRATION_ACTIVE_TTL_MS;
      const recentNonUserActivity = recentNonUserActivityBySession[key];
      const recentNonUserActivityMs = parseIsoMs(recentNonUserActivity?.updatedAt);
      const hasRecentNonUserActivity =
        Number.isFinite(recentNonUserActivityMs) &&
        nowMs - recentNonUserActivityMs >= 0 &&
        nowMs - recentNonUserActivityMs <= OPENCLAW_NON_USER_ACTIVITY_TTL_MS;
      const threadWorkSignal = openclawThreadWork[key];
      const threadWorkSignalMs = parseIsoMs(threadWorkSignal?.updatedAt);
      const latestOtherSignalMs = Math.max(
        parseIsoMs(typing?.updatedAt),
        parseIsoMs(awaiting?.sentAt),
        hasFreshOrchestrationWork ? orchestrationWorkMs : Number.NaN,
        recentNonUserActivityMs
      );
      const directThreadSignal = resolveThreadWorkSignal(threadWorkSignal, {
        latestOtherSignalMs,
        nowMs,
      });
      const newerActivityAfterStopSignal =
        hasRecentNonUserActivity &&
        Number.isFinite(threadWorkSignalMs) &&
        Number.isFinite(recentNonUserActivityMs) &&
        recentNonUserActivityMs > threadWorkSignalMs;
      if (directThreadSignal === false) {
        const stopRequestId = normalizeOpenClawRequestId(threadWorkSignal?.requestId);
        const activeRequestId =
          normalizeOpenClawRequestId(awaiting?.requestId) ||
          normalizeOpenClawRequestId(typing?.requestId) ||
          normalizeOpenClawRequestId(hasFreshOrchestrationWork ? orchestrationWork?.requestId : "") ||
          normalizeOpenClawRequestId(recentNonUserActivity?.requestId);
        if (
          (!stopRequestId || !activeRequestId || stopRequestId === activeRequestId) &&
          !newerActivityAfterStopSignal
        ) return false;
      }
      if (directThreadSignal === true) return true;
      if (typing?.typing) return true;
      if (Object.prototype.hasOwnProperty.call(effectiveAwaitingAssistant, key)) {
        const hasAuthoritativeSignal =
          Object.prototype.hasOwnProperty.call(openclawTyping, key) ||
          Object.prototype.hasOwnProperty.call(openclawThreadWork, key);
        if (!hasLocalOptimisticAwaiting && awaiting?.requestId && !hasAuthoritativeSignal && !hasFreshOrchestrationWork) {
          return false;
        }
        return true;
      }
      if (hasFreshOrchestrationWork) return true;

      const alias = typingAliasRef.current.get(key);
      if (!alias) return false;
      const sourceKey = alias.sourceSessionKey;
      const sourceTyping = openclawTyping[sourceKey];
      const sourceThreadWork = orchestrationThreadWorkBySession[sourceKey];
      const sourceThreadWorkMs = parseIsoMs(sourceThreadWork?.updatedAt);
      const sourceHasFreshThreadWork =
        Boolean(sourceThreadWork?.active) &&
        Number.isFinite(sourceThreadWorkMs) &&
        nowMs - sourceThreadWorkMs >= 0 &&
        nowMs - sourceThreadWorkMs <= OPENCLAW_ORCHESTRATION_ACTIVE_TTL_MS;
      const sourceAwaiting = effectiveAwaitingAssistant[sourceKey];
      const sourceHasLocalOptimisticAwaiting = Object.prototype.hasOwnProperty.call(awaitingAssistant, sourceKey);
      const sourceRecentNonUserActivity = recentNonUserActivityBySession[sourceKey];
      const sourceRecentNonUserActivityMs = parseIsoMs(sourceRecentNonUserActivity?.updatedAt);
      const sourceHasRecentNonUserActivity =
        Number.isFinite(sourceRecentNonUserActivityMs) &&
        nowMs - sourceRecentNonUserActivityMs >= 0 &&
        nowMs - sourceRecentNonUserActivityMs <= OPENCLAW_NON_USER_ACTIVITY_TTL_MS;
      const sourceThreadWorkSignal = openclawThreadWork[sourceKey];
      const sourceThreadWorkSignalMs = parseIsoMs(sourceThreadWorkSignal?.updatedAt);
      const sourceLatestOtherSignalMs = Math.max(
        parseIsoMs(sourceTyping?.updatedAt),
        parseIsoMs(sourceAwaiting?.sentAt),
        sourceHasFreshThreadWork ? sourceThreadWorkMs : Number.NaN,
        sourceRecentNonUserActivityMs
      );
      const sourceDirectThreadSignal = resolveThreadWorkSignal(
        sourceThreadWorkSignal,
        {
          latestOtherSignalMs: sourceLatestOtherSignalMs,
          nowMs,
        }
      );
      const sourceNewerActivityAfterStopSignal =
        sourceHasRecentNonUserActivity &&
        Number.isFinite(sourceThreadWorkSignalMs) &&
        Number.isFinite(sourceRecentNonUserActivityMs) &&
        sourceRecentNonUserActivityMs > sourceThreadWorkSignalMs;
      if (sourceDirectThreadSignal === false) {
        const sourceStopRequestId = normalizeOpenClawRequestId(sourceThreadWorkSignal?.requestId);
        const sourceActiveRequestId =
          normalizeOpenClawRequestId(sourceAwaiting?.requestId) ||
          normalizeOpenClawRequestId(sourceTyping?.requestId) ||
          normalizeOpenClawRequestId(sourceHasFreshThreadWork ? sourceThreadWork?.requestId : "") ||
          normalizeOpenClawRequestId(sourceRecentNonUserActivity?.requestId);
        if (
          (!sourceStopRequestId ||
            !sourceActiveRequestId ||
            sourceStopRequestId === sourceActiveRequestId) &&
          !sourceNewerActivityAfterStopSignal
        ) return false;
      }
      const sourceResponding =
        sourceDirectThreadSignal === true ||
        Boolean(sourceTyping?.typing) ||
        (Object.prototype.hasOwnProperty.call(effectiveAwaitingAssistant, sourceKey) &&
          !(
            !sourceHasLocalOptimisticAwaiting &&
            sourceAwaiting?.requestId &&
            !Object.prototype.hasOwnProperty.call(openclawTyping, sourceKey) &&
            !Object.prototype.hasOwnProperty.call(openclawThreadWork, sourceKey) &&
            !sourceHasFreshThreadWork
          )) ||
        sourceHasFreshThreadWork;
      if (sourceResponding) return true;

      // Cleanup only after inactivity. Do not age out while the source session is still responding.
      if (Date.now() - alias.createdAt > OPENCLAW_TYPING_ALIAS_INACTIVE_RETENTION_MS) {
        typingAliasRef.current.delete(key);
      }
      return false;
    },
    [
      effectiveAwaitingAssistant,
      awaitingAssistant,
      openclawTyping,
      openclawThreadWork,
      orchestrationThreadWorkBySession,
      recentNonUserActivityBySession,
    ]
  );

  const prevExpandedTaskIdsRef = useRef<Set<string>>(new Set());
  const liveTaskStateById = useMemo(() => {
    const map = new Map<string, { responding: boolean; visualStatus: Task["status"] }>();
    for (const task of tasks) {
      const topicId = String(task.topicId ?? "").trim();
      if (!topicId) {
        map.set(task.id, { responding: false, visualStatus: task.status });
        continue;
      }
      const responding = isSessionResponding(taskSessionKey(topicId, task.id));
      map.set(task.id, {
        responding,
        visualStatus: responding ? "doing" : task.status,
      });
    }
    return map;
  }, [isSessionResponding, tasks]);
  const taskVisualStatus = useCallback(
    (task: Task): Task["status"] => liveTaskStateById.get(task.id)?.visualStatus ?? task.status,
    [liveTaskStateById]
  );
  const isTaskResponding = useCallback(
    (task: Task) => liveTaskStateById.get(task.id)?.responding ?? false,
    [liveTaskStateById]
  );

  const [draggingTopicId, setDraggingTopicId] = useState<string | null>(null);
  const [topicDropTargetId, setTopicDropTargetId] = useState<string | null>(null);
  const [topicSwipeOpenId, setTopicSwipeOpenId] = useState<string | null>(null);
  const [taskSwipeOpenId, setTaskSwipeOpenId] = useState<string | null>(null);
  const topicPointerReorder = useRef<{
    pointerId: number;
    draggedId: string;
    orderedIds: string[];
  } | null>(null);

  useEffect(() => {
    if (topicSwipeOpenId) setTaskSwipeOpenId(null);
  }, [topicSwipeOpenId]);

  useEffect(() => {
    if (taskSwipeOpenId) setTopicSwipeOpenId(null);
  }, [taskSwipeOpenId]);

  useEffect(() => {
    if (!topicSwipeOpenId && !taskSwipeOpenId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setTopicSwipeOpenId(null);
      setTaskSwipeOpenId(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [topicSwipeOpenId, taskSwipeOpenId]);

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
    const nextKey = activeComposer ? chatKeyForTask(activeComposer.taskId) : null;
    activeChatKeyRef.current = nextKey;
    updateActiveChatAtBottom();
  }, [activeComposer, updateActiveChatAtBottom]);

  useEffect(() => {
    if (!activeComposer) return;

    const isInsideActiveChat = (target: EventTarget | null) => {
      const shell = taskChatShellRefs.current.get(activeComposer.taskId);
      return Boolean(shell && target instanceof Node && shell.contains(target));
    };

    const releaseActiveComposer = () => {
      setActiveComposer((current) => (current?.taskId === activeComposer.taskId ? null : current));
    };

    const onPointerDown = (event: PointerEvent) => {
      if (isInsideActiveChat(event.target)) return;
      releaseActiveComposer();
    };

    const onFocusIn = (event: FocusEvent) => {
      if (isInsideActiveChat(event.target)) return;
      releaseActiveComposer();
    };

    const onWheel = (event: WheelEvent) => {
      if (isInsideActiveChat(event.target)) return;
      releaseActiveComposer();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("wheel", onWheel, { passive: true, capture: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("wheel", onWheel, true);
    };
  }, [activeComposer]);

  // Hide unclassified logs from the unified view by default.
  // Use ?raw=1 to include everything (raw / debugging view).
  const visibleLogs = useMemo(() => {
    if (showRaw) return logs;
    return logs.filter(
      (entry) =>
        (entry.classificationStatus ?? "pending") === "classified" &&
        !isCronEventLog(entry) &&
        !isChatNoiseLog(entry)
    );
  }, [logs, showRaw]);

  const currentUrlKey = useCallback(() => {
    if (typeof window === "undefined") return basePath;
    return `${window.location.pathname}${window.location.search}`;
  }, [basePath]);

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

  const prevUnsnoozedTopicIdsRef = useRef<Set<string>>(new Set());
  const prevUnsnoozedTaskIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const prev = prevUnsnoozedTopicIdsRef.current;
    const next = new Set(Object.keys(unsnoozedTopicBadges));
    for (const topicId of next) {
      if (!prev.has(topicId)) markBumped("topic", topicId);
    }
    prevUnsnoozedTopicIdsRef.current = next;
  }, [markBumped, unsnoozedTopicBadges]);

  useEffect(() => {
    const prev = prevUnsnoozedTaskIdsRef.current;
    const next = new Set(Object.keys(unsnoozedTaskBadges));
    for (const taskId of next) {
      if (!prev.has(taskId)) markBumped("task", taskId);
    }
    prevUnsnoozedTaskIdsRef.current = next;
  }, [markBumped, unsnoozedTaskBadges]);

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

  const taskTopicById = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      map.set(task.id, task.topicId ?? "unassigned");
    }
    return map;
  }, [tasks]);
  const topicById = useMemo(() => new Map(topics.map((topic) => [topic.id, topic])), [topics]);

  const chatEntityIdFromKey = useCallback((chatKey: string) => {
    const key = String(chatKey ?? "").trim();
    if (!key) return "";
    if (key.startsWith("topic:")) {
      return key.slice("topic:".length).trim();
    }
    if (key.startsWith("task:")) {
      return key.slice("task:".length).trim();
    }
    return "";
  }, []);

  const sessionKeyForChatKey = useCallback(
    (chatKey: string) => {
      const entityId = chatEntityIdFromKey(chatKey);
      if (!entityId || entityId === "unassigned") return "";

      const key = String(chatKey ?? "").trim();
      if (key.startsWith("topic:")) {
        return topicSessionKey(entityId);
      }

      const topicId = taskTopicById.get(entityId) ?? "";
      if (!topicId || topicId === "unassigned") return "";
      return taskSessionKey(topicId, entityId);
    },
    [chatEntityIdFromKey, taskTopicById]
  );

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

        return compareByBoardOrder(a, b);
      });
    }
    return map;
  }, [taskBumpAt, tasks]);

  const logsByTask = useMemo(() => {
    const sorted = [...visibleLogs].sort(compareLogCreatedAtDesc);
    const map = new Map<string, LogEntry[]>();
    for (const entry of sorted) {
      const compatTaskId = compatTaskLogKey(entry);
      if (!compatTaskId) continue;
      const list = map.get(compatTaskId) ?? [];
      list.push(entry);
      map.set(compatTaskId, list);
    }
    return map;
  }, [visibleLogs]);

  const logsByTopic = useMemo(() => {
    const sorted = [...visibleLogs].sort(compareLogCreatedAtDesc);
    const map = new Map<string, LogEntry[]>();
    for (const entry of sorted) {
      const topicId = effectiveBoardTopicId(entry);
      if (!topicId) continue;
      const list = map.get(topicId) ?? [];
      list.push(entry);
      map.set(topicId, list);
    }
    return map;
  }, [visibleLogs]);

  // Full task-chat logs used for active task panes. Pending rows stay visible here so
  // the live conversation reflects real assistant/tool progress before classification lands.
  const logsByTaskAll = useMemo(() => {
    const eligible = logs.filter((entry) => !isCronEventLog(entry) && !isChatNoiseLog(entry));
    const sorted = [...eligible].sort(compareLogCreatedAtAsc);
    const map = new Map<string, LogEntry[]>();
    for (const entry of sorted) {
      const compatTaskId = compatTaskLogKey(entry);
      if (!compatTaskId) continue;
      const list = map.get(compatTaskId) ?? [];
      list.push(entry);
      map.set(compatTaskId, list);
    }
    return map;
  }, [logs]);

  const topicChatLogsByTopicAll = useMemo(() => {
    const eligible = logs.filter((entry) => !isCronEventLog(entry) && !isChatNoiseLog(entry));
    const sorted = [...eligible].sort(compareLogCreatedAtAsc);
    const map = new Map<string, LogEntry[]>();
    for (const entry of sorted) {
      const topicId = effectiveBoardTopicId(entry);
      if (!topicId) continue;
      const list = map.get(topicId) ?? [];
      list.push(entry);
      map.set(topicId, list);
    }
    return map;
  }, [logs]);

  const markVisibleChatSeen = useCallback(
    (chatKey: string) => {
      const key = String(chatKey ?? "").trim();
      if (!key) return;

      const entityId = chatEntityIdFromKey(key);
      const rows = entityId ? logsByTaskAll.get(entityId) ?? topicChatLogsByTopicAll.get(entityId) ?? [] : [];
      const topic = entityId ? topicById.get(entityId) : undefined;
      const seenAt = topic
        ? topicLastTouchedAt(topic, rows.length > 0 ? String(rows[rows.length - 1]?.createdAt ?? "").trim() : "")
        : rows.length > 0
          ? String(rows[rows.length - 1]?.createdAt ?? "").trim()
          : "";

      markChatSeenInStore(key, seenAt || undefined);
      if (!entityId) return;

      // When a topic/task chat is visibly open, clear its attention badge too so
      // the board reflects that the user has actually looked at it.
      if (taskTopicById.has(entityId)) {
        dismissUnsnoozedTaskBadge(entityId);
        return;
      }
      dismissUnsnoozedTopicBadge(entityId);
    },
    [
      chatEntityIdFromKey,
      dismissUnsnoozedTaskBadge,
      dismissUnsnoozedTopicBadge,
      logsByTaskAll,
      markChatSeenInStore,
      taskTopicById,
      topicById,
      topicChatLogsByTopicAll,
    ]
  );

  useEffect(() => {
    const visibleChatKeys = new Set<string>();
    for (const topicId of expandedTopicsSafe) {
      const key = chatKeyForTask(topicId);
      if (key) visibleChatKeys.add(key);
    }
    for (const taskId of expandedTasksSafe) {
      const key = chatKeyForTask(taskId);
      if (key) visibleChatKeys.add(key);
    }

    if (!mdUp && mobileLayer === "chat") {
      if (mobileChatTarget?.taskId) {
        const key = chatKeyForTask(mobileChatTarget.taskId);
        if (key) visibleChatKeys.add(key);
      }
    }

    for (const key of visibleChatKeys) {
      markVisibleChatSeen(key);
    }
  }, [expandedTasksSafe, expandedTopicsSafe, markVisibleChatSeen, mdUp, mobileChatTarget, mobileLayer]);

  const hydrateTaskLogs = useCallback(
    async (taskId: string) => {
      const id = String(taskId || "").trim();
      if (!id) return;
      if (taskLogHydratedRef.current.has(id)) return;
      if (taskLogHydratingRef.current.has(id)) return;
      taskLogHydratingRef.current.add(id);
      try {
        const merged: LogEntry[] = [];
        const pageSize = 400;
        let offset = 0;
        while (true) {
          const params = new URLSearchParams({
            limit: String(pageSize),
            offset: String(offset),
          });
          if (selectedSpaceId) params.set("spaceId", selectedSpaceId);
          const res = await apiFetch(
            `/api/topics/${encodeURIComponent(id)}/thread?${params.toString()}`,
            { cache: "no-store" },
            token
          );
          if (!res.ok) break;
          const payload = (await res.json().catch(() => null)) as { logs?: LogEntry[] } | LogEntry[] | null;
          const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.logs) ? payload.logs : [];
          if (!Array.isArray(rows) || rows.length === 0) break;
          merged.push(...rows);
          if (rows.length < pageSize) break;
          offset += rows.length;
        }
        if (merged.length > 0) {
          setLogs((prev) => mergeLogs(prev, merged));
        }
        taskLogHydratedRef.current.add(id);
      } finally {
        taskLogHydratingRef.current.delete(id);
      }
    },
    [selectedSpaceId, setLogs, token]
  );

  const activateUnifiedComposerSearch = useCallback(() => {
    setUnifiedComposerSearchActive(true);
  }, []);
  const clearUnifiedComposerSearch = useCallback(() => {
    setUnifiedComposerSearchActive(false);
  }, []);

  useEffect(() => {
    if (unifiedComposerDraft.trim().length > 0) return;
    setUnifiedComposerSearchActive(false);
  }, [unifiedComposerDraft]);

  const searchPlan = useMemo(
    () => buildUnifiedSearchPlan(unifiedComposerSearchActive ? unifiedComposerDraft : ""),
    [unifiedComposerDraft, unifiedComposerSearchActive]
  );
  const normalizedSearch = searchPlan.normalized;
  const semanticSearchQuery = searchPlan.lexicalQuery;
  const semanticSearchHintQuery = searchPlan.semanticQuery;
  const topicReorderEnabled = !readOnly && normalizedSearch.length === 0 && statusFilter === "all";

  const topicIdFromSessionKey = useCallback((sessionKey: string) => {
    const key = normalizeBoardSessionKey(sessionKey);
    if (!key) return "";
    if (key.startsWith(BOARD_TOPIC_SESSION_PREFIX)) {
      return key.slice(BOARD_TOPIC_SESSION_PREFIX.length).trim().split(":", 1)[0]?.trim() ?? "";
    }
    return "";
  }, []);

  const chatKeyFromSessionKey = useCallback((sessionKey: string) => {
    const topicId = topicIdFromSessionKey(sessionKey);
    return topicId ? chatKeyForTask(topicId) : "";
  }, [topicIdFromSessionKey]);

  const findPendingMessagesBySession = useCallback(
    (sessionKey: string) => {
      const normalized = normalizeBoardSessionKey(sessionKey);
      if (!normalized) return [];
      return pendingMessages.filter((pending) => normalizeBoardSessionKey(pending.sessionKey) === normalized);
    },
    [pendingMessages]
  );

  const markRecentBoardSend = useCallback((sessionKey: string) => {
    const key = normalizeBoardSessionKey(sessionKey);
    if (!key) return;
    const now = Date.now();
    const map = recentBoardSendAtRef.current;
    map.set(key, now);
    for (const [k, ts] of map) {
      if (now - ts > OPENCLAW_PROMOTION_SIGNAL_WINDOW_MS) map.delete(k);
    }
  }, []);

  const handleComposerSendUpdate = useCallback(
    (event: BoardChatComposerSendEvent | undefined) => {
      if (!event) return;
      const sessionKey = normalizeBoardSessionKey(event.sessionKey);
      if (!sessionKey) return;
      markRecentBoardSend(sessionKey);
      if (event.phase === "sending") {
        const taskId = topicIdFromSessionKey(sessionKey);
        const parentTopicId = String(taskTopicById.get(taskId) ?? taskId).trim();
        if (taskId && parentTopicId && parentTopicId !== "unassigned") {
          setExpandedTopics((prev) => {
            if (prev.has(parentTopicId)) return prev;
            const next = new Set(prev);
            next.add(parentTopicId);
            return next;
          });
          setExpandedTasks((prev) => {
            if (prev.has(taskId)) return prev;
            const next = new Set(prev);
            next.add(taskId);
            return next;
          });
          setActiveComposer({ kind: "task", topicId: parentTopicId, taskId });
          setAutoFocusTask({ topicId: parentTopicId, taskId });
          if (!mdUp) {
            setMobileChatTarget({ topicId: parentTopicId, taskId });
            setMobileLayer("chat");
          }
          focusTaskComposer(parentTopicId, taskId, { attempts: 18, reveal: true, behavior: "auto", block: "end" });
        }
        if (taskId) {
          const optimisticTs = new Date().toISOString();
          setTopics((prev) => {
            const nextSortIndex = optimisticTopSortIndex(prev, taskId);
            return prev.map((row) =>
              row.id === taskId
                ? { ...row, updatedAt: optimisticTs, sortIndex: nextSortIndex }
                : row
            );
          });
          markBumped("topic", taskId);
        }
        setAwaitingAssistant((prev) => ({
          ...prev,
          [sessionKey]: { sentAt: event.createdAt },
        }));
        setPendingMessages((prev) => [
          ...prev.filter((item) => item.localId !== event.localId),
          {
            localId: event.localId,
            sessionKey,
            message: event.message,
            attachments: event.attachments,
            createdAt: event.createdAt,
            status: "sending",
          },
        ]);
      } else if (event.phase === "queued") {
        setAwaitingAssistant((prev) => ({
          ...prev,
          [sessionKey]: { sentAt: event.createdAt, requestId: event.requestId },
        }));
        setPendingMessages((prev) =>
          prev.map((item) =>
            item.localId === event.localId ? { ...item, requestId: event.requestId, status: "sent" } : item
          )
        );
      } else if (event.phase === "failed") {
        setAwaitingAssistant((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev, sessionKey)) return prev;
          const next = { ...prev };
          delete next[sessionKey];
          return next;
        });
        setPendingMessages((prev) =>
          prev.map((item) => (item.localId === event.localId ? { ...item, status: "failed", error: event.error } : item))
        );
      }
      const chatKey = chatKeyFromSessionKey(sessionKey);
      if (chatKey) {
        activeChatKeyRef.current = chatKey;
        activeChatAtBottomRef.current = true;
        setChatJumpToBottom((prev) => (prev[chatKey] === false ? prev : { ...prev, [chatKey]: false }));
        scheduleScrollChatToBottom(chatKey);
      }
    },
    [
      chatKeyFromSessionKey,
      focusTaskComposer,
      markBumped,
      markRecentBoardSend,
      mdUp,
      scheduleScrollChatToBottom,
      setMobileChatTarget,
      setMobileLayer,
      setExpandedTasks,
      setExpandedTopics,
      setTopics,
      taskTopicById,
      topicIdFromSessionKey,
    ]
  );

  const getChatLastLogId = useCallback(
    (key: string) => {
      const taskId = chatEntityIdFromKey(key);
      if (!taskId) return "";
      const rows = logsByTaskAll.get(taskId) ?? [];
      const last = rows.length > 0 ? rows[rows.length - 1] : null;
      return last?.id ?? "";
    },
    [chatEntityIdFromKey, logsByTaskAll]
  );

  useEffect(() => {
    if (pendingMessages.length === 0) return;
    const norm = (value: string) => String(value || "").trim().replace(/\s+/g, " ");
    setPendingMessages((prev) => {
      if (prev.length === 0) return prev;
      return prev.filter((pending) => {
        const pSession = normalizeBoardSessionKey(pending.sessionKey);
        if (!pSession) return true;
        const pMessage = norm(pending.message);
        const pRequest = normalizeOpenClawRequestId(pending.requestId);
        const pTs = Date.parse(pending.createdAt);
        const matches = logs.some((entry) => {
          const lSession = normalizeBoardSessionKey(entry.source?.sessionKey);
          if (!lSession) return false;
          if ((entry.agentId ?? "").toLowerCase() !== "user") return false;
          if (lSession !== pSession) return false;
          const req = requestIdForLogEntry(entry);
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
    const assistantRequestIds = new Set<string>();
    const terminalRequestIds = new Set<string>();

    for (const entry of logs) {
      const sessionKey = normalizeBoardSessionKey(entry.source?.sessionKey);
      if (!sessionKey) continue;
      const agentId = String(entry.agentId ?? "").trim().toLowerCase();
      if (agentId === "assistant" && entry.type === "conversation") {
        const ts = entry.createdAt;
        const prev = latestAssistantBySession.get(sessionKey) ?? "";
        if (!prev || ts > prev) latestAssistantBySession.set(sessionKey, ts);
        const requestId = String(entry.source?.requestId ?? "").trim();
        if (requestId) assistantRequestIds.add(requestId);
      }
      const reqId = String(entry.source?.requestId ?? "").trim();
      if (reqId) {
        if (isTerminalSystemRequestEvent(entry)) terminalRequestIds.add(reqId);
      }
    }

    setAwaitingAssistant((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [sessionKey, info] of Object.entries(prev)) {
        const sentAtMs = Date.parse(info.sentAt);

        // Once logs carry unresolved state for this session, local optimistic state can drop out.
        if (Object.prototype.hasOwnProperty.call(derivedAwaitingAssistant, sessionKey)) {
          changed = true;
          continue;
        }

        // 1. Time-based expiry (fallback) for optimistic-only state.
        const optimisticTtlMs = info.requestId
          ? OPENCLAW_RESPONDING_OPTIMISTIC_REQUEST_TTL_MS
          : OPENCLAW_RESPONDING_OPTIMISTIC_NO_REQUEST_TTL_MS;
        if (Number.isFinite(sentAtMs) && now - sentAtMs > optimisticTtlMs) {
          changed = true;
          continue;
        }

        // 2. Request-specific terminal events
        if (info.requestId && assistantRequestIds.has(info.requestId)) {
          changed = true;
          continue;
        }
        if (info.requestId && terminalRequestIds.has(info.requestId)) {
          changed = true;
          continue;
        }

        // 3. Explicit typing: false event from backend
        // We also check for matching requestId if available to prevent stale events from
        // clearing newer requests in the same session.
        const typingStatus = openclawTyping[sessionKey];
        if (typingStatus && !typingStatus.typing) {
          if (!info.requestId || !typingStatus.requestId || info.requestId === typingStatus.requestId) {
            changed = true;
            continue;
          }
        }

        // 4. Session-level fallback only for pre-queue optimistic sends (no requestId yet).
        const assistantAt = latestAssistantBySession.get(sessionKey);
        if (!info.requestId && assistantAt && assistantAt > info.sentAt) {
          changed = true;
          continue;
        }
        next[sessionKey] = info;
      }
      return changed ? next : prev;
    });
  }, [awaitingAssistant, derivedAwaitingAssistant, logs, openclawTyping]);

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
    taskLogHydratedRef.current.clear();
  }, [selectedSpaceId, spaceVisibilityRevision]);

  useEffect(() => {
    const targets = new Set<string>();
    for (const taskId of expandedTasksSafe) {
      if (taskId) targets.add(taskId);
    }
    if (mobileLayer === "chat" && mobileChatTarget?.taskId) {
      targets.add(mobileChatTarget.taskId);
    }
    if (targets.size === 0) return;
    const taskIds = Array.from(targets).filter((taskId) => {
      const knownCount = taskChatCountById[taskId] ?? 0;
      const loadedCount = Math.max(
        logsByTaskAll.get(taskId)?.length ?? 0,
        topicChatLogsByTopicAll.get(taskId)?.length ?? 0
      );
      return chatCountsHydrated && knownCount > loadedCount;
    });
    if (taskIds.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const taskId of taskIds) {
        void hydrateTaskLogs(taskId);
      }
    }, DEFERRED_THREAD_HYDRATION_MS);
    return () => window.clearTimeout(timer);
  }, [
    chatCountsHydrated,
    expandedTasksSafe,
    hydrateTaskLogs,
    logsByTaskAll,
    mobileChatTarget,
    mobileLayer,
    taskChatCountById,
    topicChatLogsByTopicAll,
  ]);

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
      const session = active ? taskSessionKey(active.topicId, active.taskId) : "";
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

  useLayoutEffect(() => {
    if (normalizedSearch) return;

    // Typing/response indicators are not part of `logs`, so they can appear at the bottom
    // without triggering the log-based auto-scroll effect above. Keep the chat pinned when
    // the user is already at the bottom so new indicators never require manual scrolling.
    const prev = chatRespondingRef.current;
    const next = new Map<string, boolean>();

    for (const chatKey of chatScrollers.current.keys()) {
      const sessionKey = sessionKeyForChatKey(chatKey);
      const responding = sessionKey ? isSessionResponding(sessionKey) : false;
      next.set(chatKey, responding);

      const wasResponding = prev.get(chatKey) ?? false;
      if (!responding || wasResponding) continue;

      const atBottom = chatAtBottomRef.current.get(chatKey) ?? false;
      if (!atBottom) continue;

      activeChatAtBottomRef.current = true;
      scheduleScrollChatToBottom(chatKey);
      chatAtBottomRef.current.set(chatKey, true);
      setChatJumpToBottom((state) => (state[chatKey] === false ? state : { ...state, [chatKey]: false }));
    }

    chatRespondingRef.current = next;
  }, [isSessionResponding, normalizedSearch, scheduleScrollChatToBottom, sessionKeyForChatKey]);

  useEffect(() => {
    if (normalizedSearch) return;
    if (typeof window === "undefined") return;

    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const hideJumpKeys: string[] = [];
      for (const [chatKey, node] of chatScrollers.current.entries()) {
        const atBottom = chatAtBottomRef.current.get(chatKey) ?? false;
        if (!atBottom) continue;

        const remaining = node.scrollHeight - (node.scrollTop + node.clientHeight);
        if (remaining <= CHAT_AUTO_SCROLL_THRESHOLD_PX) continue;

        node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
        chatAtBottomRef.current.set(chatKey, true);
        chatLastScrollTopRef.current.set(chatKey, node.scrollTop);
        if (activeChatKeyRef.current === chatKey) activeChatAtBottomRef.current = true;
        hideJumpKeys.push(chatKey);
      }

      if (hideJumpKeys.length === 0) return;
      setChatJumpToBottom((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const key of hideJumpKeys) {
          if (next[key] === false) continue;
          next[key] = false;
          changed = true;
        }
        return changed ? next : prev;
      });
    }, CHAT_STICKY_PIN_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [normalizedSearch]);

  const semanticLimits = useMemo(
    () => ({
      topics: Math.min(Math.max(topics.length, 60), 120),
      logs: Math.min(Math.max(visibleLogs.length, 180), 320),
    }),
    [topics.length, visibleLogs.length]
  );

  const semanticRefreshKey = useMemo(() => {
    const latestTopic = topics.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    const latestTask = tasks.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    const latestLog = visibleLogs.reduce((acc, item) => {
      const stamp = item.updatedAt || item.createdAt || "";
      return stamp > acc ? stamp : acc;
    }, "");
    return `${selectedSpaceId}:${topics.length}:${tasks.length}:${visibleLogs.length}:${latestTopic}:${latestTask}:${latestLog}:${statusFilter}:${showDone ? 1 : 0}:${showRaw ? 1 : 0}:${spaceVisibilityRevision}`;
  }, [selectedSpaceId, showDone, showRaw, spaceVisibilityRevision, statusFilter, tasks, topics, visibleLogs]);

  const semanticSearch = useSemanticSearch({
    query: semanticSearchQuery,
    semanticQuery: semanticSearchHintQuery,
    spaceId: selectedSpaceId || undefined,
    allowedSpaceIds,
    includePending: showRaw,
    limitTopics: semanticLimits.topics,
    limitLogs: semanticLimits.logs,
    refreshKey: semanticRefreshKey,
  });

  const semanticForQuery = useMemo(() => {
    if (!semanticSearch.data) return null;
    const resultQuery = semanticSearch.data.query.trim().toLowerCase();
    if (!resultQuery || resultQuery !== semanticSearchQuery) return null;
    return semanticSearch.data;
  }, [semanticSearch.data, semanticSearchQuery]);

  const semanticTopicIds = useMemo(
    () =>
      pickConfidentSemanticIds(semanticForQuery?.topics, {
        absoluteFloor: 0.18,
        relativeFloor: 0.35,
        maxCount: 6,
      }),
    [semanticForQuery]
  );
  const semanticTaskIds = useMemo(
    () =>
      pickConfidentSemanticIds(semanticForQuery?.topics, {
        absoluteFloor: 0.16,
        relativeFloor: 0.34,
        maxCount: 10,
      }),
    [semanticForQuery]
  );
  const semanticLogIds = useMemo(
    () =>
      pickConfidentSemanticIds(semanticForQuery?.logs, {
        absoluteFloor: 0.14,
        relativeFloor: 0.28,
        maxCount: 18,
      }),
    [semanticForQuery]
  );
  const semanticTopicScores = useMemo(
    () => new Map((semanticForQuery?.topics ?? []).map((item) => [item.id, Number(item.score) || 0])),
    [semanticForQuery]
  );
  const semanticTaskScores = useMemo(
    () => new Map((semanticForQuery?.topics ?? []).map((item) => [item.id, Number(item.score) || 0])),
    [semanticForQuery]
  );
  const semanticLogScores = useMemo(
    () => new Map((semanticForQuery?.logs ?? []).map((item) => [item.id, Number(item.score) || 0])),
    [semanticForQuery]
  );

  const matchesLogText = useCallback((entry: LogEntry) => {
    const haystack = `${entry.summary ?? ""} ${entry.content ?? ""} ${entry.raw ?? ""}`.toLowerCase();
    return matchesSearchText(haystack, searchPlan);
  }, [searchPlan]);
  const scoreLogText = useCallback((entry: LogEntry) => {
    const haystack = `${entry.summary ?? ""} ${entry.content ?? ""} ${entry.raw ?? ""}`.toLowerCase();
    return scoreSearchText(haystack, searchPlan);
  }, [searchPlan]);

  const matchesLogSearch = useCallback((entry: LogEntry) => {
    if (!normalizedSearch) return true;
    if (semanticForQuery) {
      return semanticLogIds.has(entry.id) || matchesLogText(entry);
    }
    return matchesLogText(entry);
  }, [matchesLogText, normalizedSearch, semanticForQuery, semanticLogIds]);

  // For active chat panes we always allow a lexical fallback, even when semantic search is enabled,
  // so newly appended (pending) messages still appear immediately.
  const matchesLogSearchChat = useCallback(
    (entry: LogEntry) => {
      if (!normalizedSearch) return true;
      const haystack = `${entry.summary ?? ""} ${entry.content ?? ""} ${entry.raw ?? ""}`.toLowerCase();
      if (semanticForQuery) {
        return semanticLogIds.has(entry.id) || matchesSearchText(haystack, searchPlan);
      }
      return matchesSearchText(haystack, searchPlan);
    },
    [normalizedSearch, searchPlan, semanticForQuery, semanticLogIds]
  );

  const topicChatLogsByTopic = useMemo(() => {
    const byTopic = new Map<string, LogEntry[]>();
    for (const topic of topics) {
      const rows = topicChatLogsByTopicAll.get(topic.id) ?? [];
      byTopic.set(topic.id, normalizedSearch ? rows.filter(matchesLogSearchChat) : rows);
    }
    return byTopic;
  }, [matchesLogSearchChat, normalizedSearch, topicChatLogsByTopicAll, topics]);

  const taskChatLogsByTask = useMemo(() => {
    const byTask = new Map<string, LogEntry[]>();
    for (const task of tasks) {
      const rows = logsByTaskAll.get(task.id) ?? [];
      byTask.set(task.id, normalizedSearch ? rows.filter(matchesLogSearchChat) : rows);
    }
    return byTask;
  }, [logsByTaskAll, matchesLogSearchChat, normalizedSearch, tasks]);

  const hiddenToolCallCountBySession = useMemo(() => {
    const map = new Map<string, number>();
    if (showToolCalls) return map;

    for (const [topicId, rows] of topicChatLogsByTopicAll.entries()) {
      if (!topicId || topicId === "unassigned") continue;
      const count = countTrailingHiddenToolCallsAwaitingAgent(rows);
      if (count < 1) continue;
      map.set(topicSessionKey(topicId), count);
    }

    for (const [taskId, rows] of logsByTaskAll.entries()) {
      const topicId = taskTopicById.get(taskId) ?? "";
      if (!topicId || topicId === "unassigned") continue;
      const count = countTrailingHiddenToolCallsAwaitingAgent(rows);
      if (count < 1) continue;
      map.set(taskSessionKey(topicId, taskId), count);
    }

    return map;
  }, [logsByTaskAll, showToolCalls, taskTopicById, topicChatLogsByTopicAll]);

  const hiddenToolCallCountForSession = useCallback(
    (sessionKey: string) => {
      if (showToolCalls) return 0;
      const key = normalizeBoardSessionKey(sessionKey);
      if (!key) return 0;
      const direct = hiddenToolCallCountBySession.get(key);
      if (typeof direct === "number") return direct;
      const alias = typingAliasRef.current.get(key);
      if (!alias) return 0;
      return hiddenToolCallCountBySession.get(alias.sourceSessionKey) ?? 0;
    },
    [hiddenToolCallCountBySession, showToolCalls]
  );

  const matchesTaskSearch = useCallback((task: Task) => {
    if (revealSelection && revealedTaskIds.includes(task.id)) return true;
    if (!normalizedSearch) return true;
    const titleMatch = matchesSearchText(task.title ?? task.name, searchPlan);
    const lexicalLogMatch = logsByTask.get(task.id)?.some(matchesLogText);
    if (semanticForQuery) {
      if (titleMatch || lexicalLogMatch) return true;
      if (semanticTaskIds.has(task.id)) return true;
      const logMatches = logsByTask.get(task.id)?.some((entry) => semanticLogIds.has(entry.id));
      return Boolean(logMatches);
    }
    if (titleMatch) return true;
    const logMatches = logsByTask.get(task.id)?.some(matchesLogSearch);
    return Boolean(logMatches);
  }, [
    logsByTask,
    matchesLogText,
    matchesLogSearch,
    normalizedSearch,
    searchPlan,
    revealSelection,
    revealedTaskIds,
    semanticForQuery,
    semanticLogIds,
    semanticTaskIds,
  ]);

  const taskSearchScores = useMemo(() => {
    const map = new Map<string, number>();
    if (!normalizedSearch) return map;

    for (const task of tasks) {
      const titleScore = scoreSearchText(task.title ?? task.name, searchPlan);
      const semanticScore = semanticTaskScores.get(task.id) ?? 0;
      const confidentSemanticBonus = semanticTaskIds.has(task.id) ? 0.45 : 0;
      const bestLogScore = Math.max(
        0,
        ...(logsByTask.get(task.id) ?? []).map((entry) =>
          Math.max(scoreLogText(entry), semanticLogScores.get(entry.id) ?? 0)
        )
      );
      const score = titleScore * 1.35 + semanticScore + confidentSemanticBonus + bestLogScore * 0.7;
      if (score > 0) {
        map.set(task.id, Number(score.toFixed(4)));
      }
    }

    return map;
  }, [
    logsByTask,
    normalizedSearch,
    scoreLogText,
    searchPlan,
    semanticLogScores,
    semanticTaskIds,
    semanticTaskScores,
    tasks,
  ]);

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
      const visualStatus = taskVisualStatus(task);
      if (statusFilter !== "all") return visualStatus === statusFilter;
      if (!showDone && visualStatus === "done") return false;
      return true;
    },
    [normalizedSearch, revealSelection, revealedTaskIds, showDone, showSnoozedTasks, statusFilter, taskVisualStatus]
  );

  const topicSearchScores = useMemo(() => {
    const map = new Map<string, number>();
    if (!normalizedSearch) return map;

    for (const topic of topics) {
      const topicTextScore = scoreSearchText(`${topic.name} ${topic.description ?? ""}`, searchPlan);
      const semanticScore = semanticTopicScores.get(topic.id) ?? 0;
      const confidentSemanticBonus = semanticTopicIds.has(topic.id) ? 0.4 : 0;
      const matchingTaskScores = (tasksByTopic.get(topic.id) ?? [])
        .filter(matchesStatusFilter)
        .map((task) => taskSearchScores.get(task.id) ?? 0)
        .filter((score) => score > 0);
      const bestTaskScore = matchingTaskScores.length > 0 ? Math.max(...matchingTaskScores) : 0;
      const matchingTaskCount = matchingTaskScores.length;
      const bestLogScore = Math.max(
        0,
        ...(logsByTopic.get(topic.id) ?? []).map((entry) =>
          Math.max(scoreLogText(entry), semanticLogScores.get(entry.id) ?? 0)
        )
      );
      const score =
        topicTextScore * 1.2 +
        semanticScore +
        confidentSemanticBonus +
        bestTaskScore * 0.95 +
        bestLogScore * 0.45 +
        Math.min(0.5, matchingTaskCount * 0.12);
      if (score > 0) {
        map.set(topic.id, Number(score.toFixed(4)));
      }
    }

    return map;
  }, [
    logsByTopic,
    matchesStatusFilter,
    normalizedSearch,
    scoreLogText,
    searchPlan,
    semanticLogScores,
    semanticTopicIds,
    semanticTopicScores,
    taskSearchScores,
    tasksByTopic,
    topics,
  ]);

  const orderedTasksByTopic = useMemo(() => {
    if (!normalizedSearch) return tasksByTopic;

    const map = new Map<string, Task[]>();
    for (const [topicId, list] of tasksByTopic.entries()) {
      const sorted = [...list].sort((a, b) => {
        const aScore = taskSearchScores.get(a.id) ?? 0;
        const bScore = taskSearchScores.get(b.id) ?? 0;
        if (aScore !== bScore) return bScore - aScore;
        const aLastActivity = logsByTask.get(a.id)?.[0]?.createdAt ?? a.updatedAt;
        const bLastActivity = logsByTask.get(b.id)?.[0]?.createdAt ?? b.updatedAt;
        if (aLastActivity !== bLastActivity) return aLastActivity < bLastActivity ? 1 : -1;
        return (a.title ?? a.name).localeCompare(b.title ?? b.name);
      });
      map.set(topicId, sorted);
    }
    return map;
  }, [logsByTask, normalizedSearch, taskSearchScores, tasksByTopic]);

  const latestTopicTouchById = useMemo(() => buildLatestTopicTouchById(logs), [logs]);
  const topicAttentionIds = deriveAttentionTopicIds({
    topics,
    latestTopicTouchById,
    topicSeenByKey: chatSeenByKey,
    unsnoozedTopicBadges,
  });

  const orderedTopics = useMemo(() => {
    const now = Date.now();
    const scopedTopics =
      !normalizedSearch && selectedSpaceId
        ? topics.filter((topic) => topicMatchesSelectedSpace(topic, selectedSpaceId))
        : topics;
    const base = [...scopedTopics]
      .map((topic) => ({
        ...topic,
        lastTouchedAt: topicLastTouchedAt(
          topic,
          latestTopicTouchById[topic.id] ?? logsByTopic.get(topic.id)?.[0]?.createdAt
        ),
      }))
      .sort((a, b) => {
        if (normalizedSearch) {
          const aScore = topicSearchScores.get(a.id) ?? 0;
          const bScore = topicSearchScores.get(b.id) ?? 0;
          if (aScore !== bScore) return bScore - aScore;
          return compareByBoardOrder(
            { id: a.id, sortIndex: a.sortIndex, updatedAt: a.lastTouchedAt },
            { id: b.id, sortIndex: b.sortIndex, updatedAt: b.lastTouchedAt }
          );
        }

        const aBump = topicBumpAt[a.id] ?? 0;
        const bBump = topicBumpAt[b.id] ?? 0;
        const aBoosted = aBump > 0 && now - aBump < NEW_ITEM_BUMP_MS;
        const bBoosted = bBump > 0 && now - bBump < NEW_ITEM_BUMP_MS;
        if (aBoosted !== bBoosted) return aBoosted ? -1 : 1;
        if (aBoosted && bBoosted && aBump !== bBump) return bBump - aBump;

        if (a.lastTouchedAt !== b.lastTouchedAt) {
          return String(b.lastTouchedAt ?? "").localeCompare(String(a.lastTouchedAt ?? ""));
        }
        return compareByBoardOrder(a, b);
      });

    const filtered = base.filter((topic) => {
      if (revealSelection && revealedTopicIds.includes(topic.id)) return true;
      const effectiveView: TopicView = normalizedSearch ? "all" : topicView;
      let topicStatus = String(topic.status ?? "active").trim().toLowerCase();
      if (topicStatus === "paused") topicStatus = "snoozed";
      const isSnoozedTopic = topicStatus === "snoozed";
      const isArchivedTopic = topicStatus === "archived";
      const isDoneTopic = topicStatus === "done";
      const taskList = tasksByTopic.get(topic.id) ?? [];
      const hasMatchingTask = taskList.some((task) => matchesStatusFilter(task) && matchesTaskSearch(task));
      const topicMatchesOwnStatus = statusFilter === "all" ? showDone || topicStatus !== "done" : topicStatus === statusFilter;

      if (effectiveView === "snoozed") {
        if (!isSnoozedTopic) return false;
      } else if (effectiveView === "archived") {
        if (!isArchivedTopic) return false;
      } else {
        if (isArchivedTopic && effectiveView !== "all") return false;
        if (isSnoozedTopic && !showSnoozedTasks && !normalizedSearch) return false;
        if (isDoneTopic && !showDone && !normalizedSearch) return false;
      }

      if (statusFilter !== "all") {
        return topicMatchesOwnStatus || hasMatchingTask;
      }
      if (!showDone && isDoneTopic && !normalizedSearch) {
        return false;
      }
      if (!normalizedSearch) return true;
      const topicHit = matchesSearchText(`${topic.name} ${topic.description ?? ""}`, searchPlan);
      if (semanticForQuery) {
        if (topicHit) return true;
        if (semanticTopicIds.has(topic.id)) return true;
        if (hasMatchingTask) return true;
        const topicLogs = logsByTopic.get(topic.id) ?? [];
        return topicLogs.some((entry) => semanticLogIds.has(entry.id) || matchesLogText(entry));
      }
      if (topicHit) return true;
      if (hasMatchingTask) return true;
      const topicLogs = logsByTopic.get(topic.id) ?? [];
      return topicLogs.some(matchesLogSearch);
    });

    if (tasksByTopic.has("unassigned") && !filtered.some((topic) => topic.id === "unassigned")) {
      const effectiveView: TopicView = normalizedSearch ? "all" : topicView;
      if (effectiveView !== "snoozed" && effectiveView !== "archived") {
      filtered.push({
        id: "unassigned",
        name: "Unassigned",
        description: "Recycle bin for topics from deleted parents.",
        lastTouchedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "active",
        priority: "low",
        tags: [],
      });
      }
    }

    // Defensive: backend/history edge-cases can surface duplicate topic IDs.
    // Keep the first occurrence so React keys remain stable.
    const deduped: Topic[] = [];
    const seenTopicIds = new Set<string>();
    for (const topic of filtered) {
      if (seenTopicIds.has(topic.id)) continue;
      seenTopicIds.add(topic.id);
      deduped.push(topic);
    }
    return deduped;
  }, [
    topics,
    topicBumpAt,
    logsByTopic,
    latestTopicTouchById,
    matchesLogText,
    matchesLogSearch,
    matchesStatusFilter,
    matchesTaskSearch,
    normalizedSearch,
    searchPlan,
    semanticForQuery,
    semanticLogIds,
    semanticTopicIds,
    revealSelection,
    revealedTopicIds,
    selectedSpaceId,
    showDone,
    showSnoozedTasks,
    statusFilter,
    topicSearchScores,
    topicView,
    tasksByTopic,
  ]);

  const pageSize = UNIFIED_TOPICS_PAGE_SIZE;
  const pageCount = Math.ceil(orderedTopics.length / pageSize);
  const safePage = pageCount <= 1 ? 1 : Math.min(page, pageCount);
  const pagedTopics = pageCount > 1 ? orderedTopics.slice((safePage - 1) * pageSize, safePage * pageSize) : orderedTopics;
  const preservedTopicIds = useMemo(() => {
    const next = new Set<string>();
    const activeTopicId = String(activeComposer?.topicId ?? "").trim();
    if (activeTopicId) next.add(activeTopicId);
    const mobileTopicId = String(mobileChatTarget?.topicId ?? "").trim();
    if (mobileTopicId) next.add(mobileTopicId);
    for (const taskId of expandedTasksSafe) {
      const topicId = String(taskTopicById.get(taskId) ?? "").trim();
      if (topicId) next.add(topicId);
    }
    return Array.from(next);
  }, [activeComposer?.topicId, expandedTasksSafe, mobileChatTarget?.topicId, taskTopicById]);
  const renderedTopics = useMemo(() => {
    if (preservedTopicIds.length === 0) return pagedTopics;
    const visibleIds = new Set(pagedTopics.map((topic) => topic.id));
    let changed = false;
    for (const topicId of preservedTopicIds) {
      if (!topicId || visibleIds.has(topicId)) continue;
      visibleIds.add(topicId);
      changed = true;
    }
    if (!changed) return pagedTopics;
    return orderedTopics.filter((topic) => visibleIds.has(topic.id));
  }, [orderedTopics, pagedTopics, preservedTopicIds]);
  const scrollAnchoredTopicId = useMemo(() => {
    const activeTopicId = String(activeComposer?.topicId ?? "").trim();
    if (activeTopicId) return activeTopicId;
    const mobileTopicId = String(mobileChatTarget?.topicId ?? "").trim();
    if (mobileTopicId) return mobileTopicId;
    for (const topic of renderedTopics) {
      if (preservedTopicIds.includes(topic.id)) return topic.id;
    }
    return "";
  }, [activeComposer?.topicId, mobileChatTarget?.topicId, preservedTopicIds, renderedTopics]);
  const searchTargetsReady =
    normalizedSearch.length > 0 &&
    orderedTopics.length > 0;
  const showSendTargetButtons = searchTargetsReady;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!scrollAnchoredTopicId) {
      topicScrollAnchorRef.current = null;
      return;
    }
    const syncAnchor = () => {
      const node = topicCardRefs.current.get(scrollAnchoredTopicId);
      if (!node) return;
      topicScrollAnchorRef.current = {
        topicId: scrollAnchoredTopicId,
        top: node.getBoundingClientRect().top,
      };
    };
    syncAnchor();
    window.addEventListener("scroll", syncAnchor, { passive: true });
    window.addEventListener("resize", syncAnchor);
    return () => {
      window.removeEventListener("scroll", syncAnchor);
      window.removeEventListener("resize", syncAnchor);
    };
  }, [scrollAnchoredTopicId]);

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    if (!scrollAnchoredTopicId) {
      topicScrollAnchorRef.current = null;
      return;
    }
    const node = topicCardRefs.current.get(scrollAnchoredTopicId);
    if (!node) return;
    const nextTop = node.getBoundingClientRect().top;
    const prev = topicScrollAnchorRef.current;
    if (prev && prev.topicId === scrollAnchoredTopicId) {
      const delta = nextTop - prev.top;
      if (Math.abs(delta) > 1) {
        window.scrollBy({ top: delta, left: 0, behavior: "auto" });
      }
    }
    const refreshed = topicCardRefs.current.get(scrollAnchoredTopicId);
    topicScrollAnchorRef.current = {
      topicId: scrollAnchoredTopicId,
      top: refreshed?.getBoundingClientRect().top ?? nextTop,
    };
  }, [renderedTopics, scrollAnchoredTopicId, safePage]);

  const topicDisplayColors = useMemo(() => {
    const visibleTopicIds = orderedTopics.map((topic) => topic.id);
    const map = new Map<string, string>();
    const usage = new Map<string, number>();
    const allAssigned: string[] = [];
    const scopeColors = new Map<string, string[]>();

    const register = (topic: Topic, rawColor: string) => {
      const color = normalizeHexColor(rawColor) ?? "#4EA1FF";
      map.set(topic.id, color);
      usage.set(color, (usage.get(color) ?? 0) + 1);
      for (const scopeKey of topicColorScopeKeys(topic)) {
        const existing = scopeColors.get(scopeKey) ?? [];
        existing.push(color);
        scopeColors.set(scopeKey, existing);
      }
      allAssigned.push(color);
    };

    const prioritizedTopics = sortTopicsForColorAssignment(topics, "topic:auto:display", visibleTopicIds);
    for (const topic of prioritizedTopics) {
      const stored = normalizeHexColor(topic.color);
      if (stored) {
        register(topic, stored);
        continue;
      }
      const scopeKeys = topicColorScopeKeys(topic);
      const sameScopeColors = uniqueNormalizedColors(
        scopeKeys.flatMap((scopeKey) => scopeColors.get(scopeKey) ?? [])
      );
      const visibleColors = uniqueNormalizedColors(visibleTopicIds.map((topicId) => map.get(topicId)));
      const color = pickVibrantDistinctColor({
        palette: TOPIC_FALLBACK_COLORS,
        seed: `topic:auto:${topic.id}:${topic.name}:${scopeKeys.join("|")}`,
        primaryAvoid: [...sameScopeColors, ...visibleColors],
        secondaryAvoid: allAssigned,
        usageCount: usage,
      });
      register(topic, color);
    }
    return map;
  }, [orderedTopics, topics]);

  // In flat topology task = topic (same entity, same ID). Reuse topic colors directly.
  const taskDisplayColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      const color = topicDisplayColors.get(task.id);
      if (color) map.set(task.id, color);
    }
    return map;
  }, [tasks, topicDisplayColors]);

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

  const requestEmbeddingRefresh = useCallback(async (payload: { kind: "topic"; id: string; text: string; topicId?: string | null }) => {
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

  const applyOptimisticTopicPatch = useCallback(
    (topicId: string, patch: Partial<Topic>, options?: { promote?: boolean }) => {
      const promote = Boolean(options?.promote);
      const optimisticTs = new Date().toISOString();
      setTopics((prev) => {
        const nextSortIndex = promote ? optimisticTopSortIndex(prev, topicId) : undefined;
        return prev.map((row) =>
          row.id === topicId
            ? {
                ...row,
                ...patch,
                ...(promote ? { updatedAt: optimisticTs, sortIndex: nextSortIndex } : {}),
              }
            : row
        );
      });
      if (promote) markBumped("topic", topicId);
      return optimisticTs;
    },
    [markBumped, setTopics]
  );

  const applyOptimisticTaskPatch = useCallback(
    (taskId: string, patch: Partial<Task>, options?: { promote?: boolean }) => {
      const promote = Boolean(options?.promote);
      const optimisticTs = new Date().toISOString();
      setTasks((prev) => {
        const nextSortIndex = promote ? optimisticTopSortIndex(prev, taskId) : undefined;
        return prev.map((task) =>
          task.id === taskId
            ? {
                ...task,
                ...patch,
                ...(promote ? { updatedAt: optimisticTs, sortIndex: nextSortIndex } : {}),
              }
            : task
        );
      });
      if (promote) {
        markBumped("task", taskId);
        markBumped("topic", taskId);
      }
      return optimisticTs;
    },
    [markBumped, setTasks]
  );

  const shouldPromoteTopicTouch = useCallback((patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "undefined") continue;
      if (key === "color") continue;
      return true;
    }
    return false;
  }, []);

  const updateTask = useCallback(async (taskId: string, updates: Partial<Task>) => {
    if (readOnly) return;
    const current = tasks.find((task) => task.id === taskId);
    if (!current) return;
    const snapshot = tasks;
    const body: Record<string, unknown> = { ...updates };
    if (Object.prototype.hasOwnProperty.call(body, "title")) {
      body.name = String(updates.title ?? current.title ?? current.name).trim() || current.name;
      delete body.title;
    }
    if (Object.prototype.hasOwnProperty.call(body, "topicId")) {
      delete body.topicId;
    }
    const shouldPromote = shouldPromoteTopicTouch(body);
    applyOptimisticTaskPatch(taskId, updates, { promote: shouldPromote });
    const queuedUpdatedAt = new Date().toISOString();
    const res = await queueableApiMutation(
      `/api/topics/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        headers: writeHeaders,
        body: JSON.stringify(body),
      },
      {
        token,
        queuedResponse: {
          ...current,
          ...body,
          id: taskId,
          topicId: current.topicId,
          updatedAt: queuedUpdatedAt,
          queued: true,
        },
      }
    );

    if (!res.ok) {
      setTasks(snapshot);
      return;
    }

    const updated = parseTaskPayload(await res.json().catch(() => null));
    const nextStatus = String(updated?.status ?? updates.status ?? current.status).trim().toLowerCase();
    const transitionedToDone = nextStatus === "done" && String(current.status ?? "").trim().toLowerCase() !== "done";
    if (nextStatus !== "done") {
      setMobileForcedCollapsedTaskIds((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
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
      mobileDoneCollapseTaskIdRef.current = taskId;
      setMobileForcedCollapsedTaskIds((prev) => {
        if (prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.add(taskId);
        return next;
      });
      setExpandedTasks((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      if (mobileLayer === "chat" && mobileChatTarget?.taskId === taskId) {
        setMobileLayer("board");
        setMobileChatTarget(null);
      }
    }
  }, [
    applyOptimisticTaskPatch,
    readOnly,
    setTasks,
    tasks,
    writeHeaders,
    token,
    mdUp,
    mobileLayer,
    mobileChatTarget,
    setMobileForcedCollapsedTaskIds,
    setExpandedTasks,
    setMobileLayer,
    setMobileChatTarget,
    shouldPromoteTopicTouch,
  ]);

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
      const res = await queueableApiMutation(
        "/api/topics/reorder",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({ orderedIds }),
        },
        { token, queuedResponse: { queued: true } }
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

      const initialVisibleIds = orderedTopics
        .filter((t) => t.id !== "unassigned")
        .map((t) => t.id);
      if (initialVisibleIds.length < 2) return;

      setDraggingTopicId(topic.id);
      setTopicDropTargetId(null);
      topicPointerReorder.current = {
        pointerId: event.pointerId,
        draggedId: topic.id,
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
        setTopicEditMode("name");
        setTopicNameDraft("");
        setTopicColorDraft(currentColor);
        setTopicTagsDraft(formatTags(currentTags));
        setTopicTagsPendingEntry(false);
        setDeleteArmedKey(null);
      }
      setRenameError(renameKey);
      return;
    }
    setRenameSavingKey(renameKey);
    setRenameError(renameKey);
    try {
      const queuedUpdatedAt = new Date().toISOString();
      const res = await queueableApiMutation(
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
        {
          token,
          queuedResponse: {
            ...topic,
            id: topic.id,
            name: nameChanged ? nextName : topic.name,
            color: nextColor,
            tags: tagsChanged ? nextTags : currentTags,
            updatedAt: queuedUpdatedAt,
            queued: true,
          },
        }
      );
      if (!res.ok) {
        setRenameError(renameKey, "Failed to rename topic.");
        return;
      }
      const updated = parseTopicPayload(await res.json().catch(() => null));
      markBumped("topic", topic.id);
      if (updated?.id) {
        const nextTopic = {
          ...topic,
          ...updated,
          name: (updated.name || "").trim() || (nameChanged ? nextName : topic.name),
          color: normalizeHexColor(updated.color) ?? nextColor,
          tags: Array.isArray(updated.tags) ? updated.tags : tagsChanged ? nextTags : currentTags,
          updatedAt: updated.updatedAt ?? new Date().toISOString(),
        };
        followTopicAcrossSpacesRef.current(nextTopic);
        setTopics((prev) =>
          prev.map((item) =>
            item.id === topic.id
              ? {
                  ...item,
                  ...nextTopic,
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
        const nextTopic = {
          ...topic,
          name: nameChanged ? nextName : topic.name,
          color: nextColor,
          tags: tagsChanged ? nextTags : currentTags,
          updatedAt: new Date().toISOString(),
        };
        followTopicAcrossSpacesRef.current(nextTopic);
        setTopics((prev) =>
          prev.map((item) =>
            item.id === topic.id
              ? { ...item, ...nextTopic }
              : item
          )
        );
        if (nameChanged) {
          await requestEmbeddingRefresh({ kind: "topic", id: topic.id, text: nextName });
        }
      }
      if (shouldClose) {
        setEditingTopicId(null);
        setTopicEditMode("name");
        setTopicNameDraft("");
        setTopicColorDraft(currentColor);
        setTopicTagsDraft("");
        setTopicTagsPendingEntry(false);
        setActiveTopicTagField(null);
        setDeleteArmedKey(null);
      }
      setRenameError(renameKey);
    } finally {
      setRenameSavingKey(null);
    }
  }, [
    markBumped,
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
      setRenameError(renameKey, "Name cannot be empty.");
      return;
    }
    if (!titleChanged && !colorChanged && !tagsChanged) {
      if (shouldClose) {
        setEditingTaskId(null);
        setTaskNameDraft("");
        setTaskColorDraft(currentColor);
        setTaskTagsDraft(formatTags(currentTags));
        setTaskTagsPendingEntry(false);
        setActiveTaskTagField(null);
        setMoveTaskId(null);
        setDeleteArmedKey(null);
      }
      setRenameError(renameKey);
      return;
    }
    setRenameSavingKey(renameKey);
    setRenameError(renameKey);
    try {
      const queuedUpdatedAt = new Date().toISOString();
      const res = await queueableApiMutation(
        "/api/topics",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({
            id: task.id,
            name: titleChanged ? nextTitle : task.title ?? task.name,
            color: nextColor,
            tags: tagsChanged ? nextTags : currentTags,
          }),
        },
        {
          token,
          queuedResponse: {
            ...task,
            id: task.id,
            name: titleChanged ? nextTitle : task.title ?? task.name,
            title: titleChanged ? nextTitle : task.title ?? task.name,
            color: nextColor,
            tags: tagsChanged ? nextTags : currentTags,
            updatedAt: queuedUpdatedAt,
            queued: true,
          },
        }
      );
      if (!res.ok) {
        setRenameError(renameKey, "Failed to rename topic.");
        return;
      }
      const updated = parseTaskPayload(await res.json().catch(() => null));
      markBumped("task", task.id);
      markBumped("topic", task.id);
      if (updated?.id) {
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
            kind: "topic",
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
            kind: "topic",
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
        setTaskTagsPendingEntry(false);
        setActiveTaskTagField(null);
        setMoveTaskId(null);
        setDeleteArmedKey(null);
      }
      setRenameError(renameKey);
    } finally {
      setRenameSavingKey(null);
    }
  }, [
    markBumped,
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

  const cancelTopicEdit = useCallback((topic: Topic, currentColor: string) => {
    setEditingTopicId(null);
    setTopicEditMode("name");
    setTopicNameDraft("");
    setTopicColorDraft(currentColor);
    setTopicTagsDraft("");
    setTopicTagsPendingEntry(false);
    setActiveTopicTagField(null);
    setDeleteArmedKey(null);
    setRenameError(`topic:${topic.id}`);
  }, [setRenameError]);

  const clearTopicEditLongPress = useCallback(() => {
    if (topicEditLongPressTimerRef.current == null) return;
    window.clearTimeout(topicEditLongPressTimerRef.current);
    topicEditLongPressTimerRef.current = null;
  }, []);

  const startTopicInlineEdit = useCallback(
    (topic: Topic, currentColor: string, focusTarget: TopicEditFocusTarget = "name") => {
      if (readOnly || topic.id === "unassigned") return;
      setEditingTaskId(null);
      setTaskNameDraft("");
      setTaskColorDraft(TASK_FALLBACK_COLORS[0]);
      setEditingTopicId(topic.id);
      setTopicEditMode(focusTarget);
      setTopicNameDraft(topic.name);
      setTopicColorDraft(currentColor);
      setTopicTagsDraft(formatTags(topic.tags));
      setTopicTagsPendingEntry(false);
      setActiveTopicTagField(focusTarget === "tags" ? "rename-topic" : null);
      setDeleteArmedKey(null);
      setRenameError(`topic:${topic.id}`);
      topicEditFocusTargetRef.current = focusTarget;
    },
    [readOnly, setRenameError]
  );

  const buildTopicInlineEditGestureHandlers = useCallback(
    (topic: Topic, currentColor: string, focusTarget: TopicEditFocusTarget) => ({
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        startTopicInlineEdit(topic, currentColor, focusTarget);
      },
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse") return;
        clearTopicEditLongPress();
        topicEditLongPressTimerRef.current = window.setTimeout(() => {
          topicEditLongPressTimerRef.current = null;
          startTopicInlineEdit(topic, currentColor, focusTarget);
        }, 420);
      },
      onPointerUp: clearTopicEditLongPress,
      onPointerCancel: clearTopicEditLongPress,
      onPointerLeave: clearTopicEditLongPress,
    }),
    [clearTopicEditLongPress, startTopicInlineEdit]
  );

  const cancelTaskEdit = useCallback((task: Task, currentColor: string) => {
    setEditingTaskId(null);
    setTaskNameDraft("");
    setTaskColorDraft(currentColor);
    setTaskTagsDraft("");
    setTaskTagsPendingEntry(false);
    setActiveTaskTagField(null);
    setMoveTaskId(null);
    setDeleteArmedKey(null);
    setRenameError(`task:${task.id}`);
  }, [setRenameError]);

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
    if (!editingTopicId) return;
    const focusTarget = topicEditMode;
    const raf = window.requestAnimationFrame(() => {
      if (focusTarget === "tags") {
        topicTagsInputRef.current?.focus();
        topicTagsInputRef.current?.select();
        return;
      }
      if (focusTarget === "color") {
        topicColorInputRef.current?.focus();
        return;
      }
      topicNameInputRef.current?.focus();
      topicNameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [editingTopicId, topicEditMode]);

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

  const patchTopic = useCallback(
    async (topicId: string, patch: Partial<Topic>) => {
      if (readOnly) return;
      const current = topics.find((item) => item.id === topicId);
      if (!current) return;
      const snapshot = topics;
      const shouldPromote = shouldPromoteTopicTouch(patch as Record<string, unknown>);
      applyOptimisticTopicPatch(topicId, patch, { promote: shouldPromote });
      try {
        const queuedUpdatedAt = new Date().toISOString();
        const res = await queueableApiMutation(
          `/api/topics/${encodeURIComponent(topicId)}`,
          {
            method: "PATCH",
            headers: writeHeaders,
            body: JSON.stringify(patch),
          },
          {
            token,
            queuedResponse: {
              ...current,
              ...patch,
              id: topicId,
              updatedAt: queuedUpdatedAt,
              queued: true,
            },
          }
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
    [applyOptimisticTopicPatch, readOnly, setTopics, shouldPromoteTopicTouch, token, topics, writeHeaders]
  );

  // Persist computed topic colors exactly once for rows missing explicit colors.
  // This makes colors stable across drag/drop reorder and across sessions.
  useEffect(() => {
    if (readOnly) return;
    for (const topic of topics) {
      if (normalizeHexColor(topic.color)) continue;
      const color = topicDisplayColors.get(topic.id);
      if (!color) continue;
      if (patchedTopicColorsRef.current.has(topic.id)) continue;
      patchedTopicColorsRef.current.add(topic.id);
      void patchTopic(topic.id, { color });
    }
  }, [patchTopic, readOnly, topicDisplayColors, topics]);

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
        const res = await queueableApiMutation(
          `/api/topics/${encodeURIComponent(task.id)}`,
          { method: "DELETE" },
          { token, queuedResponse: { deleted: true, queued: true } }
        );
        if (!res.ok) continue;
        const payload = (await res.json().catch(() => null)) as { deleted?: boolean } | null;
        if (payload?.deleted) removed.add(task.id);
      }
      if (removed.size === 0) {
        setRenameError(deleteKey, "Failed to clear unassigned topics.");
        return;
      }
      const updatedAt = new Date().toISOString();
      setTasks((prev) => prev.filter((item) => !removed.has(item.id)));
      setLogs((prev) =>
        prev.map((item) =>
          item.topicId && removed.has(item.topicId) ? { ...item, topicId: null, updatedAt } : item
        )
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
      const res = await queueableApiMutation(
        `/api/topics/${encodeURIComponent(topic.id)}`,
        { method: "DELETE" },
        { token, queuedResponse: { deleted: true, queued: true } }
      );
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
      const res = await queueableApiMutation(
        `/api/topics/${encodeURIComponent(task.id)}`,
        { method: "DELETE" },
        { token, queuedResponse: { deleted: true, queued: true } }
      );
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
      setTasks((prev) => prev.filter((item) => item.id !== task.id));
      setLogs((prev) =>
        prev.map((item) => (item.topicId === task.id ? { ...item, topicId: null, updatedAt } : item))
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

  const collapseAll = () => {
    setExpandedTopics(new Set());
    setExpandedTasks(new Set());
    setChatMetaCollapseEpoch((prev) => prev + 1);
  };

  const allTopicIds = useMemo(() => orderedTopics.map((topic) => topic.id), [orderedTopics]);
  const allTaskIds = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const hasAnyExpandable = allTopicIds.length > 0 || allTaskIds.length > 0;
  const isEverythingExpanded = useMemo(() => {
    if (!hasAnyExpandable) return false;
    for (const topicId of allTopicIds) {
      if (!expandedTopicsSafe.has(topicId)) return false;
    }
    for (const taskId of allTaskIds) {
      if (!expandedTasksSafe.has(taskId)) return false;
    }
    return true;
  }, [allTaskIds, allTopicIds, expandedTasksSafe, expandedTopicsSafe, hasAnyExpandable]);

  const toggleTopicExpanded = (topicId: string) => {
    const next = new Set(expandedTopicsSafe);
    let nextTasks = new Set(expandedTasksSafe);
    if (next.has(topicId)) {
      next.delete(topicId);
      setChatMetaCollapseEpoch((prev) => prev + 1);
      // Auto-collapse child tasks when parent topic collapses.
      const topicTaskIds = new Set((tasksByTopic.get(topicId) ?? []).map((task) => task.id));
      if (topicTaskIds.size > 0) {
        nextTasks = new Set(Array.from(nextTasks).filter((id) => !topicTaskIds.has(id)));
      }
    } else {
      next.add(topicId);
    }
    setExpandedTopics(next);
    setExpandedTasks(nextTasks);
    pushUrl({ topics: Array.from(next), tasks: Array.from(nextTasks) });
  };

  const openMobileTaskChat = useCallback(
    (topicId: string, taskId: string) => {
      setMobileForcedCollapsedTaskIds((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      setMobileChatTarget({ topicId, taskId });
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
      scheduleScrollChatToBottom(chatKeyForTask(taskId));
    },
    [
      scheduleScrollChatToBottom,
      setExpandedTasks,
      setExpandedTopics,
      setMobileChatTarget,
      setMobileForcedCollapsedTaskIds,
      setMobileLayer,
    ]
  );

  const closeMobileChatLayer = useCallback(() => {
    const target = mobileChatTarget;
    if (target?.taskId) {
      setExpandedTasks((prev) => {
        if (!prev.has(target.taskId)) return prev;
        const next = new Set(prev);
        next.delete(target.taskId);
        return next;
      });
    }
    setMobileLayer("board");
    setMobileChatTarget(null);
    setChatMetaCollapseEpoch((prev) => prev + 1);
  }, [
    mobileChatTarget,
    setChatMetaCollapseEpoch,
    setExpandedTasks,
    setMobileChatTarget,
    setMobileLayer,
  ]);

  useEffect(() => {
    if (mdUp) return;
    if (mobileLayer !== "chat") return;
    if (!mobileChatTarget) return;

    const topicVisible = orderedTopics.some((topic) => topic.id === mobileChatTarget.topicId);
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
    const next = new Set(expandedTasksSafe);
    const nextTopics = new Set(expandedTopicsSafe);
    if (next.has(taskId)) {
      next.delete(taskId);
      setChatMetaCollapseEpoch((prev) => prev + 1);
    } else {
      next.add(taskId);
      nextTopics.add(topicId);
      scheduleScrollChatToBottom(chatKeyForTask(taskId));
    }
    setExpandedTopics(nextTopics);
    setExpandedTasks(next);
    pushUrl({ topics: Array.from(nextTopics), tasks: Array.from(next) });
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
    if (isEverythingExpanded) {
      collapseAll();
      pushUrl({ topics: [], tasks: [] });
      return;
    }
    setExpandedTopics(new Set(allTopicIds));
    setExpandedTasks(new Set(allTaskIds));
    setChatMetaExpandEpoch((prev) => prev + 1);
    pushUrl({ topics: allTopicIds, tasks: allTaskIds });
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
      const match = tasks.find((task) => slugify(task.title ?? task.name) === slug);
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

  const syncFromUrl = useCallback(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
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

    if (url.searchParams.has("raw")) {
      setLocalStorageItem("clawboard.display.showFullMessages", parsedState.raw ? "true" : "false");
    }
    setMessageDensity((prev) => (prev === parsedState.density ? prev : parsedState.density));
    if (url.searchParams.has("tools")) {
      setLocalStorageItem("clawboard.display.showToolCalls", parsedState.showToolCalls ? "true" : "false");
    }
    setStatusFilter((prev) => (prev === nextStatus ? prev : nextStatus));
    setShowDone((prev) => {
      const nextShowDone = parsedState.done || nextStatus === "done";
      return prev === nextShowDone ? prev : nextShowDone;
    });
    setRevealSelection((prev) => (prev === nextRevealSelection ? prev : nextRevealSelection));
    setRevealedTopicIds((prev) => (stringArraysEqual(prev, nextTopics) ? prev : nextTopics));
    setRevealedTaskIds((prev) => (stringArraysEqual(prev, nextTasks) ? prev : nextTasks));
    setPage((prev) => (prev === parsedState.page ? prev : parsedState.page));
    setExpandedTopics((prev) => (stringSetMatchesArray(prev, nextTopics) ? prev : new Set(nextTopics)));
    setExpandedTasks((prev) => (stringSetMatchesArray(prev, nextTasks) ? prev : new Set(nextTasks)));
    if (parsedState.focus) {
      const focusTopicId = nextTopics[0] ?? "";
      if (focusTopicId) {
        setExpandedTopics((prev) => {
          if (prev.has(focusTopicId)) return prev;
          const next = new Set(prev);
          next.add(focusTopicId);
          return next;
        });
        setAutoFocusTask({ topicId: focusTopicId, taskId: focusTopicId });
        setActiveComposer({ kind: "task", topicId: focusTopicId, taskId: focusTopicId });
        if (!window.matchMedia("(min-width: 768px)").matches) {
          setMobileLayer("chat");
          setMobileChatTarget({ topicId: focusTopicId, taskId: focusTopicId });
        }
        const nextUrl = new URL(url.href);
        nextUrl.searchParams.delete("focus");
        const nextHref = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
        window.history.replaceState(window.history.state, "", nextHref);
      }
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
  }, [
    basePath,
    resolveTaskId,
    resolveTopicId,
    setExpandedTasks,
    setExpandedTopics,
    setMobileChatTarget,
    setMobileLayer,
    taskTopicById,
  ]);

  useEffect(() => {
    if (!active) return;
    const handlePop = () => {
      // Mobile UX: if we're in the fullscreen chat layer, browser back should behave like tapping ✕.
      // This prevents iOS back-swipe / Android back gestures from navigating the browser history
      // in a way that leaves the app in a broken intermediate URL/state.
      if (!mdUp && mobileLayer === "chat") {
        closeMobileChatLayer();
        return;
      }
      skipNextUrlSyncUrlRef.current = null;
      restoreScrollOnNextSyncRef.current = true;
      syncFromUrl();
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [active, closeMobileChatLayer, mdUp, mobileLayer, syncFromUrl]);

  // Next router navigation (router.push / Link) does not trigger popstate.
  // Sync our internal expanded state when pathname/search params change.
  useEffect(() => {
    if (!active) return;
    if (!(pathname === basePath || pathname.startsWith(`${basePath}/`))) return;
    const currentKey = currentUrlKey();
    if (skipNextUrlSyncUrlRef.current === currentKey) {
      skipNextUrlSyncUrlRef.current = null;
      return;
    }
    skipNextUrlSyncUrlRef.current = null;
    syncFromUrl();
  }, [active, basePath, currentUrlKey, pathname, searchParamsKey, syncFromUrl]);

  useEffect(() => {
    if (!autoFocusTask) return;
    const chatKey = chatKeyForTask(autoFocusTask.taskId);
    activeChatKeyRef.current = chatKey;
    activeChatAtBottomRef.current = true;
    setChatJumpToBottom((prev) => (prev[chatKey] === false ? prev : { ...prev, [chatKey]: false }));
    scheduleScrollChatToBottom(chatKey, 12);
    focusTaskComposer(autoFocusTask.topicId, autoFocusTask.taskId, {
      attempts: 18,
      reveal: true,
      behavior: "auto",
      block: "end",
    });
  }, [autoFocusTask, focusTaskComposer, scheduleScrollChatToBottom]);

  useEffect(() => {
    // When panes open (via URL sync, expand-all, or user toggles), start scrolled to latest.
    const prevTasks = prevExpandedTaskIdsRef.current;
    for (const taskId of expandedTasksSafe) {
      if (!prevTasks.has(taskId)) scheduleScrollChatToBottom(chatKeyForTask(taskId));
    }
    prevExpandedTaskIdsRef.current = new Set(expandedTasksSafe);
  }, [expandedTasksSafe, scheduleScrollChatToBottom]);

  useEffect(() => {
    if (!hydrated) return;
    // Initialize per-chat history windows once we have the initial snapshot so the
    // visible message window is stable while the pane stays open. New messages can
    // expand the timeline, but they should not collapse already-visible history until
    // the next page load resets the per-chat window state.
    setChatHistoryStarts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const topicId of expandedTopicsSafe) {
        const key = chatKeyForTask(topicId);
        if (Object.prototype.hasOwnProperty.call(prev, key)) continue;
        const all = topicChatLogsByTopicAll.get(topicId) ?? [];
        const start = computeDefaultChatStart(all, TASK_TIMELINE_LIMIT, showToolCalls);
        next[key] = start;
        changed = true;
      }
      for (const taskId of expandedTasksSafe) {
        const key = chatKeyForTask(taskId);
        if (Object.prototype.hasOwnProperty.call(prev, key)) continue;
        const all = logsByTaskAll.get(taskId) ?? [];
        const start = computeDefaultChatStart(all, TASK_TIMELINE_LIMIT, showToolCalls);
        next[key] = start;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [expandedTasksSafe, expandedTopicsSafe, hydrated, logsByTaskAll, topicChatLogsByTopicAll, showToolCalls]);

  const pushUrl = useCallback(
    (
      overrides: Partial<Record<"raw" | "done" | "status" | "page" | "density", string>> & {
        tools?: string;
        topics?: string[];
        tasks?: string[];
        reveal?: string;
        spaceId?: string | null;
      },
      mode: "push" | "replace" = "push"
    ) => {
      const params = new URLSearchParams();
      const nextRaw = overrides.raw ?? (showRaw ? "1" : "0");
      const nextDensity = overrides.density ?? messageDensity;
      const nextTools = overrides.tools ?? (showToolCalls ? "1" : "0");
      const nextDone = overrides.done ?? (showDone ? "1" : "0");
      const nextStatus = overrides.status ?? statusFilter;
      const nextPage = overrides.page ?? String(safePage);
      const nextTopics = overrides.topics ?? Array.from(expandedTopicsSafe);
      const nextTasks = overrides.tasks ?? Array.from(expandedTasksSafe);
      const nextTopicIds = Array.from(new Set([...nextTopics, ...nextTasks]));
      const nextReveal = overrides.reveal ?? (revealSelection ? "1" : "0");
      const nextSpaceId =
        typeof overrides.spaceId === "undefined" ? selectedSpaceId : String(overrides.spaceId ?? "").trim();

      if (nextSpaceId) params.set("space", nextSpaceId);
      if (nextRaw === "1") params.set("raw", "1");
      // Compact is the default; only persist when the user explicitly chooses comfortable.
      if (nextDensity === "comfortable") params.set("density", "comfortable");
      if (nextTools === "1") params.set("tools", "1");
      if (nextDone === "1") params.set("done", "1");
      if (nextStatus !== "all") params.set("status", nextStatus);
      if (nextPage && nextPage !== "1") params.set("page", nextPage);
      if (nextReveal === "1") params.set("reveal", "1");
      const segments: string[] = [];
      for (const topicId of nextTopicIds) {
        segments.push("topic", encodeTopicParam(topicId));
      }

      const trimmedBase =
        basePath.endsWith("/") && basePath.length > 1 ? basePath.slice(0, -1) : basePath;
      const nextPath = segments.length > 0 ? `${trimmedBase}/${segments.join("/")}` : trimmedBase;
      const query = params.toString();
      const nextUrl = query ? `${nextPath}?${query}` : nextPath;
      if (typeof window === "undefined") return;
      if (!active) return;
      const currentKey = currentUrlKey();
      scrollMemory.current[currentKey] = window.scrollY;
      scrollMemory.current[nextUrl] = window.scrollY;
      if (currentKey === nextUrl) return;
      skipNextUrlSyncUrlRef.current = nextUrl;
      setLocalStorageItem(BOARD_LAST_URL_KEY, nextUrl);
      if (mode === "replace") {
        window.history.replaceState({ clawboard: true }, "", nextUrl);
      } else {
        window.history.pushState({ clawboard: true }, "", nextUrl);
      }
    },
    [
      currentUrlKey,
      encodeTopicParam,
      expandedTasksSafe,
      expandedTopicsSafe,
      safePage,
      messageDensity,
      showToolCalls,
      revealSelection,
      showDone,
      showRaw,
      statusFilter,
      basePath,
      active,
      selectedSpaceId,
    ]
  );

  const followTopicAcrossSpaces = useCallback(
    (topic: Pick<Topic, "id" | "spaceId" | "tags">) => {
      const currentSpaceId = String(selectedSpaceId ?? "").trim();
      if (!currentSpaceId) return;
      const visibleSpaceIds = topicSpaceIds(topic);
      if (visibleSpaceIds.includes(currentSpaceId)) return;

      const prioritizedIds = prioritizedTopicSpaceIds(topic);
      const nextSpaceId = prioritizedIds.find((id) => availableSpaceIds.has(id)) ?? "";
      setLocalStorageItem(ACTIVE_SPACE_KEY, nextSpaceId);
      pushUrl(
        {
          spaceId: nextSpaceId,
          topics: Array.from(new Set([...expandedTopicsSafe, topic.id])),
          reveal: "1",
          page: "1",
        },
        "replace"
      );
    },
    [availableSpaceIds, expandedTopicsSafe, pushUrl, selectedSpaceId]
  );

  useEffect(() => {
    followTopicAcrossSpacesRef.current = followTopicAcrossSpaces;
  }, [followTopicAcrossSpaces]);

  useEffect(() => {
    const taskId = mobileDoneCollapseTaskIdRef.current;
    if (!taskId) return;
    mobileDoneCollapseTaskIdRef.current = null;
    const nextTasks = Array.from(expandedTasksSafe).filter((id) => id !== taskId);
    pushUrl({ tasks: nextTasks }, "replace");
  }, [expandedTasksSafe, pushUrl]);

  const selectedComposerTarget = useMemo(() => {
    if (composerTarget?.kind === "topic") {
      const topic = topics.find((entry) => entry.id === composerTarget.topicId) ?? null;
      if (topic) return { kind: "topic" as const, topic };
    }
    return null;
  }, [composerTarget, topics]);
  const unifiedComposerIntent = useMemo(() => {
    if (selectedComposerTarget?.kind === "topic") {
      return {
        kind: "topic" as const,
        badge: "Topic",
        chipLabel: `${selectedComposerTarget.topic.name}`,
        submitLabel: unifiedComposerBusy ? "Sending..." : "Continue",
      };
    }
    return {
      kind: "new" as const,
      badge: "New",
      chipLabel: "New topic",
      submitLabel: unifiedComposerBusy ? "Starting topic..." : "Start topic",
    };
  }, [selectedComposerTarget, unifiedComposerBusy]);
  const unifiedComposerHasText = unifiedComposerDraft.trim().length > 0;
  const unifiedComposerHasContent = unifiedComposerHasText || unifiedComposerAttachments.length > 0;
  const selectedComposerSessionKey = useMemo(() => {
    if (selectedComposerTarget?.kind === "topic") {
      const topicId = String(selectedComposerTarget.topic.id ?? "").trim();
      return topicId ? topicSessionKey(topicId) : "";
    }
    return "";
  }, [selectedComposerTarget]);
  const activeComposerSessionKey = useMemo(() => {
    if (!activeComposer) return "";
    const topicId = String(activeComposer.topicId ?? "").trim();
    const taskId = String(activeComposer.taskId ?? "").trim();
    if (!topicId || !taskId) return "";
    return taskSessionKey(topicId, taskId);
  }, [activeComposer]);
  const revealedComposerSessionKey = useMemo(() => {
    if (revealedTaskIds.length !== 1) return "";
    const revealedTaskId = String(revealedTaskIds[0] ?? "").trim();
    if (!revealedTaskId) return "";
    const task = tasks.find((entry) => entry.id === revealedTaskId);
    const topicId = String(task?.topicId ?? "").trim();
    if (!task || !topicId) return "";
    return taskSessionKey(topicId, task.id);
  }, [revealedTaskIds, tasks]);
  const requestIdForSession = useCallback(
    (sessionKey: string) => {
      const key = normalizeBoardSessionKey(sessionKey);
      if (!key) return undefined;

      const direct =
        normalizeOpenClawRequestId(effectiveAwaitingAssistant[key]?.requestId) ||
        normalizeOpenClawRequestId(openclawTyping[key]?.requestId) ||
        normalizeOpenClawRequestId(openclawThreadWork[key]?.requestId) ||
        normalizeOpenClawRequestId(orchestrationThreadWorkBySession[key]?.requestId);
      if (direct) return direct;

      const alias = typingAliasRef.current.get(key);
      if (!alias) return undefined;
      const sourceKey = normalizeBoardSessionKey(alias.sourceSessionKey);
      if (!sourceKey) return undefined;
      return (
        normalizeOpenClawRequestId(effectiveAwaitingAssistant[sourceKey]?.requestId) ||
        normalizeOpenClawRequestId(openclawTyping[sourceKey]?.requestId) ||
        normalizeOpenClawRequestId(openclawThreadWork[sourceKey]?.requestId) ||
        normalizeOpenClawRequestId(orchestrationThreadWorkBySession[sourceKey]?.requestId) ||
        undefined
      );
    },
    [effectiveAwaitingAssistant, openclawTyping, openclawThreadWork, orchestrationThreadWorkBySession]
  );
  const clearUnifiedComposerFields = useCallback(() => {
    clearUnifiedComposerSearch();
    setUnifiedComposerDraft("");
    clearUnifiedComposerAttachments();
  }, [clearUnifiedComposerAttachments, clearUnifiedComposerSearch, setUnifiedComposerDraft]);

  const resolveUnifiedCancelTargetSession = useCallback(() => {
    const selectedKey = normalizeBoardSessionKey(selectedComposerSessionKey);
    if (selectedKey) return { sessionKey: selectedKey, reason: "selected" as const };

    const activeKey = normalizeBoardSessionKey(activeComposerSessionKey);
    if (activeKey) return { sessionKey: activeKey, reason: "active" as const };

    const revealedKey = normalizeBoardSessionKey(revealedComposerSessionKey);
    if (revealedKey) return { sessionKey: revealedKey, reason: "revealed" as const };

    return null;
  }, [
    activeComposerSessionKey,
    revealedComposerSessionKey,
    selectedComposerSessionKey,
  ]);

  const unifiedCancelTarget = useMemo(() => resolveUnifiedCancelTargetSession(), [resolveUnifiedCancelTargetSession]);
  const unifiedCancelTargetResponding = useMemo(() => {
    if (!unifiedCancelTarget?.sessionKey) return false;
    return isSessionResponding(unifiedCancelTarget.sessionKey);
  }, [isSessionResponding, unifiedCancelTarget]);

  const cancelUnifiedComposerRun = useCallback(
    async ({ clearComposer }: { clearComposer: boolean }) => {
      const target = resolveUnifiedCancelTargetSession();
      if (!target) {
        setUnifiedCancelNotice("Select a topic to stop.");
        return false;
      }

      setUnifiedComposerError(null);
      const requestId = requestIdForSession(target.sessionKey);
      try {
        const cancelWithPayload = async (includeRequestId: boolean) =>
          apiFetch(
            "/api/openclaw/chat",
            {
              method: "DELETE",
              headers: writeHeaders,
              body: JSON.stringify({
                sessionKey: target.sessionKey,
                ...(includeRequestId && requestId ? { requestId } : {}),
              }),
            },
            token
          );

        let res = await cancelWithPayload(true);
        if (!res.ok && requestId) {
          // Request id can drift in long/multi-run sessions. Retry session-scoped cancel.
          res = await cancelWithPayload(false);
        }
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          const msg = typeof detail?.detail === "string" ? detail.detail : `Failed to cancel (${res.status}).`;
          setUnifiedComposerError(msg);
          return false;
        }

        if (clearComposer) clearUnifiedComposerFields();
        setAwaitingAssistant((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev, target.sessionKey)) return prev;
          const next = { ...prev };
          delete next[target.sessionKey];
          return next;
        });
        setUnifiedCancelNotice(
          target.reason === "selected"
            ? "Cancelled selected target run."
            : target.reason === "revealed"
              ? "Cancelled revealed run."
            : target.reason === "active"
              ? "Cancelled active chat run."
              : "Cancelled active chat run."
        );
        return true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Failed to cancel active run.";
        setUnifiedComposerError(msg);
        return false;
      }
    },
    [clearUnifiedComposerFields, requestIdForSession, resolveUnifiedCancelTargetSession, token, writeHeaders]
  );

  const sendUnifiedComposer = useCallback(async () => {
    if (readOnly) return;
    const message = unifiedComposerDraft.trim();
    if (!message) return;
    if (isStopSlashCommand(message)) {
      setUnifiedCancelNotice(null);
      clearUnifiedComposerFields();
      void cancelUnifiedComposerRun({ clearComposer: false });
      return;
    }
    if (unifiedComposerBusy) return;

    setUnifiedComposerError(null);
    setUnifiedCancelNotice(null);

    const selectedTopic = selectedComposerTarget?.kind === "topic" ? selectedComposerTarget.topic : null;
    const forceNewTopic = !selectedTopic;

    const routedSpaceId = selectedSpaceId || undefined;
    let resolvedTopicId = String(selectedTopic?.id ?? "").trim();
    let resolvedTaskId = String(resolvedTopicId ?? "").trim();
    let sessionKey = resolvedTopicId ? topicSessionKey(resolvedTopicId) : "";

    setUnifiedComposerBusy(true);
    try {
      if (!sessionKey) {
        const resolveRes = await apiFetch(
          "/api/openclaw/resolve-board-send",
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              message,
              spaceId: routedSpaceId,
              selectedTopicId: selectedTopic ? selectedTopic.id : undefined,
              forceNewTopic,
            }),
          },
          token
        );
        if (!resolveRes.ok) {
          const detail = await resolveRes.json().catch(() => null);
          const msg = typeof detail?.detail === "string" ? detail.detail : `Failed to resolve send target (${resolveRes.status}).`;
          throw new Error(msg);
        }
        const resolved = (await resolveRes.json().catch(() => null)) as {
          topicId?: string;
          sessionKey?: string;
        } | null;
        resolvedTopicId = String(resolved?.topicId ?? "").trim();
        resolvedTaskId = resolvedTopicId;
        sessionKey = String(resolved?.sessionKey ?? "").trim();
        if (!sessionKey && resolvedTopicId) {
          sessionKey = topicSessionKey(resolvedTopicId);
        }
      }

      if (!sessionKey) return;
      markRecentBoardSend(sessionKey);

      const attachmentIds: string[] = [];
      for (const attachment of unifiedComposerAttachments) {
        const form = new FormData();
        form.append("files", attachment.file, attachment.fileName);
        const up = await apiFetch(
          "/api/attachments",
          {
            method: "POST",
            body: form,
          },
          token
        );
        if (!up.ok) {
          const detail = await up.json().catch(() => null);
          const msg = typeof detail?.detail === "string" ? detail.detail : `Failed to upload (${up.status}).`;
          throw new Error(msg);
        }
        const rows = (await up.json().catch(() => null)) as Array<{ id?: string }> | null;
        const uploadedId = Array.isArray(rows) ? String(rows[0]?.id ?? "").trim() : "";
        if (!uploadedId) throw new Error("Failed to persist attachment upload.");
        attachmentIds.push(uploadedId);
      }

      const sendRes = await apiFetch(
        "/api/openclaw/chat",
        {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify({
            sessionKey,
            message,
            spaceId: routedSpaceId,
            attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
          }),
        },
        token
      );
      if (!sendRes.ok) {
        const detail = await sendRes.json().catch(() => null);
        const msg = typeof detail?.detail === "string" ? detail.detail : `Failed to send (${sendRes.status}).`;
        throw new Error(msg);
      }

      clearUnifiedComposerFields();

      const applyTopicId = resolvedTopicId;
      const applyTaskId = resolvedTaskId;
      if (!applyTopicId || !applyTaskId) return;

      // Ensure the topic exists in client state so its card renders immediately.
      // For new topics created by resolve-board-send, the SSE event hasn't arrived yet.
      // This optimistic insert is a no-op for existing topics (upsertById skips older data).
      if (!selectedTopic) {
        const now = new Date().toISOString();
        setTopics((prev) => {
          if (prev.some((t) => t.id === applyTopicId)) return prev;
          return [
            {
              id: applyTopicId,
              name: message.slice(0, 120),
              status: "active" as const,
              tags: [],
              spaceId: routedSpaceId,
              createdAt: now,
              updatedAt: now,
            },
            ...prev,
          ];
        });
        setComposerTarget({ kind: "topic", topicId: applyTopicId });
      }
      setExpandedTopics((prev) => new Set(prev).add(applyTopicId));
      setExpandedTasks((prev) => new Set(prev).add(applyTaskId));

      // Snapshot the topic card's current viewport position BEFORE any state
      // updates that re-sort the list. This seeds the scroll anchor so the
      // useLayoutEffect compensation works on the very first render where
      // scrollAnchoredTopicId switches to this topic.
      // Set activeComposer so scrollAnchoredTopicId anchors to this topic.
      // The useLayoutEffect scroll compensation keeps the card visually stable
      // when renderedTopics re-sorts (e.g. from an SSE update arriving later).
      setActiveComposer({ kind: "task", topicId: applyTopicId, taskId: applyTaskId });

      // Focus the task composer. Use reveal: true to scroll the composer into
      // view — the topic card may not be in the DOM yet (unified composer
      // search filtering can hide cards while typing).
      setAutoFocusTask({ topicId: applyTopicId, taskId: applyTaskId });
      focusTaskComposer(applyTopicId, applyTaskId, {
        attempts: 18,
        reveal: true,
        behavior: "auto",
        block: "end",
      });

      const nextTopics = Array.from(new Set([...expandedTopicsSafe, applyTopicId]));
      const nextTasks = Array.from(new Set([...expandedTasksSafe, applyTaskId]));
      pushUrl({ topics: nextTopics, tasks: nextTasks, reveal: '1' }, 'replace');
      if (!mdUp) openMobileTaskChat(applyTopicId, applyTaskId);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Failed to send message.";
      setUnifiedComposerError(messageText);
    } finally {
      setUnifiedComposerBusy(false);
    }
  }, [
    cancelUnifiedComposerRun,
    clearUnifiedComposerFields,
    expandedTasksSafe,
    expandedTopicsSafe,
    focusTaskComposer,
    markRecentBoardSend,
    mdUp,
    openMobileTaskChat,
    pushUrl,
    readOnly,
    selectedComposerTarget,
    selectedSpaceId,
    setExpandedTasks,
    setExpandedTopics,
    setTopics,
    token,
    unifiedComposerAttachments,
    unifiedComposerBusy,
    unifiedComposerDraft,
    writeHeaders,
  ]);

  const displaySummary = [
    showDone ? "Done visible" : "Done hidden",
    showSnoozedTasks ? "Snoozed visible" : "Snoozed hidden",
    twoColumn ? "2-column board" : "1-column board",
  ].join(" · ");
  const unifiedComposerPlaceholder = mdUp
    ? "Type a message. Pick a topic if you want to continue a conversation.\nEnter sends. Shift+Enter adds a newline."
    : "Type a message or pick a target.\nEnter sends. Shift+Enter adds a newline.";
  const renderTopicViewSelect = (className = "w-full") => (
    <Select
      value={topicView}
      onChange={(event) => {
        setLocalStorageItem(TOPIC_VIEW_KEY, event.target.value);
        setPage(1);
        pushUrl({ page: "1" }, "replace");
      }}
      className={className}
    >
      <option value="active">Active topics</option>
      <option value="snoozed">Snoozed topics</option>
      <option value="archived">Archived topics</option>
      <option value="all">All topics</option>
    </Select>
  );
  const renderStatusFilterSelect = (className = "w-full") => (
    <Select value={statusFilter} onChange={(event) => updateStatusFilter(event.target.value)} className={className}>
      <option value="all">All statuses</option>
      <option value="todo">To Do</option>
      <option value="doing">Doing</option>
      <option value="blocked">Blocked</option>
      <option value="done">Done</option>
    </Select>
  );
  const renderDisplayOptionButtons = (className = "") => (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={cn(showDone ? "border-[rgba(255,90,45,0.5)]" : "opacity-85", className)}
        onClick={toggleDoneVisibility}
      >
        {showDone ? "Hide done" : "Show done"}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className={cn(showSnoozedTasks ? "border-[rgba(77,171,158,0.55)]" : "opacity-85", className)}
        onClick={() => {
          setLocalStorageItem(SHOW_SNOOZED_TASKS_KEY, showSnoozedTasks ? "false" : "true");
        }}
      >
        {showSnoozedTasks ? "Hide snoozed" : "Show snoozed"}
      </Button>
    </>
  );
  const renderBoardLayoutButtons = (className = "") => (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={cn(twoColumn ? "border-[rgba(255,90,45,0.5)]" : "opacity-85", className)}
        onClick={toggleTwoColumn}
        title={twoColumn ? "Switch to single column" : "Switch to two columns"}
      >
        {twoColumn ? "1 column" : "2 column"}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className={cn(isEverythingExpanded ? "border-[rgba(255,90,45,0.5)]" : "opacity-85", className)}
        onClick={toggleExpandAll}
      >
        {isEverythingExpanded ? "Collapse all" : "Expand all"}
      </Button>
    </>
  );

  return (
    <div className={cn("space-y-4", renderedTopics.length > 0 ? "pb-24 md:pb-28" : "")}>
      <div
        className={cn(
          "space-y-3",
          mobileLayer === "chat" ? "max-md:hidden" : ""
        )}
      >
        <div
          data-testid="unified-board-top-panel"
          className="space-y-3"
        >
          <div className="flex flex-col gap-3">
            <div className="hidden md:flex md:items-center md:gap-3 md:overflow-x-auto md:pb-1">
              <div
                role="group"
                aria-label="Filters"
                className="flex min-w-max items-center gap-2 rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(8,10,14,0.36)] px-2 py-2"
              >
                {renderTopicViewSelect("w-[210px]")}
                {renderStatusFilterSelect("w-[188px]")}
              </div>
              <div
                role="group"
                aria-label="Display"
                className="flex min-w-max items-center gap-2 rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(8,10,14,0.36)] px-2 py-2"
              >
                {renderDisplayOptionButtons()}
              </div>
              <div
                role="group"
                aria-label="Board"
                className="flex min-w-max items-center gap-2 rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(8,10,14,0.36)] px-2 py-2"
              >
                {renderBoardLayoutButtons()}
              </div>
            </div>
            <div className="space-y-2.5 md:hidden">
              <button
                type="button"
                onClick={toggleFiltersDrawer}
                aria-expanded={filtersDrawerOpen}
                className={cn(
                  "inline-flex w-full items-center justify-between gap-3 rounded-full border px-3.5 py-2 text-sm font-medium transition",
                  filtersDrawerOpen
                    ? "border-[rgba(255,90,45,0.4)] bg-[rgba(255,90,45,0.1)] text-[rgb(var(--claw-text))]"
                    : "border-[rgb(var(--claw-border))] bg-[rgba(8,10,14,0.42)] text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]"
                )}
              >
                <span>{filtersDrawerOpen ? "Hide options" : "View options"}</span>
                <span className="text-[10px] uppercase tracking-[0.18em] text-[rgb(var(--claw-muted))]">
                  {twoColumn ? "2 col" : "1 col"} {filtersDrawerOpen ? "▴" : "▾"}
                </span>
              </button>
            </div>
            {filtersDrawerOpen ? (
              <div className="space-y-3 border-t border-[rgba(255,255,255,0.08)] pt-3 md:hidden">
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[rgb(var(--claw-muted))]">
                    Filters
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {renderTopicViewSelect("w-full min-w-0")}
                    {renderStatusFilterSelect("w-full min-w-0")}
                  </div>
                </div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-[rgb(var(--claw-muted))]">
                  Display and board options
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {renderDisplayOptionButtons("min-h-10 w-full justify-center px-2 text-center")}
                  {renderBoardLayoutButtons("min-h-10 w-full justify-center px-2 text-center")}
                </div>
                <div className="text-xs text-[rgb(var(--claw-muted))]">{displaySummary}</div>
              </div>
            ) : null}
            <div className="space-y-2 border-t border-[rgba(255,255,255,0.08)] pt-3">
          <div
            ref={unifiedComposerBoxRef}
            className={cn(
              "rounded-[var(--radius-md)] border border-[rgba(255,255,255,0.12)] bg-[rgba(8,10,14,0.46)] px-2.5 py-2 transition",
              "focus-within:border-[rgba(77,171,158,0.55)] focus-within:ring-2 focus-within:ring-[rgba(77,171,158,0.18)]"
            )}
          >
              <TextArea
                ref={unifiedComposerTextareaRef}
                data-testid="unified-composer-textarea"
                value={unifiedComposerDraft}
                onFocus={() => {
                  activateUnifiedComposerSearch();
                  startUnifiedComposerFocusNudge();
                }}
                onBlur={clearUnifiedComposerFocusNudge}
                onChange={(event) => {
                  const value = event.target.value;
                  activateUnifiedComposerSearch();
                  setUnifiedComposerDraft(value);
                  setUnifiedComposerError(null);
                  setUnifiedCancelNotice(null);
                }}
                enterKeyHint={mdUp ? undefined : "send"}
                onPaste={(event) => {
                  const items = event.clipboardData?.items;
                  if (!items) return;
                  const files: File[] = [];
                  for (const item of Array.from(items)) {
                    if (item.kind !== "file") continue;
                    const file = item.getAsFile();
                    if (file) files.push(file);
                  }
                  if (files.length === 0) return;
                  event.preventDefault();
                  addUnifiedComposerFiles(files);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
                  if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
                  event.preventDefault();
                  void sendUnifiedComposer();
                }}
                placeholder={unifiedComposerPlaceholder}
                className="min-h-0 w-full resize-none overflow-y-hidden border-0 bg-transparent p-1.5 text-[15px]"
                style={{ minHeight: mdUp ? "42px" : "38px" }}
              />
              <div className="mt-2 flex flex-col gap-2 border-t border-[rgba(255,255,255,0.08)] px-1.5 pt-2.5 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div
                    data-testid="unified-composer-target-chip"
                    className={cn(
                      "inline-flex max-w-full items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] text-[rgb(var(--claw-text))]",
                      unifiedComposerIntent.kind === "topic"
                        ? "border-[rgba(255,90,45,0.42)] bg-[rgba(34,22,18,0.9)]"
                        : "border-[rgba(148,163,184,0.35)] bg-[rgba(18,22,28,0.88)]"
                    )}
                  >
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em]",
                        unifiedComposerIntent.kind === "topic"
                          ? "bg-[rgba(255,90,45,0.16)] text-[rgb(var(--claw-accent))]"
                          : "bg-[rgba(148,163,184,0.16)] text-[rgb(var(--claw-muted))]"
                      )}
                    >
                      {unifiedComposerIntent.badge}
                    </span>
                    <span className="truncate">{unifiedComposerIntent.chipLabel}</span>
                    {selectedComposerTarget ? (
                      <button
                        type="button"
                        data-testid="unified-composer-target-clear"
                        className="rounded border border-transparent px-1 text-[rgb(var(--claw-muted))] transition hover:border-[rgb(var(--claw-border))] hover:text-[rgb(var(--claw-text))]"
                        onClick={() => {
                          setComposerTarget(null);
                          setUnifiedCancelNotice(null);
                        }}
                        aria-label="Clear selected send target"
                        title="Clear selected send target"
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {unifiedComposerHasContent ? (
                    <button
                      type="button"
                      onClick={() => {
                        clearUnifiedComposerSearch();
                        setUnifiedComposerDraft('');
                        clearUnifiedComposerAttachments();
                        setUnifiedComposerError(null);
                        setUnifiedCancelNotice(null);
                      }}
                      aria-label="Clear composer"
                      title="Clear composer"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] bg-[rgba(14,17,22,0.94)] text-[rgb(var(--claw-muted))] transition hover:border-[rgba(255,90,45,0.45)] hover:text-[rgb(var(--claw-text))]"
                    >
                      <CloseIcon />
                    </button>
                  ) : null}
                  <input
                    ref={unifiedComposerFileRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      addUnifiedComposerFiles(event.target.files ?? []);
                      event.currentTarget.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => unifiedComposerFileRef.current?.click()}
                    aria-label="Attach files"
                    title="Attach files"
                    className={cn(
                      "inline-flex h-8 w-8 items-center justify-center rounded-full border text-[rgb(var(--claw-muted))] transition",
                      "border-[rgba(255,255,255,0.14)] bg-[rgba(12,14,18,0.86)] backdrop-blur",
                      "hover:border-[rgba(255,90,45,0.4)] hover:text-[rgb(var(--claw-text))]"
                    )}
                  >
                    <PaperclipIcon />
                  </button>
                  {unifiedCancelTargetResponding ? (
                    <button
                      type="button"
                      data-testid="unified-composer-stop"
                      onClick={() => {
                        setUnifiedCancelNotice(null);
                        void cancelUnifiedComposerRun({ clearComposer: false });
                      }}
                      aria-label={
                        unifiedCancelTarget?.reason === "selected"
                          ? "Stop selected run"
                          : unifiedCancelTarget?.reason === "revealed"
                            ? "Stop revealed run"
                          : unifiedCancelTarget?.reason === "active"
                            ? "Stop active chat run"
                            : "Stop active chat run"
                      }
                      title={
                        unifiedCancelTarget?.reason === "selected"
                          ? "Stop selected run"
                          : unifiedCancelTarget?.reason === "revealed"
                            ? "Stop revealed run"
                          : unifiedCancelTarget?.reason === "active"
                            ? "Stop active chat run"
                            : "Stop active chat run"
                      }
                      className={cn(
                        "inline-flex h-8 w-8 items-center justify-center rounded-full border text-[rgb(var(--claw-text))] transition",
                        "border-[rgba(220,38,38,0.7)] bg-[rgba(220,38,38,0.25)] backdrop-blur",
                        "hover:bg-[rgba(220,38,38,0.4)]"
                      )}
                    >
                      <StopIcon />
                    </button>
                  ) : null}
                  {unifiedComposerHasText ? (
                    <Button
                      data-testid="unified-composer-send"
                      size="sm"
                      className="min-w-[9rem] justify-center"
                      onClick={() => void sendUnifiedComposer()}
                      disabled={unifiedComposerBusy}
                    >
                      {unifiedComposerIntent.submitLabel}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
              <div className="flex flex-wrap items-start gap-3">
                {unifiedComposerAttachments.length > 0 ? (
                  <AttachmentStrip
                    attachments={unifiedComposerAttachments}
                    onRemove={(idx) => {
                      setUnifiedComposerAttachments((prev) => {
                        const target = prev[idx];
                        if (target?.previewUrl) {
                          try {
                            URL.revokeObjectURL(target.previewUrl);
                          } catch {
                            // ignore
                          }
                        }
                        return prev.filter((_, i) => i !== idx);
                      });
                    }}
                    className="ml-auto"
                  />
                ) : null}
              </div>
              {unifiedComposerError ? (
                <div className="text-xs text-[rgb(var(--claw-warning))]">{unifiedComposerError}</div>
              ) : null}
              {unifiedCancelNotice ? (
                <div className="text-xs text-[rgb(var(--claw-muted))]">{unifiedCancelNotice}</div>
              ) : null}
              {readOnly && (
                <span className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add token to manage topics.</span>
              )}
              {normalizedSearch ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[rgb(var(--claw-muted))]">
                  <span>
                    {semanticSearch.loading
                      ? "Finding related topics and messages…"
                      : semanticForQuery
                        ? `Potential matches (${describeSemanticSearchMode(semanticForQuery.mode)})`
                        : semanticSearch.error === "search_timeout"
                          ? "Match search timed out, using local fallback."
                          : semanticSearch.error
                            ? "Match search unavailable, using local fallback."
                            : "Finding matches…"}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3 max-md:space-y-2.5">
        {(() => {
          const topicCards = renderedTopics.map((topic, topicIndex) => {
          const topicId = topic.id;
          const isUnassigned = topicId === "unassigned";
          const taskList = orderedTasksByTopic.get(topicId) ?? [];
          const topicSelectedForSend = selectedComposerTarget?.kind === "topic" && selectedComposerTarget.topic.id === topicId;
          const lastTouchedAt =
            topicLastTouchedAt(
              topic,
              latestTopicTouchById[topicId] ?? logsByTopic.get(topicId)?.[0]?.createdAt
            ) ||
            topic.updatedAt ||
            topic.createdAt;
          const topicNeedsAttention = topicAttentionIds.has(topicId);
          const topicChatAllLogs = topicChatLogsByTopic.get(topicId) ?? [];
          const topicChatVisibleCount = countVisibleChatLogEntries(topicChatAllLogs, showToolCalls);
          const topicKnownChatCount = taskChatCountById[topicId] ?? 0;
          const topicChatEntryCountLabel = formatChatEntryCountLabel(
            showToolCalls && topicKnownChatCount > 0 ? topicKnownChatCount : undefined,
            showToolCalls ? topicChatAllLogs.length : topicChatVisibleCount,
            showToolCalls ? chatCountsHydrated : true
          );
          const topicToolingOrSystemCallCount = countToolingOrSystemChatLogEntries(topicChatAllLogs);
          const topicToolingOrSystemCallCountLabel = formatToolingOrSystemCallCountLabel(topicToolingOrSystemCallCount);
          const topicChatMetricsLabel = `${topicChatEntryCountLabel} · ${topicToolingOrSystemCallCountLabel}`;
          const topicChatBlurb = deriveChatHeaderBlurb(topicChatAllLogs);
          const topicChatKey = chatKeyForTask(topicId);
          const topicChatSessionKey = topicSessionKey(topicId);

          const topicHiddenToolCallCount = hiddenToolCallCountForSession(topicChatSessionKey);
          const topicResponding = isSessionResponding(topicChatSessionKey);
          const normalizedTopicStatus = String(topic.status ?? "active").trim().toLowerCase();
          const topicStatusTone: "muted" | "accent" | "accent2" | "warning" | "success" = topicResponding
            ? "accent"
            : normalizedTopicStatus === "doing"
              ? "accent"
              : normalizedTopicStatus === "blocked"
                ? "warning"
                : normalizedTopicStatus === "done"
                  ? "success"
                  : normalizedTopicStatus === "snoozed" || normalizedTopicStatus === "paused"
                    ? "accent2"
                    : "muted";
          const topicStatusLabel = topicResponding
            ? "Doing"
            : normalizedTopicStatus === "active"
              ? "Active"
              : normalizedTopicStatus === "snoozed" || normalizedTopicStatus === "paused"
                ? "Snoozed"
                : normalizedTopicStatus === "archived"
                  ? "Archived"
                  : STATUS_LABELS[normalizedTopicStatus] ?? (
                      normalizedTopicStatus.charAt(0).toUpperCase() + normalizedTopicStatus.slice(1)
                    );
          const topicMatchesSearch =
            normalizedSearch.length > 0 &&
            matchesSearchText(`${topic.name} ${topic.description ?? ""}`, searchPlan);
          const isExpanded = expandedTopicsSafe.has(topicId);
          const mobileChatTopicId = mobileLayer === "chat" ? mobileChatTarget?.topicId ?? null : null;
          if (!mdUp && mobileLayer === "chat" && mobileChatTopicId && mobileChatTopicId !== topicId) {
            return null;
          }
          const topicColor =
            topicDisplayColors.get(topicId) ??
            normalizeHexColor(topic.color) ??
            colorFromSeed(`topic:${topic.id}:${topic.name}`, TOPIC_FALLBACK_COLORS);
          const limitedTopicLogs = topicChatAllLogs;
          const topicChatTruncated = false;
          const topicSpaceIdList = topicSpaceIds(topic).filter((id) => id !== "space-default");
          const visibleTopicTags = dedupeTagLabels(topic.tags ?? []);
          const primaryTopicSpaceId = (() => {
            const direct = String(topic.spaceId ?? "").trim();
            if (direct && direct !== "space-default") return direct;
            return topicSpaceIdList[0] ?? "";
          })();
          const topicSpaceName = primaryTopicSpaceId
            ? spaceNameById.get(primaryTopicSpaceId) ?? deriveSpaceName(primaryTopicSpaceId)
            : "";
          const topicSwipeOpen = topicSwipeOpenId === topicId;
          const topicNameEditHandlers = buildTopicInlineEditGestureHandlers(topic, topicColor, "name");
          const topicTagsEditHandlers = buildTopicInlineEditGestureHandlers(topic, topicColor, "tags");
          const topicColorEditHandlers = buildTopicInlineEditGestureHandlers(topic, topicColor, "color");


	          const swipeActions = isUnassigned ? (
	            <button
	              type="button"
	              onClick={(event) => {
	                event.stopPropagation();
	                if (readOnly) return;
	                setTopicSwipeOpenId(null);
	                const count = taskList.length;
	                if (count === 0) return;
	                const ok = window.confirm(`Permanently delete all ${count} unassigned topic${count === 1 ? "" : "s"}? This cannot be undone.`);
	                if (!ok) return;
	                void deleteUnassignedTasks();
	              }}
	              disabled={readOnly || taskList.length === 0}
	              className={cn(
	                "inline-flex h-full min-w-[80px] items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] border px-3.5 py-2 text-xs font-semibold leading-none tracking-[0.04em] transition",
	                "border-[rgba(239,68,68,0.6)] text-[rgb(var(--claw-danger))] hover:bg-[rgba(239,68,68,0.12)]",
	                readOnly || taskList.length === 0 ? "opacity-40" : ""
	              )}
	            >
	              EMPTY
	            </button>
	          ) : (
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
		                  return isSnoozed ? "UNSNZE" : "SNOOZE";
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
              ref={(node) => {
                if (node) topicCardRefs.current.set(topicId, node);
                else topicCardRefs.current.delete(topicId);
              }}
              data-topic-card-id={topicId}
              className={cn(
                "relative rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] transition-colors duration-300",
                isExpanded ? "p-0" : "overflow-hidden p-4 md:p-5",
                draggingTopicId && topicDropTargetId === topicId ? "ring-2 ring-[rgba(255,90,45,0.55)]" : "",
                topicSelectedForSend ? "ring-2 ring-[rgba(77,171,158,0.55)]" : ""
              )}
              style={topicGlowStyle(topicColor, topicIndex, isExpanded)}
            >
              <div
                role="button"
                tabIndex={0}
                className={cn(
                  "flex min-h-[92px] flex-col justify-center text-left",
                  isExpanded
                    ? "sticky top-0 z-20 cursor-pointer rounded-t-[var(--radius-lg)] px-4 py-3 md:px-5"
                    : "cursor-pointer"
                )}
                style={isExpanded ? { top: "env(safe-area-inset-top, 0px)", ...stickyTaskHeaderStyle(topicColor, topicIndex) } : undefined}
                onClick={(event) => {
                  if (!allowToggle(event.target as HTMLElement)) return;
                  toggleTopicExpanded(topicId);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  if (!allowToggle(event.target as HTMLElement)) return;
                  event.preventDefault();
                  toggleTopicExpanded(topicId);
                }}
                onDragEnter={(event) => {
                  if (!topicReorderEnabled) return;
                  if (isUnassigned) return;
                  const dragged = draggingTopicId;
                  if (!dragged || dragged === topicId) return;
                  event.preventDefault();
                  setTopicDropTargetId(topicId);
                }}
                onDragOver={(event) => {
                  if (!topicReorderEnabled) return;
                  if (isUnassigned) return;
                  const dragged = draggingTopicId;
                  if (!dragged || dragged === topicId) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  if (!topicReorderEnabled) return;
                  if (isUnassigned) return;
                  event.preventDefault();
                  const dragged = (draggingTopicId ?? event.dataTransfer.getData("text/plain") ?? "").trim();
                  if (!dragged || dragged === topicId) return;
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
	                              : "Clear the composer draft and set Status=All to reorder"
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
	                        style={{ touchAction: "none" }}
	                        className={cn(
	                        "flex h-7 w-7 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] transition",
	                        readOnly || isUnassigned || !topicReorderEnabled
	                          ? "cursor-not-allowed opacity-50"
	                          : "cursor-grab hover:border-[rgba(255,90,45,0.3)] hover:text-[rgb(var(--claw-text))] active:cursor-grabbing"
		                        )}
		                      >
		                        <GripIcon />
		                      </button>
                      <div className="relative shrink-0">
                        <button
                          type="button"
                          data-testid={`topic-color-trigger-${topic.id}`}
                          aria-label={`Change color for ${topic.name}`}
                          title="Double click or long press to change color"
                          className="h-3.5 w-3.5 rounded-full border border-[rgba(255,255,255,0.18)] shadow-[0_0_0_1px_rgba(0,0,0,0.18)]"
                          style={{ backgroundColor: editingTopicId === topic.id ? topicColorDraft : topicColor }}
                          onClick={(event) => event.stopPropagation()}
                          {...topicColorEditHandlers}
                        />
                        {editingTopicId === topic.id &&
                        topicEditMode === "color" &&
                        topicColorMenuPosition &&
                        typeof document !== "undefined"
                          ? createPortal(
                              <div
                                data-topic-color-menu
                                className="fixed z-[1200] rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(12,14,18,0.96)] p-2 shadow-[0_12px_28px_rgba(0,0,0,0.35)]"
                                style={{
                                  top: topicColorMenuPosition.top,
                                  left: topicColorMenuPosition.left,
                                  transform: topicColorMenuPosition.openUp ? "translateY(-100%)" : undefined,
                                }}
                                onClick={(event) => event.stopPropagation()}
                                onKeyDownCapture={(event) => {
                                  if (event.key !== "Escape") return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  cancelTopicEdit(topic, topicColor);
                                }}
                              >
                                <div className="mb-2 grid grid-cols-5 gap-1.5">
                                  {TOPIC_FALLBACK_COLORS.map((candidate) => {
                                    const normalizedCandidate = normalizeHexColor(candidate) ?? candidate;
                                    const selected = normalizeHexColor(topicColorDraft) === normalizedCandidate;
                                    return (
                                      <button
                                        key={`topic-color-swatch-${topic.id}-${normalizedCandidate}`}
                                        type="button"
                                        aria-label={`Use color ${normalizedCandidate}`}
                                        title={normalizedCandidate}
                                        className={cn(
                                          "h-7 w-7 rounded-[6px] border transition",
                                          selected
                                            ? "border-white/70 shadow-[0_0_0_2px_rgba(255,255,255,0.18)]"
                                            : "border-[rgba(255,255,255,0.14)] hover:border-[rgba(255,255,255,0.32)]"
                                        )}
                                        style={{ backgroundColor: normalizedCandidate }}
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          setTopicColorDraft(normalizedCandidate);
                                          void patchTopic(topic.id, { color: normalizedCandidate });
                                          setEditingTopicId(null);
                                          setTopicEditMode("name");
                                          setActiveTopicTagField(null);
                                        }}
                                      />
                                    );
                                  })}
                                </div>
                                <input
                                  data-testid={`rename-topic-color-${topic.id}`}
                                  ref={topicColorInputRef}
                                  type="color"
                                  value={topicColorDraft}
                                  disabled={readOnly}
                                  onChange={(event) => {
                                    const next = normalizeHexColor(event.target.value);
                                    if (!next) return;
                                    setTopicColorDraft(next);
                                    void patchTopic(topic.id, { color: next });
                                    setEditingTopicId(null);
                                    setTopicEditMode("name");
                                    setActiveTopicTagField(null);
                                  }}
                                  className="sr-only"
                                />
                                <button
                                  type="button"
                                  className="inline-flex h-8 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))] transition hover:text-[rgb(var(--claw-text))]"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    topicColorInputRef.current?.click();
                                  }}
                                >
                                  Custom
                                </button>
                              </div>,
                              document.body
                            )
                          : null}
                      </div>
			                    {editingTopicId === topic.id && topicEditMode === "name" ? (
	                          <Input
                            data-testid={`rename-topic-input-${topic.id}`}
                            ref={topicNameInputRef}
                            value={topicNameDraft}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => setTopicNameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                cancelTopicEdit(topic, topicColor);
                                return;
                              }
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              event.stopPropagation();
                              void saveTopicRename(topic);
                            }}
                            placeholder="Rename topic"
                            className="h-10 w-[min(28rem,calc(100vw-6rem))] max-w-full text-base font-semibold md:h-9 md:text-lg"
                          />
                        ) : (
                      <>
                        <h2
                          className="truncate text-base font-semibold md:text-lg"
                          title={topic.name}
                          {...topicNameEditHandlers}
                        >
                          {topic.name}
                        </h2>
                        {showSendTargetButtons && !topicSwipeOpen ? (
                          <Button
                            type="button"
                            size="sm"
                            variant={topicSelectedForSend ? "secondary" : "ghost"}
                            data-testid={`select-topic-target-${topic.id}`}
                            className={cn("h-7 px-2 text-[11px]", topicSelectedForSend ? "border-[rgba(77,171,158,0.55)]" : "")}
                            onClick={(event) => {
                              event.stopPropagation();
                              setComposerTarget({ kind: "topic", topicId: topic.id });
                            }}
                          >
                            {topicSelectedForSend ? "Topic selected" : "Continue here"}
                          </Button>
                        ) : null}
                      </>
                    )}
                  </div>
                  {renameErrors[`topic:${topic.id}`] && (
                    <p className="mt-1 text-xs text-[rgb(var(--claw-warning))]">{renameErrors[`topic:${topic.id}`]}</p>
                  )}
                  <div
                    className={cn(
                      "mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-[rgb(var(--claw-muted))] sm:text-xs",
                      topicSwipeOpen ? "opacity-0 pointer-events-none" : ""
                    )}
                  >
                    {editingTopicId === topic.id && topicEditMode === "tags" ? (
                      <div
                        className="relative"
                        onKeyDownCapture={(event) => {
                          if (event.key !== "Escape") return;
                          event.preventDefault();
                          event.stopPropagation();
                          cancelTopicEdit(topic, topicColor);
                        }}
                      >
                        <Input
                          data-testid={`rename-topic-tags-${topic.id}`}
                          ref={topicTagsInputRef}
                          value={topicTagsDraft}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            setTopicTagsDraft(nextValue);
                            setTopicTagsPendingEntry(isTagDraftPending(nextValue));
                            setTopicRenameActiveSuggestionIndex(0);
                          }}
                          onFocus={() => setActiveTopicTagField("rename-topic")}
                          onBlur={() =>
                            setActiveTopicTagField((current) => (current === "rename-topic" ? null : current))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "ArrowDown" && topicRenameTagSuggestions.length > 0) {
                              event.preventDefault();
                              event.stopPropagation();
                              setTopicRenameActiveSuggestionIndex((prev) => (prev + 1) % topicRenameTagSuggestions.length);
                              return;
                            }
                            if (event.key === "ArrowUp" && topicRenameTagSuggestions.length > 0) {
                              event.preventDefault();
                              event.stopPropagation();
                              setTopicRenameActiveSuggestionIndex((prev) =>
                                prev <= 0 ? topicRenameTagSuggestions.length - 1 : prev - 1
                              );
                              return;
                            }
                            if ((event.key === "Enter" || event.key === "Tab") && topicRenameTagMenuOpen) {
                              const suggestion =
                                topicRenameTagSuggestions[topicRenameActiveSuggestionIndex] ?? topicRenameTagSuggestions[0];
                              if (suggestion) {
                                event.preventDefault();
                                event.stopPropagation();
                                applyTopicRenameTagSuggestion(suggestion);
                                return;
                              }
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              cancelTopicEdit(topic, topicColor);
                              return;
                            }
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            event.stopPropagation();
                            if (topicTagsPendingEntry) {
                              commitPendingTopicTagDraft();
                              return;
                            }
                            void saveTopicRename(topic);
                          }}
                          role="combobox"
                          aria-haspopup="listbox"
                          aria-autocomplete="list"
                          aria-expanded={topicRenameTagMenuOpen}
                          aria-controls={topicRenameTagMenuOpen ? topicRenameTagListboxId : undefined}
                          aria-activedescendant={
                            topicRenameTagMenuOpen
                              ? `${topicRenameTagListboxId}-option-${topicRenameActiveSuggestionIndex}`
                              : undefined
                          }
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          enterKeyHint="done"
                          placeholder="Tags (comma separated)"
                          className="h-10 w-[min(28rem,calc(100vw-6rem))] max-w-full md:h-9 md:w-[260px]"
                        />
                        {topicRenameTagMenuOpen ? (
                          <div
                            id={topicRenameTagListboxId}
                            role="listbox"
                            aria-label="Topic tag suggestions"
                            className="absolute left-0 top-full z-40 mt-1.5 max-h-56 w-full overflow-auto rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel))] p-1 shadow-[0_10px_24px_rgba(0,0,0,0.35)]"
                          >
                            {topicRenameTagSuggestions.map((suggestion, index) => (
                              <button
                                id={`${topicRenameTagListboxId}-option-${index}`}
                                key={`rename-topic-tag-${suggestion}`}
                                type="button"
                                role="option"
                                aria-selected={index === topicRenameActiveSuggestionIndex}
                                className={cn(
                                  "flex min-h-11 w-full items-center rounded-[var(--radius-xs)] px-3 py-2 text-left text-sm text-[rgb(var(--claw-text))] transition md:min-h-9 md:px-2 md:py-1.5 md:text-xs",
                                  index === topicRenameActiveSuggestionIndex
                                    ? "bg-[rgb(var(--claw-panel-2))] text-[rgb(var(--claw-text))]"
                                    : "hover:bg-[rgb(var(--claw-panel-2))]"
                                )}
                                onMouseEnter={() => setTopicRenameActiveSuggestionIndex(index)}
                                onPointerDown={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  applyTopicRenameTagSuggestion(suggestion);
                                }}
                              >
                                <span className="truncate">{suggestion}</span>
                                <span className="ml-auto pl-3 text-[10px] uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))] md:text-[9px]">
                                  Match
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        {(visibleTopicTags.length > 0 ? visibleTopicTags : [""]).map((tag, tagIndex) => (
                          <span
                            key={`topic-tag-${topic.id}-${tag || "empty"}-${tagIndex}`}
                            className={cn(
                              "inline-flex min-h-6 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-[0.08em] transition",
                              tag
                                ? "border-[rgba(148,163,184,0.22)] bg-[rgba(148,163,184,0.07)] text-[rgb(var(--claw-muted))]"
                                : "border-[rgba(148,163,184,0.14)] bg-[rgba(148,163,184,0.03)] text-[rgba(148,163,184,0.55)]"
                            )}
                            title={tag ? "Double click to edit tags" : "Double click to add tags"}
                            {...topicTagsEditHandlers}
                          >
                            {tag || "\u00A0"}
                          </span>
                        ))}
                      </>
                    )}
	                    <span>{topicChatMetricsLabel}</span>
                    {lastTouchedAt ? <span>Last touch {formatRelativeTime(lastTouchedAt)}</span> : null}
		                    {topicNeedsAttention ? (
		                      <span
                          title="Topic needs a look"
                          className="inline-flex min-w-[1.45rem] items-center justify-center rounded-full border border-[rgba(255,90,45,0.42)] bg-[rgba(255,90,45,0.16)] px-1.5 py-0.5 text-[10px] font-semibold text-[rgb(var(--claw-text))]"
                        >
                          1
                        </span>
		                    ) : null}
		                  </div>
                  <div
                    className={cn(
                      "mt-2 flex flex-wrap items-center justify-between gap-2",
                      topicSwipeOpen ? "opacity-0 pointer-events-none" : ""
                    )}
                  >
                    {!(editingTopicId === topic.id && topicEditMode === "name") && topicChatBlurb ? (
                      <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-[rgba(var(--claw-muted),0.9)]">
                        <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">
                          Topic chat
                        </span>
                        {topicResponding ? <TypingDots /> : null}
                        <span className="text-[rgba(var(--claw-muted),0.55)]">·</span>
                        <div className="min-w-0 max-w-[52ch] overflow-x-auto whitespace-nowrap claw-scrollbar-none" title={topicChatBlurb.full}>
                          {topicChatBlurb.clipped}
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {!isExpanded && topicResponding ? (
                          <span title="OpenClaw responding" className="inline-flex items-center">
                            <TypingDots />
                          </span>
                        ) : null}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <div className="relative" data-topic-status-menu>
                        <button
                          type="button"
                          data-testid={`topic-status-trigger-${topic.id}`}
                          disabled={readOnly}
                          aria-haspopup="menu"
                          aria-expanded={statusMenuTopicId === topic.id}
                          title={readOnly ? "Read only" : "Change status"}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (readOnly) return;
                            if (statusMenuTopicId === topic.id) {
                              setStatusMenuTopicId(null);
                              setTopicStatusMenuPosition(null);
                              return;
                            }
                            openTopicStatusMenu(topic.id);
                          }}
                          onKeyDown={(event) => {
                            if (readOnly) return;
                            if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            event.stopPropagation();
                            openTopicStatusMenu(topic.id);
                            window.requestAnimationFrame(() => {
                              const first = document.querySelector<HTMLElement>(
                                `[data-testid='topic-status-option-${topic.id}-0']`
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
                          <StatusPill tone={topicStatusTone} label={topicStatusLabel} />
                        </button>
                        {statusMenuTopicId === topic.id && !readOnly && topicStatusMenuPosition && typeof document !== "undefined"
                          ? createPortal(
                              <div
                                role="menu"
                                data-topic-status-menu
                                data-testid={`topic-status-menu-${topic.id}`}
                                className="fixed z-[1200] min-w-[170px] rounded-xl border border-[rgba(148,163,184,0.28)] bg-[rgba(16,19,24,0.96)] p-1.5 shadow-[0_14px_35px_rgba(0,0,0,0.4)] backdrop-blur"
                                style={{
                                  top: topicStatusMenuPosition.top,
                                  left: topicStatusMenuPosition.left,
                                  transform: topicStatusMenuPosition.openUp ? "translateY(-100%)" : undefined,
                                }}
                                onClick={(event) => event.stopPropagation()}
                              >
                                {TASK_STATUS_OPTIONS.filter((status) => status !== normalizedTopicStatus).map((status, index, all) => (
                                  <button
                                    key={status}
                                    type="button"
                                    role="menuitem"
                                    data-testid={`topic-status-option-${topic.id}-${index}`}
                                    onClick={() => {
                                      setStatusMenuTopicId(null);
                                      setTopicStatusMenuPosition(null);
                                      void patchTopic(topic.id, { status, snoozedUntil: status === "active" ? null : topic.snoozedUntil ?? null });
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === "Escape") {
                                        event.preventDefault();
                                        setStatusMenuTopicId(null);
                                        setTopicStatusMenuPosition(null);
                                        const trigger = document.querySelector<HTMLElement>(
                                          `[data-testid='topic-status-trigger-${topic.id}']`
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
                                        `[data-testid='topic-status-option-${topic.id}-${nextIndex}']`
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
                        aria-label={isExpanded ? `Collapse topic ${topic.name}` : `Expand topic ${topic.name}`}
                        title={isExpanded ? "Collapse" : "Expand"}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleTopicExpanded(topicId);
                        }}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-base text-[rgb(var(--claw-muted))] transition",
                          "hover:border-[rgba(77,171,158,0.45)] hover:text-[rgb(var(--claw-text))]"
                        )}
                      >
                        {isExpanded ? "▾" : "▸"}
                      </button>
                    </div>
                  </div>
	                </div>
		              </div>
	
		              {isExpanded && (
		                <div
                      data-testid={`topic-expanded-body-${topicId}`}
	                      className="space-y-3 px-4 pb-4 max-md:pb-2 md:px-5 md:pb-5"
	                    >
                      {!isUnassigned ? (
                        <div
                          ref={(node) => {
                            if (node) taskChatShellRefs.current.set(topicId, node);
                            else taskChatShellRefs.current.delete(topicId);
                          }}
                          data-testid={`topic-chat-shell-${topicId}`}
                          className="pt-1"
                        >
                          <div className="mb-2 flex flex-nowrap items-center justify-end gap-2">
                            <span
                              data-testid={`topic-chat-entries-${topic.id}`}
                              className="shrink-0 whitespace-nowrap text-xs text-[rgb(var(--claw-muted))]"
                            >
                              {topicChatMetricsLabel}
                            </span>
                          </div>
                          {topicChatAllLogs.length === 0 &&
                          findPendingMessagesBySession(topicChatSessionKey).length === 0 &&
                          !isSessionResponding(topicChatSessionKey) ? (
                            <p className="mb-3 text-sm text-[rgb(var(--claw-muted))]">No messages yet.</p>
                          ) : null}
                          <div className="relative">
                            {chatJumpToBottom[topicChatKey] ? (
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
                                  activeChatAtBottomRef.current = true;
                                  scheduleScrollChatToBottom(topicChatKey);
                                }}
                                aria-label="Jump to latest messages"
                                title="Jump to latest"
                              >
                                Jump to latest ↓
                              </button>
                            ) : null}
                            <div
                              data-testid={`topic-chat-scroll-${topic.id}`}
                              ref={getChatScrollerRef(topicChatKey)}
                              onScroll={(event) => {
                                const key = topicChatKey;
                                const node = event.currentTarget;
                                const showTop = node.scrollTop > 2;
                                if (topicChatTruncated && node.scrollTop <= 24) {
                                  loadOlderChat(topicChatKey, 1, topicChatAllLogs, TASK_TIMELINE_LIMIT);
                                }
                                const remaining = node.scrollHeight - (node.scrollTop + node.clientHeight);
                                const atBottom = remaining <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
                                chatAtBottomRef.current.set(key, atBottom);

                                const prevTop = chatLastScrollTopRef.current.get(key) ?? node.scrollTop;
                                const delta = node.scrollTop - prevTop;
                                chatLastScrollTopRef.current.set(key, node.scrollTop);
                                const shouldShowJump = !atBottom && delta > 0;
                                setChatJumpToBottom((prev) =>
                                  prev[key] === shouldShowJump ? prev : { ...prev, [key]: shouldShowJump }
                                );
                                setChatTopFade((prev) =>
                                  prev[key] === showTop ? prev : { ...prev, [key]: showTop }
                                );
                                if (activeChatKeyRef.current === key) updateActiveChatAtBottom();
                              }}
                              className="overflow-y-auto"
                              style={{
                                maxHeight: "max(240px, calc(100dvh - var(--claw-header-h, 0px) - 270px))",
                                ...chatTopMaskStyle(Boolean(chatTopFade[topicChatKey])),
                              }}
                            >
                              <LogList
                                logs={limitedTopicLogs}
                                topics={topics}
                                scopeTopicId={topicId}
                                showFilters={false}
                                showRawToggle={false}
                                showDensityToggle={false}
                                showRawAll={showRaw}
                                messageDensity={messageDensity}
                                metaDefaultCollapsed={true}
                                metaExpandEpoch={chatMetaExpandEpoch}
                                metaCollapseEpoch={chatMetaCollapseEpoch}
                                variant="chat"
                                hideToolCallsInChat={!showToolCalls}
                                enableNavigation={false}
                              />
                              {pendingMessages
                                .filter(
                                  (pending) =>
                                    normalizeBoardSessionKey(pending.sessionKey) === normalizeBoardSessionKey(topicChatSessionKey)
                                )
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
                                          <Markdown highlightCommands={true}>{pending.message}</Markdown>
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
                                                ? sseConnected ? "Delivered" : "Delivered · reconnecting"
                                                : pending.error
                                                  ? pending.error
                                                  : "Failed to send."}
                                          </span>
                                          {pending.debugHint ? (
                                            <span className="ml-2 text-[10px] text-[rgba(148,163,184,0.65)]">
                                              {pending.debugHint}
                                            </span>
                                          ) : null}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              {isSessionResponding(topicChatSessionKey) ? (
                                <div className="py-1">
                                  <div className="flex justify-start">
                                    <div className="w-full max-w-[78%] px-4 py-2" title="OpenClaw responding">
                                      <TypingDots />
                                      {topicHiddenToolCallCount > 0 ? (
                                        <span
                                          data-testid={`topic-chat-hidden-tool-count-${topic.id}`}
                                          className="ml-2 text-[11px] uppercase tracking-[0.16em] text-[rgba(148,163,184,0.9)]"
                                        >
                                          {topicHiddenToolCallCount} hidden tool{topicHiddenToolCallCount === 1 ? " call" : " calls"}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>
                              ) : null}
                              <div aria-hidden className="h-12" />
                            </div>
                          </div>
                          <BoardChatComposer
                            ref={(node) => {
                              if (node) composerHandlesRef.current.set(topicChatSessionKey, node);
                              else composerHandlesRef.current.delete(topicChatSessionKey);
                            }}
                            sessionKey={topicChatSessionKey}
                            spaceId={selectedSpaceId || undefined}
                            className={
                              activeComposer?.taskId === topicId || autoFocusTask?.taskId === topicId
                                ? "sticky bottom-0 z-20 mt-3 pb-2 pt-3"
                                : "mt-4"
                            }
                            variant="seamless"
                            placeholder={`Message ${topic.name}…`}
                            onFocus={() => {
                              setActiveComposer({ kind: "task", topicId, taskId: topicId });
                              activeChatAtBottomRef.current = true;
                              scheduleScrollChatToBottom(topicChatKey);
                              setChatJumpToBottom((prev) =>
                                prev[topicChatKey] === false ? prev : { ...prev, [topicChatKey]: false }
                              );
                            }}
                            autoFocus={autoFocusTask?.topicId === topicId && autoFocusTask?.taskId === topicId}
                            onAutoFocusApplied={() =>
                              setAutoFocusTask((prev) =>
                                prev?.topicId === topicId && prev?.taskId === topicId ? null : prev
                              )
                            }
                            onSendUpdate={handleComposerSendUpdate}
                            waiting={isSessionResponding(topicChatSessionKey)}
                            waitingRequestId={requestIdForSession(topicChatSessionKey)}
                            onCancel={() => {
                              setAwaitingAssistant((prev) => {
                                if (!Object.prototype.hasOwnProperty.call(prev, topicChatSessionKey)) return prev;
                                const next = { ...prev };
                                delete next[topicChatSessionKey];
                                return next;
                              });
                            }}
                            testId={`topic-chat-composer-${topic.id}`}
                          />
                        </div>
                      ) : null}
                      {taskList
	                    .filter((task) => {
	                      if (!matchesStatusFilter(task)) return false;
	                      if (!normalizedSearch) return true;
	                      if (topicMatchesSearch) return true;
	                      return matchesTaskSearch(task);
	                    })
	                    .map((task, taskIndex) => {
                      const mobileTaskId = mobileChatTarget?.taskId ?? "";
                      if (
                        !mdUp &&
                        mobileLayer === "chat" &&
                        mobileTaskId &&
                        mobileTaskId !== task.id
                      ) {
                        return null;
                      }
	                      const taskChatFullscreen =
	                        !mdUp &&
	                        mobileLayer === "chat" &&
                        mobileTaskId === task.id;
                      const taskExpanded =
                        !(!mdUp && mobileForcedCollapsedTaskIds.has(task.id)) &&
                        (taskChatFullscreen || expandedTasksSafe.has(task.id));
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
	                              setSnoozeTarget({ kind: "task", topicId, taskId: task.id, label: task.title ?? task.name });
	                            }}
	                            disabled={readOnly}
	                            className={cn(
	                              "inline-flex h-full min-w-[80px] items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] border px-3.5 py-2 text-xs font-semibold leading-none tracking-[0.04em] transition",
	                              "border-[rgba(77,171,158,0.55)] text-[rgb(var(--claw-accent-2))] hover:bg-[rgba(77,171,158,0.14)]",
                              readOnly ? "opacity-60" : ""
                            )}
                          >
	                            {taskIsSnoozed ? "UNSNZE" : "SNOOZE"}
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
                              const ok = window.confirm(`Delete \"${task.title}\"? This cannot be undone.`);
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
                      const taskChatAllLogs = taskChatLogsByTask.get(task.id) ?? [];
                      const taskChatVisibleCount = countVisibleChatLogEntries(taskChatAllLogs, showToolCalls);
                      const taskChatEntryCountLabel = formatChatEntryCountLabel(
                        showToolCalls ? taskChatCountById[task.id] : undefined,
                        showToolCalls ? taskChatAllLogs.length : taskChatVisibleCount,
                        showToolCalls ? chatCountsHydrated : true
                      );
                      const taskToolingOrSystemCallCount = countToolingOrSystemChatLogEntries(taskChatAllLogs);
                      const taskToolingOrSystemCallCountLabel = formatToolingOrSystemCallCountLabel(taskToolingOrSystemCallCount);
                      const taskChatMetricsLabel = `${taskChatEntryCountLabel} · ${taskToolingOrSystemCallCountLabel}`;
                      const taskChatBlurb = deriveChatHeaderBlurb(taskChatAllLogs);
                      const taskChatSessionKey = taskSessionKey(topicId, task.id);
                      const taskWorkspaceAttention = deriveTaskWorkspaceAttention(
                        taskChatAllLogs,
                        workspaceByAgentId,
                        taskChatSessionKey,
                        workspaceAttentionSeenByKey
                      );
                      const taskWorkspacePathLabel = taskWorkspaceAttention
                        ? workspaceDirDisplay(taskWorkspaceAttention.workspace.workspaceDir)
                        : "";
	                      const taskChatKey = chatKeyForTask(task.id);
                      const taskHiddenToolCallCount = hiddenToolCallCountForSession(taskChatSessionKey);
                      const taskSelectedForSend = topicSelectedForSend;
                      const limitedLogs = taskChatAllLogs;
                      const truncated = false;
	                      return (
                          <SwipeRevealRow
                            key={task.id}
                            rowId={task.id}
                            openId={taskSwipeOpenId}
                            setOpenId={setTaskSwipeOpenId}
                            actions={taskSwipeActions}
                            anchorLabel={task.title}
                            disabled={!mdUp && mobileLayer === "chat"}
                          >
		                        <div
                              data-task-card-id={task.id}
		                          className={cn(
		                            "border border-[rgb(var(--claw-border))] p-4 transition-colors duration-300 md:p-5",
                                taskChatFullscreen
                                  ? "fixed inset-0 z-[1400] m-0 flex h-[var(--claw-mobile-vh)] flex-col overflow-hidden rounded-none border-0 bg-[rgb(10,12,16)] p-0"
                                  : "relative rounded-[var(--radius-lg)]",
		                            draggingTopicId && topicDropTargetId === topicId ? "border-[rgba(77,171,158,0.55)]" : "",
                                statusMenuTaskId === task.id ? "z-40" : "",
                                taskSelectedForSend ? "ring-2 ring-[rgba(77,171,158,0.55)]" : ""
		                          )}
		                          style={taskChatFullscreen ? mobileOverlaySurfaceStyle(taskColor) : topicGlowStyle(topicColor, topicIndex, taskExpanded)}
		                        >
                          <div
                            role="button"
                            tabIndex={0}
                            className={cn(
                              "flex items-start justify-between gap-2.5 text-left",
                              taskChatFullscreen ? "hidden" : "",
                              editingTaskId === task.id ? "flex-wrap" : "flex-nowrap",
                              taskExpanded && !taskChatFullscreen
                                ? "sticky z-20 -mx-3.5 -mt-3.5 min-h-[76px] rounded-t-[calc(var(--radius-md)-1px)] px-3.5 py-2 sm:-mx-4 sm:-mt-4 sm:px-4"
                                : ""
                            )}
                            style={
                              taskExpanded && !taskChatFullscreen
                                ? { top: 0, ...stickyTaskHeaderStyle(taskColor, taskIndex) }
                                : undefined
                            }
                            onClick={(event) => {
                              if (!allowToggle(event.target as HTMLElement)) return;
                              toggleTaskExpanded(topicId, task.id);
                            }}
		                            onDragEnter={(event) => {
		                              if (!topicReorderEnabled) return;
		                              if (isUnassigned) return;
		                              const dragged = draggingTopicId;
		                              if (!dragged || dragged === topicId) return;
	                              event.preventDefault();
	                              setTopicDropTargetId(topicId);
	                            }}
	                            onDragOver={(event) => {
	                              if (!topicReorderEnabled) return;
	                              if (isUnassigned) return;
	                              const dragged = draggingTopicId;
	                              if (!dragged || dragged === topicId) return;
	                              event.preventDefault();
	                              event.dataTransfer.dropEffect = "move";
	                            }}
	                            onDrop={(event) => {
	                              if (!topicReorderEnabled) return;
	                              if (isUnassigned) return;
	                              event.preventDefault();
	                              const dragged = (draggingTopicId ?? event.dataTransfer.getData("text/plain") ?? "").trim();
	                              if (!dragged || dragged === topicId) return;
	                              const order = orderedTopics.filter((item) => item.id !== "unassigned").map((item) => item.id);
	                              const from = order.indexOf(dragged);
	                              const to = order.indexOf(topicId);
	                              const next = moveInArray(order, from, to);
	                              setDraggingTopicId(null);
	                              setTopicDropTargetId(null);
	                              void persistTopicOrder(next);
	                            }}
	                            aria-expanded={taskExpanded}
	                          >
		                          <div className="min-w-0">
			                            <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
		                              <button
		                                type="button"
		                                data-testid={`reorder-topic-${topicId}`}
		                                aria-label="Reorder topic"
                                    data-no-swipe="true"
		                                title={
		                                  isUnassigned
		                                    ? "Unassigned is a virtual bucket."
		                                    : readOnly
		                                      ? "Read-only mode. Add token in Setup to reorder."
		                                      : topicReorderEnabled
		                                        ? "Drag to reorder"
		                                        : "Clear the composer draft and set Status=All to reorder"
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
		                                style={{ touchAction: "none" }}
		                                className={cn(
		                                  "flex h-7 w-7 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] transition",
		                                  readOnly || isUnassigned || !topicReorderEnabled
		                                    ? "cursor-not-allowed opacity-50"
		                                    : "cursor-grab hover:border-[rgba(77,171,158,0.4)] hover:text-[rgb(var(--claw-text))] active:cursor-grabbing"
		                                )}
		                              >
		                                <GripIcon />
		                              </button>
		                              {editingTaskId === task.id ? (
		                                <div
                                    className="flex flex-wrap items-center gap-2"
                                    onKeyDownCapture={(event) => {
                                      if (event.key !== "Escape") return;
                                      event.preventDefault();
                                      event.stopPropagation();
                                      cancelTaskEdit(task, taskColor);
                                    }}
                                  >
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
                                    }}
		                                    placeholder="Rename topic"
		                                    className="h-9 w-[280px] max-w-[68vw]"
		                                  />
                                  <div className="relative">
		                                    <Input
                                      data-testid={`rename-task-tags-${task.id}`}
		                                      value={taskTagsDraft}
		                                      onClick={(event) => event.stopPropagation()}
		                                      onChange={(event) => {
                                        const nextValue = event.target.value;
                                        setTaskTagsDraft(nextValue);
                                        setTaskTagsPendingEntry(isTagDraftPending(nextValue));
                                        setTaskRenameActiveSuggestionIndex(0);
                                      }}
                                      onFocus={() => setActiveTaskTagField("rename-task")}
                                      onBlur={() =>
                                        setActiveTaskTagField((current) => (current === "rename-task" ? null : current))
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === "ArrowDown" && taskRenameTagSuggestions.length > 0) {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          setTaskRenameActiveSuggestionIndex((prev) => (prev + 1) % taskRenameTagSuggestions.length);
                                          return;
                                        }
                                        if (event.key === "ArrowUp" && taskRenameTagSuggestions.length > 0) {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          setTaskRenameActiveSuggestionIndex((prev) =>
                                            prev <= 0 ? taskRenameTagSuggestions.length - 1 : prev - 1
                                          );
                                          return;
                                        }
                                        if ((event.key === "Enter" || event.key === "Tab") && taskRenameTagMenuOpen) {
                                          const suggestion =
                                            taskRenameTagSuggestions[taskRenameActiveSuggestionIndex] ?? taskRenameTagSuggestions[0];
                                          if (suggestion) {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            applyTaskRenameTagSuggestion(suggestion);
                                            return;
                                          }
                                        }
                                        if (event.key === "Escape") {
                                          setActiveTaskTagField(null);
                                          setTaskRenameActiveSuggestionIndex(0);
                                          return;
                                        }
                                        if (event.key !== "Enter") return;
                                        event.preventDefault();
                                        event.stopPropagation();
                                        if (taskTagsPendingEntry) {
                                          commitPendingTaskTagDraft();
                                          return;
                                        }
                                        void saveTaskRename(task);
                                      }}
                                      role="combobox"
                                      aria-haspopup="listbox"
                                      aria-autocomplete="list"
                                      aria-expanded={taskRenameTagMenuOpen}
                                      aria-controls={taskRenameTagMenuOpen ? taskRenameTagListboxId : undefined}
                                      aria-activedescendant={
                                        taskRenameTagMenuOpen
                                          ? `${taskRenameTagListboxId}-option-${taskRenameActiveSuggestionIndex}`
                                          : undefined
                                      }
                                      autoCapitalize="none"
                                      autoCorrect="off"
                                      spellCheck={false}
                                      enterKeyHint="done"
		                                      placeholder="Tags (comma separated)"
		                                      className="h-11 w-[min(28rem,calc(100vw-4rem))] max-w-full md:h-9 md:w-[240px]"
		                                    />
                                    {taskRenameTagMenuOpen ? (
                                      <div
                                        id={taskRenameTagListboxId}
                                        role="listbox"
                                        aria-label="Topic tag suggestions"
                                        className="absolute left-0 top-full z-40 mt-1.5 max-h-56 w-full overflow-auto rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel))] p-1 shadow-[0_10px_24px_rgba(0,0,0,0.35)]"
                                      >
                                        {taskRenameTagSuggestions.map((suggestion, index) => (
                                          <button
                                            id={`${taskRenameTagListboxId}-option-${index}`}
                                            key={`rename-task-tag-${suggestion}`}
                                            type="button"
                                            role="option"
                                            aria-selected={index === taskRenameActiveSuggestionIndex}
                                            className={cn(
                                              "flex min-h-11 w-full items-center rounded-[var(--radius-xs)] px-3 py-2 text-left text-sm text-[rgb(var(--claw-text))] transition md:min-h-9 md:px-2 md:py-1.5 md:text-xs",
                                              index === taskRenameActiveSuggestionIndex
                                                ? "bg-[rgb(var(--claw-panel-2))] text-[rgb(var(--claw-text))]"
                                                : "hover:bg-[rgb(var(--claw-panel-2))]"
                                            )}
                                            onMouseEnter={() => setTaskRenameActiveSuggestionIndex(index)}
                                            onPointerDown={(event) => {
                                              event.preventDefault();
                                              event.stopPropagation();
                                              applyTaskRenameTagSuggestion(suggestion);
                                            }}
                                          >
                                            <span className="truncate">{suggestion}</span>
                                            <span className="ml-auto pl-3 text-[10px] uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))] md:text-[9px]">
                                              Match
                                            </span>
                                          </button>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
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
                                        {!task.topicId ? (
                                          <option value="">Unassigned (Recycle Bin)</option>
                                        ) : null}
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
		                                      cancelTaskEdit(task, taskColor);
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
                                  {showSendTargetButtons ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant={taskSelectedForSend ? "secondary" : "ghost"}
                                      data-testid={`select-task-target-${task.id}`}
                                      className={cn("h-7 px-2 text-[11px]", taskSelectedForSend ? "border-[rgba(77,171,158,0.55)]" : "")}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setComposerTarget({ kind: "topic", topicId });
                                      }}
                                    >
                                      {taskSelectedForSend ? "Topic selected" : "Use topic"}
                                    </Button>
                                  ) : null}
                                  <button
                                    type="button"
                                    data-testid={`rename-task-${task.id}`}
                                    aria-label={`Rename topic ${task.title}`}
                                    title={readOnly ? "Read-only mode. Add token in Setup to rename." : "Rename topic"}
                                    disabled={readOnly}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (readOnly) return;
                                      setEditingTopicId(null);
                                      setTopicNameDraft("");
                                      setTopicColorDraft(TOPIC_FALLBACK_COLORS[0]);
                                      setEditingTaskId(task.id);
                                      setTaskNameDraft(task.title ?? task.name);
                                      setTaskColorDraft(taskColor);
                                      setTaskTagsDraft(formatTags(task.tags));
                                      setTaskTagsPendingEntry(false);
                                      setMoveTaskId(null);
                                      setDeleteArmedKey(null);
                                      setRenameError(`task:${task.id}`);
                                    }}
                                    className={cn(
                                      "hidden md:flex h-7 w-7 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] transition",
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
                            </div>
	                            {renameErrors[`task:${task.id}`] && (
	                              <div className="mt-1 text-xs text-[rgb(var(--claw-warning))]">{renameErrors[`task:${task.id}`]}</div>
	                            )}
                            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-[rgb(var(--claw-muted))] sm:text-xs">
                              {topicSpaceName ? (
                                <span
                                  className="inline-flex items-center rounded-full border border-[rgba(148,163,184,0.22)] bg-[rgba(148,163,184,0.07)] px-2 py-0.5 text-[10px] font-medium tracking-[0.08em] text-[rgb(var(--claw-muted))]"
                                >
                                  {topicSpaceName}
                                </span>
                              ) : null}
                              <span>{taskChatMetricsLabel}</span>
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
	                            {isTaskResponding(task) ? (
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
                                  <StatusPill
                                    tone={STATUS_TONE[taskVisualStatus(task) ?? "active"]}
                                    label={STATUS_LABELS[taskVisualStatus(task) ?? "active"] ?? taskVisualStatus(task) ?? "active"}
                                  />
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
                              ref={(node) => {
                                if (node) taskChatShellRefs.current.set(task.id, node);
                                else taskChatShellRefs.current.delete(task.id);
                              }}
                              className={cn(
                                "mt-2.5 pt-2",
                                taskChatFullscreen
                                  ? "mt-0 flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none px-4"
                                  : ""
                              )}
                              style={
                                taskChatFullscreen
                                  ? {
                                      ...mobileOverlaySurfaceStyle(taskColor),
                                      paddingTop: "calc(env(safe-area-inset-top) + 2.7rem)",
                                      paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)",
                                    }
                                  : undefined
                              }
                            >
                              {taskChatFullscreen ? (
                                <div
                                  className="absolute left-3 z-20 flex items-center gap-2"
                                  style={{ top: "calc(env(safe-area-inset-top) + 0.5rem)" }}
                                >
                                  <button
                                    type="button"
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border text-base text-[rgb(var(--claw-text))] backdrop-blur"
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
                                  {!readOnly ? (
                                    <button
                                      type="button"
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border text-[rgb(var(--claw-text))] backdrop-blur"
                                      style={mobileOverlayCloseButtonStyle(taskColor)}
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        closeMobileChatLayer();
                                        setEditingTopicId(null);
                                        setTopicNameDraft("");
                                        setTopicColorDraft(TOPIC_FALLBACK_COLORS[0]);
                                        setEditingTaskId(task.id);
                                        setTaskNameDraft(task.title ?? task.name);
                                        setTaskColorDraft(taskColor);
                                        setTaskTagsDraft(formatTags(task.tags));
                                        setTaskTagsPendingEntry(false);
                                        setMoveTaskId(null);
                                        setDeleteArmedKey(null);
                                        setRenameError(`task:${task.id}`);
                                      }}
                                      aria-label="Edit task"
                                      title="Edit task"
                                    >
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                        <path d="M12 20h9" />
                                        <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                                      </svg>
                                    </button>
                                  ) : null}
                                </div>
                              ) : null}
						                              <div
                                        className={cn(
                                          taskChatFullscreen
                                            ? "mb-2 space-y-1"
                                            : "mb-2.5 flex items-start justify-between gap-2"
                                        )}
                                      >
                                        {taskChatFullscreen ? (
                                          <div className="flex min-w-0 items-start justify-between gap-2">
                                            <div data-testid={`task-chat-context-${task.id}`} className="min-w-0 flex-1 pr-2">
                                              <div className="flex min-w-0 items-center gap-1.5">
                                                <div className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">
                                                  CHAT
                                                </div>
                                                {isTaskResponding(task) ? <TypingDots /> : null}
                                              </div>
                                              <nav
                                                aria-label="Topic chat context"
                                                data-testid={`task-chat-breadcrumb-${task.id}`}
                                                className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-[11px] text-[rgb(var(--claw-muted))]"
                                              >
                                                <span className="shrink-0 uppercase tracking-[0.14em]">Topic</span>
                                                <span className="inline-flex max-w-full overflow-x-auto whitespace-nowrap claw-scrollbar-none font-medium text-[rgb(var(--claw-text))]">
                                                  {topic.name}
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
                                          <div className="flex min-w-0 flex-1 items-center gap-2">
                                            <div className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">
                                              TASK CHAT
                                            </div>
                                            {isTaskResponding(task) ? <TypingDots /> : null}
                                            {taskChatBlurb ? (
                                              <>
                                                <span className="text-xs text-[rgba(var(--claw-muted),0.55)]">·</span>
                                                <div
                                                  className="min-w-0 max-w-[56ch] overflow-x-auto whitespace-nowrap claw-scrollbar-none text-xs text-[rgba(var(--claw-muted),0.9)]"
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
                                            taskChatFullscreen ? "w-full justify-end" : "ml-auto shrink-0 justify-end"
                                          )}
                                        >
                                          <div className="flex flex-nowrap items-center justify-end gap-2">
                                            <span
                                              data-testid={`task-chat-entries-${task.id}`}
                                              className="shrink-0 whitespace-nowrap text-xs text-[rgb(var(--claw-muted))]"
                                            >
                                              {taskChatMetricsLabel}
                                            </span>
                                            {truncated ? (
                                              <Button
                                                size="sm"
                                                variant="secondary"
                                                onClick={() =>
                                                  loadOlderChat(taskChatKey, 1, taskChatAllLogs, TASK_TIMELINE_LIMIT)
                                                }
                                                className="order-last shrink-0 whitespace-nowrap"
                                              >
                                                Load older
                                              </Button>
                                            ) : null}
                                          </div>
                                        </div>
                                      </div>
                              {taskWorkspaceAttention ? (
                                <div
                                  className={cn(
                                    "mb-2 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-xs",
                                    "border-[rgba(77,171,158,0.28)] bg-[rgba(16,27,26,0.42)]"
                                  )}
                                >
                                  <div className="min-w-0">
                                    <div className="text-[10px] uppercase tracking-[0.16em] text-[rgb(var(--claw-accent-2))]">
                                      {taskWorkspaceAttention.hint}
                                    </div>
                                    <div
                                      className="overflow-x-auto whitespace-nowrap claw-scrollbar-none text-[rgb(var(--claw-muted))]"
                                      title={taskWorkspaceAttention.workspace.workspaceDir}
                                    >
                                      {taskWorkspacePathLabel}
                                    </div>
                                  </div>
                                  <Link
                                    href={workspaceRoute(taskWorkspaceAttention.agentId)}
                                    data-testid={`task-chat-workspace-link-${task.id}`}
                                    onClick={() => markWorkspaceAttentionSeen(taskWorkspaceAttention)}
                                    className="inline-flex h-8 shrink-0 items-center justify-center rounded-full border border-[rgba(77,171,158,0.35)] bg-[rgba(77,171,158,0.14)] px-3 text-[11px] font-semibold text-[rgb(var(--claw-text))] transition hover:border-[rgba(255,90,45,0.35)] hover:text-[rgb(var(--claw-text))]"
                                  >
                                    {taskWorkspaceAttention.label}
                                  </Link>
                                </div>
                              ) : null}
                              {taskChatAllLogs.length === 0 &&
                              findPendingMessagesBySession(taskSessionKey(topicId, task.id)).length === 0 &&
                              !isTaskResponding(task) ? (
		                                <p className="mb-3 text-sm text-[rgb(var(--claw-muted))]">No messages yet.</p>
		                              ) : null}
	                                <div className={cn("relative", taskChatFullscreen ? "min-h-0 flex flex-1 flex-col" : "")}>
	                                  {chatJumpToBottom[taskChatKey] ? (
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
	                                        activeChatAtBottomRef.current = true;
	                                        scheduleScrollChatToBottom(taskChatKey);
	                                      }}
	                                      aria-label="Jump to latest messages"
	                                      title="Jump to latest"
	                                    >
	                                      Jump to latest ↓
	                                    </button>
	                                  ) : null}
		                                  <div
		                                    data-testid={`task-chat-scroll-${task.id}`}
		                                    ref={getChatScrollerRef(taskChatKey)}
		                                    onScroll={(event) => {
		                                      const key = taskChatKey;
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
	                                        ? chatTopMaskStyle(Boolean(chatTopFade[taskChatKey]))
	                                        : {
	                                            // Keep the composer visible while allowing long conversations to scroll within the chat pane.
	                                            maxHeight: "max(240px, calc(100dvh - var(--claw-header-h, 0px) - 300px))",
                                              ...chatTopMaskStyle(Boolean(chatTopFade[taskChatKey])),
	                                          }
	                                    }
	                                  >
                                    <LogList
                                      logs={limitedLogs}
                                      topics={topics}
                                      scopeTopicId={topicId}
                                      scopeTaskId={task.id}
                                      showFilters={false}
                                      showRawToggle={false}
                                      showDensityToggle={false}
                                      showRawAll={showRaw}
                                      messageDensity={messageDensity}
                                      metaDefaultCollapsed={true}
                                      metaExpandEpoch={chatMetaExpandEpoch}
                                      metaCollapseEpoch={chatMetaCollapseEpoch}
	                                      variant="chat"
                                      hideToolCallsInChat={!showToolCalls}
	                                      enableNavigation={false}
	                                    />
                                      {!isUnassigned
                                        ? pendingMessages
                                            .filter((pending) => normalizeBoardSessionKey(pending.sessionKey) === normalizeBoardSessionKey(taskSessionKey(topicId, task.id)))
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
                                                      <Markdown highlightCommands={true}>{
                                                        pending.message
                                                      }</Markdown>
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
                                                            ? sseConnected ? "Delivered" : "Delivered · reconnecting"
                                                            : pending.error
                                                              ? pending.error
                                                              : "Failed to send."}
                                                      </span>
                                                      {pending.debugHint ? (
                                                        <span className="ml-2 text-[10px] text-[rgba(148,163,184,0.65)]">
                                                          {pending.debugHint}
                                                        </span>
                                                      ) : null}
                                                    </div>
                                                  </div>
                                                </div>
                                              </div>
                                            ))
                                        : null}
                                      {!isUnassigned && isSessionResponding(taskChatSessionKey) ? (
                                        <div className="py-1">
                                          <div className="flex justify-start">
                                            <div className="w-full max-w-[78%] px-4 py-2" title="OpenClaw responding">
                                              <TypingDots />
                                              {taskHiddenToolCallCount > 0 ? (
                                                <span
                                                  data-testid={`task-chat-hidden-tool-count-${task.id}`}
                                                  className="ml-2 text-[11px] uppercase tracking-[0.16em] text-[rgba(148,163,184,0.9)]"
                                                >
                                                  {taskHiddenToolCallCount} hidden tool{taskHiddenToolCallCount === 1 ? " call" : " calls"}
                                                </span>
                                              ) : null}
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
					                                <BoardChatComposer
	                                      ref={(node) => {
	                                        const key = taskSessionKey(topicId, task.id);
	                                        if (node) composerHandlesRef.current.set(key, node);
			                                  else composerHandlesRef.current.delete(key);
			                                }}
			                                  sessionKey={taskSessionKey(topicId, task.id)}
			                                  spaceId={selectedSpaceId || undefined}
			                                  className={cn(
                                        activeComposer?.taskId === task.id || autoFocusTask?.taskId === task.id
                                          ? taskChatFullscreen
                                            ? "sticky bottom-0 z-20 -mx-4 mt-0 shrink-0 border-t border-[rgba(255,255,255,0.08)] bg-[linear-gradient(to_top,rgba(11,13,18,0.98),rgba(11,13,18,0.9)_72%,rgba(11,13,18,0.42))] px-4 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 backdrop-blur"
                                            : "sticky bottom-0 z-20 -mx-2 mt-3 border-t border-[rgba(255,255,255,0.08)] bg-[linear-gradient(to_top,rgba(11,13,18,0.98),rgba(11,13,18,0.92)_72%,rgba(11,13,18,0.36))] px-2 pb-2 pt-3 backdrop-blur"
                                          : "mt-4",
                                        taskChatFullscreen && !(activeComposer?.taskId === task.id || autoFocusTask?.taskId === task.id)
                                          ? "max-md:mt-0.5 max-md:shrink-0 max-md:border-t max-md:border-[rgba(255,255,255,0.08)] max-md:bg-[rgba(11,13,18,0.86)] max-md:px-1 max-md:pb-0 max-md:pt-1 max-md:backdrop-blur"
                                          : ""
                                      )}
			                                  variant="seamless"
			                                  dense={taskChatFullscreen}
			                                  placeholder={`Message ${task.title}…`}
			                                  onFocus={() => {
			                                    setActiveComposer({ kind: "task", topicId, taskId: task.id });
			                                    if (!taskChatFullscreen) {
			                                      activeChatAtBottomRef.current = true;
			                                      scheduleScrollChatToBottom(taskChatKey);
			                                      setChatJumpToBottom((prev) =>
			                                        prev[taskChatKey] === false ? prev : { ...prev, [taskChatKey]: false }
			                                      );
			                                    }
			                                  }}
			                                  autoFocus={autoFocusTask?.topicId === topicId && autoFocusTask?.taskId === task.id}
			                                  onAutoFocusApplied={() =>
			                                    setAutoFocusTask((prev) =>
			                                      prev?.topicId === topicId && prev?.taskId === task.id ? null : prev
			                                    )
			                                  }
			                                  onSendUpdate={handleComposerSendUpdate}
			                                  waiting={isTaskResponding(task)}
			                                  waitingRequestId={requestIdForSession(taskSessionKey(topicId, task.id))}
			                                  onCancel={() => {
			                                    const sk = taskSessionKey(topicId, task.id);
			                                    setAwaitingAssistant((prev) => {
			                                      if (!Object.prototype.hasOwnProperty.call(prev, sk)) return prev;
			                                      const next = { ...prev };
			                                      delete next[sk];
			                                      return next;
			                                    });
			                                  }}
			                                  testId={`task-chat-composer-${task.id}`}
				                                />
					                              )}
				                          </div>
				                        )}
				                      </div>
				                          </SwipeRevealRow>
				                    );
				                    })}
			                  {/* Intentionally omit "No tasks match your filters." to keep topic cards visually tight. */}

                </div>
	              )}
	            </div>
	          );

          return (
            <SwipeRevealRow
              key={topicId}
              rowId={topicId}
              openId={topicSwipeOpenId}
              setOpenId={setTopicSwipeOpenId}
              actions={swipeActions}
              anchorLabel={topic.name}
              disabled={!mdUp && mobileLayer === "chat"}
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

      {renderedTopics.length > 0 ? (
        <div
          className="pointer-events-none fixed inset-x-0 z-30 flex justify-center px-4"
          style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <div className="pointer-events-auto">
            <ColorShuffleTrigger
              topics={topics}
              visibleTopicIds={orderedTopics.map((topic) => topic.id)}
              onTopicsUpdate={setTopics}
              token={token}
            />
          </div>
        </div>
      ) : null}

      <SnoozeModal
        open={Boolean(snoozeTarget)}
        title="Snooze topic"
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
