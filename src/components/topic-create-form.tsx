"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Select, TextArea } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { apiFetch } from "@/lib/api";

export function TopicCreateForm() {
  const router = useRouter();
  const { token, tokenRequired } = useAppConfig();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Topic name is required.");
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch(
        "/api/topics",
        {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          priority,
        }),
        },
        token
      );

      if (!res.ok) {
        throw new Error("Failed to create topic.");
      }

      setName("");
      setDescription("");
      setPriority("medium");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  };

  const readOnly = tokenRequired && !token;

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <div>
        <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Name</label>
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Topic name" />
      </div>
      <div>
        <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Description</label>
        <TextArea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this topic about?" />
      </div>
      <div>
        <div>
          <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Priority</label>
          <Select value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        </div>
      </div>
      {readOnly && (
        <p className="text-sm text-[rgb(var(--claw-warning))]">
          Token required for changes. Set it in Setup.
        </p>
      )}
      {error && <p className="text-sm text-[rgb(var(--claw-danger))]">{error}</p>}
      <Button type="submit" disabled={saving || readOnly}>
        {saving ? "Creating..." : "Create topic"}
      </Button>
    </form>
  );
}
