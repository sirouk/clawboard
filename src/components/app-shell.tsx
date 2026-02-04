"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui";
import { useAppConfig } from "@/components/providers";
import { cn } from "@/lib/cn";
import { CommandPalette } from "@/components/command-palette";
import { getApiBase } from "@/lib/api";
import { DataProvider } from "@/components/data-provider";

const ICONS: Record<string, React.ReactElement> = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h6M4 12h10M4 18h14" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="20" cy="12" r="2" />
      <circle cx="22" cy="18" r="2" />
    </svg>
  ),
  stats: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19h16" />
      <path d="M7 16V10" />
      <path d="M12 16V6" />
      <path d="M17 16v-4" />
    </svg>
  ),
  setup: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
      <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 0 1-4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 0 1 0-4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V4a2 2 0 0 1 4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6H20a2 2 0 0 1 0 4h-.2a1 1 0 0 0-.9.6z" />
    </svg>
  ),
  providers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <path d="M16.5 7.5c0-2-2-3-4.5-3s-4.5 1-4.5 3 2 3 4.5 3 4.5 1 4.5 3-2 3-4.5 3-4.5-1-4.5-3" />
      <path d="M4 20l16-16" />
    </svg>
  ),
};

const NAV_ITEMS = [
  { href: "/u", label: "Home", id: "home" },
  { href: "/stats", label: "Stats", id: "stats" },
  { href: "/providers", label: "Providers", id: "providers" },
  { href: "/setup", label: "Setup", id: "setup" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { instanceTitle, token, tokenRequired } = useAppConfig();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("clawboard.navCollapsed") === "true";
  });

  const status = tokenRequired ? (token ? "CONNECTED" : "READ-ONLY") : "OPEN";
  const statusTone: BadgeTone = tokenRequired ? (token ? "success" : "warning") : "accent2";
  const statusTitle = tokenRequired
    ? token
      ? "Token set. Writes enabled."
      : "Token required for writes."
    : "No token required.";
  const docsHref = `${getApiBase() || ""}/docs`;
  const iconSize = collapsed ? 32 : 48;

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("clawboard.navCollapsed", next ? "true" : "false");
      }
      return next;
    });
  };

  return (
    <DataProvider>
      <div className="min-h-screen bg-[rgb(var(--claw-bg))]">
        <div className="flex min-h-screen flex-col lg:flex-row">
          <aside
            className={cn(
              "border-b border-[rgb(var(--claw-border))] bg-[rgb(var(--claw-panel))] px-4 py-6 lg:min-h-screen lg:h-screen lg:border-b-0 lg:border-r transition-all lg:sticky lg:top-0 lg:self-start lg:flex lg:flex-col",
              collapsed ? "lg:w-20" : "lg:w-64"
            )}
          >
            <div>
              <div className="flex items-center justify-between lg:block">
                <Link href="/u" className="flex items-center justify-center">
                  <div className={cn("relative transition-all", collapsed ? "h-8 w-8" : "h-12 w-12")}>
                    <Image
                      src="/clawboard-mark.png"
                      alt="Clawboard"
                      width={iconSize}
                      height={iconSize}
                      priority
                      className="object-contain"
                    />
                  </div>
                </Link>
                <div className="lg:hidden">
                  <Badge tone={statusTone} title={statusTitle}>
                    {status}
                  </Badge>
                </div>
              </div>
              <nav className="mt-6 flex gap-3 lg:flex-col">
                {NAV_ITEMS.map((item) => {
                  const isUnified = item.href === "/u";
                  const active =
                    pathname === item.href ||
                    (isUnified && (pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/u")));
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        "flex items-center rounded-full text-sm transition",
                        collapsed ? "justify-center px-3 py-2" : "justify-between px-4 py-2",
                        active
                          ? "bg-[linear-gradient(90deg,rgba(255,90,45,0.24),rgba(255,90,45,0.04))] text-[rgb(var(--claw-text))] shadow-[0_0_0_1px_rgba(255,90,45,0.35)]"
                          : "text-[rgb(var(--claw-muted))] hover:text-[rgb(var(--claw-text))]"
                      )}
                      aria-label={item.label}
                      aria-current={active ? "page" : undefined}
                    >
                      <span className="flex items-center gap-2">
                        <span className="h-4 w-4 text-current">{ICONS[item.id]}</span>
                        {!collapsed && <span>{item.label}</span>}
                      </span>
                    </Link>
                  );
                })}
              </nav>
            </div>
            <div className="mt-auto hidden lg:block space-y-4">
              <button
                className={cn(
                  "flex items-center justify-center rounded-full border border-[rgb(var(--claw-border))] px-3 py-2 text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))] transition hover:text-[rgb(var(--claw-text))]",
                  collapsed ? "h-10 w-10" : "w-full"
                )}
                onClick={toggleCollapsed}
                aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
              >
                {collapsed ? "›" : "‹"}
              </button>
              <a
                href={docsHref}
                target="_blank"
                rel="noreferrer"
                className="block text-center text-xs uppercase tracking-[0.2em] text-[rgb(var(--claw-muted))] transition hover:text-[rgb(var(--claw-text))]"
              >
                API
              </a>
            </div>
          </aside>

          <div className="flex-1">
            <header className="border-b border-[rgb(var(--claw-border))] bg-[rgba(0,0,0,0.3)] px-6 py-4 backdrop-blur">
              <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between">
                <Link href="/u" className="block">
                  <div className="text-sm uppercase tracking-[0.3em] text-[rgb(var(--claw-muted))]">Clawboard</div>
                  <div className="text-lg font-semibold text-[rgb(var(--claw-text))]">{instanceTitle}</div>
                </Link>
                <div className="hidden items-center gap-3 lg:flex">
                  <Badge tone="muted">⌘K</Badge>
                  <Badge tone={statusTone} title={statusTitle}>
                    {status}
                  </Badge>
                </div>
              </div>
            </header>
            <main className="mx-auto w-full max-w-[1280px] px-6 py-8">{children}</main>
          </div>
        </div>
        <CommandPalette />
      </div>
    </DataProvider>
  );
}
