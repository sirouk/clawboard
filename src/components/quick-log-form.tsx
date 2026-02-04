"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Select, TextArea } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { apiUrl } from "@/lib/api";

export function QuickLogForm({ topicId, taskId }: { topicId?: string | null; taskId?: string | null }) {
  const router = useRouter();
  const { token, tokenRequired } = useAppConfig();
  const [content, setContent] = useState("");
  const [type, setType] = useState("note");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readOnly = tokenRequired && !token;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!content.trim()) {
      setError("Log content is required.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(apiUrl("/api/log"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Clawboard-Token": token,
        },
        body: JSON.stringify({
          topicId: topicId ?? null,
          taskId: taskId ?? null,
          type,
          content: content.trim(),
          summary: content.trim(),
          agentId: "ui",
          agentLabel: "Clawboard UI",
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to create log entry.");
      }

      setContent("");
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
        <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Log type</label>
        <Select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="note">Note</option>
          <option value="conversation">Conversation</option>
          <option value="action">Action</option>
          <option value="system">System</option>
        </Select>
      </div>
      <div>
        <label className="text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))]">Log entry</label>
        <TextArea value={content} onChange={(event) => setContent(event.target.value)} placeholder="What happened?" />
      </div>
      {readOnly && <p className="text-sm text-[rgb(var(--claw-warning))]">Token required for changes. Set it in Setup.</p>}
      {error && <p className="text-sm text-[rgb(var(--claw-danger))]">{error}</p>}
      <Button type="submit" disabled={saving || readOnly}>
        {saving ? "Saving..." : "Add log"}
      </Button>
    </form>
  );
}