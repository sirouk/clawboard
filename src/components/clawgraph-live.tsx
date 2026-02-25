"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge, Button, Card, CardHeader, SearchInput } from "@/components/ui";
import { useDataStore } from "@/components/data-provider";
import { apiFetch } from "@/lib/api";
import {
  buildClawgraphFromData,
  layoutClawgraph,
  type ClawgraphData,
  type ClawgraphEdge,
  type ClawgraphNode,
  type ClawgraphNodeType,
} from "@/lib/clawgraph";
import { cn } from "@/lib/cn";
import { buildTaskUrl, buildTopicUrl, UNIFIED_BASE, withRevealParam, withSpaceParam } from "@/lib/url";
import type { Space, Task, Topic } from "@/lib/types";
import { useSemanticSearch } from "@/lib/use-semantic-search";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";
import { buildSpaceVisibilityRevision, resolveSpaceVisibilityFromViewer } from "@/lib/space-visibility";

const EDGE_COLORS: Record<string, string> = {
  has_task: "rgba(78,161,255,0.72)",
  mentions: "rgba(86,214,178,0.66)",
  co_occurs: "rgba(140,151,170,0.46)",
  related_topic: "rgba(255,168,96,0.62)",
  related_task: "rgba(252,195,110,0.58)",
  agent_focus: "rgba(231,211,111,0.62)",
};

const MIN_ZOOM = 0.38;
const MAX_ZOOM = 2.6;
const MAX_NODE_DRAG = 1200;
const DEFAULT_STRENGTH_PERCENT = 90;
const DEFAULT_LAYOUT_STRENGTH = DEFAULT_STRENGTH_PERCENT;
const INITIAL_REMOTE_WAIT_MS = 900;
const REMOTE_REFRESH_DEBOUNCE_MS = 320;
const QUERY_ROOT_MAX_HOPS = 2;
const QUERY_ROOT_MAX_BRANCH_PER_NODE = 24;
const QUERY_ROOT_MAX_NODES = 180;
const QUERY_ROOT_MAX_EDGES = 520;

const EMPTY_GRAPH: ClawgraphData = {
  generatedAt: "",
  stats: {
    nodeCount: 0,
    edgeCount: 0,
    topicCount: 0,
    taskCount: 0,
    entityCount: 0,
    agentCount: 0,
    density: 0,
  },
  nodes: [],
  edges: [],
};

const NODE_THEME: Record<ClawgraphNodeType, { color: string; glow: string }> = {
  topic: { color: "#FF8A4A", glow: "#FF8A4A" },
  task: { color: "#4EA1FF", glow: "#4EA1FF" },
  entity: { color: "#59C3A6", glow: "#59C3A6" },
  agent: { color: "#F4B55F", glow: "#F4B55F" },
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  panX: number;
  panY: number;
};

type NodeDragState = {
  pointerId: number;
  nodeId: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  dragging: boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  const padded = normalized.length === 3 ? normalized.split("").map((char) => `${char}${char}`).join("") : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(padded)) return { r: 78, g: 161, b: 255 };
  return {
    r: Number.parseInt(padded.slice(0, 2), 16),
    g: Number.parseInt(padded.slice(2, 4), 16),
    b: Number.parseInt(padded.slice(4, 6), 16),
  };
}

