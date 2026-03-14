"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Topic } from "@/lib/types";
import { Button, Input, Select } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { useLocalStorageItem } from "@/lib/local-storage";
import { queueableApiMutation } from "@/lib/write-queue";

export function TaskCreateForm({ topics, defaultTopicId }: { topics: Topic[]; defaultTopicId?: string | null }) {
  const router = useRouter();
  const { token, tokenRequired } = useAppConfig();
  const activeSpaceId = (useLocalStorageItem("clawboard.space.active") ?? "").trim();
  const [title, setTitle] = useState("");
  const [topicId, setTopicId] = useState(defaultTopicId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readOnly = tokenRequired && !token;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError("Topic title is required.");
      return;
    }

    const parentTopic = topics.find((topic) => topic.id === topicId) ?? null;
    const resolvedSpaceId = String(parentTopic?.spaceId ?? "").trim() || activeSpaceId;

    setSaving(true);
    try {
      const queuedUpdatedAt = new Date().toISOString();
      const res = await queueableApiMutation(
        "/api/topics",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: title.trim(),
            status: "todo",
            spaceId: resolvedSpaceId || undefined,
            tags: parentTopic?.tags ?? undefined,
          }),
        },
        {
          token,
          queuedResponse: {
            id: `topic-${queuedUpdatedAt}`,
            spaceId: resolvedSpaceId || "space-default",
            name: title.trim(),
            status: "todo",
            tags: parentTopic?.tags ?? [],
            createdBy: "user",
            sortIndex: 0,
            createdAt: queuedUpdatedAt,
            updatedAt: queuedUpdatedAt,
            queued: true,
          },
        }
      );

      if (!res.ok) {
        throw new Error("Failed to create topic.");
      }

      setTitle("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={handleSubmit}>
      <div>
        <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Title</label>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add a new topic" />
      </div>
      <div>
        <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Topic</label>
        <Select value={topicId} onChange={(event) => setTopicId(event.target.value)}>
          <option value="">Unassigned</option>
          {topics.map((topic) => (
            <option key={topic.id} value={topic.id}>
              {topic.name}
            </option>
          ))}
        </Select>
      </div>
      {readOnly && <p className="text-sm text-[rgb(var(--claw-warning))]">Token required for changes. Set it in Setup.</p>}
      {error && <p className="text-sm text-[rgb(var(--claw-danger))]">{error}</p>}
      <Button type="submit" disabled={saving || readOnly}>
        {saving ? "Adding..." : "Add topic"}
      </Button>
    </form>
  );
}
