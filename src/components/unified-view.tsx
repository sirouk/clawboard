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
import type { LogEntry, Space, Task, Topic } from "@/lib/types";
import { Button, Input, Select, StatusPill, TextArea } from "@/components/ui";
import { LogList } from "@/components/log-list";
import { formatRelativeTime } from "@/lib/format";
import { useAppConfig } from "@/components/providers";
import { PinToggleGeneric } from "@/components/pin-toggle-generic";

import { decodeSlugId, encodeTaskSlug, encodeTopicSlug, slugify } from "@/lib/slug";
import { cn } from "@/lib/cn";
import { apiFetch } from "@/lib/api";
import { useDataStore } from "@/components/data-provider";
import { useSemanticSearch } from "@/lib/use-semantic-search";
import { mergeLogs } from "@/lib/live-utils";
import {
  BoardChatComposer,
  type BoardChatComposerHandle,
  type BoardChatComposerSendEvent,
} from "@/components/board-chat-composer";
import {
  BOARD_TASK_SESSION_PREFIX,
  BOARD_TOPIC_SESSION_PREFIX,
  normalizeBoardSessionKey,
  taskSessionKey,
  topicSessionKey,
} from "@/lib/board-session";
import {
  chatKeyForTask,
  chatKeyForTopic,
} from "@/lib/attention-state";
import { Markdown } from "@/components/markdown";
import { AttachmentStrip, type AttachmentLike } from "@/components/attachments";
import { queueDraftUpsert, readBestDraftValue, usePersistentDraft } from "@/lib/drafts";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";
import { randomId } from "@/lib/id";
import { buildSpaceVisibilityRevision, resolveSpaceVisibilityFromViewer } from "@/lib/space-visibility";
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
const FILTERS_DRAWER_OPEN_KEY = "clawboard.unified.filtersDrawerOpen";
const FILTERS_DRAWER_OPEN_DEFAULT = false;
const ACTIVE_SPACE_KEY = "clawboard.space.active";
const BOARD_LAST_URL_KEY = "clawboard.board.lastUrl";

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
const TOPIC_TIMELINE_LIMIT = 4;
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
  | { kind: "topic"; topicId: string }
  | { kind: "task"; topicId: string; taskId: string };
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

type LogChatCountsPayload = {
  topicChatCounts?: Record<string, number>;
  taskChatCounts?: Record<string, number>;
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
    const boardTaskId = String(source.boardScopeTaskId ?? entry.taskId ?? "").trim();
    if (boardTopicId && boardTaskId) {
      next.sessionKeys.add(taskSessionKey(boardTopicId, boardTaskId));
    }
    if (boardTopicId) {
      next.sessionKeys.add(topicSessionKey(boardTopicId));
    }

    const requestId = normalizeOpenClawRequestId(source.requestId ?? source.messageId);
    if (requestId) next.requestId = requestId;

    next.status = inferOrchestrationRunStatus(entry, source, next.status);
    const stamp = String(entry.updatedAt ?? entry.createdAt ?? "").trim();
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

function friendlyTagDraftLabel(value: string) {
  const raw = String(value ?? "");
  const trailingSeparator = /[-\s]+$/.test(raw);
  const friendly = friendlyTagLabel(raw);
  if (!friendly) return "";
  return trailingSeparator ? `${friendly} ` : friendly;
}

function normalizeTagDraftInput(text: string) {
  const raw = String(text ?? "");
  const trailingComma = /,\s*$/.test(raw);
  const parts = raw.split(",");
  return parts
    .map((part, index) => {
      const isLast = index === parts.length - 1;
      const isActiveQuery = isLast && !trailingComma;
      return isActiveQuery ? friendlyTagDraftLabel(part) : friendlyTagLabel(part);
    })
    .join(", ");
}

function parseTags(text: string) {
  return text
    .split(",")
    .map((t) => normalizeTagValue(t))
    .filter(Boolean)
    .slice(0, 32);
}

function formatTags(tags: string[] | undefined | null) {
  const list = (tags ?? []).map((t) => friendlyTagLabel(String(t || ""))).filter(Boolean);
  return list.join(", ");
}

function splitTagDraft(text: string) {
  const raw = String(text ?? "");
  const trailingComma = /,\s*$/.test(raw);
  const parts = raw.split(",");
  const committedRaw = trailingComma ? parts : parts.slice(0, -1);
  const committed = committedRaw.map((part) => normalizeTagValue(part)).filter(Boolean);
  const queryRaw = trailingComma ? "" : parts[parts.length - 1] ?? "";
  const query = normalizeTagValue(queryRaw);
  return { committed, query };
}

function applyTagSuggestionToDraft(text: string, suggestion: string) {
  const { committed } = splitTagDraft(text);
  const deduped = new Set<string>(committed);
  deduped.add(suggestion);
  const next = Array.from(deduped).slice(0, 32).map((entry) => friendlyTagLabel(entry)).filter(Boolean);
  return next.length > 0 ? `${next.join(", ")}, ` : "";
}

function commitTagDraftEntry(text: string) {
  const { committed, query } = splitTagDraft(text);
  const deduped = new Set<string>(committed);
  if (query) deduped.add(query);
  const next = Array.from(deduped).slice(0, 32).map((entry) => friendlyTagLabel(entry)).filter(Boolean);
  return next.length > 0 ? `${next.join(", ")}, ` : "";
}

function tagSuggestionsForDraft(text: string, options: string[]) {
  const { committed, query } = splitTagDraft(text);
  if (!query) return [] as string[];
  const committedSet = new Set(committed);
  return options
    .filter((candidate) => !committedSet.has(candidate) && candidate.includes(query))
    .map((candidate) => {
      const exact = candidate === query ? 0 : 1;
      const prefix = candidate.startsWith(query) ? 0 : 1;
      return { candidate, exact, prefix, length: candidate.length };
    })
    .sort((a, b) => a.exact - b.exact || a.prefix - b.prefix || a.length - b.length || a.candidate.localeCompare(b.candidate))
    .map((item) => item.candidate)
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

const UNIFIED_TOPIC_TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "hey",
  "help",
  "i",
  "in",
  "is",
  "just",
  "message",
  "need",
  "of",
  "on",
  "or",
  "please",
  "the",
  "to",
  "vs",
  "with",
]);

