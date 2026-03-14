import { chatKeyForTopic } from "@/lib/attention-state";
import { isChatNoiseLog } from "@/lib/chat-log-visibility";
import type { LogEntry, Topic } from "@/lib/types";

type TopicAttentionTopic = Pick<Topic, "id" | "createdAt" | "updatedAt">;

function normalizeStamp(value: string | null | undefined) {
  const stamp = String(value ?? "").trim();
  if (!stamp) return "";
  return Number.isFinite(Date.parse(stamp)) ? stamp : "";
}

function newerStamp(current: string, candidate: string) {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate > current ? candidate : current;
}

export function buildLatestTopicTouchById(logs: LogEntry[]) {
  const out: Record<string, string> = {};
  for (const entry of logs) {
    const topicId = String(entry.topicId ?? "").trim();
    if (!topicId) continue;
    if (isChatNoiseLog(entry)) continue;
    const stamp = normalizeStamp(entry.createdAt ?? entry.updatedAt);
    if (!stamp) continue;
    out[topicId] = newerStamp(out[topicId] ?? "", stamp);
  }
  return out;
}

export function topicLastTouchedAt(topic: TopicAttentionTopic, latestLogAt?: string | null) {
  let touchedAt = normalizeStamp(topic.updatedAt ?? topic.createdAt);
  touchedAt = newerStamp(touchedAt, normalizeStamp(latestLogAt));
  return touchedAt;
}

export function topicAttentionActivityAt(
  topic: TopicAttentionTopic,
  latestLogAt?: string | null,
  badgeAt?: number | null | undefined
) {
  let activityAt = topicLastTouchedAt(topic, latestLogAt);
  if (typeof badgeAt === "number" && Number.isFinite(badgeAt) && badgeAt > 0) {
    activityAt = newerStamp(activityAt, new Date(badgeAt).toISOString());
  }
  return activityAt;
}

export function deriveAttentionTopicIds({
  topics,
  latestTopicTouchById,
  topicSeenByKey,
  unsnoozedTopicBadges = {},
}: {
  topics: TopicAttentionTopic[];
  latestTopicTouchById: Record<string, string>;
  topicSeenByKey: Record<string, string>;
  unsnoozedTopicBadges?: Record<string, number>;
}) {
  const out = new Set<string>();
  for (const topic of topics) {
    const topicId = String(topic.id ?? "").trim();
    if (!topicId) continue;
    const activityAt = topicAttentionActivityAt(
      topic,
      latestTopicTouchById[topicId],
      unsnoozedTopicBadges[topicId]
    );
    if (!activityAt) continue;
    const seenAt = normalizeStamp(topicSeenByKey[chatKeyForTopic(topicId)] ?? "");
    if (!seenAt || activityAt > seenAt) out.add(topicId);
  }
  return out;
}
