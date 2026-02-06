"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardHeader, Input } from "@/components/ui";
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
import { buildTaskUrl, buildTopicUrl, UNIFIED_BASE } from "@/lib/url";
import type { Task, Topic } from "@/lib/types";
import { useSemanticSearch } from "@/lib/use-semantic-search";

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
const MAX_NODE_DRAG = 140;

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
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
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

export function ClawgraphLive() {
  const router = useRouter();
  const { topics, tasks, logs } = useDataStore();
  const [query, setQuery] = useState("");
  const [showAdvancedControls, setShowAdvancedControls] = useState(false);
  const [strengthPercent, setStrengthPercent] = useState(50);
  const [showEntityLinks, setShowEntityLinks] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [remoteGraph, setRemoteGraph] = useState<ClawgraphData | null>(null);
  const [graphMode, setGraphMode] = useState<"api" | "local">("local");
  const [isFetching, setIsFetching] = useState(false);
  const [isMapFullScreen, setIsMapFullScreen] = useState(false);
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const didDragRef = useRef(false);
  const [viewportSize, setViewportSize] = useState({ width: 1080, height: 680 });
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });

  const localGraph = useMemo(
    () =>
      buildClawgraphFromData(topics, tasks, logs, {
        maxEntities: 120,
        maxNodes: 260,
        minEdgeWeight: 0.08,
      }),
    [logs, tasks, topics]
  );

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      setIsFetching(true);
      try {
        const params = new URLSearchParams({
          maxEntities: "140",
          maxNodes: "320",
          minEdgeWeight: "0.08",
          limitLogs: "3200",
          includePending: "true",
        });
        const res = await apiFetch(`/api/clawgraph?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`status_${res.status}`);
        const payload = (await res.json()) as ClawgraphData;
        if (!payload || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) throw new Error("invalid_graph");
        if (!alive) return;
        setRemoteGraph(payload);
        setGraphMode("api");
      } catch {
        if (!alive) return;
        setRemoteGraph(null);
        setGraphMode("local");
      } finally {
        if (alive) setIsFetching(false);
      }
    }, 320);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [topics.length, tasks.length, logs.length]);

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
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMapFullScreen(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", handleKey);
    };
  }, [isMapFullScreen]);

  const graph = remoteGraph ?? localGraph;
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

  const candidateEdges = useMemo(() => {
    return graph.edges.filter((edge) => {
      if (!showEntityLinks && edge.type === "co_occurs") return false;
      return true;
    });
  }, [graph.edges, showEntityLinks]);

  const edgeThreshold = useMemo(() => {
    if (candidateEdges.length === 0) return 0;
    const weights = candidateEdges.map((edge) => edge.weight).sort((a, b) => a - b);
    if (strengthPercent <= 0) return weights[0] - 1e-6;
    if (strengthPercent >= 100) return weights[weights.length - 1];
    const rank = Math.floor((strengthPercent / 100) * (weights.length - 1));
    return weights[rank] ?? weights[weights.length - 1];
  }, [candidateEdges, strengthPercent]);

  const filteredEdges = useMemo(() => {
    return candidateEdges.filter((edge) => edge.weight >= edgeThreshold);
  }, [candidateEdges, edgeThreshold]);

  const nodeIdsFromEdges = useMemo(() => {
    const ids = new Set<string>();
    filteredEdges.forEach((edge) => {
      ids.add(edge.source);
      ids.add(edge.target);
    });
    return ids;
  }, [filteredEdges]);

  const displayNodes = useMemo(() => graph.nodes.filter((node) => nodeIdsFromEdges.has(node.id)), [graph.nodes, nodeIdsFromEdges]);
  const displayNodeById = useMemo(() => new Map(displayNodes.map((node) => [node.id, node])), [displayNodes]);

  useEffect(() => {
    if (!selectedNodeId) return;
    if (!displayNodeById.has(selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [displayNodeById, selectedNodeId]);

  const basePositions = useMemo(
    () => layoutClawgraph(displayNodes, filteredEdges, viewportSize.width, viewportSize.height),
    [displayNodes, filteredEdges, viewportSize.height, viewportSize.width]
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

  const normalizedQuery = query.trim().toLowerCase();
  const semanticRefreshKey = useMemo(() => {
    const latestTopic = topics.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    const latestTask = tasks.reduce((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), "");
    const latestLog = logs.reduce((acc, item) => {
      const stamp = item.updatedAt || item.createdAt || "";
      return stamp > acc ? stamp : acc;
    }, "");
    return `${topics.length}:${tasks.length}:${logs.length}:${latestTopic}:${latestTask}:${latestLog}`;
  }, [logs, tasks, topics]);
  const semanticSearch = useSemanticSearch({
    query: normalizedQuery,
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
    filteredEdges.forEach((edge) => {
      if (matchedNodes.has(edge.source) || matchedNodes.has(edge.target)) {
        ids.add(edge.source);
        ids.add(edge.target);
      }
    });
    return ids;
  }, [filteredEdges, matchedNodes]);

  const selectedNode = selectedNodeId ? displayNodeById.get(selectedNodeId) ?? null : null;
  const connectedEdges = useMemo(() => {
    if (!selectedNodeId) return [] as ClawgraphEdge[];
    return filteredEdges
      .filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 14);
  }, [filteredEdges, selectedNodeId]);

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

  const selectedTopicUrl = selectedTopic ? buildTopicUrl(selectedTopic, topics) : null;
  const selectedTaskUrl = selectedTask ? buildTaskUrl(selectedTask, topics) : null;

  const connectedEdgeRows = useMemo(() => {
    if (!selectedNodeId || !selectedNode) return [] as Array<{
      edge: ClawgraphEdge;
      summary: string;
      href: string;
    }>;

    return connectedEdges.map((edge) => {
      const oppositeNodeId = edge.source === selectedNodeId ? edge.target : edge.source;
      const oppositeNode = displayNodeById.get(oppositeNodeId) ?? nodeById.get(oppositeNodeId) ?? null;
      const oppositeTopic = topicFromNode(oppositeNode, topics);
      const oppositeTask = taskFromNode(oppositeNode, tasks);
      const params = new URLSearchParams();
      const topicIds = new Set<string>();
      const taskIds = new Set<string>();
      const pushTopic = (id?: string | null) => {
        if (id) topicIds.add(id);
      };
      const pushTask = (task?: Task | null) => {
        if (!task) return;
        taskIds.add(task.id);
        if (task.topicId) topicIds.add(task.topicId);
      };

      if (oppositeTask) {
        pushTask(oppositeTask);
      } else if (oppositeTopic) {
        pushTopic(oppositeTopic.id);
      } else if (selectedTask) {
        pushTask(selectedTask);
      } else if (selectedTopic) {
        pushTopic(selectedTopic.id);
      }

      topicIds.forEach((id) => params.append("topic", id));
      taskIds.forEach((id) => params.append("task", id));
      if (topicIds.size === 0 && taskIds.size === 0) {
        const queryHint = oppositeNode?.label ?? selectedNode.label;
        if (queryHint) params.set("q", queryHint);
      }

      const href = params.size > 0 ? `${UNIFIED_BASE}?${params.toString()}` : UNIFIED_BASE;

      return {
        edge,
        summary: summarizeEdge(edge, nodeById),
        href,
      };
    });
  }, [connectedEdges, displayNodeById, nodeById, selectedNode, selectedNodeId, selectedTask, selectedTopic, tasks, topics]);

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
      startX: point.x,
      startY: point.y,
      offsetX: offset.x,
      offsetY: offset.y,
    };
    canvasRef.current?.setPointerCapture(event.pointerId);
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
      const point = pointerToGraph(event);
      const deltaX = point.x - nodeDrag.startX;
      const deltaY = point.y - nodeDrag.startY;
      if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
        didDragRef.current = true;
      }
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
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      didDragRef.current = true;
    }
    setView((prev) => ({ ...prev, x: drag.panX + deltaX, y: drag.panY + deltaY }));
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const nodeDrag = nodeDragRef.current;
    if (nodeDrag && nodeDrag.pointerId === event.pointerId) {
      nodeDragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const stats = graph.stats;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Clawgraph</h1>
          <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
            Topic, task, entity, and agent relationships mapped as an interactive memory graph.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent2">{graphMode === "api" ? "Graph API" : "Local fallback"}</Badge>
          <Badge tone="muted">{stats.nodeCount} nodes</Badge>
          <Badge tone="muted">{stats.edgeCount} edges</Badge>
          <Badge tone="accent">{Math.round(stats.density * 100)}% density</Badge>
        </div>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Controls</h2>
          <Badge tone={isFetching ? "warning" : "muted"}>{isFetching ? "Refreshing graph" : "Stable"}</Badge>
        </CardHeader>
        <div className="grid gap-3 md:grid-cols-[1.4fr_auto]">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search entity, topic, task, or agent" />
          <div className="flex items-center gap-2 justify-self-start">
            <Button size="sm" variant="secondary" onClick={resetView}>
              Fit
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className={cn(showAdvancedControls ? "border-[rgba(255,90,45,0.5)]" : "")}
              onClick={() => setShowAdvancedControls((prev) => !prev)}
            >
              {showAdvancedControls ? "Hide advanced" : "Advanced"}
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
              ? "Searching memory index…"
              : semanticForQuery
                ? `Semantic search (${semanticForQuery.mode}) + graph label match`
                : semanticSearch.error
                  ? "Semantic search unavailable, using graph label fallback."
                  : "Searching…"}
          </p>
        )}
        {showAdvancedControls && (
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
        )}
      </Card>

      {isMapFullScreen && (
        <div
          className="fixed inset-0 z-40 bg-[rgba(7,9,12,0.82)] backdrop-blur-sm"
          onClick={() => setIsMapFullScreen(false)}
        />
      )}
      <div className={cn("grid gap-6 xl:grid-cols-[2.2fr_1fr]", isMapFullScreen && "block")}>
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
                {filteredEdges.map((edge) => {
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
          <div className="space-y-4">
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
                        <div className="text-xs text-[rgb(var(--claw-text))]">{row.summary}</div>
                        <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">
                          {row.edge.type} · {row.edge.weight.toFixed(2)} · evidence {row.edge.evidence}
                        </div>
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
              Visible edges: <span className="text-[rgb(var(--claw-text))]">{filteredEdges.length}</span>
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
