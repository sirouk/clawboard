"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Topic } from "@/lib/types";
import { useAppConfig } from "@/components/providers";
import { cn } from "@/lib/cn";
import { apiUrl } from "@/lib/api";

export function PinToggle({
  topic,
  onToggled,
  size = "md",
}: {
  topic: Topic;
  onToggled?: (nextPinned: boolean) => void;
  size?: "sm" | "md";
}) {
  const { token, tokenRequired } = useAppConfig();
  const router = useRouter();
  const readOnly = tokenRequired && !token;
  const [saving, setSaving] = useState(false);

  const togglePinned = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (readOnly || saving) return;
    setSaving(true);
    const res = await fetch(apiUrl("/api/topics"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Clawboard-Token": token,
      },
      body: JSON.stringify({
        ...topic,
        name: topic.name,
        pinned: !topic.pinned,
      }),
    });
    if (res.ok) {
      onToggled?.(!topic.pinned);
      if (!onToggled) {
        router.refresh();
      }
    }
    setSaving(false);
  };

  const isPinned = Boolean(topic.pinned);
  const baseSize = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const iconSize = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  const color = isPinned ? "text-[rgb(var(--claw-text))]" : "text-[rgb(var(--claw-muted))]";

  return (
    <button
      type="button"
      onClick={togglePinned}
      disabled={readOnly || saving}
      aria-pressed={isPinned}
      title={isPinned ? "Unpin topic" : "Pin topic"}
      className={cn(
        "flex items-center justify-center rounded-full border border-[rgb(var(--claw-border))] transition hover:border-[rgba(255,90,45,0.3)]",
        baseSize,
        color,
        readOnly ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill={isPinned ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={iconSize}
      >
        <path d="M14 9V4h-4v5l-3 4h10l-3-4z" />
        <path d="M12 13v7" />
      </svg>
    </button>
  );
}