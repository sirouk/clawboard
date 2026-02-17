import { cn } from "@/lib/cn";
import type { ChangeEvent, ComponentProps } from "react";

// iOS Safari zooms the page when focusing inputs with font-size < 16px.
// Default to 16px on small screens, and keep the denser `text-sm` on desktop.
const FORM_FIELD_TEXT_SIZE = "max-md:text-[16px] md:text-sm";
const FORM_FIELD_DISABLED = "disabled:cursor-not-allowed disabled:opacity-70";
const FORM_FIELD_PLACEHOLDER_HINT = "placeholder:font-normal placeholder:opacity-60";

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
        "h-11 w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 text-[rgb(var(--claw-text))] placeholder:text-[rgb(var(--claw-muted))] transition focus:border-[rgb(var(--claw-accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(226,86,64,0.2)]",
        FORM_FIELD_TEXT_SIZE,
        FORM_FIELD_DISABLED,
        FORM_FIELD_PLACEHOLDER_HINT,
        className
      )}
      {...props}
    />
  );
}

type SearchInputProps = Omit<ComponentProps<"input">, "type" | "className"> & {
  className?: string;
  inputClassName?: string;
  onClear?: () => void;
};

export function SearchInput({ className, inputClassName, onClear, value, onChange, ...props }: SearchInputProps) {
  const hasValue = typeof value === "string" ? value.length > 0 : false;

  const handleClear = () => {
    if (onClear) {
      onClear();
      return;
    }
    if (typeof onChange === "function") {
      const syntheticEvent = { target: { value: "" } } as ChangeEvent<HTMLInputElement>;
      onChange(syntheticEvent);
    }
  };

  return (
    <div className={cn("relative", className)}>
      <Input
        type="search"
        value={value}
        onChange={onChange}
        className={cn(
          "w-full pr-10 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none",
          inputClassName
        )}
        {...props}
      />
      {hasValue ? (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-[rgb(var(--claw-border))] bg-[rgba(14,17,22,0.94)] text-[rgb(var(--claw-muted))] transition hover:border-[rgba(255,90,45,0.45)] hover:text-[rgb(var(--claw-text))]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-11 w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 text-[rgb(var(--claw-text))] transition focus:border-[rgb(var(--claw-accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(226,86,64,0.2)]",
        FORM_FIELD_TEXT_SIZE,
        FORM_FIELD_DISABLED,
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
        "min-h-[120px] w-full rounded-[var(--radius-md)] border border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel-2))] px-3 py-2 text-[rgb(var(--claw-text))] placeholder:text-[rgb(var(--claw-muted))] transition focus:border-[rgb(var(--claw-accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(226,86,64,0.2)]",
        FORM_FIELD_TEXT_SIZE,
        FORM_FIELD_DISABLED,
        FORM_FIELD_PLACEHOLDER_HINT,
        className
      )}
      {...props}
    />
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-[rgba(226,86,64,0.4)] focus:ring-offset-2 focus:ring-offset-[rgb(var(--claw-panel))]",
        checked ? "bg-[rgb(var(--claw-accent))]" : "bg-[rgb(var(--claw-panel-3))]",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
          checked ? "translate-x-5" : "translate-x-0"
        )}
      />
    </button>
  );
}
