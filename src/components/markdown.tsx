"use client";

import { isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";

type MarkdownCodeProps = React.ComponentPropsWithoutRef<"code"> & {
  inline?: boolean;
  node?: unknown;
};

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const resetLater = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setState("idle"), 1400);
  };

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          try {
            await writeClipboardText(text);
            setState("copied");
          } catch {
            setState("failed");
          } finally {
            resetLater();
          }
        })();
      }}
      aria-label={state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy code"}
      title={state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      className={cn(
        "inline-flex items-center gap-1 rounded-[10px] border border-[rgba(255,255,255,0.14)] bg-black/55 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.22em]",
        "text-[rgba(var(--claw-muted),0.95)] shadow-[0_10px_22px_rgba(0,0,0,0.35)] backdrop-blur transition",
        "hover:border-[rgba(255,90,45,0.45)] hover:text-[rgb(var(--claw-text))]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(226,86,64,0.4)]",
        className
      )}
    >
      {state === "copied" ? (
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3.5 w-3.5">
          <path
            fillRule="evenodd"
            d="M16.704 5.296a1 1 0 0 1 0 1.414l-7.25 7.25a1 1 0 0 1-1.414 0l-3.25-3.25a1 1 0 1 1 1.414-1.414l2.543 2.543 6.543-6.543a1 1 0 0 1 1.414 0Z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3.5 w-3.5">
          <path d="M6 2a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1v-2H6V4h7v1h2V4a2 2 0 0 0-2-2H6Z" />
          <path d="M9 7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H9Zm0 2h7v9H9V9Z" />
        </svg>
      )}
      <span className="leading-none">{state === "copied" ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function Markdown({ children, className, highlightCommands = true }: { children: string; className?: string; highlightCommands?: boolean }) {
  const text = typeof children === "string" ? children : String(children ?? "");
  if (!text.trim()) return null;

  return (
    <div className={cn("claw-markdown", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: ({ children }) => {
            const content = children;
            // Check if the paragraph starts with a forwardslash command
            if (highlightCommands && typeof content === "string" && content.startsWith("/") && !content.includes("\n")) {
              const parts = content.split(/\s+/, 2);
              const cmd = parts[0];
              const rest = parts[1] || "";
              return (
                <p className="break-words">
                  <span className="font-bold text-[rgb(var(--claw-accent))]">{cmd}</span> {rest}
                </p>
              );
            }
            return (
              <p className="break-words">
                {children}
              </p>
            );
          },
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 decoration-[rgba(var(--claw-muted),0.72)] hover:decoration-[rgba(var(--claw-text),0.85)]"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="ml-5 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="ml-5 list-decimal space-y-1">{children}</ol>,
          li: ({ children }) => <li className="break-words">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[rgba(255,255,255,0.18)] pl-3 text-[rgba(var(--claw-text),0.92)]">
              {children}
            </blockquote>
          ),
          code: ({ inline, className, children, ...props }: MarkdownCodeProps) => {
            if (!inline) {
              return (
                <code className={cn("font-mono", className)} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className={cn(
                  "rounded-[8px] bg-black/35 px-1 py-0.5 font-mono text-[0.92em] text-[rgba(var(--claw-text),0.92)]",
                  className
                )}
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => {
            const raw = nodeText(children).replace(/\n$/, "");
            const isSingleLine = raw && !raw.includes("\n");
            const buttonPos = isSingleLine ? "top-1/2 -translate-y-1/2" : "bottom-2";
            const prePadding = isSingleLine ? "p-3 pr-14" : "p-3 pr-14 pb-9";
            return (
              <div className="relative">
                <pre
                  className={cn(
                    "overflow-x-auto rounded-[var(--radius-md)] bg-black/40 text-xs leading-relaxed text-[rgb(var(--claw-text))]",
                    prePadding
                  )}
                >
                  {children}
                </pre>
                {raw.trim() ? <CopyButton text={raw} className={cn("absolute right-2", buttonPos)} /> : null}
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
