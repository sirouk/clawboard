import type { Topic } from "@/lib/types";
import { encodeTopicSlug } from "@/lib/slug";

export const UNIFIED_BASE = "/u";

type TopicLike = Pick<Topic, "id" | "name">;

export function buildTopicUrl(topic: TopicLike, topics?: TopicLike[]) {
  void topics;
  return `${UNIFIED_BASE}/topic/${encodeTopicSlug(topic)}`;
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

export function withFocusParam(href: string, enabled = true) {
  const [withoutHash, hash = ""] = href.split("#", 2);
  const [path, query = ""] = withoutHash.split("?", 2);
  const params = new URLSearchParams(query);
  if (enabled) {
    params.set("focus", "1");
  } else {
    params.delete("focus");
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