function toRgba(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function summarizeEdge(edge: ClawgraphEdge, nodeById: Map<string, ClawgraphNode>) {
  const source = nodeById.get(edge.source)?.label ?? edge.source;
  const target = nodeById.get(edge.target)?.label ?? edge.target;
  return `${source} -> ${target}`;
}

function topicFromNode(node: ClawgraphNode | null, topics: Topic[]) {
  if (!node || node.type !== "topic") return null;
  const topicIdFromMeta = String(node.meta?.topicId ?? "").trim();
  const topicId = topicIdFromMeta || node.id.replace(/^topic:/, "");
  if (!topicId) return null;
  return topics.find((topic) => topic.id === topicId) ?? null;
}

function taskFromNode(node: ClawgraphNode | null, tasks: Task[]) {
  if (!node || node.type !== "task") return null;
  const taskIdFromMeta = String(node.meta?.taskId ?? "").trim();
  const taskId = taskIdFromMeta || node.id.replace(/^task:/, "");
  if (!taskId) return null;
  return tasks.find((task) => task.id === taskId) ?? null;
}

function slug(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
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

function edgeThresholdAtPercent(edges: ClawgraphEdge[], percent: number) {
  if (edges.length === 0) return 0;
  const weights = edges.map((edge) => edge.weight).sort((a, b) => a - b);
  if (percent <= 0) return weights[0] - 1e-6;
  if (percent >= 100) return weights[weights.length - 1];
  const rank = Math.floor((percent / 100) * (weights.length - 1));
  return weights[rank] ?? weights[weights.length - 1];
}

function buildGraphStats(nodes: ClawgraphNode[], edges: ClawgraphEdge[]): ClawgraphData["stats"] {
  const topicCount = nodes.filter((node) => node.type === "topic").length;
  const taskCount = nodes.filter((node) => node.type === "task").length;
  const entityCount = nodes.filter((node) => node.type === "entity").length;
  const agentCount = nodes.filter((node) => node.type === "agent").length;
  const densityBase = Math.max(1, (nodes.length * (nodes.length - 1)) / 2);
  const density = Math.min(1, edges.length / densityBase);
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    topicCount,
    taskCount,
    entityCount,
    agentCount,
    density: Number(density.toFixed(4)),
  };
}

function buildQueryRootedSubgraph(
  graph: ClawgraphData,
  rootNodeIds: Set<string>,
  options: {
    includeCoOccurs: boolean;
  },
): ClawgraphData | null {
  const { includeCoOccurs } = options;
  if (!graph.nodes.length || rootNodeIds.size === 0) return null;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const roots = Array.from(rootNodeIds).filter((id) => nodeById.has(id));
  if (roots.length === 0) return null;

  const traversalEdges = graph.edges.filter((edge) => includeCoOccurs || edge.type !== "co_occurs");
  if (traversalEdges.length === 0) {
    const rootNodes = graph.nodes.filter((node) => roots.includes(node.id));
    return {
      generatedAt: graph.generatedAt,
      nodes: rootNodes,
      edges: [],
      stats: buildGraphStats(rootNodes, []),
    };
  }

  const adjacency = new Map<string, ClawgraphEdge[]>();
  for (const edge of traversalEdges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const fromSource = adjacency.get(edge.source) ?? [];
    fromSource.push(edge);
    adjacency.set(edge.source, fromSource);
    const fromTarget = adjacency.get(edge.target) ?? [];
    fromTarget.push(edge);
    adjacency.set(edge.target, fromTarget);
  }
  for (const [nodeId, edges] of adjacency.entries()) {
    adjacency.set(
      nodeId,
      [...edges].sort((a, b) => b.weight - a.weight)
    );
  }

  const includedNodes = new Set<string>(roots);
  const includedEdges = new Set<string>();
  let frontier = [...roots];
  for (let hop = 0; hop < QUERY_ROOT_MAX_HOPS; hop += 1) {
    if (frontier.length === 0) break;
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      const neighbors = adjacency.get(nodeId) ?? [];
      let branchCount = 0;
      for (const edge of neighbors) {
        if (includedEdges.size >= QUERY_ROOT_MAX_EDGES) break;
        const otherId = edge.source === nodeId ? edge.target : edge.source;
        includedEdges.add(edge.id);
        if (!includedNodes.has(otherId)) {
          includedNodes.add(otherId);
          nextFrontier.push(otherId);
        }
        branchCount += 1;
        if (branchCount >= QUERY_ROOT_MAX_BRANCH_PER_NODE || includedNodes.size >= QUERY_ROOT_MAX_NODES) break;
      }
      if (includedNodes.size >= QUERY_ROOT_MAX_NODES || includedEdges.size >= QUERY_ROOT_MAX_EDGES) break;
    }
    frontier = nextFrontier;
    if (includedNodes.size >= QUERY_ROOT_MAX_NODES || includedEdges.size >= QUERY_ROOT_MAX_EDGES) break;
  }

  if (includedEdges.size === 0) {
    const fallback = [...traversalEdges]
      .filter((edge) => roots.includes(edge.source) || roots.includes(edge.target))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, Math.min(24, QUERY_ROOT_MAX_EDGES));
    for (const edge of fallback) {
      includedEdges.add(edge.id);
      includedNodes.add(edge.source);
      includedNodes.add(edge.target);
    }
  }

  let edges = traversalEdges
    .filter((edge) => includedEdges.has(edge.id) && includedNodes.has(edge.source) && includedNodes.has(edge.target))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, QUERY_ROOT_MAX_EDGES);

  const rootSet = new Set<string>(roots);
  const rankedNodeIds = Array.from(includedNodes).sort((left, right) => {
    const leftRoot = rootSet.has(left) ? 1 : 0;
    const rightRoot = rootSet.has(right) ? 1 : 0;
    if (leftRoot !== rightRoot) return rightRoot - leftRoot;
    const leftScore = Number(nodeById.get(left)?.score ?? 0);
    const rightScore = Number(nodeById.get(right)?.score ?? 0);
    return rightScore - leftScore;
  });
  const keepNodeIds = new Set<string>(rankedNodeIds.slice(0, QUERY_ROOT_MAX_NODES));
  for (const rootId of roots) {
    if (keepNodeIds.size >= QUERY_ROOT_MAX_NODES) break;
    keepNodeIds.add(rootId);
  }
  edges = edges.filter((edge) => keepNodeIds.has(edge.source) && keepNodeIds.has(edge.target));

  const nodeIdsFromEdges = new Set<string>();
  for (const edge of edges) {
    nodeIdsFromEdges.add(edge.source);
    nodeIdsFromEdges.add(edge.target);
  }
  for (const rootId of roots) {
    if (keepNodeIds.has(rootId)) nodeIdsFromEdges.add(rootId);
  }

  let nodes = graph.nodes.filter((node) => keepNodeIds.has(node.id) && nodeIdsFromEdges.has(node.id));
  if (nodes.length === 0) return null;

  nodes = [...nodes].sort((left, right) => {
    const leftRoot = rootSet.has(left.id) ? 1 : 0;
    const rightRoot = rootSet.has(right.id) ? 1 : 0;
    if (leftRoot !== rightRoot) return rightRoot - leftRoot;
    return Number(right.score || 0) - Number(left.score || 0);
  });

  return {
    generatedAt: graph.generatedAt,
    nodes,
    edges,
    stats: buildGraphStats(nodes, edges),
  };
}

