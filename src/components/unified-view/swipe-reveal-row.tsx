"use client";

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";

const TOPIC_ACTION_REVEAL_PX = 288;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeHexColor(value: string | undefined | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

function hexToRgb(hex: string) {
  const normalized = normalizeHexColor(hex) ?? "#4EA1FF";
  const raw = normalized.slice(1);
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function rgba(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function swipeRevealBackdropStyle(color?: string | null): CSSProperties | undefined {
  const normalized = normalizeHexColor(color);
  if (!normalized) return undefined;
  return {
    backgroundColor: "rgb(10,12,16)",
    backgroundImage: [
      `radial-gradient(circle at 14% 50%, ${rgba(normalized, 0.18)} 0%, transparent 52%)`,
      `linear-gradient(148deg, ${rgba(normalized, 0.22)} 0%, rgba(12,14,18,0.84) 42%, ${rgba(normalized, 0.1)} 100%)`,
    ].join(", "),
    boxShadow: `inset 0 0 0 1px ${rgba(normalized, 0.1)}`,
  };
}

function hasActiveTextSelectionWithin(root: HTMLElement | null) {
  if (!root || typeof window === "undefined") return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  if (anchorNode && root.contains(anchorNode)) return true;
  if (focusNode && root.contains(focusNode)) return true;
  return false;
}

export function SwipeRevealRow({
  rowId,
  openId,
  setOpenId,
  actions,
  anchorLabel,
  children,
  disabled = false,
  surfaceTint,
  wrapperTestId,
  wrapperClassName,
  wrapperStyle,
  backdropTinted = true,
  anchorRowClassName,
  anchorPillClassName,
}: {
  rowId: string;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  actions: ReactNode;
  anchorLabel?: string;
  children: ReactNode;
  disabled?: boolean;
  surfaceTint?: string | null;
  wrapperTestId?: string;
  wrapperClassName?: string;
  wrapperStyle?: CSSProperties;
  backdropTinted?: boolean;
  anchorRowClassName?: string;
  anchorPillClassName?: string;
}) {
  const allowSwipe = !disabled;
  const isOpen = allowSwipe && openId === rowId;
  const gesture = useRef<{
    startX: number;
    startY: number;
    startOffset: number;
    pointerType: string;
    pointerId: number;
    captureNode: HTMLElement | null;
  } | null>(null);
  const [swiping, setSwiping] = useState(false);
  const swipingRef = useRef(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragOffsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const pendingOffsetRef = useRef(0);
  const wheelEndTimerRef = useRef<number | null>(null);
  const wheelWasOpenRef = useRef(false);

  const effectiveOffset = !allowSwipe ? 0 : swiping ? dragOffset : isOpen ? TOPIC_ACTION_REVEAL_PX : 0;
  const actionsOpacity = clamp(effectiveOffset / TOPIC_ACTION_REVEAL_PX, 0, 1);
  const showActions = allowSwipe && actionsOpacity > 0.01;
  const showAnchorLabel =
    allowSwipe && Boolean((anchorLabel ?? "").trim()) && (isOpen || swiping || effectiveOffset > 8);
  const rowContentOpacity = !allowSwipe ? 1 : clamp(1 - effectiveOffset / (TOPIC_ACTION_REVEAL_PX * 0.62), 0, 1);
  const swipeBackdrop = swipeRevealBackdropStyle(surfaceTint);

  const scheduleOffset = (next: number) => {
    dragOffsetRef.current = next;
    pendingOffsetRef.current = next;
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      setDragOffset(pendingOffsetRef.current);
    });
  };

  const settleSwipe = useCallback(() => {
    if (!allowSwipe) return;
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const threshold = wheelWasOpenRef.current ? TOPIC_ACTION_REVEAL_PX * 0.85 : TOPIC_ACTION_REVEAL_PX * 0.35;
    const shouldOpen = dragOffsetRef.current > threshold;
    setOpenId(shouldOpen ? rowId : null);
    setDragOffset(0);
    dragOffsetRef.current = 0;
    pendingOffsetRef.current = 0;
    setSwiping(false);
    swipingRef.current = false;
  }, [allowSwipe, rowId, setOpenId]);

  const handlePointerDown = allowSwipe
    ? (event: React.PointerEvent<HTMLDivElement>) => {
        if ("button" in event && event.button !== 0) return;
        const target = event.target as HTMLElement | null;
        if (event.pointerType === "mouse") return;
        if (!isOpen && target?.closest("button, a, input, textarea, select, [data-no-swipe='true']")) return;
        event.stopPropagation();
        setSwiping(false);
        swipingRef.current = false;
        gesture.current = {
          startX: event.clientX,
          startY: event.clientY,
          startOffset: isOpen ? TOPIC_ACTION_REVEAL_PX : 0,
          pointerType: event.pointerType,
          pointerId: event.pointerId,
          captureNode: event.currentTarget as HTMLElement,
        };
      }
    : undefined;

  const handlePointerMove = allowSwipe
    ? (event: React.PointerEvent<HTMLDivElement>) => {
        const g = gesture.current;
        if (!g) return;
        if (g.pointerType === "mouse") return;
        const dx = event.clientX - g.startX;
        const dy = event.clientY - g.startY;
        if (!swipingRef.current) {
          if (Math.abs(dx) < 12) return;
          if (Math.abs(dx) < Math.abs(dy) * 1.25) return;
          swipingRef.current = true;
          setSwiping(true);
          if (openId !== rowId) setOpenId(rowId);
          event.stopPropagation();
          try {
            g.captureNode?.setPointerCapture(g.pointerId);
          } catch {
            // ignore
          }
        }
        event.preventDefault();
        event.stopPropagation();
        const next = clamp(g.startOffset - dx, 0, TOPIC_ACTION_REVEAL_PX);
        scheduleOffset(next);
      }
    : undefined;

  const handlePointerUp = allowSwipe
    ? (event: React.PointerEvent<HTMLDivElement>) => {
        const g = gesture.current;
        gesture.current = null;
        const wasSwiping = swipingRef.current;
        swipingRef.current = false;
        try {
          (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
        } catch {
          // ignore
        }
        if (rafRef.current != null) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        if (!g || !wasSwiping) return;
        const threshold = g.startOffset > 0 ? TOPIC_ACTION_REVEAL_PX * 0.9 : TOPIC_ACTION_REVEAL_PX * 0.35;
        const shouldOpen = dragOffsetRef.current > threshold;
        setOpenId(shouldOpen ? rowId : null);
        setDragOffset(0);
        dragOffsetRef.current = 0;
        pendingOffsetRef.current = 0;
        setSwiping(false);
      }
    : undefined;

  const handlePointerCancel = allowSwipe
    ? () => {
        gesture.current = null;
        swipingRef.current = false;
        if (rafRef.current != null) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        if (wheelEndTimerRef.current != null) {
          window.clearTimeout(wheelEndTimerRef.current);
          wheelEndTimerRef.current = null;
        }
        setDragOffset(0);
        dragOffsetRef.current = 0;
        pendingOffsetRef.current = 0;
        setSwiping(false);
      }
    : undefined;

  return (
    <div
      data-testid={wrapperTestId}
      className={cn("relative overflow-x-clip rounded-[var(--radius-lg)]", wrapperClassName)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onContextMenu={
        allowSwipe
          ? (event) => {
              const target = event.target as HTMLElement | null;
              if (target?.closest("button, a, input, textarea, select")) return;
              if (hasActiveTextSelectionWithin(event.currentTarget)) return;
              if (typeof window !== "undefined" && !window.matchMedia("(min-width: 768px)").matches) return;
              event.preventDefault();
              event.stopPropagation();
              gesture.current = null;
              swipingRef.current = false;
              if (rafRef.current != null) {
                window.cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
              }
              if (wheelEndTimerRef.current != null) {
                window.clearTimeout(wheelEndTimerRef.current);
                wheelEndTimerRef.current = null;
              }
              setSwiping(false);
              setDragOffset(0);
              dragOffsetRef.current = 0;
              pendingOffsetRef.current = 0;
              if (openId !== rowId) setOpenId(rowId);
            }
          : undefined
      }
      style={{ touchAction: allowSwipe ? "pan-y" : "auto", ...wrapperStyle }}
    >
      {showActions ? (
        <div
          className="absolute inset-0 flex items-stretch gap-2 p-1 transition-opacity"
          style={{ opacity: actionsOpacity, ...(backdropTinted ? swipeBackdrop : undefined) }}
        >
          {showAnchorLabel ? (
            <div className={cn("pointer-events-none flex min-w-0 flex-1 items-center", anchorRowClassName)}>
              <div
                className={cn(
                  "max-w-[min(42vw,12rem)] rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(9,11,15,0.72)] px-3 py-1.5 text-[11px] font-semibold tracking-[0.02em] text-[rgb(var(--claw-text))] shadow-[0_8px_18px_rgba(0,0,0,0.26)] backdrop-blur",
                  anchorPillClassName
                )}
                style={
                  surfaceTint
                    ? {
                        backgroundImage: `linear-gradient(135deg, ${rgba(surfaceTint, 0.18)} 0%, rgba(9,11,15,0.78) 72%)`,
                        borderColor: rgba(surfaceTint, 0.18),
                      }
                    : undefined
                }
                title={anchorLabel}
              >
                <span className="block truncate whitespace-nowrap">{anchorLabel}</span>
              </div>
            </div>
          ) : null}
          <div className="ml-auto flex items-stretch gap-2">{actions}</div>
        </div>
      ) : null}
      <div
        onClickCapture={
          allowSwipe
            ? (event) => {
                if (swiping || effectiveOffset > 8) {
                  event.preventDefault();
                  event.stopPropagation();
                }
                if (isOpen && !swiping) {
                  setOpenId(null);
                  event.preventDefault();
                  event.stopPropagation();
                }
              }
            : undefined
        }
        onWheel={
          allowSwipe
            ? (event) => {
                if (event.deltaMode !== 0) return;
                const target = event.target as HTMLElement | null;
                if (target?.closest("button, a, input, textarea, select, [data-no-swipe='true']")) return;
                const dx = event.deltaX;
                const dy = event.deltaY;
                if (Math.abs(dx) < 10) return;
                if (Math.abs(dx) < Math.abs(dy) * 1.35) return;
                event.preventDefault();
                event.stopPropagation();
                const current = swipingRef.current ? dragOffsetRef.current : isOpen ? TOPIC_ACTION_REVEAL_PX : 0;
                const next = clamp(current + dx, 0, TOPIC_ACTION_REVEAL_PX);
                if (!swipingRef.current) {
                  wheelWasOpenRef.current = isOpen;
                  swipingRef.current = true;
                  setSwiping(true);
                  if (openId !== rowId) setOpenId(rowId);
                }
                scheduleOffset(next);
                if (wheelEndTimerRef.current != null) window.clearTimeout(wheelEndTimerRef.current);
                wheelEndTimerRef.current = window.setTimeout(() => {
                  wheelEndTimerRef.current = null;
                  settleSwipe();
                }, 120);
              }
            : undefined
        }
        className={cn(
          "relative",
          allowSwipe && (swiping || effectiveOffset > 0) ? "will-change-transform" : "",
          allowSwipe && (swiping || isOpen) ? "z-20" : "",
          allowSwipe && swiping ? "" : "transition-[transform,opacity] duration-200 ease-out"
        )}
        style={{
          ...(effectiveOffset > 0 ? { transform: `translate3d(-${effectiveOffset}px,0,0)` } : {}),
          opacity: rowContentOpacity,
          touchAction: allowSwipe ? "pan-y" : "auto",
        }}
      >
        {children}
      </div>
    </div>
  );
}
