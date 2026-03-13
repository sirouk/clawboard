"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import { useDataStore } from "@/components/data-provider";
import { cn } from "@/lib/cn";

// Show the banner after this many ms of disconnect, so brief blips don't flash.
const SHOW_DELAY_MS = 3_000;
// After reconnecting, show "Back online" briefly before hiding.
const DISMISS_DELAY_MS = 2_500;

type BannerState = "hidden" | "offline" | "reconnecting" | "synced";

export function ConnectionStatusBanner() {
  const { connectionStatus, disconnectedSince, hydrated } = useDataStore();
  const [bannerState, setBannerState] = useState<BannerState>("hidden");
  const wasDisconnectedRef = useRef(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Clear any pending timers on state change.
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }

    if (!hydrated) return;

    if (connectionStatus === "connected") {
      if (wasDisconnectedRef.current) {
        // Just reconnected — show "synced" briefly.
        wasDisconnectedRef.current = false;
        startTransition(() => {
          setBannerState("synced");
        });
        dismissTimerRef.current = setTimeout(() => {
          setBannerState("hidden");
        }, DISMISS_DELAY_MS);
      } else {
        startTransition(() => {
          setBannerState("hidden");
        });
      }
      return;
    }

    // Disconnected (offline or reconnecting). Delay showing the banner to avoid flashing
    // on brief network hiccups.
    const elapsed = disconnectedSince ? Date.now() - disconnectedSince : 0;
    const remaining = Math.max(0, SHOW_DELAY_MS - elapsed);

    const show = () => {
      wasDisconnectedRef.current = true;
      setBannerState(connectionStatus === "offline" ? "offline" : "reconnecting");
    };

    if (remaining <= 0) {
      show();
    } else {
      showTimerRef.current = setTimeout(show, remaining);
    }

    return () => {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [connectionStatus, disconnectedSince, hydrated]);

  // Update banner when switching between offline and reconnecting while already visible.
  useEffect(() => {
    if (bannerState !== "offline" && bannerState !== "reconnecting") return;
    const target = connectionStatus === "offline" ? "offline" : "reconnecting";
    if (bannerState !== target) {
      startTransition(() => {
        setBannerState(target);
      });
    }
  }, [connectionStatus, bannerState]);

  if (bannerState === "hidden") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium tracking-wide transition-all duration-300",
        bannerState === "offline" &&
          "bg-[rgba(239,68,68,0.12)] text-[rgba(239,68,68,0.9)] border-b border-[rgba(239,68,68,0.2)]",
        bannerState === "reconnecting" &&
          "bg-[rgba(234,179,8,0.10)] text-[rgba(234,179,8,0.9)] border-b border-[rgba(234,179,8,0.2)]",
        bannerState === "synced" &&
          "bg-[rgba(80,200,120,0.10)] text-[rgba(80,200,120,0.9)] border-b border-[rgba(80,200,120,0.2)]"
      )}
    >
      {bannerState === "offline" && (
        <>
          <OfflineIcon />
          <span>Offline — your data is preserved, updates will sync when connection returns</span>
        </>
      )}
      {bannerState === "reconnecting" && (
        <>
          <PulsingDot className="bg-[rgba(234,179,8,0.9)]" />
          <span>Reconnecting — your data is preserved</span>
        </>
      )}
      {bannerState === "synced" && (
        <>
          <CheckIcon />
          <span>Back online — synced</span>
        </>
      )}
    </div>
  );
}

function PulsingDot({ className }: { className?: string }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      <span
        className={cn(
          "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
          className
        )}
      />
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", className)} />
    </span>
  );
}

function OfflineIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
    >
      <path d="M2 2l20 20" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M2 8.82a15 15 0 0 1 4.17-2.65" />
      <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" />
      <path d="M16.85 11.25a10 10 0 0 1 2.22 1.68" />
      <path d="M5 12.86a10 10 0 0 1 5.17-2.86" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
