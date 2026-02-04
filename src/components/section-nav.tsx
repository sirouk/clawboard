"use client";

import { cn } from "@/lib/cn";

export function SectionNav({ items }: { items: Array<{ id: string; label: string }> }) {
  return (
    <div className="sticky top-0 z-10 -mx-6 border-b border-[rgb(var(--claw-border))] bg-[rgba(10,12,16,0.9)] px-6 py-3 backdrop-blur">
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className={cn(
              "rounded-full border border-[rgb(var(--claw-border))] px-4 py-2 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))] transition",
              "hover:border-[rgba(255,90,45,0.5)] hover:text-[rgb(var(--claw-text))]"
            )}
          >
            {item.label}
          </a>
        ))}
      </div>
    </div>
  );
}
