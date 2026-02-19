import type { LogEntry, Task, Topic } from "@/lib/types";

export type ClawgraphNodeType = "topic" | "task" | "entity" | "agent";
export type ClawgraphEdgeType = "has_task" | "mentions" | "co_occurs" | "related_topic" | "related_task" | "agent_focus";

export type ClawgraphNode = {
  id: string;
  label: string;
  type: ClawgraphNodeType;
  score: number;
  size: number;
  color: string;
  meta: Record<string, unknown>;
};

export type ClawgraphEdge = {
  id: string;
  source: string;
  target: string;
  type: ClawgraphEdgeType;
  weight: number;
  evidence: number;
};

export type ClawgraphStats = {
  nodeCount: number;
  edgeCount: number;
  topicCount: number;
  taskCount: number;
  entityCount: number;
  agentCount: number;
  density: number;
};

export type ClawgraphData = {
  generatedAt: string;
  stats: ClawgraphStats;
  nodes: ClawgraphNode[];
  edges: ClawgraphEdge[];
};

type BuildNode = {
  id: string;
  label: string;
  type: ClawgraphNodeType;
  score: number;
  meta: Record<string, unknown>;
};

type BuildOptions = {
  maxEntities?: number;
  maxNodes?: number;
  minEdgeWeight?: number;
};

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "about",
  "where",
  "what",
  "when",
  "have",
  "has",
  "been",
  "were",
  "is",
  "are",
  "to",
  "of",
  "on",
  "in",
  "a",
  "an",
  "user",
  "assistant",
  "system",
  "summary",
  "channel",
  "session",
  "message",
  "messages",
  "agent",
]);

const ENTITY_BLOCKLIST = new Set([
  "EST",
  "UTC",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);

const ENTITY_NOISE_TOKENS = new Set(["ok", "okay", "yeah", "yes", "hey", "so", "please", "pls", "thanks", "thx"]);

const NODE_COLORS: Record<ClawgraphNodeType, string> = {
  topic: "#ff8a4a",
  task: "#4ea1ff",
  entity: "#45c4a0",
  agent: "#f2c84b",
};

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";
}

function shouldExcludeAgentFocus(agentLabel: string) {
  const key = slug(agentLabel);
  // OpenClaw is the backbone agent label in many logs, so linking it to every extracted
  // entity creates an unhelpful global hub in the graph.
  return key === "openclaw" || key.startsWith("openclaw-");
}

function cleanText(value: string) {
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

function isToolCallLog(log: LogEntry) {
  if (log.type !== "action") return false;
  const combined = `${log.summary ?? ""} ${log.content ?? ""} ${log.raw ?? ""}`.toLowerCase();
  return combined.includes("tool call:") || combined.includes("tool result:") || combined.includes("tool error:");
}

function words(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\s]+/g, " ");
  return new Set(
    normalized
      .split(" ")
      .map((part) => part.trim())
      .filter((part) => part.length > 2 && !STOP_WORDS.has(part))
  );
}

function jaccard(a: string, b: string) {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  wa.forEach((word) => {
    if (wb.has(word)) inter += 1;
  });
  return inter / (wa.size + wb.size - inter);
}

