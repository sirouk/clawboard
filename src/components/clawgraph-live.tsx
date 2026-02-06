"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardHeader, Input } from "@/components/ui";
import { useDataStore } from "@/components/data-provider";
import { apiUrl } from "@/lib/api";
import { buildClawgraphFromData, layoutClawgraph, type ClawgraphData, type ClawgraphEdge, type ClawgraphNode } from "@/lib/clawgraph";
import { cn } from "@/lib/cn";
import { buildTaskUrl, buildTopicUrl, UNIFIED_BASE } from "@/lib/url";

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

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  panX: number;
  panY: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function summarizeEdge(edge: ClawgraphEdge, nodeById: Map<string, ClawgraphNode>) {
  const source = nodeById.get(edge.source)?.label ?? edge.source;
  const target = nodeById.get(edge.target)?.label ?? edge.target;
  return `${source} -> ${target}`;
}

export function ClawgraphLive() {
  const router = useRouter();
  const { topics, tasks, logs } = useDataStore();
  const [query, setQuery] = useState("");
  const [showAdvancedControls, setShowAdvancedControls] = useState(false);
  const [edgeThreshold, setEdgeThreshold] = useState(0.16);
  const [showEntityLinks, setShowEntityLinks] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [remoteGraph, setRemoteGraph] = useState<ClawgraphData | null>(null);
  const [graphMode, setGraphMode] = useState<"api" | "local">("local");
  const [isFetching, setIsFetching] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
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
        const res = await fetch(apiUrl(`/api/clawgraph?${params.toString()}`), { cache: "no-store" });
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
      const height = Math.max(420, Math.floor(Math.min(window.innerHeight * 0.7, width * 0.72)));
      setViewportSize({ width, height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const graph = remoteGraph ?? localGraph;
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

  const filteredEdges = useMemo(() => {
    return graph.edges.filter((edge) => {
      if (!showEntityLinks && edge.type === "co_occurs") return false;
      return edge.weight >= edgeThreshold;
    });
  }, [edgeThreshold, graph.edges, showEntityLinks]);

  const nodeIdsFromEdges = useMemo(() => {
    const ids = new Set<string>();
    filteredEdges.forEach((edge) => {
      ids.add(edge.source);
      ids.add(edge.target);
    });
    graph.nodes.forEach((node) => {
      if (node.type === "topic" || node.type === "task") ids.add(node.id);
    });
    return ids;
  }, [filteredEdges, graph.nodes]);

  const displayNodes = useMemo(() => graph.nodes.filter((node) => nodeIdsFromEdges.has(node.id)), [graph.nodes, nodeIdsFromEdges]);
  const displayNodeById = useMemo(() => new Map(displayNodes.map((node) => [node.id, node])), [displayNodes]);

  const positions = useMemo(
    () => layoutClawgraph(displayNodes, filteredEdges, viewportSize.width, viewportSize.height),
    [displayNodes, filteredEdges, viewportSize.height, viewportSize.width]
  );

  const normalizedQuery = query.trim().toLowerCase();
  const matchedNodes = useMemo(() => {
    if (!normalizedQuery) return new Set<string>();
    const ids = new Set<string>();
    displayNodes.forEach((node) => {
      const haystack = `${node.label} ${JSON.stringify(node.meta ?? {})}`.toLowerCase();
      if (haystack.includes(normalizedQuery)) ids.add(node.id);
    });
    return ids;
  }, [displayNodes, normalizedQuery]);

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

  const selectedTopic = useMemo(() => {
    if (!selectedNode || selectedNode.type !== "topic") return null;
    const topicId = String(selectedNode.meta?.topicId ?? "").trim();
    if (!topicId) return null;
    return topics.find((topic) => topic.id === topicId) ?? null;
  }, [selectedNode, topics]);

  const selectedTask = useMemo(() => {
    if (!selectedNode || selectedNode.type !== "task") return null;
    const taskId = String(selectedNode.meta?.taskId ?? "").trim();
    if (!taskId) return null;
    return tasks.find((task) => task.id === taskId) ?? null;
  }, [selectedNode, tasks]);

  const selectedTopicUrl = selectedTopic ? buildTopicUrl(selectedTopic, topics) : null;
  const selectedTaskUrl = selectedTask ? buildTaskUrl(selectedTask, topics) : null;
  const selectedSearchUrl = selectedNode ? `${UNIFIED_BASE}?q=${encodeURIComponent(selectedNode.label)}` : null;
  const selectedLogUrl = selectedNode ? `/log?q=${encodeURIComponent(selectedNode.label)}` : null;

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

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
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
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    setView((prev) => ({ ...prev, x: drag.panX + deltaX, y: drag.panY + deltaY }));
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
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
        <div className="grid gap-3 md:grid-cols-[1.5fr_auto_auto]">
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
        </div>
        {showAdvancedControls && (
          <div className="mt-3 grid gap-3 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgba(14,17,22,0.9)] p-3 md:grid-cols-[1.3fr_1fr_auto]">
            <label className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">
              Edge
              <input
                type="range"
                min={0}
                max={0.9}
                step={0.02}
                value={edgeThreshold}
                onChange={(event) => setEdgeThreshold(Number(event.target.value))}
                className="w-full accent-[rgb(var(--claw-accent))]"
              />
              <span className="tabular-nums text-[rgb(var(--claw-text))]">{edgeThreshold.toFixed(2)}</span>
            </label>
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

      <div className="grid gap-6 xl:grid-cols-[2.2fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader>
            <h2 className="text-lg font-semibold">Memory Map</h2>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full border border-[rgba(255,138,74,0.6)] px-2 py-1 text-[rgb(var(--claw-muted))]">Topics</span>
              <span className="rounded-full border border-[rgba(78,161,255,0.7)] px-2 py-1 text-[rgb(var(--claw-muted))]">Tasks</span>
              <span className="rounded-full border border-[rgba(69,196,160,0.7)] px-2 py-1 text-[rgb(var(--claw-muted))]">Entities</span>
              <span className="rounded-full border border-[rgba(242,200,75,0.7)] px-2 py-1 text-[rgb(var(--claw-muted))]">Agents</span>
            </div>
          </CardHeader>
          <div ref={containerRef} className="relative px-3 pb-3">
            <svg
              data-testid="clawgraph-canvas"
              viewBox={`0 0 ${viewportSize.width} ${viewportSize.height}`}
              className="h-[68vh] min-h-[420px] w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[radial-gradient(circle_at_30%_20%,rgba(255,90,45,0.11),transparent_44%),radial-gradient(circle_at_70%_80%,rgba(77,163,255,0.12),transparent_48%),rgba(10,12,16,0.95)]"
              onWheel={handleWheel}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
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
                  const allowScaleLabel = view.scale >= 1.02;
                  const allowPriorityLabel = node.type === "topic" || node.type === "task" || node.score >= 2.1;
                  const showNodeLabel = selected || matched || hovered || (showLabels && (allowScaleLabel || allowPriorityLabel));
                  return (
                    <g
                      key={node.id}
                      data-node-id={node.id}
                      transform={`translate(${pos.x} ${pos.y})`}
                      className="cursor-pointer"
                      onPointerDown={(event) => event.stopPropagation()}
                      onMouseEnter={() => setHoveredNodeId(node.id)}
                      onMouseLeave={() => setHoveredNodeId((prev) => (prev === node.id ? null : prev))}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedNodeId(node.id);
                      }}
                    >
                      <circle
                        r={selected ? node.size * 0.62 : node.size * 0.52}
                        fill={node.color}
                        fillOpacity={dimmed ? 0.22 : selected ? 0.96 : 0.78}
                        stroke="rgba(255,255,255,0.84)"
                        strokeWidth={selected ? 1.9 : matched ? 1.5 : 1.05}
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
                  <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">{selectedNode.type}</div>
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
                  {selectedSearchUrl && (
                    <Button size="sm" variant="secondary" onClick={() => router.push(selectedSearchUrl)}>
                      Search board
                    </Button>
                  )}
                  {selectedLogUrl && (
                    <Button size="sm" variant="secondary" onClick={() => router.push(selectedLogUrl)}>
                      Filter related logs
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-[0.16em] text-[rgb(var(--claw-muted))]">Strongest links</div>
                  {connectedEdges.length === 0 && <p className="text-sm text-[rgb(var(--claw-muted))]">No visible links.</p>}
                  {connectedEdges.map((edge) => (
                    <div key={edge.id} className="rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] p-2">
                      <div className="text-xs text-[rgb(var(--claw-text))]">{summarizeEdge(edge, nodeById)}</div>
                      <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-[rgb(var(--claw-muted))]">
                        {edge.type} · {edge.weight.toFixed(2)} · evidence {edge.evidence}
                      </div>
                    </div>
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
      </div>
    </div>
  );
}
