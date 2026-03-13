"use client";

import { decodeSlugId } from "@/lib/slug";

export type UnifiedUrlDensity = "comfortable" | "compact";

export type UnifiedUrlState = {
  raw: boolean;
  density: UnifiedUrlDensity;
  showToolCalls: boolean;
  done: boolean;
  status: string;
  reveal: boolean;
  page: number;
  topics: string[];
  tasks: string[];
};

type RawParseMode = "not-zero" | "one-only";

type ParseUnifiedUrlStateOptions = {
  basePath: string;
  resolveTopicId?: (value: string) => string;
  resolveTaskId?: (value: string) => string;
  rawParseMode?: RawParseMode;
  rawDefaultWhenMissing?: boolean;
  taskTopicById?: Map<string, string>;
};

const DEFAULT_STATE: UnifiedUrlState = {
  raw: true,
  density: "compact",
  showToolCalls: false,
  done: false,
  status: "all",
  reveal: false,
  page: 1,
  topics: [],
  tasks: [],
};

function parsePathSelections(pathname: string, basePath: string) {
  const segments = pathname.startsWith(basePath) ? pathname.slice(basePath.length).split("/").filter(Boolean) : [];
  const topics: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const key = segments[i];
    const value = segments[i + 1];
    if (!value) continue;
    if (key === "topic") {
      topics.push(value);
      i += 1;
    }
  }
  return { topics, tasks: [] as string[] };
}

function parseRawParam(params: URLSearchParams, mode: RawParseMode, defaultWhenMissing: boolean) {
  const rawParam = params.get("raw");
  if (rawParam === null) return defaultWhenMissing;
  if (mode === "one-only") return rawParam === "1";
  return rawParam !== "0";
}

function sanitizePage(raw: number) {
  if (!Number.isFinite(raw)) return 1;
  const value = Math.floor(raw);
  return value > 0 ? value : 1;
}

function mapIdValues(values: string[], resolve: (value: string) => string) {
  return values.map((value) => resolve(value)).filter(Boolean);
}

export function parseUnifiedUrlState(url: URL, options: ParseUnifiedUrlStateOptions): UnifiedUrlState {
  const resolveTopicId = options.resolveTopicId ?? decodeSlugId;
  const rawParseMode = options.rawParseMode ?? "not-zero";
  const rawDefaultWhenMissing = options.rawDefaultWhenMissing ?? false;

  const params = url.searchParams;
  const pathSelections = parsePathSelections(url.pathname, options.basePath);
  const hasPathSelections = pathSelections.topics.length > 0 || pathSelections.tasks.length > 0;

  let nextTopics = hasPathSelections
    ? mapIdValues(pathSelections.topics, resolveTopicId)
    : mapIdValues(params.getAll("topic"), resolveTopicId);

  if (nextTopics.length === 0) {
    const legacyTopics = params.get("topics")?.split(",").filter(Boolean) ?? [];
    nextTopics = mapIdValues(legacyTopics, resolveTopicId);
  }

  const densityParam = (params.get("density") ?? "").trim().toLowerCase();
  const density: UnifiedUrlDensity = densityParam === "comfortable" ? "comfortable" : "compact";

  return {
    raw: parseRawParam(params, rawParseMode, rawDefaultWhenMissing),
    density,
    showToolCalls: params.get("tools") === "1",
    done: params.get("done") === "1",
    status: params.get("status") ?? "all",
    reveal: params.get("reveal") === "1",
    page: sanitizePage(Number(params.get("page") ?? 1)),
    topics: nextTopics,
    tasks: [],
  };
}

export function getInitialUnifiedUrlState(basePath: string): UnifiedUrlState {
  void basePath;
  // Keep the server and client first render identical. The mounted sync effect in
  // UnifiedView applies the real URL state immediately after hydration.
  return DEFAULT_STATE;
}
