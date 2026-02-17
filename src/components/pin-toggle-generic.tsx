"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Topic, Task } from "@/lib/types";
import { useAppConfig } from "@/components/providers";
import { cn } from "@/lib/cn";
import { apiFetch } from "@/lib/api";

interface PinToggleGenericProps {
  item: Topic | Task;
  itemType: "topic" | "task";
  onToggled?: (nextPinned: boolean) => void;
  size?: "sm" | "md";
}

export function PinToggleGeneric({
  item,
  itemType,
  onToggled,
  size = "md",
}: PinToggleGenericProps) {
  const { token, tokenRequired } = useAppConfig();
  const router = useRouter();
  const readOnly = tokenRequired && !token;
  const [saving, setSaving] = useState(false);

  const togglePinned = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (readOnly || saving) return;
    setSaving(true);
    
    const endpoint = itemType === "topic" ? "/api/topics" : "/api/tasks";
    
    // Prepare the payload - for topics we need to include the name
    const payload = {
      ...item,
      pinned: !item.pinned,
    } as Topic | Task;
    
    // For topics, ensure name is included
    if (itemType === "topic" && 'name' in item && item.name) {
      (payload as Topic).name = item.name;
    }

    const res = await apiFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }, token);
    
    if (res.ok) {
      onToggled?.(!item.pinned);
      if (!onToggled) {
        router.refresh();
      }
    }
    setSaving(false);
  };

  const isPinned = Boolean(item.pinned);
  const baseSize = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const iconSize = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  const color = isPinned ? "text-[rgb(var(--claw-text))]" : "text-[rgb(var(--claw-muted))]";
  const title = isPinned 
    ? `Unpin ${itemType}` 
    : `Pin ${itemType}`;

  return (
    <button
      type="button"
      onClick={togglePinned}
      disabled={readOnly || saving}
      aria-pressed={isPinned}
      title={title}
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