export function ClawgraphLive() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { spaces: storeSpaces, topics: storeTopics, tasks: storeTasks, logs: storeLogs, hydrated } = useDataStore();
  const activeSpaceId = (useLocalStorageItem("clawboard.space.active") ?? "").trim();
  const spaceFromUrl = (searchParams.get("space") ?? "").trim();
  const spaceQueryInitializedRef = useRef(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const [strengthPercent, setStrengthPercent] = useState(DEFAULT_STRENGTH_PERCENT);
  const [showEntityLinks, setShowEntityLinks] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [remoteGraph, setRemoteGraph] = useState<ClawgraphData | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [graphMode, setGraphMode] = useState<"pending" | "local" | "remote">("pending");
  const [isMapFullScreen, setIsMapFullScreen] = useState(false);
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const didDragRef = useRef(false);
  const [viewportSize, setViewportSize] = useState({ width: 1080, height: 680 });
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });

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

  const selectedSpaceId = useMemo(() => {
    if (!activeSpaceId) return "";
    if (spaces.some((space) => space.id === activeSpaceId)) return activeSpaceId;
    return "";
  }, [activeSpaceId, spaces]);

  useEffect(() => {
    if (spaceQueryInitializedRef.current) return;
    spaceQueryInitializedRef.current = true;
    if (!spaceFromUrl) return;
    if (spaceFromUrl === activeSpaceId) return;
    setLocalStorageItem("clawboard.space.active", spaceFromUrl);
  }, [activeSpaceId, spaceFromUrl]);
  useEffect(() => {
    if (!hydrated) return;
    if (!activeSpaceId) return;
    if (selectedSpaceId) return;
    setLocalStorageItem("clawboard.space.active", "");
  }, [activeSpaceId, hydrated, selectedSpaceId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (pathname !== "/graph") return;
    if (spaceFromUrl && !activeSpaceId && !selectedSpaceId) return;
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
  }, [activeSpaceId, pathname, selectedSpaceId, spaceFromUrl]);

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

  const allowedSpaceSet = useMemo(() => new Set(allowedSpaceIds), [allowedSpaceIds]);

  const topics = useMemo(() => {
    if (!selectedSpaceId || allowedSpaceSet.size === 0) return storeTopics;
    return storeTopics.filter((topic) => topicSpaceIds(topic).some((spaceId) => allowedSpaceSet.has(spaceId)));
  }, [allowedSpaceSet, selectedSpaceId, storeTopics]);

  const topicById = useMemo(() => new Map(topics.map((topic) => [topic.id, topic])), [topics]);

  const tasks = useMemo(() => {
    if (!selectedSpaceId || allowedSpaceSet.size === 0) return storeTasks;
    return storeTasks.filter((task) => {
      const directSpace = String(task.spaceId ?? "").trim();
      if (directSpace) return allowedSpaceSet.has(directSpace);
      if (task.topicId) {
        const topic = topicById.get(task.topicId);
        if (!topic) return false;
        return topicSpaceIds(topic).some((spaceId) => allowedSpaceSet.has(spaceId));
      }
      return false;
    });
  }, [allowedSpaceSet, selectedSpaceId, storeTasks, topicById]);

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const logs = useMemo(() => {
    if (!selectedSpaceId || allowedSpaceSet.size === 0) return storeLogs;
    return storeLogs.filter((entry) => {
      const directSpace = String(entry.spaceId ?? "").trim();
      if (directSpace) return allowedSpaceSet.has(directSpace);
      if (entry.taskId) {
        const task = taskById.get(entry.taskId);
        if (task) {
          const taskSpace = String(task.spaceId ?? "").trim();
          if (taskSpace) return allowedSpaceSet.has(taskSpace);
          if (task.topicId) {
            const parent = topicById.get(task.topicId);
            if (parent) {
              return topicSpaceIds(parent).some((spaceId) => allowedSpaceSet.has(spaceId));
            }
          }
        }
      }
      if (entry.topicId) {
        const topic = topicById.get(entry.topicId);
        if (topic) {
          return topicSpaceIds(topic).some((spaceId) => allowedSpaceSet.has(spaceId));
        }
      }
      return false;
    });
  }, [allowedSpaceSet, selectedSpaceId, storeLogs, taskById, topicById]);

  const localGraph = useMemo(() => {
    // Building the local graph is expensive; only do it when we are actively rendering local mode.
    if (graphMode !== "local") return EMPTY_GRAPH;
    return buildClawgraphFromData(topics, tasks, logs, {
      maxEntities: 120,
      maxNodes: 260,
      minEdgeWeight: 0.08,
    });
  }, [graphMode, logs, tasks, topics]);

  const fetchRemoteGraph = useCallback(async () => {
    const params = new URLSearchParams({
      maxEntities: "140",
      maxNodes: "320",
      minEdgeWeight: "0.08",
      limitLogs: "3200",
      includePending: "true",
    });
    if (selectedSpaceId) params.set("spaceId", selectedSpaceId);
    if (allowedSpaceIds.length > 0) params.set("allowedSpaceIds", allowedSpaceIds.join(","));
    const res = await apiFetch(`/api/clawgraph?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`status_${res.status}`);
    const payload = (await res.json()) as ClawgraphData;
    if (!payload || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) throw new Error("invalid_graph");
    return payload;
  }, [allowedSpaceIds, selectedSpaceId]);

  useEffect(() => {
    if (graphMode !== "pending") return;
    let alive = true;
    setIsFetching(true);
    const fallbackTimer = window.setTimeout(() => {
      if (!alive) return;
      setGraphMode("local");
      setIsFetching(false);
    }, INITIAL_REMOTE_WAIT_MS);

    void (async () => {
      try {
        const payload = await fetchRemoteGraph();
        if (!alive) return;
        clearTimeout(fallbackTimer);
        setRemoteGraph(payload);
        setGraphMode("remote");
      } catch {
        if (!alive) return;
        clearTimeout(fallbackTimer);
        setGraphMode("local");
      } finally {
        if (alive) setIsFetching(false);
      }
    })();

    return () => {
      alive = false;
      clearTimeout(fallbackTimer);
    };
  }, [fetchRemoteGraph, graphMode, spaceVisibilityRevision]);

  useEffect(() => {
    if (graphMode !== "remote") return;
    let alive = true;
    const timer = window.setTimeout(async () => {
      setIsFetching(true);
      try {
        const payload = await fetchRemoteGraph();
        if (!alive) return;
        setRemoteGraph(payload);
      } catch {
        // Keep current remote graph on refresh failures to avoid jarring fallbacks.
      } finally {
        if (alive) setIsFetching(false);
      }
    }, REMOTE_REFRESH_DEBOUNCE_MS);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [fetchRemoteGraph, graphMode, logs.length, spaceVisibilityRevision, tasks.length, topics.length]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.max(440, Math.floor(entry.contentRect.width));
      const preferredHeight = isMapFullScreen ? window.innerHeight - 220 : Math.min(window.innerHeight * 0.7, width * 0.72);
      const height = Math.max(420, Math.floor(preferredHeight));
      setViewportSize({ width, height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [isMapFullScreen]);

  useEffect(() => {
    if (!isMapFullScreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isMapFullScreen]);

  const semanticRefreshKey = useMemo(() => {
    const latestTopic = topics.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    const latestTask = tasks.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    const latestLog = logs.reduce((acc, item) => {
      const stamp = item.updatedAt || item.createdAt || "";
      return stamp > acc ? stamp : acc;
    }, "");
    return `${topics.length}:${tasks.length}:${logs.length}:${latestTopic}:${latestTask}:${latestLog}:${spaceVisibilityRevision}`;
  }, [logs, spaceVisibilityRevision, tasks, topics]);
  const semanticSearch = useSemanticSearch({
    query: normalizedQuery,
    spaceId: selectedSpaceId || undefined,
    allowedSpaceIds,
    includePending: true,
    limitTopics: Math.min(Math.max(topics.length, 120), 500),
    limitTasks: Math.min(Math.max(tasks.length, 240), 1200),
    limitLogs: Math.min(Math.max(logs.length, 800), 4000),
    refreshKey: semanticRefreshKey,
  });

  const semanticForQuery = useMemo(() => {
    if (!semanticSearch.data) return null;
    const resultQuery = semanticSearch.data.query.trim().toLowerCase();
    if (!resultQuery || resultQuery !== normalizedQuery) return null;
    return semanticSearch.data;
  }, [normalizedQuery, semanticSearch.data]);

  const graphBase = graphMode === "remote" && remoteGraph ? remoteGraph : graphMode === "local" ? localGraph : EMPTY_GRAPH;
  const queryRootNodeIds = useMemo(() => {
    if (!normalizedQuery || normalizedQuery.length < 2) return new Set<string>();
    const ids = new Set<string>();
    for (const topicId of semanticForQuery?.matchedTopicIds ?? []) {
      if (!topicId) continue;
      ids.add(`topic:${topicId}`);
    }
    for (const taskId of semanticForQuery?.matchedTaskIds ?? []) {
      if (!taskId) continue;
      ids.add(`task:${taskId}`);
    }
    const matchedLogIds = new Set(semanticForQuery?.matchedLogIds ?? []);
    if (matchedLogIds.size > 0) {
      for (const entry of logs) {
        if (!matchedLogIds.has(entry.id)) continue;
        if (entry.topicId) ids.add(`topic:${entry.topicId}`);
        if (entry.taskId) ids.add(`task:${entry.taskId}`);
        const agentLabel = String(entry.agentLabel || entry.agentId || "").trim();
        if (agentLabel) ids.add(`agent:${slug(agentLabel)}`);
      }
    }
    for (const node of graphBase.nodes) {
      const haystack = `${node.label} ${JSON.stringify(node.meta ?? {})}`.toLowerCase();
      if (!haystack.includes(normalizedQuery)) continue;
      ids.add(node.id);
    }
    return ids;
  }, [graphBase.nodes, logs, normalizedQuery, semanticForQuery]);
  const queryRootedGraph = useMemo(() => {
    if (!normalizedQuery || queryRootNodeIds.size === 0) return null;
    return buildQueryRootedSubgraph(graphBase, queryRootNodeIds, {
      includeCoOccurs: showEntityLinks,
    });
  }, [graphBase, normalizedQuery, queryRootNodeIds, showEntityLinks]);

  const graph = queryRootedGraph ?? graphBase;
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

  const candidateEdges = useMemo(() => {
    return graph.edges.filter((edge) => {
      if (!showEntityLinks && edge.type === "co_occurs") return false;
      return true;
    });
  }, [graph.edges, showEntityLinks]);

  const edgeThreshold = useMemo(() => edgeThresholdAtPercent(candidateEdges, strengthPercent), [candidateEdges, strengthPercent]);
  const layoutEdgeThreshold = useMemo(() => edgeThresholdAtPercent(candidateEdges, DEFAULT_LAYOUT_STRENGTH), [candidateEdges]);

  const filteredEdges = useMemo(() => {
    return candidateEdges.filter((edge) => edge.weight >= edgeThreshold);
  }, [candidateEdges, edgeThreshold]);
  const layoutEdges = useMemo(() => {
    return candidateEdges.filter((edge) => edge.weight >= layoutEdgeThreshold);
  }, [candidateEdges, layoutEdgeThreshold]);

  const strongestEdgesAllForSelection = useMemo(() => {
    if (!selectedNodeId) return [] as ClawgraphEdge[];
    // Strongest links should respect the edge-type toggles, but not the strength cutoff.
    return [...candidateEdges]
      .filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 14);
  }, [candidateEdges, selectedNodeId]);

  const strongestEdgesForSelection = useMemo(() => {
    if (!selectedNodeId) return [] as ClawgraphEdge[];
    // Apply the strength cutoff to the "strongest links" list, but ensure we still show at least
    // one relationship (otherwise the detail panel can look broken at high cutoffs).
    const visible = strongestEdgesAllForSelection.filter((edge) => edge.weight >= edgeThreshold);
    if (visible.length > 0) return visible;
    return strongestEdgesAllForSelection.slice(0, 1);
  }, [edgeThreshold, selectedNodeId, strongestEdgesAllForSelection]);

  const edgesForRender = useMemo(() => {
    if (!selectedNodeId || strongestEdgesForSelection.length === 0) return filteredEdges;
    const ids = new Set(filteredEdges.map((edge) => edge.id));
    const next = [...filteredEdges];
    for (const edge of strongestEdgesForSelection) {
      if (ids.has(edge.id)) continue;
      next.push(edge);
    }
    return next;
  }, [filteredEdges, selectedNodeId, strongestEdgesForSelection]);

  const nodeIdsForLayout = useMemo(() => {
    const ids = new Set<string>();
    candidateEdges.forEach((edge) => {
      ids.add(edge.source);
      ids.add(edge.target);
    });
    // Keep selected node rendered even if no visible edge points to it.
    if (selectedNodeId) ids.add(selectedNodeId);
    return ids;
  }, [candidateEdges, selectedNodeId]);

  const displayNodes = useMemo(() => graph.nodes.filter((node) => nodeIdsForLayout.has(node.id)), [graph.nodes, nodeIdsForLayout]);
  const displayNodeById = useMemo(() => new Map(displayNodes.map((node) => [node.id, node])), [displayNodes]);

  useEffect(() => {
    if (!selectedNodeId) return;
    if (!displayNodeById.has(selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [displayNodeById, selectedNodeId]);

  const basePositions = useMemo(
    () => layoutClawgraph(displayNodes, layoutEdges, viewportSize.width, viewportSize.height),
    [displayNodes, layoutEdges, viewportSize.height, viewportSize.width]
  );

  const positions = useMemo(() => {
    if (Object.keys(nodeOffsets).length === 0) return basePositions;
    const next = new Map(basePositions);
    Object.entries(nodeOffsets).forEach(([id, offset]) => {
      const base = next.get(id);
      if (!base) return;
      next.set(id, { x: base.x + offset.x, y: base.y + offset.y });
    });
    return next;
  }, [basePositions, nodeOffsets]);

  useEffect(() => {
    if (Object.keys(nodeOffsets).length === 0) return;
    const visibleIds = new Set(displayNodes.map((node) => node.id));
    let changed = false;
    const next: Record<string, { x: number; y: number }> = {};
    Object.entries(nodeOffsets).forEach(([id, offset]) => {
      if (visibleIds.has(id)) {
        next[id] = offset;
      } else {
        changed = true;
      }
    });
    if (changed) setNodeOffsets(next);
  }, [displayNodes, nodeOffsets]);

  const semanticMatchedNodes = useMemo(() => {
    if (!semanticForQuery) return new Set<string>();
    const ids = new Set<string>();
    for (const topicId of semanticForQuery.matchedTopicIds ?? []) {
      if (!topicId) continue;
      ids.add(`topic:${topicId}`);
    }
    for (const taskId of semanticForQuery.matchedTaskIds ?? []) {
      if (!taskId) continue;
      ids.add(`task:${taskId}`);
    }
    const matchedLogIds = new Set(semanticForQuery.matchedLogIds ?? []);
    for (const entry of logs) {
      if (!matchedLogIds.has(entry.id)) continue;
      if (entry.topicId) ids.add(`topic:${entry.topicId}`);
      if (entry.taskId) ids.add(`task:${entry.taskId}`);
      const agentLabel = String(entry.agentLabel || entry.agentId || "").trim();
      if (agentLabel) ids.add(`agent:${slug(agentLabel)}`);
    }
    return ids;
  }, [logs, semanticForQuery]);

  const matchedNodes = useMemo(() => {
    if (!normalizedQuery) return new Set<string>();
    const ids = new Set<string>(Array.from(semanticMatchedNodes).filter((id) => displayNodeById.has(id)));
    displayNodes.forEach((node) => {
      const haystack = `${node.label} ${JSON.stringify(node.meta ?? {})}`.toLowerCase();
      if (haystack.includes(normalizedQuery)) ids.add(node.id);
    });
    return ids;
  }, [displayNodeById, displayNodes, normalizedQuery, semanticMatchedNodes]);

  const connectedToMatch = useMemo(() => {
    if (matchedNodes.size === 0) return new Set<string>();
    const ids = new Set<string>(matchedNodes);
    edgesForRender.forEach((edge) => {
      if (matchedNodes.has(edge.source) || matchedNodes.has(edge.target)) {
        ids.add(edge.source);
        ids.add(edge.target);
      }
    });
    return ids;
  }, [edgesForRender, matchedNodes]);

  const selectedNode = selectedNodeId ? displayNodeById.get(selectedNodeId) ?? null : null;
  const connectedEdges = useMemo(() => {
    return strongestEdgesForSelection;
  }, [strongestEdgesForSelection]);

  const connectedNodes = useMemo(() => {
    if (!selectedNodeId) return [] as ClawgraphNode[];
    const ids = new Set<string>();
    connectedEdges.forEach((edge) => {
      ids.add(edge.source === selectedNodeId ? edge.target : edge.source);
    });
    return Array.from(ids)
      .map((id) => displayNodeById.get(id))
      .filter((item): item is ClawgraphNode => Boolean(item));
  }, [connectedEdges, displayNodeById, selectedNodeId]);

  const selectedTopic = useMemo(() => topicFromNode(selectedNode, topics), [selectedNode, topics]);

  const selectedTask = useMemo(() => taskFromNode(selectedNode, tasks), [selectedNode, tasks]);

  const selectedTopicUrl = selectedTopic
    ? withSpaceParam(withRevealParam(buildTopicUrl(selectedTopic, topics)), selectedTopic.spaceId)
    : null;
  const selectedTaskUrl = selectedTask
    ? withSpaceParam(
        withRevealParam(buildTaskUrl(selectedTask, topics)),
        String(selectedTask.spaceId ?? "").trim() ||
          String(topics.find((topic) => topic.id === selectedTask.topicId)?.spaceId ?? "").trim()
      )
    : null;

  const connectedEdgeRows = useMemo(() => {
    if (!selectedNodeId || !selectedNode) return [] as Array<{
      edge: ClawgraphEdge;
      title: string;
      subtitle: string;
      href: string;
    }>;

    return connectedEdges.map((edge) => {
      const oppositeNodeId = edge.source === selectedNodeId ? edge.target : edge.source;
      const oppositeNode = displayNodeById.get(oppositeNodeId) ?? nodeById.get(oppositeNodeId) ?? null;
      const oppositeTopic = topicFromNode(oppositeNode, topics);
      const oppositeTask = taskFromNode(oppositeNode, tasks);
      const oppositeTaskSpaceId =
        String(oppositeTask?.spaceId ?? "").trim() ||
        String(topics.find((topic) => topic.id === oppositeTask?.topicId)?.spaceId ?? "").trim();
      const selectedTaskSpaceId =
        String(selectedTask?.spaceId ?? "").trim() ||
        String(topics.find((topic) => topic.id === selectedTask?.topicId)?.spaceId ?? "").trim();
      let href = withRevealParam(UNIFIED_BASE);
      if (oppositeTask) {
        href = withSpaceParam(withRevealParam(buildTaskUrl(oppositeTask, topics)), oppositeTaskSpaceId);
      } else if (oppositeTopic) {
        href = withSpaceParam(withRevealParam(buildTopicUrl(oppositeTopic, topics)), oppositeTopic.spaceId);
      } else {
        const queryHint = oppositeNode?.label ?? selectedNode.label;
        const base = selectedTask
          ? buildTaskUrl(selectedTask, topics)
          : selectedTopic
            ? buildTopicUrl(selectedTopic, topics)
            : UNIFIED_BASE;
        const baseWithQuery = queryHint ? `${base}?q=${encodeURIComponent(queryHint)}` : base;
        const fallbackSpaceId = selectedTask ? selectedTaskSpaceId : selectedTopic?.spaceId;
        href = withSpaceParam(withRevealParam(baseWithQuery), fallbackSpaceId);
      }

      return {
        edge,
        title: oppositeNode?.label ?? summarizeEdge(edge, nodeById),
        subtitle: `${edge.type} · ${edge.weight.toFixed(2)}${edge.weight < edgeThreshold ? ` (below cutoff ${edgeThreshold.toFixed(2)})` : ""} · evidence ${
          edge.evidence
        }`,
        href,
      };
    });
  }, [
    connectedEdges,
    displayNodeById,
    edgeThreshold,
    nodeById,
    selectedNode,
    selectedNodeId,
    selectedTask,
    selectedTopic,
    tasks,
    topics,
  ]);

  const pointerToGraph = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect() ?? containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    return {
      x: (localX - view.x) / view.scale,
      y: (localY - view.y) / view.scale,
    };
  };

  const clampNodeOffset = (value: number) => clamp(value, -MAX_NODE_DRAG, MAX_NODE_DRAG);

  const resetView = () => setView({ x: 0, y: 0, scale: 1 });

  const fitToGraph = useCallback(() => {
    if (positions.size === 0) return;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    positions.forEach((pos) => {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x);
      maxY = Math.max(maxY, pos.y);
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return;
    const padding = 84;
    const boundsWidth = Math.max(120, maxX - minX);
    const boundsHeight = Math.max(120, maxY - minY);
    const scale = clamp(
      Math.min(viewportSize.width / (boundsWidth + padding * 2), viewportSize.height / (boundsHeight + padding * 2)),
      MIN_ZOOM,
      MAX_ZOOM
    );
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const x = viewportSize.width / 2 - centerX * scale;
    const y = viewportSize.height / 2 - centerY * scale;
    setView({ x, y, scale });
  }, [positions, viewportSize.height, viewportSize.width]);

  const zoomBy = (factor: number) => {
    setView((prev) => ({
      ...prev,
      scale: clamp(prev.scale * factor, MIN_ZOOM, MAX_ZOOM),
    }));
  };

  const handleWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    setView((prev) => {
      const nextScale = clamp(prev.scale * factor, MIN_ZOOM, MAX_ZOOM);
      const worldX = (pointerX - prev.x) / prev.scale;
      const worldY = (pointerY - prev.y) / prev.scale;
      const x = pointerX - worldX * nextScale;
      const y = pointerY - worldY * nextScale;
      return { x, y, scale: nextScale };
    });
  };

  const beginNodeDrag = (event: React.PointerEvent<SVGGElement>, nodeId: string) => {
    if (event.button !== 0) return;
    const point = pointerToGraph(event);
    const offset = nodeOffsets[nodeId] ?? { x: 0, y: 0 };
    didDragRef.current = false;
    dragRef.current = null;
    nodeDragRef.current = {
      pointerId: event.pointerId,
      nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: point.x,
      startY: point.y,
      offsetX: offset.x,
      offsetY: offset.y,
      dragging: false,
    };
  };

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    didDragRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: view.x,
      panY: view.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const nodeDrag = nodeDragRef.current;
    if (nodeDrag && nodeDrag.pointerId === event.pointerId) {
      const pixelDeltaX = event.clientX - nodeDrag.startClientX;
      const pixelDeltaY = event.clientY - nodeDrag.startClientY;
      // Drag intent must be measured in screen pixels. Measuring in graph-space makes click jitter
      // look like a drag when zoomed out, which breaks node selection.
      if (!nodeDrag.dragging) {
        if (Math.abs(pixelDeltaX) < 8 && Math.abs(pixelDeltaY) < 8) {
          return;
        }
        nodeDrag.dragging = true;
        didDragRef.current = true;
        try {
          // Only capture once we have real drag intent; capturing on pointerdown can
          // redirect click events away from the node (breaking selection).
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }
      const point = pointerToGraph(event);
      const deltaX = point.x - nodeDrag.startX;
      const deltaY = point.y - nodeDrag.startY;
      setNodeOffsets((prev) => ({
        ...prev,
        [nodeDrag.nodeId]: {
          x: clampNodeOffset(nodeDrag.offsetX + deltaX),
          y: clampNodeOffset(nodeDrag.offsetY + deltaY),
        },
      }));
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) > 6 || Math.abs(deltaY) > 6) {
      didDragRef.current = true;
    }
    setView((prev) => ({ ...prev, x: drag.panX + deltaX, y: drag.panY + deltaY }));
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const nodeDrag = nodeDragRef.current;
    if (nodeDrag && nodeDrag.pointerId === event.pointerId) {
      nodeDragRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  };

  const stats = graph.stats;

	return (
		<div className="space-y-6">
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Controls</h2>
          <Badge tone={isFetching ? "warning" : "muted"}>{isFetching ? "Refreshing graph" : "Stable"}</Badge>
        </CardHeader>
        <div className="grid gap-3 md:grid-cols-[1.4fr_auto]">
          <SearchInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery("")}
            placeholder="Search entity, topic, task, or agent"
          />
          <div className="flex items-center gap-2 justify-self-start">
            <Button size="sm" variant="secondary" onClick={fitToGraph}>
              Fit
            </Button>
            <Button size="sm" variant="ghost" onClick={resetView}>
              Reset
            </Button>
          </div>
          <label className="md:col-span-2 flex flex-col gap-2 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))] sm:flex-row sm:items-center">
            Strength
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={strengthPercent}
              onChange={(event) => setStrengthPercent(Number(event.target.value))}
              className="w-full accent-[rgb(var(--claw-accent))]"
            />
            <span className="tabular-nums text-[rgb(var(--claw-text))]">{strengthPercent}</span>
            <span className="tabular-nums text-[rgb(var(--claw-muted))]">cutoff {edgeThreshold.toFixed(2)}</span>
          </label>
        </div>
        {normalizedQuery && (
          <p className="text-xs text-[rgb(var(--claw-muted))]">
            {semanticSearch.loading
              ? "Searching semantic index…"
              : semanticForQuery
                ? queryRootedGraph
                  ? `Semantic search (${semanticForQuery.mode}) + query-rooted subgraph`
                  : `Semantic search (${semanticForQuery.mode}) + graph label match`
                : semanticSearch.error === "search_timeout"
                  ? "Semantic search timed out, using graph label fallback."
                  : semanticSearch.error
                  ? "Semantic search unavailable, using graph label fallback."
                  : "Searching…"}
          </p>
        )}
        {normalizedQuery && queryRootedGraph && (
          <p className="text-xs text-[rgb(var(--claw-muted))]">
            Subgraph: {graph.stats.nodeCount} nodes · {graph.stats.edgeCount} edges · rooted on query matches
          </p>
        )}
        <div className="mt-3 grid gap-3 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(14,17,22,0.9)] p-3 md:grid-cols-[1fr_auto]">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={showEntityLinks ? "secondary" : "ghost"} size="sm" onClick={() => setShowEntityLinks((prev) => !prev)}>
              {showEntityLinks ? "Hide co-occur" : "Show co-occur"}
            </Button>
            <Button variant={showLabels ? "secondary" : "ghost"} size="sm" onClick={() => setShowLabels((prev) => !prev)}>
              {showLabels ? "Hide labels" : "Show labels"}
            </Button>
          </div>
          <div className="flex items-center gap-2 justify-self-start">
            <Button size="sm" variant="secondary" onClick={() => zoomBy(1.12)}>
              +
            </Button>
            <Button size="sm" variant="secondary" onClick={() => zoomBy(0.9)}>
              -
            </Button>
          </div>
        </div>
      </Card>

      {isMapFullScreen && (
        <div
          className="fixed inset-0 z-40 bg-[rgba(7,9,12,0.82)] backdrop-blur-sm"
          onClick={() => setIsMapFullScreen(false)}
        />
      )}
      <div className={cn("space-y-6", isMapFullScreen && "block")}>
        <div className={cn(isMapFullScreen && "fixed inset-4 z-50")}>
          <Card className={cn("overflow-hidden", isMapFullScreen && "h-full w-full")}>
            <CardHeader className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Memory Map</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {(
                    [
                      { type: "topic", label: "Topics" },
                      { type: "task", label: "Tasks" },
                      { type: "entity", label: "Entities" },
                      { type: "agent", label: "Agents" },
                    ] as Array<{ type: ClawgraphNodeType; label: string }>
                  ).map((chip) => {
                    const theme = NODE_THEME[chip.type];
                    return (
                      <span
                        key={chip.type}
                        className="rounded-full border px-2 py-1 text-[rgb(var(--claw-muted))]"
                        style={{
                          borderColor: toRgba(theme.color, 0.55),
                          background: `linear-gradient(145deg, ${toRgba(theme.color, 0.16)}, rgba(16,19,24,0.88))`,
                          boxShadow: `0 0 0 1px ${toRgba(theme.color, 0.18)}, 0 0 18px ${toRgba(theme.glow, 0.16)}`,
                        }}
                      >
                        {chip.label}
                      </span>
                    );
                  })}
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setIsMapFullScreen((prev) => !prev)}>
                {isMapFullScreen ? "Exit full screen" : "Full screen"}
              </Button>
            </CardHeader>
            <div
              ref={containerRef}
              className={cn("relative px-3 pb-3", isMapFullScreen && "h-[calc(100vh-260px)]")}
            >
              <svg
                data-testid="clawgraph-canvas"
                ref={canvasRef}
                viewBox={`0 0 ${viewportSize.width} ${viewportSize.height}`}
                className={cn(
                  "w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[radial-gradient(circle_at_18%_14%,rgba(255,138,74,0.17),transparent_44%),radial-gradient(circle_at_82%_18%,rgba(78,161,255,0.15),transparent_44%),radial-gradient(circle_at_56%_86%,rgba(89,195,166,0.13),transparent_48%),radial-gradient(circle_at_90%_80%,rgba(244,181,95,0.1),transparent_46%),rgba(10,12,16,0.95)]",
                  isMapFullScreen ? "h-[calc(100vh-260px)] min-h-[520px]" : "h-[68vh] min-h-[420px]"
                )}
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onClick={() => {
                  if (didDragRef.current) {
                    didDragRef.current = false;
                    return;
                  }
                  setSelectedNodeId(null);
                }}
                role="img"
                aria-label="Clawgraph node relationship map"
              >
                <g transform={`translate(${view.x.toFixed(2)} ${view.y.toFixed(2)}) scale(${view.scale.toFixed(3)})`}>
                {edgesForRender.map((edge) => {
                  const source = positions.get(edge.source);
                  const target = positions.get(edge.target);
                  if (!source || !target) return null;
                  const dimmed =
                    normalizedQuery.length > 0 &&
                    matchedNodes.size > 0 &&
                    !connectedToMatch.has(edge.source) &&
                    !connectedToMatch.has(edge.target);
                  const selected = selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId);
                  const stroke = EDGE_COLORS[edge.type] ?? "rgba(148,158,177,0.54)";
                  return (
                    <line
                      key={edge.id}
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke={stroke}
                      strokeWidth={selected ? Math.min(4.2, 1.3 + edge.weight * 1.1) : Math.min(2.8, 0.8 + edge.weight * 0.72)}
                      strokeOpacity={dimmed ? 0.12 : selected ? 0.95 : 0.42}
                    />
                  );
                })}

                {displayNodes.map((node) => {
                  const pos = positions.get(node.id);
                  if (!pos) return null;
                  const matched = normalizedQuery.length > 0 && matchedNodes.has(node.id);
                  const connectedMatch = normalizedQuery.length > 0 && connectedToMatch.has(node.id);
                  const dimmed = normalizedQuery.length > 0 && !matched && !connectedMatch;
                  const selected = node.id === selectedNodeId;
                  const hovered = node.id === hoveredNodeId;
                  const nodeTheme = NODE_THEME[node.type];
                  const nodeColor = node.color || nodeTheme.color;
                  const allowScaleLabel = view.scale >= 1.02;
                  const allowPriorityLabel = node.type === "topic" || node.type === "task" || node.score >= 2.1;
                  const showNodeLabel = selected || matched || hovered || (showLabels && (allowScaleLabel || allowPriorityLabel));
                  const primaryGlow = toRgba(nodeColor, selected ? 0.44 : hovered ? 0.34 : 0.26);
                  const secondaryGlow = toRgba(nodeTheme.glow, selected ? 0.28 : hovered ? 0.2 : 0.14);
                  return (
                    <g
                      key={node.id}
                      data-node-id={node.id}
                      transform={`translate(${pos.x} ${pos.y})`}
                      className="cursor-grab active:cursor-grabbing"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        beginNodeDrag(event, node.id);
                      }}
                      onMouseEnter={() => setHoveredNodeId(node.id)}
                      onMouseLeave={() => setHoveredNodeId((prev) => (prev === node.id ? null : prev))}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (didDragRef.current) {
                          didDragRef.current = false;
                          return;
                        }
                        setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
                      }}
                    >
                      <circle
                        r={selected ? node.size * 0.62 : node.size * 0.52}
                        fill={nodeColor}
                        fillOpacity={dimmed ? 0.22 : selected ? 0.96 : 0.78}
                        stroke={selected ? "rgba(255,255,255,0.92)" : toRgba(nodeColor, matched || hovered ? 0.86 : 0.68)}
                        strokeWidth={selected ? 1.9 : matched ? 1.5 : 1.05}
                        style={{
                          filter: dimmed
                            ? undefined
                            : `drop-shadow(0 0 ${selected ? 16 : hovered ? 13 : 10}px ${primaryGlow}) drop-shadow(0 0 ${
                                selected ? 30 : hovered ? 24 : 18
                              }px ${secondaryGlow})`,
                        }}
                      />
                      {showNodeLabel && (
                        <text
                          x={node.size * 0.55 + 4}
                          y={4}
                          fill={dimmed ? "rgba(209,220,236,0.36)" : "rgba(229,237,247,0.92)"}
                          fontSize={selected || hovered ? 12 : 10}
                          className="select-none"
                        >
                          {node.label.length > 34 ? `${node.label.slice(0, 33)}…` : node.label}
                        </text>
                      )}
                    </g>
                  );
                })}
                </g>
              </svg>
            </div>
          </Card>
        </div>

        {!isMapFullScreen && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card data-testid="clawgraph-detail">
              <CardHeader>
                <h2 className="text-lg font-semibold">Node Detail</h2>
                <Badge tone={selectedNode ? "accent2" : "muted"}>{selectedNode ? selectedNode.type : "Select a node"}</Badge>
              </CardHeader>
              {!selectedNode && (
                <p className="text-sm text-[rgb(var(--claw-muted))]">
                  Click any node to inspect its relationships and strongest links.
                </p>
              )}
              {selectedNode && (
                <div className="space-y-3">
                  <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-3">
                    <div className="text-sm font-semibold">{selectedNode.label}</div>
                    <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">
                      {selectedNode.type}
                    </div>
                    <div className="mt-2 text-xs text-[rgb(var(--claw-muted))]">
                      Score {selectedNode.score.toFixed(2)} · size {selectedNode.size.toFixed(1)}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedTopicUrl && (
                      <Button size="sm" variant="secondary" onClick={() => router.push(selectedTopicUrl)}>
                        Open topic
                      </Button>
                    )}
                    {selectedTaskUrl && (
                      <Button size="sm" variant="secondary" onClick={() => router.push(selectedTaskUrl)}>
                        Open task
                      </Button>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">Strongest links</div>
                    {connectedEdgeRows.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No visible links.</p>}
                    {connectedEdgeRows.map((row) => (
                      <button
                        key={row.edge.id}
                        type="button"
                        data-testid="strongest-link-action"
                        className="w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-2 text-left transition hover:border-[rgba(255,90,45,0.35)]"
                        onClick={() => router.push(row.href)}
                      >
                        <div className="text-sm text-[rgb(var(--claw-text))]">{row.title}</div>
                        <div className="mt-1 text-xs text-[rgb(var(--claw-muted))]">{row.subtitle}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader>
                <h2 className="text-lg font-semibold">Graph Health</h2>
                <Badge tone="muted">Realtime</Badge>
              </CardHeader>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-2">
                  <div className="text-xs text-[rgb(var(--claw-muted))]">Topics</div>
                  <div className="font-semibold">{stats.topicCount}</div>
                </div>
                <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-2">
                  <div className="text-xs text-[rgb(var(--claw-muted))]">Tasks</div>
                  <div className="font-semibold">{stats.taskCount}</div>
                </div>
                <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-2">
                  <div className="text-xs text-[rgb(var(--claw-muted))]">Entities</div>
                  <div className="font-semibold">{stats.entityCount}</div>
                </div>
                <div className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-2">
                  <div className="text-xs text-[rgb(var(--claw-muted))]">Agents</div>
                  <div className="font-semibold">{stats.agentCount}</div>
                </div>
              </div>
              <div className="mt-3 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-3 text-xs text-[rgb(var(--claw-muted))]">
                Query matches: <span className="text-[rgb(var(--claw-text))]">{matchedNodes.size}</span>
                <br />
                Visible nodes: <span className="text-[rgb(var(--claw-text))]">{displayNodes.length}</span>
                <br />
                Visible edges: <span className="text-[rgb(var(--claw-text))]">{edgesForRender.length}</span>
              </div>
              {connectedNodes.length > 0 && (
                <div className="mt-3">
                  <div className="mb-2 text-xs uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">Neighbors</div>
                  <div className="flex flex-wrap gap-2">
                    {connectedNodes.slice(0, 18).map((node) => (
                      <button
                        key={node.id}
                        className={cn(
                          "rounded-full border px-2 py-1 text-xs transition",
                          node.id === selectedNodeId
                            ? "border-[rgba(255,90,45,0.6)] text-[rgb(var(--claw-text))]"
                            : "border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]"
                        )}
                        onClick={() => setSelectedNodeId(node.id)}
                      >
                        {node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>
      )}
      </div>
    </div>
  );
}