function titleCaseToken(token: string, forceCapitalize: boolean) {
  const trimmed = token.trim();
  if (!trimmed) return "";
  if (/^[A-Z0-9]{2,}$/.test(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (!forceCapitalize && UNIFIED_TOPIC_TITLE_STOPWORDS.has(lower)) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function deriveUnifiedTopicNameFromMessage(message: string) {
  const normalized = stripTransportNoise(String(message ?? "")).replace(/\s+/g, " ").trim();
  if (!normalized) return "Untitled Topic";

  const sentence = normalized
    .split(/[\n.!?]+/)
    .map((part) => part.trim())
    .find(Boolean) ?? normalized;
  const cleaned = sentence.replace(/^[\-*#>\d\.\)\(\[\]\s]+/, "").trim();
  const rawTerms = cleaned
    .split(/\s+/)
    .map((term) => term.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "").trim())
    .filter(Boolean);
  if (rawTerms.length === 0) return "Untitled Topic";

  const uniqueTerms: string[] = [];
  const seenTerms = new Set<string>();
  for (const term of rawTerms) {
    const key = term.toLowerCase();
    if (!key || seenTerms.has(key)) continue;
    seenTerms.add(key);
    uniqueTerms.push(term);
    if (uniqueTerms.length >= 12) break;
  }
  if (uniqueTerms.length === 0) return "Untitled Topic";

  const keywordTerms = uniqueTerms.filter((term) => !UNIFIED_TOPIC_TITLE_STOPWORDS.has(term.toLowerCase()));
  const terms = (keywordTerms.length > 0 ? keywordTerms : uniqueTerms).slice(0, 6);

  const titled = terms
    .map((token, idx) => titleCaseToken(token, idx === 0 || idx === terms.length - 1))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!titled) return "Untitled Topic";
  if (titled.length <= 56) return titled;
  return `${titled.slice(0, 53).trimEnd()}...`;
}

function spaceTagFromSelection(spaceId: string | null | undefined, spaces: Pick<Space, "id" | "name">[]) {
  const normalizedId = String(spaceId ?? "").trim();
  if (!normalizedId || normalizedId === "space-default") return null;
  const selected = spaces.find((space) => String(space.id ?? "").trim() === normalizedId) ?? null;
  const fromName = normalizeTagValue(selected?.name ?? "");
  if (fromName && spaceIdFromTagLabel(fromName) === normalizedId) return fromName;
  const fromId = normalizeTagValue(normalizedId.replace(/^space[-_]+/i, "") || normalizedId);
  if (fromId && spaceIdFromTagLabel(fromId) === normalizedId) return fromId;
  return fromName || fromId || null;
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

const CHAT_TOOLING_LOG_TYPES = new Set(["action", "system", "import"]);

function isToolingOrSystemChatLog(entry: LogEntry) {
  const type = String(entry.type ?? "").trim().toLowerCase();
  if (CHAT_TOOLING_LOG_TYPES.has(type)) return true;
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  return agentId === "system";
}

function isAgentConversationChatLog(entry: LogEntry) {
  if (String(entry.type ?? "").trim().toLowerCase() !== "conversation") return false;
  const agentId = String(entry.agentId ?? "").trim().toLowerCase();
  return Boolean(agentId) && agentId !== "user" && agentId !== "system";
}

function countVisibleChatLogEntries(entries: LogEntry[], showToolCalls: boolean) {
  if (showToolCalls) return entries.length;
  let count = 0;
  for (const entry of entries) {
    if (!isToolingOrSystemChatLog(entry)) count += 1;
  }
  return count;
}

function countToolingOrSystemChatLogEntries(entries: LogEntry[]) {
  let count = 0;
  for (const entry of entries) {
    if (isToolingOrSystemChatLog(entry)) count += 1;
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
    if (isToolingOrSystemChatLog(entry)) hiddenToolCount += 1;
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
    const score =
      minPrimary * 4.6 +
      avgPrimary * 1.2 +
      minSecondary * 0.9 +
      vibrancy * 0.8 -
      usagePenalty * 1.7 +
      jitter;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
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

// Sticky section-header backgrounds.
// A 155deg diagonal layer replicates the card's own gradient at the card-matching alpha so the
// top blends seamlessly with the card body behind it.  A vertical dark-bottom overlay (using a
// wide transparent band) then darkens only the lower edge, creating a crisp separator between
// the pinned title row and the content scrolling beneath — without overpowering the top colour.
function stickyTopicHeaderStyle(color: string, index: number): CSSProperties {
  const band = index % 2 === 0;
  // Mirror topicGlowStyle expanded alpha values exactly so the header reads as part of the card.
  const topAlpha = band ? 0.25 : 0.19;
  const lowAlpha = band ? 0.13 : 0.09;
  return {
    background: [
      // Dark-bottom overlay: stay transparent for the top ~55% so the card colour shows through.
      `linear-gradient(to bottom, transparent 55%, rgba(12,14,18,0.96) 100%)`,
      // Card gradient replica — same angle and stops as topicGlowStyle.
      `linear-gradient(155deg, ${rgba(color, topAlpha)}, rgba(16,19,24,0.90) 48%, ${rgba(color, lowAlpha)})`,
    ].join(", "),
  };
}

function stickyTaskHeaderStyle(color: string, index: number): CSSProperties {
  const band = index % 2 === 0;
  // Mirror taskGlowStyle expanded alpha values.
  const topAlpha = band ? 0.27 : 0.20;
  const lowAlpha = band ? 0.14 : 0.10;
  return {
    background: [
      `linear-gradient(to bottom, transparent 55%, rgba(12,14,18,0.96) 100%)`,
      `linear-gradient(145deg, ${rgba(color, topAlpha)}, rgba(20,24,31,0.86) 52%, ${rgba(color, lowAlpha)})`,
    ].join(", "),
    borderColor: rgba(color, 0.3),
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

function sortBySeed<T>(values: T[], seed: string, key: (value: T) => string) {
  return [...values].sort((a, b) => {
    const aKey = key(a);
    const bKey = key(b);
    const aHash = hashString(`${seed}:${aKey}`);
    const bHash = hashString(`${seed}:${bKey}`);
    if (aHash !== bHash) return aHash - bHash;
    return aKey.localeCompare(bKey);
  });
}

export function ColorShuffleTrigger({ 
  topics, 
  tasks, 
  onTopicsUpdate, 
  onTasksUpdate,
  token
}: { 
  topics: Topic[]; 
  tasks: Task[]; 
  onTopicsUpdate: (topics: Topic[]) => void;
  onTasksUpdate: (tasks: Task[]) => void;
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
      const topicRecent: string[] = [];
      const topicColorsBySpace = new Map<string, string[]>();

      const registerTopicColor = (topic: Topic, rawColor: string) => {
        const color = normalizeHexColor(rawColor) ?? "#4EA1FF";
        topicColorById.set(topic.id, color);
        topicUsage.set(color, (topicUsage.get(color) ?? 0) + 1);
        for (const scopeKey of topicColorScopeKeys(topic)) {
          const existing = topicColorsBySpace.get(scopeKey) ?? [];
          existing.push(color);
          topicColorsBySpace.set(scopeKey, existing);
        }
        topicRecent.push(color);
        if (topicRecent.length > 20) topicRecent.shift();
      };

      const topicOrder = sortBySeed(topics, `${runSeed}:topics`, (topic) => topic.id);
      for (const topic of topicOrder) {
        const scopeKeys = topicColorScopeKeys(topic);
        const sameSpaceColors = Array.from(
          new Set(scopeKeys.flatMap((scopeKey) => topicColorsBySpace.get(scopeKey) ?? []))
        );
        const color = pickVibrantDistinctColor({
          palette: TOPIC_FALLBACK_COLORS,
          seed: `${runSeed}:topic:${topic.id}:${topic.name}`,
          primaryAvoid: sameSpaceColors,
          secondaryAvoid: topicRecent,
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

      const taskUsage = new Map<string, number>();
      const taskRecent: string[] = [];
      const taskColorsByTopic = new Map<string, string[]>();
      const taskColorById = new Map<string, string>();

      const registerTaskColor = (task: Task, rawColor: string) => {
        const color = normalizeHexColor(rawColor) ?? "#4EA1FF";
        taskColorById.set(task.id, color);
        taskUsage.set(color, (taskUsage.get(color) ?? 0) + 1);
        const topicKey = (task.topicId ?? "").trim() || "__unassigned__";
        const existing = taskColorsByTopic.get(topicKey) ?? [];
        existing.push(color);
        taskColorsByTopic.set(topicKey, existing);
        taskRecent.push(color);
        if (taskRecent.length > 24) taskRecent.shift();
      };

      const taskOrder = sortBySeed(tasks, `${runSeed}:tasks`, (task) => task.id);
      for (const task of taskOrder) {
        const topicKey = (task.topicId ?? "").trim() || "__unassigned__";
        const topicColor = task.topicId ? topicColorById.get(task.topicId) ?? null : null;
        const siblingColors = taskColorsByTopic.get(topicKey) ?? [];
        const primaryAvoid = topicColor ? [topicColor, ...siblingColors] : [...siblingColors];
        const secondaryAvoid = topicColor ? [topicColor, ...taskRecent] : taskRecent;
        const color = pickVibrantDistinctColor({
          palette: TASK_FALLBACK_COLORS,
          seed: `${runSeed}:task:${task.id}:${task.title}:${topicKey}`,
          primaryAvoid,
          secondaryAvoid,
          usageCount: taskUsage,
        });
        registerTaskColor(task, color);
      }

      const nextTasks = tasks.map((task) => {
        const color = taskColorById.get(task.id) ?? normalizeHexColor(task.color) ?? "#4EA1FF";
        return { ...task, color };
      });

      for (const task of nextTasks) {
        await apiFetch(
          `/api/tasks/${encodeURIComponent(task.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ color: task.color }),
          },
          token
        );
      }
      onTasksUpdate(nextTasks);
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

export function UnifiedView({ basePath = "/u" }: { basePath?: string } = {}) {
  const { token, tokenRequired } = useAppConfig();
  const {
    spaces: storeSpaces,
    topics: storeTopics,
    topicTags: storeTopicTags,
    tasks: storeTasks,
    logs: storeLogs,
    drafts,
    openclawTyping,
    openclawThreadWork,
    hydrated,
    setTopics,
    setTasks,
    setLogs,
    unsnoozedTopicBadges,
    unsnoozedTaskBadges,
    markChatSeen: markChatSeenInStore,
    dismissUnsnoozedTopicBadge,
    dismissUnsnoozedTaskBadge,
  } = useDataStore();
  const readOnly = tokenRequired && !token;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const scrollMemory = useRef<Record<string, number>>({});
  const restoreScrollOnNextSyncRef = useRef(false);
  const skipNextUrlSyncUrlRef = useRef<string | null>(null);
  const [initialUrlState] = useState(() => getInitialUnifiedUrlState(basePath));
  const twoColumn = useLocalStorageItem("clawboard.unified.twoColumn") !== "false";
  const filtersDrawerOpenStored = useLocalStorageItem(FILTERS_DRAWER_OPEN_KEY);
  const filtersDrawerOpen =
    filtersDrawerOpenStored === null ? FILTERS_DRAWER_OPEN_DEFAULT : filtersDrawerOpenStored === "true";
  const storedTopicView = (useLocalStorageItem(TOPIC_VIEW_KEY) ?? "").trim().toLowerCase();
  const topicView: TopicView = isTopicView(storedTopicView) ? storedTopicView : "active";
  const showSnoozedTasks = useLocalStorageItem(SHOW_SNOOZED_TASKS_KEY) === "true";
  const activeSpaceIdStored = (useLocalStorageItem(ACTIVE_SPACE_KEY) ?? "").trim();
  // Must start false to match SSR output. useEffect syncs the real value post-hydration,
  // preventing the server/client HTML mismatch that causes a hydration error.
  const [mdUp, setMdUp] = useState(false);
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
  const [showRaw, setShowRaw] = useState(initialUrlState.raw);
  const [messageDensity, setMessageDensity] = useState<MessageDensity>(initialUrlState.density);
  const [showToolCalls, setShowToolCalls] = useState(initialUrlState.showToolCalls);
  const [search, setSearch] = useState(initialUrlState.search);
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
  useEffect(() => {
    if (filtersDrawerOpenStored !== null) return;
    setLocalStorageItem(FILTERS_DRAWER_OPEN_KEY, FILTERS_DRAWER_OPEN_DEFAULT ? "true" : "false");
  }, [filtersDrawerOpenStored]);
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

  const spaceFromUrl = useMemo(() => (searchParams.get("space") ?? "").trim(), [searchParams]);
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

  const allowedSpaceSet = useMemo(() => new Set(allowedSpaceIds), [allowedSpaceIds]);

  const storeTopicById = useMemo(() => new Map(storeTopics.map((topic) => [topic.id, topic])), [storeTopics]);

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

  const logs = storeLogs;
  const [topicChatCountById, setTopicChatCountById] = useState<Record<string, number>>({});
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
      setTopicChatCountById(normalizeCountMap(payload?.topicChatCounts));
      setTaskChatCountById(normalizeCountMap(payload?.taskChatCounts));
      setChatCountsHydrated(true);
    } catch {
      // Best-effort: keep existing counts when aggregate endpoint is unavailable.
    }
  }, [selectedSpaceId, token]);

  useEffect(() => {
    setChatCountsHydrated(false);
    setTopicChatCountById({});
    setTaskChatCountById({});
  }, [selectedSpaceId]);

  useEffect(() => {
    if (!hydrated) return;
    void refreshChatCounts();
  }, [hydrated, refreshChatCounts]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      void refreshChatCounts();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [hydrated, logChangeFingerprint, refreshChatCounts]);

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
    if (!(pathname === basePath || pathname.startsWith(`${basePath}/`))) return;
    const next = `${window.location.pathname}${window.location.search}`;
    if (!next.startsWith("/u")) return;
    setLocalStorageItem(BOARD_LAST_URL_KEY, next);
  }, [basePath, pathname, searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") return;
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
  }, [activeSpaceIdStored, pathname, selectedSpaceId, spaceFromUrl]);

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
  const { value: unifiedComposerDraft, setValue: setUnifiedComposerDraft } = usePersistentDraft("draft:unified:composer", {
    fallback: "",
  });
  const [unifiedComposerAttachments, setUnifiedComposerAttachments] = useState<UnifiedComposerAttachment[]>([]);
  const [unifiedComposerBusy, setUnifiedComposerBusy] = useState(false);
  const [unifiedComposerError, setUnifiedComposerError] = useState<string | null>(null);
  const [unifiedCancelNotice, setUnifiedCancelNotice] = useState<string | null>(null);
  const [composerTarget, setComposerTarget] = useState<UnifiedComposerTarget | null>(null);
  const unifiedComposerFileRef = useRef<HTMLInputElement | null>(null);
  const unifiedComposerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const unifiedComposerAttachmentsRef = useRef<UnifiedComposerAttachment[]>([]);
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
    const minH = mdUp ? 44 : 36;
    const nextHeight = Math.min(Math.max(el.scrollHeight, minH), UNIFIED_COMPOSER_MAX_HEIGHT_PX);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > UNIFIED_COMPOSER_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [unifiedComposerDraft, mdUp]);

  useEffect(() => {
    if (!composerTarget) return;
    if (composerTarget.kind === "task") {
      const exists = tasks.some((task) => task.id === composerTarget.taskId && task.topicId === composerTarget.topicId);
      if (!exists) setComposerTarget(null);
      return;
    }
    const exists = topics.some((topic) => topic.id === composerTarget.topicId);
    if (!exists) setComposerTarget(null);
  }, [composerTarget, tasks, topics]);

  const knownTopicTagOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const tag of storeTopicTags ?? []) {
      const normalized = normalizeTagValue(String(tag ?? ""));
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [storeTopicTags]);
  const [taskNameDraft, setTaskNameDraft] = useState("");
  const [taskColorDraft, setTaskColorDraft] = useState("#4EA1FF");
  const [taskTagsDraft, setTaskTagsDraft] = useState("");
  const topicRenameTagSuggestions = useMemo(
    () => tagSuggestionsForDraft(topicTagsDraft, knownTopicTagOptions),
    [knownTopicTagOptions, topicTagsDraft]
  );
  const [activeTopicTagField, setActiveTopicTagField] = useState<"new-topic" | "rename-topic" | null>(null);
  const [renameSavingKey, setRenameSavingKey] = useState<string | null>(null);
  const [deleteArmedKey, setDeleteArmedKey] = useState<string | null>(null);
  const [deleteInFlightKey, setDeleteInFlightKey] = useState<string | null>(null);
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});
  const [page, setPage] = useState(initialUrlState.page);
  const [isSticky, setIsSticky] = useState(false);
  const stickyBarRef = useRef<HTMLDivElement>(null);
  const [stickyBarHeight, setStickyBarHeight] = useState(0);
  const committedSearch = useRef(initialUrlState.search);
  const [topicBumpAt, setTopicBumpAt] = useState<Record<string, number>>({});
  const [taskBumpAt, setTaskBumpAt] = useState<Record<string, number>>({});
  const bumpTimers = useRef<Map<string, number>>(new Map());
  const mobileDoneCollapseTaskIdRef = useRef<string | null>(null);
  const patchedTopicColorsRef = useRef<Set<string>>(new Set());
  const patchedTaskColorsRef = useRef<Set<string>>(new Set());
  const [activeComposer, setActiveComposer] = useState<
    | { kind: "topic"; topicId: string }
    | { kind: "task"; topicId: string; taskId: string }
    | null
  >(null);
  const [autoFocusTask, setAutoFocusTask] = useState<{ topicId: string; taskId: string } | null>(null);
  const [autoFocusTopicId, setAutoFocusTopicId] = useState<string | null>(null);
  const [chatMetaExpandEpoch, setChatMetaExpandEpoch] = useState(0);
  const [chatMetaCollapseEpoch, setChatMetaCollapseEpoch] = useState(1);
  const prevTaskByLogId = useRef<Map<string, string | null>>(new Map());
  const activeChatKeyRef = useRef<string | null>(null);
  const activeChatAtBottomRef = useRef(true);
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
  const topicLogHydratedRef = useRef<Set<string>>(new Set());
  const topicLogHydratingRef = useRef<Set<string>>(new Set());

  const CHAT_AUTO_SCROLL_THRESHOLD_PX = 24;
  const CHAT_STICKY_PIN_INTERVAL_MS = 140;
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

  const computeDefaultChatStart = (logs: LogEntry[] | undefined, initialLimit: number) => {
    const all = logs ?? [];
    if (all.length === 0) return 0;
    const fallback = Math.max(0, all.length - initialLimit);
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const entry = all[i];
      const agentId = String(entry.agentId ?? "")
        .trim()
        .toLowerCase();
      if (agentId !== "user") continue;
      return Math.min(fallback, i);
    }
    return fallback;
  };

  const computeChatStart = useCallback(
    (state: Record<string, number>, key: string, len: number, initialLimit: number, logs?: LogEntry[]) => {
      const maxStart = Math.max(0, len - 1);
      const has = Object.prototype.hasOwnProperty.call(state, key);
      const defaultStart = computeDefaultChatStart(logs, initialLimit);
      const raw = has ? Number(state[key]) : defaultStart;
      const value = Number.isFinite(raw) ? Math.floor(raw) : 0;
      if (has && value <= 0 && len > initialLimit && !chatHistoryLoadedOlderRef.current.has(key)) {
        return clamp(defaultStart, 0, maxStart);
      }
      return clamp(value, 0, maxStart);
    },
    []
  );

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
    [computeChatStart, setChatHistoryStarts]
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

  const isSessionResponding = useCallback(
    (sessionKey: string) => {
      const key = normalizeBoardSessionKey(sessionKey);
      if (!key) return false;
      const nowMs = Date.now();
      const typing = openclawTyping[key];
      const awaiting = effectiveAwaitingAssistant[key];
      const orchestrationWork = orchestrationThreadWorkBySession[key];
      const latestOtherSignalMs = Math.max(
        parseIsoMs(typing?.updatedAt),
        parseIsoMs(awaiting?.sentAt),
        parseIsoMs(orchestrationWork?.updatedAt)
      );
      const directThreadSignal = resolveThreadWorkSignal(openclawThreadWork[key], {
        latestOtherSignalMs,
        nowMs,
      });
      if (directThreadSignal === false) return false;
      if (directThreadSignal === true) return true;
      if (typing?.typing) return true;
      if (Object.prototype.hasOwnProperty.call(effectiveAwaitingAssistant, key)) return true;
      if (orchestrationWork?.active) return true;

      const alias = typingAliasRef.current.get(key);
      if (!alias) return false;
      const sourceKey = alias.sourceSessionKey;
      const sourceTyping = openclawTyping[sourceKey];
      const sourceThreadWork = orchestrationThreadWorkBySession[sourceKey];
      const sourceAwaiting = effectiveAwaitingAssistant[sourceKey];
      const sourceLatestOtherSignalMs = Math.max(
        parseIsoMs(sourceTyping?.updatedAt),
        parseIsoMs(sourceAwaiting?.sentAt),
        parseIsoMs(sourceThreadWork?.updatedAt)
      );
      const sourceDirectThreadSignal = resolveThreadWorkSignal(
        openclawThreadWork[sourceKey],
        {
          latestOtherSignalMs: sourceLatestOtherSignalMs,
          nowMs,
        }
      );
      if (sourceDirectThreadSignal === false) return false;
      const sourceResponding =
        sourceDirectThreadSignal === true ||
        Boolean(sourceTyping?.typing) ||
        Object.prototype.hasOwnProperty.call(effectiveAwaitingAssistant, sourceKey) ||
        Boolean(sourceThreadWork?.active);
      if (sourceResponding) return true;

      // Cleanup only after inactivity. Do not age out while the source session is still responding.
      if (Date.now() - alias.createdAt > OPENCLAW_TYPING_ALIAS_INACTIVE_RETENTION_MS) {
        typingAliasRef.current.delete(key);
      }
      return false;
    },
    [effectiveAwaitingAssistant, openclawTyping, openclawThreadWork, orchestrationThreadWorkBySession]
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
    const el = stickyBarRef.current;
    if (!el) return;
    const update = () => setStickyBarHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
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

  const sessionKeyForChatKey = useCallback(
    (chatKey: string) => {
      const key = String(chatKey ?? "").trim();
      if (!key) return "";
      if (key.startsWith("topic:")) {
        const topicId = key.slice("topic:".length).trim();
        if (!topicId || topicId === "unassigned") return "";
        return topicSessionKey(topicId);
      }
      if (key.startsWith("task:")) {
        const taskId = key.slice("task:".length).trim();
        if (!taskId) return "";
        const topicId = taskTopicById.get(taskId) ?? "";
        if (!topicId || topicId === "unassigned") return "";
        return taskSessionKey(topicId, taskId);
      }
      return "";
    },
    [taskTopicById]
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
    const sorted = [...visibleLogs].sort(compareLogCreatedAtDesc);
    const map = new Map<string, LogEntry[]>();
    for (const entry of sorted) {
      if (!entry.taskId) continue;
      const list = map.get(entry.taskId) ?? [];
      list.push(entry);
      map.set(entry.taskId, list);
    }
    return map;
  }, [visibleLogs]);

  const logsByTopic = useMemo(() => {
    const sorted = [...visibleLogs].sort(compareLogCreatedAtDesc);
    const map = new Map<string, LogEntry[]>();
    for (const entry of sorted) {
      if (!entry.topicId) continue;
      const list = map.get(entry.topicId) ?? [];
      list.push(entry);
      map.set(entry.topicId, list);
    }
    return map;
  }, [visibleLogs]);

  // Full logs map (includes pending) used for active Topic/Task chat panes.
  const logsByTaskAll = useMemo(() => {
    const eligible = showRaw ? logs : logs.filter((entry) => !isCronEventLog(entry));
    const sorted = [...eligible].sort(compareLogCreatedAtAsc);
    const map = new Map<string, LogEntry[]>();
    for (const entry of sorted) {
      if (!entry.taskId) continue;
      const list = map.get(entry.taskId) ?? [];
      list.push(entry);
      map.set(entry.taskId, list);
    }
    return map;
  }, [logs, showRaw]);

  const logsByTopicAll = useMemo(() => {
    const eligible = showRaw ? logs : logs.filter((entry) => !isCronEventLog(entry));
    const sorted = [...eligible].sort(compareLogCreatedAtAsc);
    const map = new Map<string, LogEntry[]>();
    for (const entry of sorted) {
      if (!entry.topicId) continue;
      const list = map.get(entry.topicId) ?? [];
      list.push(entry);
      map.set(entry.topicId, list);
    }
    return map;
  }, [logs, showRaw]);

  const topicRootLogsByTopic = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const [topicId, rows] of logsByTopicAll.entries()) {
      map.set(topicId, rows.filter((entry) => !entry.taskId));
    }
    return map;
  }, [logsByTopicAll]);

  const markVisibleChatSeen = useCallback(
    (chatKey: string) => {
      const key = String(chatKey ?? "").trim();
      if (!key) return;

      let seenAt = "";
      if (key.startsWith("task:")) {
        const taskId = key.slice("task:".length).trim();
        const rows = taskId ? logsByTaskAll.get(taskId) ?? [] : [];
        seenAt = rows.length > 0 ? String(rows[rows.length - 1]?.createdAt ?? "").trim() : "";
      } else if (key.startsWith("topic:")) {
        const topicId = key.slice("topic:".length).trim();
        const rows = topicId ? topicRootLogsByTopic.get(topicId) ?? [] : [];
        seenAt = rows.length > 0 ? String(rows[rows.length - 1]?.createdAt ?? "").trim() : "";
      }

      markChatSeenInStore(key, seenAt || undefined);
    },
    [logsByTaskAll, markChatSeenInStore, topicRootLogsByTopic]
  );

  useEffect(() => {
    const visibleChatKeys = new Set<string>();
    for (const taskId of expandedTasksSafe) {
      const key = chatKeyForTask(taskId);
      if (key) visibleChatKeys.add(key);
    }
    for (const topicId of expandedTopicChatsSafe) {
      const key = chatKeyForTopic(topicId);
      if (key) visibleChatKeys.add(key);
    }

    if (!mdUp && mobileLayer === "chat") {
      if (mobileChatTarget?.kind === "task") {
        const key = chatKeyForTask(mobileChatTarget.taskId);
        if (key) visibleChatKeys.add(key);
      } else if (mobileChatTarget?.kind === "topic") {
        const key = chatKeyForTopic(mobileChatTarget.topicId);
        if (key) visibleChatKeys.add(key);
      }
    }

    for (const key of visibleChatKeys) {
      markVisibleChatSeen(key);
    }
  }, [expandedTasksSafe, expandedTopicChatsSafe, markVisibleChatSeen, mdUp, mobileChatTarget, mobileLayer]);

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
            taskId: id,
            limit: String(pageSize),
            offset: String(offset),
          });
          if (selectedSpaceId) params.set("spaceId", selectedSpaceId);
          const res = await apiFetch(
            `/api/log?${params.toString()}`,
            { cache: "no-store" },
            token
          );
          if (!res.ok) break;
          const rows = (await res.json().catch(() => [])) as LogEntry[];
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

  const hydrateTopicLogs = useCallback(
    async (topicId: string) => {
      const id = String(topicId || "").trim();
      if (!id || id === "unassigned") return;
      if (topicLogHydratedRef.current.has(id)) return;
      if (topicLogHydratingRef.current.has(id)) return;
      topicLogHydratingRef.current.add(id);
      try {
        const merged: LogEntry[] = [];
        const pageSize = 400;
        let offset = 0;
        while (true) {
          const params = new URLSearchParams({
            topicId: id,
            limit: String(pageSize),
            offset: String(offset),
          });
          if (selectedSpaceId) params.set("spaceId", selectedSpaceId);
          const res = await apiFetch(
            `/api/log?${params.toString()}`,
            { cache: "no-store" },
            token
          );
          if (!res.ok) break;
          const rows = (await res.json().catch(() => [])) as LogEntry[];
          if (!Array.isArray(rows) || rows.length === 0) break;
          merged.push(...rows);
          if (rows.length < pageSize) break;
          offset += rows.length;
        }
        if (merged.length > 0) {
          setLogs((prev) => mergeLogs(prev, merged));
        }
        topicLogHydratedRef.current.add(id);
      } finally {
        topicLogHydratingRef.current.delete(id);
      }
    },
    [selectedSpaceId, setLogs, token]
  );

  const searchPlan = useMemo(() => buildUnifiedSearchPlan(search), [search]);
  const normalizedSearch = searchPlan.normalized;
  const semanticSearchQuery = searchPlan.lexicalQuery;
  const semanticSearchHintQuery = searchPlan.semanticQuery;
  const topicReorderEnabled = !readOnly && normalizedSearch.length === 0 && statusFilter === "all";
  const taskReorderEnabled = topicReorderEnabled;

  const chatKeyFromSessionKey = useCallback((sessionKey: string) => {
    const key = normalizeBoardSessionKey(sessionKey);
    if (!key) return "";
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
        const rows = topicRootLogsByTopic.get(topicId) ?? [];
        const last = rows.length > 0 ? rows[rows.length - 1] : null;
        return last?.id ?? "";
      }
      return "";
    },
    [logsByTaskAll, topicRootLogsByTopic]
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
    topicLogHydratedRef.current.clear();
  }, [selectedSpaceId, spaceVisibilityRevision]);

  useEffect(() => {
    const targets = new Set<string>();
    for (const taskId of expandedTasksSafe) {
      if (taskId) targets.add(taskId);
    }
    if (mobileLayer === "chat" && mobileChatTarget?.kind === "task" && mobileChatTarget.taskId) {
      targets.add(mobileChatTarget.taskId);
    }
    const topicTargets = new Set<string>();
    for (const taskId of targets) {
      void hydrateTaskLogs(taskId);
      const topicId = taskTopicById.get(taskId);
      if (topicId && topicId !== "unassigned") {
        topicTargets.add(topicId);
      }
    }
    for (const topicId of topicTargets) {
      void hydrateTopicLogs(topicId);
    }
  }, [expandedTasksSafe, hydrateTaskLogs, hydrateTopicLogs, mobileChatTarget, mobileLayer, taskTopicById]);

  useEffect(() => {
    const targets = new Set<string>();
    for (const topicId of expandedTopicChatsSafe) {
      if (topicId && topicId !== "unassigned") targets.add(topicId);
    }
    if (mobileLayer === "chat" && mobileChatTarget?.kind === "topic" && mobileChatTarget.topicId && mobileChatTarget.topicId !== "unassigned") {
      targets.add(mobileChatTarget.topicId);
    }
    for (const topicId of targets) {
      void hydrateTopicLogs(topicId);
    }
  }, [expandedTopicChatsSafe, hydrateTopicLogs, mobileChatTarget, mobileLayer]);

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
    return `${selectedSpaceId}:${topics.length}:${tasks.length}:${visibleLogs.length}:${latestTopic}:${latestTask}:${latestLog}:${statusFilter}:${showDone ? 1 : 0}:${showRaw ? 1 : 0}:${spaceVisibilityRevision}`;
  }, [selectedSpaceId, showDone, showRaw, spaceVisibilityRevision, statusFilter, tasks, topics, visibleLogs]);

  const semanticSearch = useSemanticSearch({
    query: semanticSearchQuery,
    semanticQuery: semanticSearchHintQuery,
    spaceId: selectedSpaceId || undefined,
    allowedSpaceIds,
    includePending: showRaw,
    limitTopics: semanticLimits.topics,
    limitTasks: semanticLimits.tasks,
    limitLogs: semanticLimits.logs,
    refreshKey: semanticRefreshKey,
  });

  const semanticForQuery = useMemo(() => {
    if (!semanticSearch.data) return null;
    const resultQuery = semanticSearch.data.query.trim().toLowerCase();
    if (!resultQuery || resultQuery !== semanticSearchQuery) return null;
    return semanticSearch.data;
  }, [semanticSearch.data, semanticSearchQuery]);

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
    return matchesSearchText(haystack, searchPlan);
  }, [normalizedSearch, searchPlan, semanticForQuery, semanticLogIds]);

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

  const taskChatLogsByTask = useMemo(() => {
    const byTask = new Map<string, LogEntry[]>();
    for (const task of tasks) {
      const rows = logsByTaskAll.get(task.id) ?? [];
      byTask.set(task.id, normalizedSearch ? rows.filter(matchesLogSearchChat) : rows);
    }
    return byTask;
  }, [logsByTaskAll, matchesLogSearchChat, normalizedSearch, tasks]);

  const topicChatLogsByTopic = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    for (const [topicId, rows] of topicRootLogsByTopic.entries()) {
      map.set(topicId, normalizedSearch ? rows.filter(matchesLogSearchChat) : rows);
    }
    return map;
  }, [matchesLogSearchChat, normalizedSearch, topicRootLogsByTopic]);

  const hiddenToolCallCountBySession = useMemo(() => {
    const map = new Map<string, number>();
    if (showToolCalls) return map;

    for (const [taskId, rows] of logsByTaskAll.entries()) {
      const topicId = taskTopicById.get(taskId) ?? "";
      if (!topicId || topicId === "unassigned") continue;
      const count = countTrailingHiddenToolCallsAwaitingAgent(rows);
      if (count < 1) continue;
      map.set(taskSessionKey(topicId, taskId), count);
    }

    for (const [topicId, rows] of topicRootLogsByTopic.entries()) {
      if (!topicId || topicId === "unassigned") continue;
      const count = countTrailingHiddenToolCallsAwaitingAgent(rows);
      if (count < 1) continue;
      map.set(topicSessionKey(topicId), count);
    }

    return map;
  }, [logsByTaskAll, showToolCalls, taskTopicById, topicRootLogsByTopic]);

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
    if (semanticForQuery) {
      if (semanticTaskIds.has(task.id)) return true;
      const logMatches = logsByTask.get(task.id)?.some((entry) => semanticLogIds.has(entry.id));
      return Boolean(logMatches);
    }
    if (matchesSearchText(task.title, searchPlan)) return true;
    const logMatches = logsByTask.get(task.id)?.some(matchesLogSearch);
    return Boolean(logMatches);
  }, [
    logsByTask,
    matchesLogSearch,
    normalizedSearch,
    searchPlan,
    revealSelection,
    revealedTaskIds,
    semanticForQuery,
    semanticLogIds,
    semanticTaskIds,
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
      if (statusFilter !== "all") return task.status === statusFilter;
      if (!showDone && task.status === "done") return false;
      return true;
    },
    [normalizedSearch, revealSelection, revealedTaskIds, showDone, showSnoozedTasks, statusFilter]
  );

  const orderedTopics = useMemo(() => {
    const now = Date.now();
    const scopedTopics =
      !normalizedSearch && selectedSpaceId
        ? topics.filter((topic) => topicSpaceIds(topic).includes(selectedSpaceId))
        : topics;
    const base = [...scopedTopics]
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
      const taskList = tasksByTopic.get(topic.id) ?? [];
      const hasMatchingTask = taskList.some((task) => matchesStatusFilter(task) && matchesTaskSearch(task));

      if (effectiveView === "active") {
        if (topicStatus !== "active") {
          // "Show snoozed" should surface snoozed topics even when they currently have no tasks.
          const includeSnoozedTopicByTask = topicStatus === "snoozed" && showSnoozedTasks;
          const includeArchivedTopicByTask =
            topicStatus === "archived" && (showDone || statusFilter === "done") && hasMatchingTask;
          if (!includeSnoozedTopicByTask && !includeArchivedTopicByTask) return false;
        }
      } else if (effectiveView === "snoozed") {
        if (topicStatus !== "snoozed") return false;
      } else if (effectiveView === "archived") {
        if (topicStatus !== "archived") return false;
      }

      if (statusFilter !== "all") {
        return hasMatchingTask;
      }
      if (!normalizedSearch) return true;
      if (semanticForQuery) {
        if (semanticTopicIds.has(topic.id)) return true;
        if (hasMatchingTask) return true;
        const topicLogs = logsByTopic.get(topic.id) ?? [];
        return topicLogs.some((entry) => semanticLogIds.has(entry.id));
      }
      const topicHit = matchesSearchText(`${topic.name} ${topic.description ?? ""}`, searchPlan);
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
        description: "Recycle bin for tasks from deleted topics.",
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
    matchesLogSearch,
    matchesStatusFilter,
    matchesTaskSearch,
    normalizedSearch,
    searchPlan,
    semanticForQuery,
    semanticLogIds,
    semanticTopicIds,
    semanticTopicScores,
    revealSelection,
    revealedTopicIds,
    selectedSpaceId,
    showDone,
    showSnoozedTasks,
    statusFilter,
    topicView,
    tasksByTopic,
  ]);

  const pageSize = UNIFIED_TOPICS_PAGE_SIZE;
  const pageCount = Math.ceil(orderedTopics.length / pageSize);
  const safePage = pageCount <= 1 ? 1 : Math.min(page, pageCount);
  const pagedTopics = pageCount > 1 ? orderedTopics.slice((safePage - 1) * pageSize, safePage * pageSize) : orderedTopics;
  const searchTargetsReady =
    normalizedSearch.length > 0 &&
    unifiedComposerDraft.trim().length > 0 &&
    orderedTopics.length > 0 &&
    (semanticSearchQuery.length < 2 ||
      semanticSearch.query.trim().toLowerCase() === semanticSearchQuery ||
      Boolean(semanticForQuery) ||
      Boolean(semanticSearch.error));
  const showSendTargetButtons = searchTargetsReady;

  const topicDisplayColors = useMemo(() => {
    // Assign in stable ID order so drag/reorder never changes colors.
    const map = new Map<string, string>();
    const usage = new Map<string, number>();
    const recentGlobal: string[] = [];
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
      recentGlobal.push(color);
      if (recentGlobal.length > 18) recentGlobal.shift();
    };

    const stableTopics = topics.slice().sort((a, b) => a.id.localeCompare(b.id));
    for (const topic of stableTopics) {
      const stored = normalizeHexColor(topic.color);
      if (stored) {
        register(topic, stored);
        continue;
      }
      const scopeKeys = topicColorScopeKeys(topic);
      const sameScopeColors = Array.from(new Set(scopeKeys.flatMap((scopeKey) => scopeColors.get(scopeKey) ?? [])));
      const color = pickVibrantDistinctColor({
        palette: TOPIC_FALLBACK_COLORS,
        seed: `topic:auto:${topic.id}:${topic.name}:${scopeKeys.join("|")}`,
        primaryAvoid: sameScopeColors,
        secondaryAvoid: recentGlobal,
        usageCount: usage,
      });
      register(topic, color);
    }
    return map;
  }, [topics]);

  const taskDisplayColors = useMemo(() => {
    const map = new Map<string, string>();
    const usage = new Map<string, number>();
    const recentGlobal: string[] = [];
    const siblingColorsByTopic = new Map<string, string[]>();

    const register = (task: Task, rawColor: string) => {
      const color = normalizeHexColor(rawColor) ?? "#4EA1FF";
      map.set(task.id, color);
      usage.set(color, (usage.get(color) ?? 0) + 1);
      const topicKey = (task.topicId ?? "").trim() || "__unassigned__";
      const existing = siblingColorsByTopic.get(topicKey) ?? [];
      existing.push(color);
      siblingColorsByTopic.set(topicKey, existing);
      recentGlobal.push(color);
      if (recentGlobal.length > 24) recentGlobal.shift();
    };

    const stableTasks = tasks.slice().sort((a, b) => a.id.localeCompare(b.id));
    for (const task of stableTasks) {
      const stored = normalizeHexColor(task.color);
      if (stored) {
        register(task, stored);
        continue;
      }
      const topicColor = task.topicId ? topicDisplayColors.get(task.topicId) : null;
      const topicKey = (task.topicId ?? "").trim() || "__unassigned__";
      const siblingColors = siblingColorsByTopic.get(topicKey) ?? [];
      const primaryAvoid = topicColor ? [topicColor, ...siblingColors] : [...siblingColors];
      const secondaryAvoid = topicColor ? [topicColor, ...recentGlobal] : recentGlobal;
      const color = pickVibrantDistinctColor({
        palette: TASK_FALLBACK_COLORS,
        seed: `task:auto:${task.id}:${task.title}:${topicKey}:${topicColor ?? ""}`,
        primaryAvoid,
        secondaryAvoid,
        usageCount: usage,
      });
      register(task, color);
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

  const updateTask = useCallback(async (taskId: string, updates: Partial<Task>) => {
    if (readOnly) return;
    const current = tasks.find((task) => task.id === taskId);
    if (!current) return;
    const res = await apiFetch(
      `/api/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        headers: writeHeaders,
        body: JSON.stringify(updates),
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
  }, [readOnly, tasks, writeHeaders, token, mdUp, mobileLayer, mobileChatTarget, setTasks, setExpandedTasks, setMobileLayer, setMobileChatTarget]);

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
        setActiveTopicTagField(null);
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

  const cancelTopicEdit = useCallback((topic: Topic, currentColor: string) => {
    setEditingTopicId(null);
    setTopicNameDraft("");
    setTopicColorDraft(currentColor);
    setTopicTagsDraft("");
    setActiveTopicTagField(null);
    setDeleteArmedKey(null);
    setRenameError(`topic:${topic.id}`);
  }, [setRenameError]);

  const cancelTaskEdit = useCallback((task: Task, currentColor: string) => {
    setEditingTaskId(null);
    setTaskNameDraft("");
    setTaskColorDraft(currentColor);
    setTaskTagsDraft("");
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
            spaceId: scopeTopicId ? undefined : selectedSpaceId || undefined,
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
      pushUrl(
        { topics: Array.from(nextTopics), tasks: Array.from(nextTasks), page: "1" },
        !mdUp && !!resolvedTopicId ? "push" : "replace"
      );
      if (resolvedTopicId) {
        setAutoFocusTask({ topicId: resolvedTopicId, taskId: created.id });
        if (!mdUp) {
          openMobileTaskChat(resolvedTopicId, created.id);
        }
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

  // Persist computed colors exactly once for topics/tasks missing explicit colors.
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

  useEffect(() => {
    if (readOnly) return;
    for (const task of tasks) {
      if (normalizeHexColor(task.color)) continue;
      const color = taskDisplayColors.get(task.id);
      if (!color) continue;
      if (patchedTaskColorsRef.current.has(task.id)) continue;
      patchedTaskColorsRef.current.add(task.id);
      void updateTask(task.id, { color });
    }
  }, [readOnly, taskDisplayColors, tasks, updateTask]);

  const deleteUnassignedTasks = async () => {
    if (readOnly) return;
    const deleteKey = "topic:unassigned";
    const unassignedTasks = tasks.filter((task) => !task.topicId);
    if (unassignedTasks.length === 0) return;
    setDeleteInFlightKey(deleteKey);
    setRenameError(deleteKey);
    try {
      const removed = new Set<string>();
      const bulkRes = await apiFetch("/api/tasks/unassigned/empty", { method: "DELETE" }, token);
      if (bulkRes.status === 404) {
        // Backward compatibility with older backends: fall back to per-task deletes.
        for (const task of unassignedTasks) {
          const res = await apiFetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" }, token);
          if (!res.ok) continue;
          const payload = (await res.json().catch(() => null)) as { deleted?: boolean } | null;
          if (payload?.deleted) removed.add(task.id);
        }
      } else if (bulkRes.ok) {
        for (const task of unassignedTasks) removed.add(task.id);
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

  const collapseAll = () => {
    setExpandedTopics(new Set());
    setExpandedTasks(new Set());
    setExpandedTopicChats(new Set());
    setChatMetaCollapseEpoch((prev) => prev + 1);
  };

  const allTopicIds = useMemo(() => orderedTopics.map((topic) => topic.id), [orderedTopics]);
  const allTaskIds = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const chatEligibleTopicIds = useMemo(
    () => allTopicIds.filter((topicId) => topicId !== "unassigned"),
    [allTopicIds]
  );
  const hasAnyExpandable = allTopicIds.length > 0 || allTaskIds.length > 0;
  const isEverythingExpanded = useMemo(() => {
    if (!hasAnyExpandable) return false;
    for (const topicId of allTopicIds) {
      if (!expandedTopicsSafe.has(topicId)) return false;
    }
    for (const taskId of allTaskIds) {
      if (!expandedTasksSafe.has(taskId)) return false;
    }
    for (const topicId of chatEligibleTopicIds) {
      if (!expandedTopicChatsSafe.has(topicId)) return false;
    }
    return true;
  }, [allTaskIds, allTopicIds, chatEligibleTopicIds, expandedTasksSafe, expandedTopicChatsSafe, expandedTopicsSafe, hasAnyExpandable]);

  const toggleTopicExpanded = (topicId: string) => {
    const next = new Set(expandedTopicsSafe);
    const nextChats = new Set(expandedTopicChatsSafe);
    let nextTasks = new Set(expandedTasksSafe);
    if (next.has(topicId)) {
      next.delete(topicId);
      nextChats.delete(topicId);
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
      // Topic chat open does not currently mutate the URL, so create an explicit history frame.
      // That way the mobile browser back gesture can cleanly close fullscreen chat (like ✕)
      // without navigating away from the board.
      if (typeof window !== "undefined") {
        window.history.pushState({ clawboard: true, mobileLayer: "chat" }, "", window.location.href);
      }

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
    setChatMetaCollapseEpoch((prev) => prev + 1);
  }, [
    mobileChatTarget,
    setChatMetaCollapseEpoch,
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
      setChatMetaCollapseEpoch((prev) => prev + 1);
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
      setChatMetaCollapseEpoch((prev) => prev + 1);
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

  const toggleToolCallsVisibility = () => {
    const next = !showToolCalls;
    setShowToolCalls(next);
    pushUrl({ tools: next ? "1" : "0" });
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
    setExpandedTopicChats(new Set(chatEligibleTopicIds));
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
    setShowToolCalls(parsedState.showToolCalls);
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
  }, [closeMobileChatLayer, mdUp, mobileLayer, syncFromUrl]);

  // Next router navigation (router.push / Link) does not trigger popstate.
  // Sync our internal expanded state when pathname/search params change.
  useEffect(() => {
    const currentKey = currentUrlKey();
    if (skipNextUrlSyncUrlRef.current === currentKey) {
      skipNextUrlSyncUrlRef.current = null;
      return;
    }
    skipNextUrlSyncUrlRef.current = null;
    syncFromUrl();
  }, [currentUrlKey, pathname, searchParams, syncFromUrl]);

  useEffect(() => {
    if (!autoFocusTopicId) return;
    const chatKey = `topic:${autoFocusTopicId}`;
    activeChatKeyRef.current = chatKey;
    activeChatAtBottomRef.current = true;
    scheduleScrollChatToBottom(chatKey);

    const session = topicSessionKey(autoFocusTopicId);
    const focusComposer = () => {
      const handle = composerHandlesRef.current.get(session);
      handle?.focus({ reveal: true, behavior: "auto", block: "end" });
    };
    focusComposer();
    const timer = window.setTimeout(focusComposer, 120);
    return () => window.clearTimeout(timer);
  }, [autoFocusTopicId, scheduleScrollChatToBottom]);

  useEffect(() => {
    if (!autoFocusTask) return;
    const chatKey = `task:${autoFocusTask.taskId}`;
    activeChatKeyRef.current = chatKey;
    activeChatAtBottomRef.current = true;
    scheduleScrollChatToBottom(chatKey);

    const session = taskSessionKey(autoFocusTask.topicId, autoFocusTask.taskId);
    const focusComposer = () => {
      const handle = composerHandlesRef.current.get(session);
      handle?.focus({ reveal: true, behavior: "auto", block: "end" });
    };
    focusComposer();
    const timer = window.setTimeout(focusComposer, 120);
    return () => window.clearTimeout(timer);
  }, [autoFocusTask, scheduleScrollChatToBottom]);

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
        const start = computeDefaultChatStart(all, TASK_TIMELINE_LIMIT);
        if (start <= 0) continue;
        next[key] = start;
        changed = true;
      }
      for (const topicId of expandedTopicChatsSafe) {
        if (topicId === "unassigned") continue;
        const key = chatKeyForTopic(topicId);
        if (Object.prototype.hasOwnProperty.call(prev, key)) continue;
        const all = topicRootLogsByTopic.get(topicId) ?? [];
        const start = computeDefaultChatStart(all, TOPIC_TIMELINE_LIMIT);
        if (start <= 0) continue;
        next[key] = start;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [expandedTasksSafe, expandedTopicChatsSafe, hydrated, logsByTaskAll, topicRootLogsByTopic]);

  const pushUrl = useCallback(
    (
      overrides: Partial<Record<"q" | "raw" | "done" | "status" | "page" | "density", string>> & {
        tools?: string;
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
      const nextTools = overrides.tools ?? (showToolCalls ? "1" : "0");
      const nextDone = overrides.done ?? (showDone ? "1" : "0");
      const nextStatus = overrides.status ?? statusFilter;
      const nextPage = overrides.page ?? String(safePage);
      const nextTopics = overrides.topics ?? Array.from(expandedTopicsSafe);
      const nextTasks = overrides.tasks ?? Array.from(expandedTasksSafe);
      const nextReveal = overrides.reveal ?? (revealSelection ? "1" : "0");

      if (nextSearch) params.set("q", nextSearch);
      if (selectedSpaceId) params.set("space", selectedSpaceId);
      if (nextRaw === "1") params.set("raw", "1");
      // Compact is the default; only persist when the user explicitly chooses comfortable.
      if (nextDensity === "comfortable") params.set("density", "comfortable");
      if (nextTools === "1") params.set("tools", "1");
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
      encodeTaskParam,
      encodeTopicParam,
      expandedTasksSafe,
      expandedTopicsSafe,
      safePage,
      search,
      messageDensity,
      showToolCalls,
      revealSelection,
      showDone,
      showRaw,
      statusFilter,
      basePath,
      selectedSpaceId,
    ]
  );

  useEffect(() => {
    const taskId = mobileDoneCollapseTaskIdRef.current;
    if (!taskId) return;
    mobileDoneCollapseTaskIdRef.current = null;
    const nextTasks = Array.from(expandedTasksSafe).filter((id) => id !== taskId);
    pushUrl({ tasks: nextTasks }, "replace");
  }, [expandedTasksSafe, pushUrl]);

  const selectedComposerTarget = useMemo(() => {
    if (composerTarget?.kind === "task") {
      const task = tasks.find((entry) => entry.id === composerTarget.taskId);
      if (task?.topicId) {
        const topic = topics.find((entry) => entry.id === task.topicId) ?? null;
        if (topic) return { kind: "task" as const, task, topic };
      }
      return null;
    }
    if (composerTarget?.kind === "topic") {
      const topic = topics.find((entry) => entry.id === composerTarget.topicId) ?? null;
      if (topic) return { kind: "topic" as const, topic };
    }
    return null;
  }, [composerTarget, tasks, topics]);
  const unifiedComposerHasText = unifiedComposerDraft.trim().length > 0;
  const unifiedComposerHasContent = unifiedComposerHasText || unifiedComposerAttachments.length > 0;
  const unifiedComposerSendsToNewTopic = !selectedComposerTarget;
  const unifiedComposerSubmitLabel = unifiedComposerSendsToNewTopic ? "New Topic" : "Send";
  const selectedComposerSessionKey = useMemo(() => {
    if (selectedComposerTarget?.kind === "task") {
      const topicId = String(selectedComposerTarget.task.topicId ?? "").trim();
      const taskId = String(selectedComposerTarget.task.id ?? "").trim();
      if (!topicId || !taskId) return "";
      return taskSessionKey(topicId, taskId);
    }
    if (selectedComposerTarget?.kind === "topic") {
      const topicId = String(selectedComposerTarget.topic.id ?? "").trim();
      if (!topicId) return "";
      return topicSessionKey(topicId);
    }
    return "";
  }, [selectedComposerTarget]);
  const activeComposerSessionKey = useMemo(() => {
    if (!activeComposer) return "";
    if (activeComposer.kind === "topic") {
      const topicId = String(activeComposer.topicId ?? "").trim();
      if (!topicId) return "";
      return topicSessionKey(topicId);
    }
    const topicId = String(activeComposer.topicId ?? "").trim();
    const taskId = String(activeComposer.taskId ?? "").trim();
    if (!topicId || !taskId) return "";
    return taskSessionKey(topicId, taskId);
  }, [activeComposer]);
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
  const inFlightBoardSessionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const key of Object.keys(effectiveAwaitingAssistant)) {
      const normalized = normalizeBoardSessionKey(key);
      if (!normalized || !isSessionResponding(normalized)) continue;
      keys.add(normalized);
    }
    for (const [key, typing] of Object.entries(openclawTyping)) {
      if (!typing?.typing) continue;
      const normalized = normalizeBoardSessionKey(key);
      if (!normalized || !isSessionResponding(normalized)) continue;
      keys.add(normalized);
    }
    for (const [key, signal] of Object.entries(openclawThreadWork)) {
      if (!signal?.active) continue;
      const normalized = normalizeBoardSessionKey(key);
      if (!normalized || !isSessionResponding(normalized)) continue;
      keys.add(normalized);
    }
    for (const [key, work] of Object.entries(orchestrationThreadWorkBySession)) {
      if (!work?.active) continue;
      const normalized = normalizeBoardSessionKey(key);
      if (!normalized || !isSessionResponding(normalized)) continue;
      keys.add(normalized);
    }
    return Array.from(keys).sort();
  }, [
    effectiveAwaitingAssistant,
    isSessionResponding,
    openclawTyping,
    openclawThreadWork,
    orchestrationThreadWorkBySession,
  ]);
  const selectedComposerTargetResponding = useMemo(() => {
    if (!selectedComposerSessionKey) return false;
    return isSessionResponding(selectedComposerSessionKey);
  }, [isSessionResponding, selectedComposerSessionKey]);

  const clearUnifiedComposerFields = useCallback(() => {
    setUnifiedComposerDraft("");
    setSearch("");
    setPage(1);
    clearUnifiedComposerAttachments();
    committedSearch.current = "";
    pushUrl({ q: "", page: "1" }, "replace");
  }, [clearUnifiedComposerAttachments, pushUrl, setPage, setSearch, setUnifiedComposerDraft]);

  const resolveUnifiedCancelTargetSession = useCallback(() => {
    const selectedKey = normalizeBoardSessionKey(selectedComposerSessionKey);
    if (selectedKey) return { sessionKey: selectedKey, reason: "selected" as const };

    const activeKey = normalizeBoardSessionKey(activeComposerSessionKey);
    if (activeKey) return { sessionKey: activeKey, reason: "active" as const };

    if (inFlightBoardSessionKeys.length === 1) {
      return { sessionKey: inFlightBoardSessionKeys[0], reason: "single" as const };
    }
    return null;
  }, [activeComposerSessionKey, inFlightBoardSessionKeys, selectedComposerSessionKey]);

  const cancelUnifiedComposerRun = useCallback(
    async ({ clearComposer }: { clearComposer: boolean }) => {
      const target = resolveUnifiedCancelTargetSession();
      if (!target) {
        setUnifiedCancelNotice("Select a topic/task target to stop.");
        return false;
      }

      setUnifiedComposerError(null);
      const requestId = requestIdForSession(target.sessionKey);
      try {
        const res = await apiFetch(
          "/api/openclaw/chat",
          {
            method: "DELETE",
            headers: writeHeaders,
            body: JSON.stringify({
              sessionKey: target.sessionKey,
              ...(requestId ? { requestId } : {}),
            }),
          },
          token
        );
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
            : target.reason === "active"
              ? "Cancelled active chat run."
              : "Cancelled the only active board run."
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

  const sendUnifiedComposer = useCallback(async (forceNewTopic: boolean) => {
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

    const selectedTask = selectedComposerTarget?.kind === "task" ? selectedComposerTarget.task : null;
    const selectedTopic = selectedComposerTarget?.kind === "topic"
      ? selectedComposerTarget.topic
      : selectedComposerTarget?.kind === "task"
        ? selectedComposerTarget.topic
        : null;

    const routedSpaceId = selectedSpaceId || undefined;

    const asNewTopic = forceNewTopic || (!selectedTask && !selectedTopic);
    let createdTopicId = "";
    let sessionKey = "";

    setUnifiedComposerBusy(true);
    try {
      if (asNewTopic) {
        const scopeSpaceId = String(selectedSpaceId ?? "").trim();
        const scopeTag = spaceTagFromSelection(scopeSpaceId, spaces);
        const tags = scopeTag ? [scopeTag] : [];

        const usage = new Map<string, number>();
        const scopedColors: string[] = [];
        const recentGlobal: string[] = [];
        const stableTopics = storeTopics.slice().sort((a, b) => a.id.localeCompare(b.id));
        for (const topic of stableTopics) {
          const color =
            normalizeHexColor(topic.color) ??
            topicDisplayColors.get(topic.id) ??
            colorFromSeed(`topic:${topic.id}:${topic.name}`, TOPIC_FALLBACK_COLORS);
          if (!color) continue;
          usage.set(color, (usage.get(color) ?? 0) + 1);
          recentGlobal.push(color);
          if (recentGlobal.length > 24) recentGlobal.shift();
          if (scopeSpaceId && topicSpaceIds(topic).includes(scopeSpaceId)) scopedColors.push(color);
        }
        const topicColor = pickVibrantDistinctColor({
          palette: TOPIC_FALLBACK_COLORS,
          seed: `topic:unified:new:${scopeSpaceId || "global"}:${Date.now()}:${message.slice(0, 80)}`,
          primaryAvoid: scopedColors,
          secondaryAvoid: recentGlobal,
          usageCount: usage,
        });
        const topicName = deriveUnifiedTopicNameFromMessage(message);

        const createTopicRes = await apiFetch(
          "/api/topics",
          {
            method: "POST",
            headers: writeHeaders,
            body: JSON.stringify({
              name: topicName,
              color: topicColor,
              ...(tags.length > 0 ? { tags } : {}),
            }),
          },
          token
        );
        if (!createTopicRes.ok) throw new Error("new_topic_create_failed");
        const createdTopic = parseTopicPayload(await createTopicRes.json().catch(() => null));
        if (!createdTopic?.id) throw new Error("new_topic_create_invalid");

        createdTopicId = createdTopic.id;
        const hydratedTopic: Topic = {
          ...createdTopic,
          color: normalizeHexColor(createdTopic.color) ?? topicColor,
          tags: Array.isArray(createdTopic.tags) ? createdTopic.tags : tags,
        };
        setTopics((prev) => {
          if (prev.some((topic) => topic.id === hydratedTopic.id)) {
            return prev.map((topic) => (topic.id === hydratedTopic.id ? { ...topic, ...hydratedTopic } : topic));
          }
          return [hydratedTopic, ...prev];
        });

        sessionKey = topicSessionKey(createdTopicId);
      } else {
        sessionKey = selectedTask
          ? taskSessionKey(String(selectedTask.topicId || ""), selectedTask.id)
          : topicSessionKey(String(selectedTopic?.id || ""));
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
            // Keep unified messages promotable into task scope when classifier/orchestration decides.
            topicOnly: false,
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

      if (asNewTopic && createdTopicId) {
        setComposerTarget({ kind: "topic", topicId: createdTopicId });
        setExpandedTopics((prev) => new Set(prev).add(createdTopicId));
        setExpandedTopicChats((prev) => new Set(prev).add(createdTopicId));
        setAutoFocusTopicId(createdTopicId);
        const nextTopics = Array.from(new Set([...expandedTopicsSafe, createdTopicId]));
        pushUrl({ topics: nextTopics, reveal: "1" }, "replace");
        if (!mdUp) openMobileTopicChat(createdTopicId);
        return;
      }
      if (selectedTask && selectedTask.topicId) {
        const topicId = selectedTask.topicId;
        const taskId = selectedTask.id;
        setExpandedTopics((prev) => new Set(prev).add(topicId));
        setExpandedTasks((prev) => new Set(prev).add(taskId));
        setAutoFocusTask({ topicId, taskId });
        const nextTopics = Array.from(new Set([...expandedTopicsSafe, topicId]));
        const nextTasks = Array.from(new Set([...expandedTasksSafe, taskId]));
        pushUrl({ topics: nextTopics, tasks: nextTasks, reveal: '1' }, 'replace');
        if (!mdUp) openMobileTaskChat(topicId, taskId);
        return;
      }
      if (selectedTopic) {
        const topicId = selectedTopic.id;
        setExpandedTopics((prev) => new Set(prev).add(topicId));
        setExpandedTopicChats((prev) => new Set(prev).add(topicId));
        setAutoFocusTopicId(topicId);
        const nextTopics = Array.from(new Set([...expandedTopicsSafe, topicId]));
        pushUrl({ topics: nextTopics, reveal: '1' }, 'replace');
        if (!mdUp) openMobileTopicChat(topicId);
      }
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
    markRecentBoardSend,
    mdUp,
    openMobileTaskChat,
    openMobileTopicChat,
    pushUrl,
    readOnly,
    selectedComposerTarget,
    selectedSpaceId,
    setExpandedTasks,
    setExpandedTopicChats,
    setExpandedTopics,
    setTopics,
    spaces,
    storeTopics,
    token,
    topicDisplayColors,
    unifiedComposerAttachments,
    unifiedComposerBusy,
    unifiedComposerDraft,
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
        const sessionKey = normalizeBoardSessionKey(entry.source?.sessionKey);
        if (sessionKey && sessionKey.startsWith(BOARD_TOPIC_SESSION_PREFIX)) {
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
    if (!sentAt || Date.now() - sentAt > OPENCLAW_PROMOTION_SIGNAL_WINDOW_MS) return;
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
    // Update the unified composer target so future sends go to the promoted task session,
    // not the original topic session.
    setComposerTarget({ kind: "task", topicId: promotion.topicId, taskId: promotion.taskId });
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
    if (!mdUp) {
      openMobileTaskChat(promotion.topicId, promotion.taskId);
    }

    const nextTopics = Array.from(new Set([...expandedTopicsSafe, promotion.topicId]));
    const nextTasks = Array.from(new Set([...expandedTasksSafe, promotion.taskId]));
    pushUrl({ topics: nextTopics, tasks: nextTasks }, "replace");
  }, [expandedTasksSafe, expandedTopicsSafe, logs, mdUp, openMobileTaskChat, pushUrl, scheduleScrollChatToBottom, setComposerTarget, setExpandedTasks, setExpandedTopics]);

  return (
    <div className="space-y-4">
      <div
        ref={stickyBarRef}
        className={cn(
          "sticky top-0 z-30 -mx-3 space-y-2 px-3 pb-2 pt-2 transition sm:-mx-4 sm:px-4 sm:pb-2.5 sm:pt-2.5 md:-mx-6 md:space-y-3 md:px-6 md:pb-3 md:pt-4",
          mobileLayer === "chat" ? "max-md:hidden" : "",
          isSticky
            ? "border-b border-[rgb(var(--claw-border))] bg-[rgba(12,14,18,0.9)] backdrop-blur"
            : "bg-transparent"
        )}
      >
        <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(14,17,22,0.92)] p-2.5 md:p-3">
          <button
            type="button"
            onClick={toggleFiltersDrawer}
            aria-expanded={filtersDrawerOpen}
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] border px-3 py-2 text-left transition",
              filtersDrawerOpen
                ? "border-[rgba(255,90,45,0.35)] bg-[rgba(255,90,45,0.08)]"
                : "border-[rgb(var(--claw-border))] bg-[rgba(8,10,14,0.28)]"
            )}
          >
            <span className="text-sm font-semibold">Board controls</span>
            <span className="inline-flex items-center gap-2 text-xs text-[rgb(var(--claw-muted))]">
              {filtersDrawerOpen ? "Close" : "Open"}
              <span className="text-[10px]">{filtersDrawerOpen ? "▴" : "▾"}</span>
            </span>
          </button>
          {filtersDrawerOpen ? (
            <div className="mt-2">
              <div className="space-y-2 md:hidden">
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={topicView}
                    onChange={(event) => {
                      setLocalStorageItem(TOPIC_VIEW_KEY, event.target.value);
                      setPage(1);
                      pushUrl({ page: "1" }, "replace");
                    }}
                    className="w-full"
                  >
                    <option value="active">Active topics</option>
                    <option value="snoozed">Snoozed topics</option>
                    <option value="archived">Archived topics</option>
                    <option value="all">All topics</option>
                  </Select>
                  <Select value={statusFilter} onChange={(event) => updateStatusFilter(event.target.value)} className="w-full">
                    <option value="all">All statuses</option>
                    <option value="todo">To Do</option>
                    <option value="doing">Doing</option>
                    <option value="blocked">Blocked</option>
                    <option value="done">Done</option>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className={cn("w-full justify-center", showSnoozedTasks ? "border-[rgba(77,171,158,0.55)]" : "opacity-85")}
                    onClick={() => {
                      setLocalStorageItem(SHOW_SNOOZED_TASKS_KEY, showSnoozedTasks ? "false" : "true");
                    }}
                  >
                    {showSnoozedTasks ? "Hide snoozed" : "Show snoozed"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className={cn("w-full justify-center", showDone ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                    onClick={toggleDoneVisibility}
                  >
                    {showDone ? "Hide done" : "Show done"}
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className={cn(
                      "w-full justify-center",
                      showToolCalls ? "border-[rgba(255,90,45,0.5)]" : "opacity-85"
                    )}
                    onClick={toggleToolCallsVisibility}
                  >
                    {showToolCalls ? "Hide tool calls" : "Show tool calls"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className={cn("w-full justify-center", showRaw ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                    onClick={toggleRawVisibility}
                  >
                    {showRaw ? "Hide full msgs" : "Show full msgs"}
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className={cn("w-full justify-center", twoColumn ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                    onClick={toggleTwoColumn}
                    title={twoColumn ? "Switch to single column" : "Switch to two columns"}
                  >
                    {twoColumn ? "1 column" : "2 column"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className={cn(
                      "w-full justify-center",
                      isEverythingExpanded ? "border-[rgba(255,90,45,0.5)]" : "opacity-85"
                    )}
                    onClick={toggleExpandAll}
                  >
                    {isEverythingExpanded ? "Collapse all" : "Expand all"}
                  </Button>
                </div>
              </div>
              <div className="hidden flex-wrap items-center gap-2 md:flex">
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
                <Select value={statusFilter} onChange={(event) => updateStatusFilter(event.target.value)} className="max-w-[190px]">
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
                  {showSnoozedTasks ? "Hide snoozed" : "Show snoozed"}
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
                  className={cn(showToolCalls ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                  onClick={toggleToolCallsVisibility}
                >
                  {showToolCalls ? "Hide tool calls" : "Show tool calls"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className={cn(
                    isEverythingExpanded ? "border-[rgba(255,90,45,0.5)]" : "opacity-85"
                  )}
                  onClick={toggleExpandAll}
                >
                  {isEverythingExpanded ? "Collapse all" : "Expand all"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className={cn("ml-auto", twoColumn ? "border-[rgba(255,90,45,0.5)]" : "opacity-85")}
                  onClick={toggleTwoColumn}
                  title={twoColumn ? "Switch to single column" : "Switch to two columns"}
                >
                  {twoColumn ? "1 column" : "2 column"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="space-y-2">
          <div className="relative rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(8,10,14,0.36)] p-2">
            <TextArea
              ref={unifiedComposerTextareaRef}
              data-testid="unified-composer-textarea"
              value={unifiedComposerDraft}
              onChange={(event) => {
                const value = event.target.value;
                setUnifiedComposerDraft(value);
                setUnifiedComposerError(null);
                setUnifiedCancelNotice(null);
                setSearch(value);
                setPage(1);
                pushUrl({ q: value, page: "1" }, "replace");
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
                if (event.key === 'Enter' && event.ctrlKey) {
                  event.preventDefault();
                  void sendUnifiedComposer(unifiedComposerSendsToNewTopic);
                  return;
                }
                // On mobile the keyboard "Send" key fires plain Enter — treat it as send.
                if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !mdUp) {
                  event.preventDefault();
                  void sendUnifiedComposer(unifiedComposerSendsToNewTopic);
                }
              }}
              placeholder="Chat about a Topic"
              className="resize-none overflow-y-hidden border-0 bg-transparent p-2 pr-[11.5rem]"
              style={{ minHeight: mdUp ? "44px" : "36px" }}
            />
            <div className="pointer-events-none absolute bottom-2 left-3 right-[11.25rem] flex min-h-8 items-end">
              {selectedComposerTarget ? (
                <div
                  data-testid="unified-composer-target-chip"
                  className="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full border border-[rgba(77,171,158,0.55)] bg-[rgba(18,28,34,0.9)] px-2.5 py-1 text-[11px] text-[rgb(var(--claw-text))]"
                >
                  <span className="truncate">
                    Sending to {selectedComposerTarget.kind === "task"
                      ? `task: ${selectedComposerTarget.task.title}`
                      : `topic: ${selectedComposerTarget.topic.name}`}
                  </span>
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
                </div>
              ) : (
                <span className="text-[11px] text-[rgb(var(--claw-muted))]">No target selected — New Topic</span>
              )}
            </div>
            <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
              {unifiedComposerHasContent ? (
                <button
                  type="button"
                  onClick={() => {
                    setUnifiedComposerDraft('');
                    setSearch('');
                    setPage(1);
                    clearUnifiedComposerAttachments();
                    setUnifiedComposerError(null);
                    setUnifiedCancelNotice(null);
                    committedSearch.current = '';
                    pushUrl({ q: '', page: '1' }, 'replace');
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
              {selectedComposerTargetResponding ? (
                <button
                  type="button"
                  data-testid="unified-composer-stop"
                  onClick={() => {
                    setUnifiedCancelNotice(null);
                    void cancelUnifiedComposerRun({ clearComposer: false });
                  }}
                  aria-label="Stop selected run"
                  title="Stop selected run"
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
                  data-testid={unifiedComposerSendsToNewTopic ? "unified-composer-new-topic" : "unified-composer-send"}
                  size="sm"
                  onClick={() => void sendUnifiedComposer(unifiedComposerSendsToNewTopic)}
                  disabled={unifiedComposerBusy}
                >
                  {unifiedComposerSubmitLabel}
                </Button>
              ) : null}
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
        </div>
        {readOnly && (
          <span className="text-xs text-[rgb(var(--claw-warning))]">Read-only mode. Add token to move tasks.</span>
        )}
        {normalizedSearch && (
          <span className="text-xs text-[rgb(var(--claw-muted))]">
            {semanticSearch.loading
              ? "Searching semantic index…"
              : semanticForQuery
                ? `Semantic search (${semanticForQuery.mode})`
                : semanticSearch.error === "search_timeout"
                  ? "Semantic search timed out, using local match fallback."
                  : semanticSearch.error
                  ? "Semantic search unavailable, using local match fallback."
                  : "Searching…"}
          </span>
        )}
      </div>

      <div className="space-y-3 max-md:space-y-2.5">
        {(() => {
          const topicCards = pagedTopics.map((topic, topicIndex) => {
          const topicId = topic.id;
          const isUnassigned = topicId === "unassigned";
          const deleteKey = `topic:${topic.id}`;
          const taskList = tasksByTopic.get(topicId) ?? [];
          const topicSelectedForSend = selectedComposerTarget?.kind === "topic" && selectedComposerTarget.topic.id === topicId;
          const selectedTaskIdForSend = selectedComposerTarget?.kind === "task" ? selectedComposerTarget.task.id : "";
          const openCount = taskList.filter((task) => task.status !== "done").length;
          const doingCount = taskList.filter((task) => task.status === "doing").length;
	          const blockedCount = taskList.filter((task) => task.status === "blocked").length;
	          const lastActivity = logsByTopic.get(topicId)?.[0]?.createdAt ?? topic.updatedAt;
          const hasUnsnoozedBadge = Object.prototype.hasOwnProperty.call(unsnoozedTopicBadges, topicId);
          const topicChatAllLogs = topicChatLogsByTopic.get(topicId) ?? [];
          const topicChatVisibleCount = countVisibleChatLogEntries(topicChatAllLogs, showToolCalls);
          const topicChatEntryCountLabel = formatChatEntryCountLabel(
            showToolCalls ? topicChatCountById[topicId] : undefined,
            showToolCalls ? topicChatAllLogs.length : topicChatVisibleCount,
            showToolCalls ? chatCountsHydrated : true
          );
          const topicToolingOrSystemCallCount =
            countToolingOrSystemChatLogEntries(topicChatAllLogs) +
            taskList.reduce(
              (sum, task) => sum + countToolingOrSystemChatLogEntries(taskChatLogsByTask.get(task.id) ?? []),
              0
            );
          const topicToolingOrSystemCallCountLabel = formatToolingOrSystemCallCountLabel(topicToolingOrSystemCallCount);
          const topicChatMetricsLabel = `${topicChatEntryCountLabel} · ${topicToolingOrSystemCallCountLabel}`;
	          const topicMatchesSearch =
	            normalizedSearch.length > 0 &&
	            matchesSearchText(`${topic.name} ${topic.description ?? ""}`, searchPlan);
	          const topicChatBlurb = deriveChatHeaderBlurb(topicChatAllLogs);
	          const showTasks = true;
	          const isExpanded = expandedTopicsSafe.has(topicId);
	          const topicChatKey = chatKeyForTopic(topicId);
          const topicChatSessionKey = topicSessionKey(topicId);
          const topicHiddenToolCallCount = hiddenToolCallCountForSession(topicChatSessionKey);
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
            : computeChatStart(
                chatHistoryStarts,
                topicChatKey,
                topicChatAllLogs.length,
                TOPIC_TIMELINE_LIMIT,
                topicChatAllLogs
              );
          const topicChatLogs = topicChatAllLogs.slice(topicChatStart);
	          const topicChatTruncated = !normalizedSearch && topicChatStart > 0;
	          const topicColor =
	            topicDisplayColors.get(topicId) ??
	            normalizeHexColor(topic.color) ??
	            colorFromSeed(`topic:${topic.id}:${topic.name}`, TOPIC_FALLBACK_COLORS);
          const topicSpaceIdList = topicSpaceIds(topic).filter((id) => id !== "space-default");
          const primaryTopicSpaceId = (() => {
            const direct = String(topic.spaceId ?? "").trim();
            if (direct && direct !== "space-default") return direct;
            return topicSpaceIdList[0] ?? "";
          })();
          const topicSpaceName = primaryTopicSpaceId
            ? spaceNameById.get(primaryTopicSpaceId) ?? deriveSpaceName(primaryTopicSpaceId)
            : "";
          const topicSpaceExtraCount = topicSpaceName ? Math.max(0, topicSpaceIdList.length - 1) : 0;

	          const swipeActions = isUnassigned ? (
	            <button
	              type="button"
	              onClick={(event) => {
	                event.stopPropagation();
	                if (readOnly) return;
	                setTopicSwipeOpenId(null);
	                const count = taskList.length;
	                if (count === 0) return;
	                const ok = window.confirm(`Permanently delete all ${count} unassigned task${count === 1 ? "" : "s"}? This cannot be undone.`);
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
              data-topic-card-id={topicId}
              className={cn(
                "border border-[rgb(var(--claw-border))] p-4 transition-colors duration-300 md:p-5",
                topicChatFullscreen
                  ? "fixed inset-0 z-[1400] m-0 flex h-[var(--claw-mobile-vh)] flex-col overflow-hidden rounded-none border-0 bg-[rgb(10,12,16)] p-0"
                  : "relative rounded-[var(--radius-lg)]",
                // Sticky section-header behavior is handled by the inner header row — not the outer card.
                // The outer card must remain non-sticky so the browser can use it as the sticky boundary
                // (header sticks until the card's bottom edge passes the top threshold).
                draggingTopicId && topicDropTargetId === topicId ? "border-[rgba(255,90,45,0.55)]" : "",
                topicSelectedForSend ? "ring-2 ring-[rgba(77,171,158,0.55)]" : ""
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
                    ? "sticky z-10 -mx-4 px-4 py-2 border-b border-[rgb(var(--claw-border))] backdrop-blur md:-mx-5 md:px-5"
                    : ""
                )}
                style={
                  isExpanded && !topicChatFullscreen
                    ? { top: stickyBarHeight, ...stickyTopicHeaderStyle(topicColor, topicIndex) }
                    : undefined
                }
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
		                    {editingTopicId === topic.id ? (
		                      <div
                            className="flex flex-wrap items-center gap-2"
                            onKeyDownCapture={(event) => {
                              if (event.key !== "Escape") return;
                              event.preventDefault();
                              event.stopPropagation();
                              cancelTopicEdit(topic, topicColor);
                            }}
                          >
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
                          }}
		                          placeholder="Rename topic"
		                          className="h-9 w-[260px] max-w-[70vw]"
		                        />
		                        <div className="relative">
		                          <Input
		                            value={topicTagsDraft}
		                            onClick={(event) => event.stopPropagation()}
		                            onChange={(event) => setTopicTagsDraft(normalizeTagDraftInput(event.target.value))}
		                            onFocus={() => setActiveTopicTagField("rename-topic")}
		                            onBlur={() =>
		                              setActiveTopicTagField((current) => (current === "rename-topic" ? null : current))
		                            }
		                            onKeyDown={(event) => {
		                              if (event.key !== "Enter") return;
		                              event.preventDefault();
		                              event.stopPropagation();
		                              setTopicTagsDraft(commitTagDraftEntry(topicTagsDraft));
		                            }}
		                            placeholder="Tags (comma separated)"
		                            className="h-9 w-[240px] max-w-[70vw]"
		                          />
		                          {activeTopicTagField === "rename-topic" && topicRenameTagSuggestions.length > 0 ? (
		                            <div className="absolute left-0 top-full z-40 mt-1.5 max-h-44 w-[240px] max-w-[70vw] overflow-auto rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel))] p-1 shadow-[0_10px_24px_rgba(0,0,0,0.35)]">
		                              {topicRenameTagSuggestions.map((suggestion) => (
		                                <button
		                                  key={`rename-topic-tag-${suggestion}`}
		                                  type="button"
		                                  className="flex w-full items-center justify-between rounded-[var(--radius-xs)] px-2 py-1.5 text-left text-xs text-[rgb(var(--claw-text))] transition hover:bg-[rgb(var(--claw-panel-2))]"
		                                  onMouseDown={(event) => {
		                                    event.preventDefault();
		                                    event.stopPropagation();
		                                    setTopicTagsDraft(applyTagSuggestionToDraft(topicTagsDraft, suggestion));
		                                  }}
		                                >
		                                  <span>{friendlyTagLabel(suggestion)}</span>
		                                  <span className="font-mono text-[10px] text-[rgb(var(--claw-muted))]">{suggestion}</span>
		                                </button>
		                              ))}
		                            </div>
		                          ) : null}
		                        </div>
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
                            cancelTopicEdit(topic, topicColor);
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
                        {showSendTargetButtons ? (
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
                            {topicSelectedForSend ? "Selected" : "Send here"}
                          </Button>
                        ) : null}
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
                            setActiveTopicTagField(null);
                            setDeleteArmedKey(null);
                            setRenameError(`topic:${topic.id}`);
                          }}
                          className={cn(
                            "hidden md:flex h-7 w-7 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] transition",
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
                    <PinToggleGeneric
                      item={topic} itemType="topic"
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
                    {topicSpaceName ? (
                      <span
                        className="inline-flex items-center rounded-full border border-[rgba(148,163,184,0.22)] bg-[rgba(148,163,184,0.07)] px-2 py-0.5 text-[10px] font-medium tracking-[0.08em] text-[rgb(var(--claw-muted))]"
                        title={
                          topicSpaceIdList
                            .map((id) => spaceNameById.get(id) ?? deriveSpaceName(id))
                            .join(", ")
                        }
                      >
                        {topicSpaceName}
                        {topicSpaceExtraCount > 0 ? ` +${topicSpaceExtraCount}` : ""}
                      </span>
                    ) : null}
	                    <span>{taskList.length} tasks</span>
	                    <span>{openCount} open</span>
	                    {isExpanded && <span>{doingCount} doing</span>}
	                    {isExpanded && <span>{blockedCount} blocked</span>}
                      <span>{topicChatMetricsLabel}</span>
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
                      {!isUnassigned ? (
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
                      ) : (
                        <p className="text-xs text-[rgb(var(--claw-muted))]">
                          Recycle bin: tasks appear here after their topic is deleted. Swipe left and tap EMPTY to clear all.
                        </p>
                      )}
	                  {taskList.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No tasks yet.</p>}
	                  {taskList
	                    .filter((task) => {
	                      if (!matchesStatusFilter(task)) return false;
	                      if (!normalizedSearch) return true;
	                      if (topicMatchesSearch) return true;
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
	                      const taskChatKey = chatKeyForTask(task.id);
                      const taskChatSessionKey = taskSessionKey(topicId, task.id);
                      const taskHiddenToolCallCount = hiddenToolCallCountForSession(taskChatSessionKey);
                      const taskSelectedForSend = selectedTaskIdForSend === task.id;
                      const start = normalizedSearch
                        ? 0
                        : computeChatStart(
                            chatHistoryStarts,
                            taskChatKey,
                            taskChatAllLogs.length,
                            TASK_TIMELINE_LIMIT,
                            taskChatAllLogs
                          );
                      const limitedLogs = taskChatAllLogs.slice(start);
                      const truncated = !normalizedSearch && start > 0;
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
		                            "border border-[rgb(var(--claw-border))] p-3.5 transition-colors duration-300 sm:p-4",
                                taskChatFullscreen
                                  ? "fixed inset-0 z-[1400] m-0 flex h-[var(--claw-mobile-vh)] flex-col overflow-hidden rounded-none border-0 bg-[rgb(10,12,16)] p-0"
                                  : "relative rounded-[var(--radius-md)]",
		                            draggingTaskId && taskDropTargetId === task.id ? "border-[rgba(77,171,158,0.55)]" : "",
                                statusMenuTaskId === task.id ? "z-40" : "",
                                taskSelectedForSend ? "ring-2 ring-[rgba(77,171,158,0.55)]" : ""
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
                              taskExpanded && !taskChatFullscreen
                                ? "sticky z-20 -mx-3.5 border-b border-[rgb(var(--claw-border))] px-3.5 py-2 backdrop-blur sm:-mx-4 sm:px-4"
                                : ""
                            )}
                            style={
                              taskExpanded && !taskChatFullscreen
                                ? { top: stickyBarHeight, ...stickyTaskHeaderStyle(taskColor, taskIndex) }
                                : undefined
                            }
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
		                                style={{ touchAction: "none" }}
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
		                                    placeholder="Rename task"
		                                    className="h-9 w-[280px] max-w-[68vw]"
		                                  />
		                                  <Input
		                                    value={taskTagsDraft}
		                                    onClick={(event) => event.stopPropagation()}
		                                    onChange={(event) => setTaskTagsDraft(normalizeTagDraftInput(event.target.value))}
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
                                        setComposerTarget({ kind: "task", topicId, taskId: task.id });
                                      }}
                                    >
                                      {taskSelectedForSend ? "Selected" : "Send here"}
                                    </Button>
                                  ) : null}
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
                              <PinToggleGeneric
                                item={task} itemType="task"
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
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[rgb(var(--claw-muted))]">
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
                                  ? "mt-0 flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+2.7rem)]"
                                  : ""
                              )}
                              style={taskChatFullscreen ? mobileOverlaySurfaceStyle(taskColor) : undefined}
                            >
                              {taskChatFullscreen ? (
                                <div className="absolute left-3 top-[calc(env(safe-area-inset-top)+0.5rem)] z-20 flex items-center gap-2">
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
                                        setTaskNameDraft(task.title);
                                        setTaskColorDraft(taskColor);
                                        setTaskTagsDraft(formatTags(task.tags));
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
                                          <div className="flex min-w-0 flex-1 items-center gap-2">
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
                              findPendingMessagesBySession(taskSessionKey(topicId, task.id)).length === 0 &&
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
                                                            ? "Sent"
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
					                                <>
					                                <BoardChatComposer
	                                      ref={(node) => {
	                                        const key = taskSessionKey(topicId, task.id);
	                                        if (node) composerHandlesRef.current.set(key, node);
                                        else composerHandlesRef.current.delete(key);
                                      }}
			                                  sessionKey={taskSessionKey(topicId, task.id)}
			                                  topicId={topicId}
			                                  spaceId={selectedSpaceId || undefined}
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
			                                  waiting={isSessionResponding(taskSessionKey(topicId, task.id))}
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
			                          <div className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{topicChatMetricsLabel}</div>
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
                                <div className="absolute left-3 top-[calc(env(safe-area-inset-top)+0.5rem)] z-20 flex items-center gap-2">
                                  <button
                                    type="button"
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border text-base text-[rgb(var(--claw-text))] backdrop-blur"
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
                                  {!readOnly && topic.id !== "unassigned" ? (
                                    <button
                                      type="button"
                                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border text-[rgb(var(--claw-text))] backdrop-blur"
                                      style={mobileOverlayCloseButtonStyle(topicColor)}
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        closeMobileChatLayer();
                                        setEditingTaskId(null);
                                        setTaskNameDraft("");
                                        setTaskColorDraft(TASK_FALLBACK_COLORS[0]);
                                        setEditingTopicId(topic.id);
                                        setTopicNameDraft(topic.name);
                                        setTopicColorDraft(topicColor);
                                        setTopicTagsDraft(formatTags(topic.tags));
                                        setActiveTopicTagField(null);
                                        setDeleteArmedKey(null);
                                        setRenameError(`topic:${topicId}`);
                                      }}
                                      aria-label="Edit topic"
                                      title="Edit topic"
                                    >
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                        <path d="M12 20h9" />
                                        <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                                      </svg>
                                    </button>
                                  ) : null}
                                </div>
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
                                          {topicChatMetricsLabel}
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
                              findPendingMessagesBySession(topicSessionKey(topicId)).length === 0 &&
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
		                                metaDefaultCollapsed={true}
		                                metaExpandEpoch={chatMetaExpandEpoch}
		                                metaCollapseEpoch={chatMetaCollapseEpoch}
			                                variant="chat"
                                hideToolCallsInChat={!showToolCalls}
			                                enableNavigation={false}
			                              />
                                      {pendingMessages
                                        .filter((pending) =>
                                          normalizeBoardSessionKey(pending.sessionKey) === normalizeBoardSessionKey(topicSessionKey(topicId))
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
                                                        ? "Sent"
                                                        : pending.error
                                                          ? pending.error
                                                          : "Failed to send."}
                                                  </span>
                                                  {pending.debugHint ? (
                                                    <span className="ml-2 text-[10px] text-[rgba(148,163,184,0.65)]">{pending.debugHint}</span>
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
                                                  data-testid={`topic-chat-hidden-tool-count-${topicId}`}
                                                  className="ml-2 text-[11px] uppercase tracking-[0.16em] text-[rgba(148,163,184,0.9)]"
                                                >
                                                  {topicHiddenToolCallCount} hidden tool{topicHiddenToolCallCount === 1 ? " call" : " calls"}
                                                </span>
                                              ) : null}
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
			                            topicId={topicId}
			                            spaceId={selectedSpaceId || undefined}
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
		                            waiting={isSessionResponding(topicSessionKey(topicId))}
		                            waitingRequestId={requestIdForSession(topicSessionKey(topicId))}
		                            onCancel={() => {
		                              const sk = topicSessionKey(topicId);
		                              setAwaitingAssistant((prev) => {
		                                if (!Object.prototype.hasOwnProperty.call(prev, sk)) return prev;
		                                const next = { ...prev };
		                                delete next[sk];
		                                return next;
		                              });
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

      <div className="mt-8 flex justify-center border-t border-[rgba(255,255,255,0.06)] pt-8 pb-12">
        <ColorShuffleTrigger 
          topics={topics} 
          tasks={tasks} 
          onTopicsUpdate={setTopics} 
          onTasksUpdate={setTasks} 
          token={token}
        />
      </div>

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
