import type { Task, Topic } from "@/lib/types";
import { encodeTaskSlug, encodeTopicSlug } from "@/lib/slug";

export const UNIFIED_BASE = "/u";

type TopicLike = Pick<Topic, "id" | "name" | "parentId">;

const buildTopicChain = (topic: TopicLike, topics?: TopicLike[]) => {
  if (!topics || topics.length === 0) return [topic];
  const map = new Map(topics.map((item) => [item.id, item]));
  const chain: TopicLike[] = [];
  const seen = new Set<string>();
  let current: TopicLike | undefined = topic;
  while (current && !seen.has(current.id)) {
    chain.unshift(current);
    seen.add(current.id);
    current = current.parentId ? map.get(current.parentId) : undefined;
  }
  return chain;
};

export function buildTopicUrl(topic: TopicLike, topics?: TopicLike[]) {
  const chain = buildTopicChain(topic, topics);
  const segments = chain.map((item) => `topic/${encodeTopicSlug(item)}`).join("/");
  return `${UNIFIED_BASE}/${segments}`;
}

export function buildTaskUrl(
  task: Pick<Task, "id" | "title" | "topicId">,
  topics?: TopicLike[],
  overrideTopic?: TopicLike | null
) {
  const topic = overrideTopic ?? topics?.find((item) => item.id === task.topicId) ?? null;
  if (topic) {
    const base = buildTopicUrl(topic, topics);
    return `${base}/task/${encodeTaskSlug({ id: task.id, title: task.title })}`;
  }
  return `${UNIFIED_BASE}/task/${encodeTaskSlug({ id: task.id, title: task.title })}`;
}

export function withRevealParam(href: string, enabled = true) {
  const [withoutHash, hash = ""] = href.split("#", 2);
  const [path, query = ""] = withoutHash.split("?", 2);
  const params = new URLSearchParams(query);
  if (enabled) {
    params.set("reveal", "1");
  } else {
    params.delete("reveal");
  }
  const nextQuery = params.toString();
  const nextHref = nextQuery ? `${path}?${nextQuery}` : path;
  return hash ? `${nextHref}#${hash}` : nextHref;
}
