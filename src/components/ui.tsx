import { cn } from "@/lib/cn";
import type { ComponentProps } from "react";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-lg)] border border-[rgb(var(--claw-border))] bg-[linear-gradient(145deg,rgba(28,32,40,0.92),rgba(16,19,24,0.88))] p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.25),0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur transition-colors hover:border-[rgba(255,90,45,0.3)]",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mb-4 flex items-center justify-between", className)} {...props} />;
}

export type BadgeTone = "muted" | "accent" | "accent2" | "success" | "warning" | "danger";

export function Badge({ className, tone = "muted", ...props }: ComponentProps<"span"> & { tone?: BadgeTone }) {
  const toneClasses: Record<string, string> = {
    muted: "border-[rgb(var(--claw-border))] text-[rgb(var(--claw-muted))]",
    accent: "border-[rgba(226,86,64,0.5)] text-[rgb(var(--claw-accent))]",
    accent2: "border-[rgba(77,171,158,0.5)] text-[rgb(var(--claw-accent-2))]",
    success: "border-[rgba(80,200,120,0.5)] text-[rgb(var(--claw-success))]",
    warning: "border-[rgba(234,179,8,0.5)] text-[rgb(var(--claw-warning))]",
    danger: "border-[rgba(239,68,68,0.5)] text-[rgb(var(--claw-danger))]",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-[0.12em]",
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}

export function StatusPill({
  className,
  tone = "muted",
  label,
}: {
  className?: string;
  tone?: BadgeTone;
  label: string;
}) {
  const toneClasses: Record<string, string> = {
    muted: "bg-[rgba(148,163,184,0.14)] text-[rgb(var(--claw-muted))]",
    accent: "bg-[rgba(255,90,45,0.16)] text-[rgb(var(--claw-accent))]",
    accent2: "bg-[rgba(77,171,158,0.16)] text-[rgb(var(--claw-accent-2))]",
    success: "bg-[rgba(80,200,120,0.16)] text-[rgb(var(--claw-success))]",
    warning: "bg-[rgba(234,179,8,0.16)] text-[rgb(var(--claw-warning))]",
    danger: "bg-[rgba(239,68,68,0.16)] text-[rgb(var(--claw-danger))]",
  };

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-semibold tracking-[0.12em]",
        toneClasses[tone],
        className
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span>{label}</span>
    </span>
  );
}

export function Button({ className, variant = "primary", size = "md", ...props }: ComponentProps<"button"> & { variant?: "primary" | "secondary" | "ghost"; size?: "sm" | "md" }) {
  const variants: Record<string, string> = {
    primary:
      "bg-[rgb(var(--claw-accent))] text-black shadow-[0_0_20px_rgba(226,86,64,0.25)] hover:bg-[rgb(236,110,90)]",
    secondary:
      "bg-[rgb(var(--claw-panel-2))] text-[rgb(var(--claw-text))] border border-[rgb(var(--claw-border))] hover:bg-[rgba(255,255,255,0.04)]",
    ghost: "bg-transparent text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]",
  };
  const sizes: Record<string, string> = {
    sm: "h-9 px-3 text-sm",
    md: "h-11 px-4 text-sm",
  };
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(226,86,64,0.4)] disabled:cursor-not-allowed disabled:opacity-60",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 text-sm text-[rgb(var(--claw-text))] placeholder:text-[rgb(var(--claw-muted))] transition focus:border-[rgb(var(--claw-accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(226,86,64,0.2)]",
        className
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-11 w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 text-sm text-[rgb(var(--claw-text))] transition focus:border-[rgb(var(--claw-accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(226,86,64,0.2)]",
        className
      )}
      {...props}
    />
  );
}

export function TextArea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-[120px] w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 py-2 text-sm text-[rgb(var(--claw-text))] placeholder:text-[rgb(var(--claw-muted))] transition focus:border-[rgb(var(--claw-accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(226,86,64,0.2)]",
        className
      )}
      {...props}
    />
  );
}