function extractEntities(text: string) {
  const source = cleanText(text).replace(/\s+/g, " ");
  if (!source) return new Set<string>();
  const canonicalByKey = new Map<string, string>();

  const addToken = (token: string) => {
    let normalized = token.trim().replace(/^[`*[\]{}()'"!.,:;]+|[`*[\]{}()'"!.,:;]+$/g, "");
    normalized = normalized.replace(/\s+/g, " ").trim();
    if (!normalized) return;

    const parts = normalized.split(" ").filter(Boolean);
    while (parts.length > 0 && ENTITY_NOISE_TOKENS.has(parts[0].toLowerCase())) {
      parts.shift();
    }
    while (parts.length > 0 && ENTITY_NOISE_TOKENS.has(parts[parts.length - 1].toLowerCase())) {
      parts.pop();
    }
    normalized = parts.join(" ").trim();
    if (!normalized) return;
    if (normalized.length < 3) return;
    if (normalized.length > 48) return;
    if (ENTITY_BLOCKLIST.has(normalized)) return;
    const key = normalized.toLowerCase();
    if (STOP_WORDS.has(key)) return;

    const existing = canonicalByKey.get(key);
    if (!existing || normalized.length > existing.length) {
      canonicalByKey.set(key, normalized);
    }
  };

  const upper = source.match(/\b[A-Z][A-Z0-9_-]{2,}\b/g) ?? [];
  upper.forEach(addToken);

  const camel = source.match(/\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+\b/g) ?? [];
  camel.forEach(addToken);

  const titledSingle = source.match(/\b[A-Z][a-z0-9]{2,}\b/g) ?? [];
  titledSingle.forEach(addToken);

  const titled = source.match(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,2}\b/g) ?? [];
  titled.forEach(addToken);

  return new Set(canonicalByKey.values());
}

function nodeSize(type: ClawgraphNodeType, score: number) {
  const base = type === "topic" ? 20 : type === "task" ? 15 : type === "agent" ? 11.5 : 10.5;
  const boost = Math.max(0, Math.min(22, Math.sqrt(Math.max(score, 0)) * 2.4));
  return Math.round((base + boost) * 100) / 100;
}

function edgeKey(source: string, target: string, type: ClawgraphEdgeType, undirected = false) {
  if (!undirected) return `${source}|${target}|${type}`;
  return source <= target ? `${source}|${target}|${type}` : `${target}|${source}|${type}`;
}

export function buildClawgraphFromData(
  topics: Topic[],
  tasks: Task[],
  logs: LogEntry[],
  options: BuildOptions = {}
): ClawgraphData {
  const maxEntities = Math.max(12, Math.min(400, options.maxEntities ?? 120));
  const maxNodes = Math.max(40, Math.min(800, options.maxNodes ?? 260));
  const minEdgeWeight = Math.max(0, Math.min(2, options.minEdgeWeight ?? 0.16));

  const nodeMap = new Map<string, BuildNode>();
  const edgeWeights = new Map<string, number>();
  const edgeEvidence = new Map<string, number>();

  const addEdge = (source: string, target: string, type: ClawgraphEdgeType, weight: number, undirected = false) => {
    const key = edgeKey(source, target, type, undirected);
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + weight);
    edgeEvidence.set(key, (edgeEvidence.get(key) ?? 0) + 1);
  };

  const notesByRelated = new Map<string, string[]>();
  for (const log of logs) {
    if (log.type !== "note" || !log.relatedLogId) continue;
    const text = cleanText(log.content || log.summary || "");
    if (!text) continue;
    const list = notesByRelated.get(log.relatedLogId) ?? [];
    if (list.length < 4) list.push(text.slice(0, 800));
    notesByRelated.set(log.relatedLogId, list);
  }

  for (const topic of topics) {
    const nodeId = `topic:${topic.id}`;
    nodeMap.set(nodeId, {
      id: nodeId,
      label: topic.name || topic.id,
      type: "topic",
      score: 1.6 + (topic.pinned ? 0.65 : 0),
      meta: {
        topicId: topic.id,
        description: topic.description ?? "",
        pinned: Boolean(topic.pinned),
      },
    });
  }

  for (const task of tasks) {
    const nodeId = `task:${task.id}`;
    const statusBoost = task.status === "doing" ? 0.9 : task.status === "blocked" ? 0.7 : task.status === "todo" ? 0.45 : 0.1;
    nodeMap.set(nodeId, {
      id: nodeId,
      label: task.title || task.id,
      type: "task",
      score: 1.1 + statusBoost + (task.pinned ? 0.45 : 0),
      meta: {
        taskId: task.id,
        topicId: task.topicId ?? null,
        status: task.status,
        pinned: Boolean(task.pinned),
      },
    });
    if (task.topicId && nodeMap.has(`topic:${task.topicId}`)) {
      addEdge(`topic:${task.topicId}`, nodeId, "has_task", 1 + statusBoost * 0.25);
    }
  }

  const entityScore = new Map<string, number>();
  const entityLabel = new Map<string, string>();
  const topicEntity = new Map<string, Map<string, number>>();
  const taskEntity = new Map<string, Map<string, number>>();
  const agentEntity = new Map<string, Map<string, number>>();

  const bumpInMap = (container: Map<string, Map<string, number>>, bucket: string, key: string, weight: number) => {
    const inner = container.get(bucket) ?? new Map<string, number>();
    inner.set(key, (inner.get(key) ?? 0) + weight);
    container.set(bucket, inner);
  };

  for (const log of logs) {
    if (log.type === "note") continue;
    if (isToolCallLog(log)) continue;
    const combined = [log.summary || "", log.content || "", (log.raw || "").slice(0, 900), ...(notesByRelated.get(log.id) ?? [])]
      .join("\n")
      .trim();
    const entities = extractEntities(combined);
    if (entities.size === 0) continue;

    const weightBase = log.type === "conversation" ? 1 : log.type === "action" ? 0.72 : log.type === "system" ? 0.55 : 0.45;
    const noteBoost = 1 + Math.min(0.8, (notesByRelated.get(log.id)?.length ?? 0) * 0.2);
    const weight = weightBase * noteBoost;

    const agentLabel = (log.agentLabel || log.agentId || "").trim();
    const excludeAgentFocus = agentLabel ? shouldExcludeAgentFocus(agentLabel) : false;
    if (agentLabel && !excludeAgentFocus) {
      const agentNode = `agent:${slug(agentLabel)}`;
      if (!nodeMap.has(agentNode)) {
        nodeMap.set(agentNode, {
          id: agentNode,
          label: agentLabel.slice(0, 38),
          type: "agent",
          score: 0.9,
          meta: { agentLabel },
        });
      }
      const agentBuildNode = nodeMap.get(agentNode);
      if (agentBuildNode) agentBuildNode.score += 0.1;
    }

    const entityIds: string[] = [];
    entities.forEach((entity) => {
      const key = entity.toLowerCase();
      entityScore.set(key, (entityScore.get(key) ?? 0) + weight);
      if (!entityLabel.has(key) || entity.length > (entityLabel.get(key) ?? "").length) {
        entityLabel.set(key, entity);
      }
      const entityId = `entity:${slug(key)}`;
      entityIds.push(entityId);
      if (log.topicId) bumpInMap(topicEntity, log.topicId, entityId, weight);
      if (log.taskId) bumpInMap(taskEntity, log.taskId, entityId, weight);
      if (agentLabel && !excludeAgentFocus) bumpInMap(agentEntity, agentLabel, entityId, weight * 0.85);
    });

    const uniq = Array.from(new Set(entityIds)).sort();
    for (let i = 0; i < uniq.length; i += 1) {
      for (let j = i + 1; j < uniq.length; j += 1) {
        addEdge(uniq[i], uniq[j], "co_occurs", Math.max(0.12, weight * 0.38), true);
      }
    }
  }

  const selectedEntity = Array.from(entityScore.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntities);
  const selectedEntityIds = new Set(selectedEntity.map(([key]) => `entity:${slug(key)}`));

  selectedEntity.forEach(([key, score]) => {
    const entityId = `entity:${slug(key)}`;
    nodeMap.set(entityId, {
      id: entityId,
      label: entityLabel.get(key) ?? key,
      type: "entity",
      score: 0.9 + score,
      meta: {
        entityKey: key,
        mentions: Number(score.toFixed(3)),
      },
    });
  });

  topicEntity.forEach((entityMap, topicId) => {
    const source = `topic:${topicId}`;
    if (!nodeMap.has(source)) return;
    entityMap.forEach((weight, entityId) => {
      if (!selectedEntityIds.has(entityId)) return;
      addEdge(source, entityId, "mentions", weight);
      const node = nodeMap.get(source);
      if (node) node.score += weight * 0.05;
    });
  });

  taskEntity.forEach((entityMap, taskId) => {
    const source = `task:${taskId}`;
    if (!nodeMap.has(source)) return;
    entityMap.forEach((weight, entityId) => {
      if (!selectedEntityIds.has(entityId)) return;
      addEdge(source, entityId, "mentions", weight);
      const node = nodeMap.get(source);
      if (node) node.score += weight * 0.035;
    });
  });

  agentEntity.forEach((entityMap, agentLabel) => {
    const source = `agent:${slug(agentLabel)}`;
    if (!nodeMap.has(source)) return;
    entityMap.forEach((weight, entityId) => {
      if (!selectedEntityIds.has(entityId)) return;
      addEdge(source, entityId, "agent_focus", weight);
    });
  });

  const topicNameById = new Map(topics.map((topic) => [topic.id, topic.name]));
  for (let i = 0; i < topics.length; i += 1) {
    for (let j = i + 1; j < topics.length; j += 1) {
      const left = topics[i];
      const right = topics[j];
      const leftMap = topicEntity.get(left.id) ?? new Map<string, number>();
      const rightMap = topicEntity.get(right.id) ?? new Map<string, number>();
      let shared = 0;
      leftMap.forEach((weight, entityId) => {
        if (selectedEntityIds.has(entityId) && rightMap.has(entityId)) {
          shared += Math.min(weight, rightMap.get(entityId) ?? 0);
        }
      });
      const lexical = jaccard(topicNameById.get(left.id) ?? "", topicNameById.get(right.id) ?? "");
      const score = shared * 0.12 + lexical;
      if (score < 0.28) continue;
      addEdge(`topic:${left.id}`, `topic:${right.id}`, "related_topic", score, true);
    }
  }

  const tasksByTopic = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.topicId) continue;
    const list = tasksByTopic.get(task.topicId) ?? [];
    list.push(task);
    tasksByTopic.set(task.topicId, list);
  }
  tasksByTopic.forEach((bucket) => {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const left = bucket[i];
        const right = bucket[j];
        const leftMap = taskEntity.get(left.id) ?? new Map<string, number>();
        const rightMap = taskEntity.get(right.id) ?? new Map<string, number>();
        let shared = 0;
        leftMap.forEach((weight, entityId) => {
          if (selectedEntityIds.has(entityId) && rightMap.has(entityId)) {
            shared += Math.min(weight, rightMap.get(entityId) ?? 0);
          }
        });
        if (shared < 0.95) continue;
        addEdge(`task:${left.id}`, `task:${right.id}`, "related_task", shared * 0.11, true);
      }
    }
  });

  const structural = new Set<string>();
  nodeMap.forEach((node, nodeId) => {
    if (node.type !== "entity") structural.add(nodeId);
  });
  const entityRank = Array.from(nodeMap.entries())
    .filter(([, node]) => node.type === "entity")
    .sort((a, b) => b[1].score - a[1].score)
    .map(([id]) => id);
  const keepEntityCount = Math.max(10, Math.min(maxEntities, maxNodes - structural.size));
  const keepNodes = new Set(structural);
  entityRank.slice(0, keepEntityCount).forEach((id) => keepNodes.add(id));

  const edges: ClawgraphEdge[] = Array.from(edgeWeights.entries())
    .map(([key, weight]) => {
      const [source, target, type] = key.split("|");
      return {
        id: "",
        source,
        target,
        type: type as ClawgraphEdgeType,
        weight: Number(weight.toFixed(4)),
        evidence: edgeEvidence.get(key) ?? 1,
      };
    })
    .filter((edge) => keepNodes.has(edge.source) && keepNodes.has(edge.target))
    .filter((edge) => edge.type === "has_task" || edge.weight >= minEdgeWeight)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 1200)
    .map((edge, index) => ({ ...edge, id: `edge-${index + 1}` }));

  const usedNodes = new Set<string>();
  edges.forEach((edge) => {
    usedNodes.add(edge.source);
    usedNodes.add(edge.target);
  });
  keepNodes.forEach((nodeId) => {
    if (nodeId.startsWith("topic:") || nodeId.startsWith("task:")) usedNodes.add(nodeId);
  });

  const graphNodes: ClawgraphNode[] = Array.from(nodeMap.values())
    .filter((node) => usedNodes.has(node.id))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return b.score - a.score;
    })
    .map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      score: Number(node.score.toFixed(4)),
      size: nodeSize(node.type, node.score),
      color: NODE_COLORS[node.type],
      meta: node.meta,
    }));

  const topicCount = graphNodes.filter((node) => node.type === "topic").length;
  const taskCount = graphNodes.filter((node) => node.type === "task").length;
  const entityCount = graphNodes.filter((node) => node.type === "entity").length;
  const agentCount = graphNodes.filter((node) => node.type === "agent").length;
  const densityBase = Math.max(1, (graphNodes.length * (graphNodes.length - 1)) / 2);
  const density = Math.min(1, edges.length / densityBase);

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      nodeCount: graphNodes.length,
      edgeCount: edges.length,
      topicCount,
      taskCount,
      entityCount,
      agentCount,
      density: Number(density.toFixed(4)),
    },
    nodes: graphNodes,
    edges,
  };
}

