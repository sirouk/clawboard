"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Topic } from "@/lib/types";
import { Button, Input, Select } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { apiUrl } from "@/lib/api";

export function TaskCreateForm({ topics, defaultTopicId }: { topics: Topic[]; defaultTopicId?: string | null }) {
  const router = useRouter();
  const { token, tokenRequired } = useAppConfig();
  const [title, setTitle] = useState("");
  const [topicId, setTopicId] = useState(defaultTopicId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readOnly = tokenRequired && !token;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError("Task title is required.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(apiUrl("/api/tasks"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Clawboard-Token": token,
        },
        body: JSON.stringify({
          title: title.trim(),
          topicId: topicId || null,
          status: "todo",
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to create task.");
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
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add a new task" />
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
        {saving ? "Adding..." : "Add task"}
      </Button>
    </form>
  );
}