"use client";

import { decodeSlugId } from "@/lib/slug";

export type UnifiedUrlDensity = "comfortable" | "compact";

export type UnifiedUrlState = {
  search: string;
  raw: boolean;
  density: UnifiedUrlDensity;
  done: boolean;
  status: string;
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
  taskTopicById?: Map<string, string>;
};

const DEFAULT_STATE: UnifiedUrlState = {
  search: "",
  raw: true,
  density: "compact",
  done: false,
  status: "all",
  page: 1,
  topics: [],
  tasks: [],
};

function parsePathSelections(pathname: string, basePath: string) {
  const segments = pathname.startsWith(basePath) ? pathname.slice(basePath.length).split("/").filter(Boolean) : [];
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
}

function parseRawParam(params: URLSearchParams, mode: RawParseMode) {
  if (mode === "one-only") return params.get("raw") === "1";
  return params.get("raw") !== "0";
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
  const resolveTaskId = options.resolveTaskId ?? decodeSlugId;
  const rawParseMode = options.rawParseMode ?? "not-zero";

  const params = url.searchParams;
  const pathSelections = parsePathSelections(url.pathname, options.basePath);
  const hasPathSelections = pathSelections.topics.length > 0 || pathSelections.tasks.length > 0;

  let nextTopics = hasPathSelections
    ? mapIdValues(pathSelections.topics, resolveTopicId)
    : mapIdValues(params.getAll("topic"), resolveTopicId);
  let nextTasks = hasPathSelections
    ? mapIdValues(pathSelections.tasks, resolveTaskId)
    : mapIdValues(params.getAll("task"), resolveTaskId);

  if (nextTopics.length === 0) {
    const legacyTopics = params.get("topics")?.split(",").filter(Boolean) ?? [];
    nextTopics = mapIdValues(legacyTopics, resolveTopicId);
  }
  if (nextTasks.length === 0) {
    const legacyTasks = params.get("tasks")?.split(",").filter(Boolean) ?? [];
    nextTasks = mapIdValues(legacyTasks, resolveTaskId);
  }

  if (nextTasks.length > 0 && options.taskTopicById) {
    const parentTopicIds = nextTasks
      .map((taskId) => options.taskTopicById?.get(taskId))
      .filter((topicId): topicId is string => Boolean(topicId));
    if (parentTopicIds.length > 0) {
      nextTopics = Array.from(new Set([...nextTopics, ...parentTopicIds]));
    }
  }

  const densityParam = (params.get("density") ?? "").trim().toLowerCase();
  const density: UnifiedUrlDensity = densityParam === "comfortable" ? "comfortable" : "compact";

  return {
    search: params.get("q") ?? "",
    raw: parseRawParam(params, rawParseMode),
    density,
    done: params.get("done") === "1",
    status: params.get("status") ?? "all",
    page: sanitizePage(Number(params.get("page") ?? 1)),
    topics: nextTopics,
    tasks: nextTasks,
  };
}

export function getInitialUnifiedUrlState(basePath: string): UnifiedUrlState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  return parseUnifiedUrlState(new URL(window.location.href), { basePath, rawParseMode: "not-zero" });
}