export type GraphLayoutPosition = {
  x: number;
  y: number;
};

function desiredEdgeDistance(type: ClawgraphEdgeType) {
  switch (type) {
    case "has_task":
      return 150;
    case "mentions":
      return 205;
    case "agent_focus":
      return 225;
    case "co_occurs":
      return 280;
    case "related_task":
      return 255;
    case "related_topic":
      return 300;
    default:
      return 235;
  }
}

export function layoutClawgraph(
  nodes: ClawgraphNode[],
  edges: ClawgraphEdge[],
  width: number,
  height: number,
  iterations = 160
) {
  if (nodes.length === 0) return new Map<string, GraphLayoutPosition>();
  const safeWidth = Math.max(520, width || 980);
  const safeHeight = Math.max(420, height || 680);
  const centerX = safeWidth / 2;
  const centerY = safeHeight / 2;

  const typeOrder: ClawgraphNodeType[] = ["topic", "task", "entity", "agent"];
  const groupedByType: Record<ClawgraphNodeType, ClawgraphNode[]> = {
    topic: [],
    task: [],
    entity: [],
    agent: [],
  };
  nodes.forEach((node) => groupedByType[node.type].push(node));
  const orderedNodes = typeOrder.flatMap((type) => groupedByType[type]);

  const indexById = new Map<string, number>();
  orderedNodes.forEach((node, index) => {
    indexById.set(node.id, index);
  });

  const edgePairs = edges
    .map((edge) => {
      const source = indexById.get(edge.source);
      const target = indexById.get(edge.target);
      if (source === undefined || target === undefined) return null;
      return { source, target, weight: edge.weight, type: edge.type };
    })
    .filter((item): item is { source: number; target: number; weight: number; type: ClawgraphEdgeType } => Boolean(item));

  const adjacency = Array.from({ length: orderedNodes.length }, () => new Set<number>());
  edgePairs.forEach((edge) => {
    adjacency[edge.source]?.add(edge.target);
    adjacency[edge.target]?.add(edge.source);
  });

  const componentByIndex = new Int32Array(orderedNodes.length);
  componentByIndex.fill(-1);
  const components: number[][] = [];

  for (let i = 0; i < orderedNodes.length; i += 1) {
    if (componentByIndex[i] !== -1) continue;
    const componentId = components.length;
    const stack = [i];
    const indices: number[] = [];
    componentByIndex[i] = componentId;
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;
      indices.push(current);
      adjacency[current]?.forEach((next) => {
        if (componentByIndex[next] !== -1) return;
        componentByIndex[next] = componentId;
        stack.push(next);
      });
    }
    components.push(indices);
  }

  const edgeCountByComponent = new Map<number, number>();
  edgePairs.forEach((edge) => {
    const sourceComponent = componentByIndex[edge.source];
    const targetComponent = componentByIndex[edge.target];
    if (sourceComponent !== targetComponent) return;
    edgeCountByComponent.set(sourceComponent, (edgeCountByComponent.get(sourceComponent) ?? 0) + 1);
  });

  const boundX = safeWidth * 0.35;
  const boundY = safeHeight * 0.35;
  const componentAnchors = Array.from({ length: components.length }, () => ({ x: centerX, y: centerY }));
  const orderedComponents = components
    .map((indices, id) => ({
      id,
      size: indices.length,
      edgeCount: edgeCountByComponent.get(id) ?? 0,
    }))
    .sort((a, b) => {
      if (a.size !== b.size) return b.size - a.size;
      if (a.edgeCount !== b.edgeCount) return b.edgeCount - a.edgeCount;
      return a.id - b.id;
    });

  const baseSpan = Math.min(safeWidth, safeHeight);
  const islandStartRadius = baseSpan * 0.34;
  const islandRadiusStep = baseSpan * 0.17;
  orderedComponents.forEach((component, orderIndex) => {
    if (orderIndex === 0) {
      componentAnchors[component.id] = { x: centerX, y: centerY };
      return;
    }
    const offsetIndex = orderIndex - 1;
    const angle = offsetIndex * 2.399963229728653;
    const singletonBoost = component.size <= 1 ? baseSpan * 0.12 : 0;
    const radius = islandStartRadius + Math.sqrt(offsetIndex + 1) * islandRadiusStep + singletonBoost;
    const nextX = centerX + Math.cos(angle) * radius;
    const nextY = centerY + Math.sin(angle) * radius;
    componentAnchors[component.id] = {
      x: Math.max(-boundX * 0.55, Math.min(safeWidth + boundX * 0.55, nextX)),
      y: Math.max(-boundY * 0.55, Math.min(safeHeight + boundY * 0.55, nextY)),
    };
  });

  const x = new Float64Array(orderedNodes.length);
  const y = new Float64Array(orderedNodes.length);
  const vx = new Float64Array(orderedNodes.length);
  const vy = new Float64Array(orderedNodes.length);
  const nodesByComponentType: Array<Record<ClawgraphNodeType, number[]>> = components.map(() => ({
    topic: [],
    task: [],
    entity: [],
    agent: [],
  }));

  orderedNodes.forEach((node, index) => {
    const componentId = componentByIndex[index];
    nodesByComponentType[componentId]?.[node.type].push(index);
  });

  components.forEach((indices, componentId) => {
    const anchor = componentAnchors[componentId] ?? { x: centerX, y: centerY };
    const componentSize = indices.length;
    const baseRadius = Math.max(38, Math.min(188, 32 + componentSize * 6));
    typeOrder.forEach((type) => {
      const bucket = nodesByComponentType[componentId]?.[type] ?? [];
      if (bucket.length === 0) return;
      const scale = type === "topic" ? 0.46 : type === "task" ? 0.74 : type === "entity" ? 1.02 : 1.28;
      const radius = baseRadius * scale;
      bucket.forEach((nodeIndex, position) => {
        const angle = (position / Math.max(1, bucket.length)) * Math.PI * 2 + componentId * 0.29;
        const jitter = ((position % 5) - 2) * 2.6;
        x[nodeIndex] = anchor.x + Math.cos(angle) * radius + jitter;
        y[nodeIndex] = anchor.y + Math.sin(angle) * radius + jitter;
      });
    });
  });

  const kRepel = 2600;
  const crossComponentRepel = 0.16;
  const damping = 0.82;
  const centering = 0.0024;

  for (let iter = 0; iter < iterations; iter += 1) {
    for (let i = 0; i < orderedNodes.length; i += 1) {
      for (let j = i + 1; j < orderedNodes.length; j += 1) {
        const dx = x[j] - x[i];
        const dy = y[j] - y[i];
        const dist2 = dx * dx + dy * dy + 24;
        const dist = Math.sqrt(dist2);
        const sameComponent = componentByIndex[i] === componentByIndex[j];
        const force = (sameComponent ? kRepel : kRepel * crossComponentRepel) / dist2;
        const nx = dx / dist;
        const ny = dy / dist;
        vx[i] -= nx * force;
        vy[i] -= ny * force;
        vx[j] += nx * force;
        vy[j] += ny * force;
      }
    }

    edgePairs.forEach((edge) => {
      const dx = x[edge.target] - x[edge.source];
      const dy = y[edge.target] - y[edge.source];
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const desired = desiredEdgeDistance(edge.type);
      const spring = (dist - desired) * (0.0022 + Math.min(0.004, edge.weight * 0.002));
      const nx = dx / dist;
      const ny = dy / dist;
      vx[edge.source] += nx * spring;
      vy[edge.source] += ny * spring;
      vx[edge.target] -= nx * spring;
      vy[edge.target] -= ny * spring;
    });

    for (let i = 0; i < orderedNodes.length; i += 1) {
      const componentId = componentByIndex[i];
      const anchor = componentAnchors[componentId] ?? { x: centerX, y: centerY };
      const componentSize = components[componentId]?.length ?? 1;
      const pull = componentSize <= 1 ? centering * 1.5 : centering;
      vx[i] += (anchor.x - x[i]) * pull;
      vy[i] += (anchor.y - y[i]) * pull;
      vx[i] *= damping;
      vy[i] *= damping;
      x[i] += vx[i];
      y[i] += vy[i];
      // Allow nodes to drift slightly out of view; users can pan/zoom back.
      x[i] = Math.max(-boundX, Math.min(safeWidth + boundX, x[i]));
      y[i] = Math.max(-boundY, Math.min(safeHeight + boundY, y[i]));
    }
  }

  const out = new Map<string, GraphLayoutPosition>();
  orderedNodes.forEach((node) => {
    const idx = indexById.get(node.id);
    if (idx === undefined) return;
    out.set(node.id, { x: Number(x[idx].toFixed(2)), y: Number(y[idx].toFixed(2)) });
  });
  return out;
}
