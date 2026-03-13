import type { Topic } from "@/lib/types";
import { encodeTopicSlug } from "@/lib/slug";

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

/** @deprecated Tasks merged into Topics. Delegates to buildTopicUrl. */
export function buildTaskUrl(
  task: TopicLike & { title?: string; topicId?: string | null },
  topics?: TopicLike[],
) {
  return buildTopicUrl({ id: task.id, name: task.title ?? task.name, parentId: task.parentId }, topics);
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

export function withSpaceParam(href: string, spaceId?: string | null) {
  const [withoutHash, hash = ""] = href.split("#", 2);
  const [path, query = ""] = withoutHash.split("?", 2);
  const params = new URLSearchParams(query);
  const normalized = String(spaceId ?? "").trim();
  if (normalized && normalized !== "space-default") {
    params.set("space", normalized);
  } else {
    params.delete("space");
  }
  const nextQuery = params.toString();
  const nextHref = nextQuery ? `${path}?${nextQuery}` : path;
  return hash ? `${nextHref}#${hash}` : nextHref;
}
