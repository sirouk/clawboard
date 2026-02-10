"use client";

import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";

export function Markdown({ children, className }: { children: string; className?: string }) {
  const text = typeof children === "string" ? children : String(children ?? "");
  if (!text.trim()) return null;

  return (
    <div className={cn("claw-markdown", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: ({ children }) => <p className="break-words">{children}</p>,
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
          code: ({ className, children, ...props }) => {
            const isBlock = typeof className === "string" && className.includes("language-");
            if (isBlock) {
              return (
                <code className={cn("font-mono text-xs", className)} {...props}>
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
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-[var(--radius-md)] bg-black/40 p-3 text-xs leading-relaxed text-[rgb(var(--claw-text))]">
              {children}
            </pre>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

