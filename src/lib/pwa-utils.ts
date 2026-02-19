"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";

export const PUSH_ENABLED_KEY = "clawboard:push-enabled";
export const CLAWBOARD_NOTIFICATION_CLICK_EVENT = "clawboard:notification-clicked";
export const CLAWBOARD_NOTIFICATION_CLICK_MESSAGE_TYPE = "clawboard:notification-clicked";
export const CLAWBOARD_NOTIFY_TOPIC_PARAM = "cbn_topic";
export const CLAWBOARD_NOTIFY_TASK_PARAM = "cbn_task";
export const CLAWBOARD_NOTIFY_CHAT_PARAM = "cbn_chat";
const PWA_ICON = "/icons/icon-192.png";
const PWA_BADGE = "/icons/icon-192.png";
const activeWindowNotificationsByTag = new Map<string, Set<Notification>>();
const SERVICE_WORKER_READY_TIMEOUT_MS = 1400;
const TITLE_BADGE_PREFIX = /^\(\d+\)\s+/;

type NavigatorWithBadge = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function supportsNotifications() {
  if (typeof window === "undefined") return false;
  return "Notification" in window;
}

function supportsBadging() {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as NavigatorWithBadge;
  return typeof nav.setAppBadge === "function" || typeof nav.clearAppBadge === "function";
}

function notificationsEnabledFromStorage(rawValue: string | null) {
  return rawValue !== "false";
}

function normalizeBadgeCount(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function setDocumentTitleBadge(count: number) {
  if (typeof document === "undefined") return;
  const current = String(document.title || "").trim();
  const base = (current.replace(TITLE_BADGE_PREFIX, "").trim() || "Clawboard");
  if (count > 0) {
    document.title = `(${count}) ${base}`;
    return;
  }
  document.title = base;
}

async function resolveReadyServiceWorkerRegistration(timeoutMs = SERVICE_WORKER_READY_TIMEOUT_MS) {
  if (typeof window === "undefined") return null;
  if (typeof navigator === "undefined") return null;
  if (!("serviceWorker" in navigator)) return null;

  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = window.setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    const readyPromise = navigator.serviceWorker.ready
      .then((registration) => registration ?? null)
      .catch(() => null);
    const registration = await Promise.race([readyPromise, timeoutPromise]);
    return registration ?? null;
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
}

export function canSendPwaNotifications(enabled = true) {
  if (!enabled) return false;
  if (!supportsNotifications()) return false;
  return Notification.permission === "granted";
}

export type PwaNotificationClickData = {
  url?: string;
  topicId?: string;
  taskId?: string;
  chatKey?: string;
};

export type PwaNotificationInput = {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
  data?: PwaNotificationClickData;
};

export function parsePwaNotificationClickData(input: unknown): PwaNotificationClickData {
  if (!input || typeof input !== "object") return {};
  const value = input as Record<string, unknown>;
  const url = String(value.url ?? "").trim();
  const topicId = String(value.topicId ?? "").trim();
  const taskId = String(value.taskId ?? "").trim();
  const chatKey = String(value.chatKey ?? "").trim();
  const out: PwaNotificationClickData = {};
  if (url) out.url = url;
  if (topicId) out.topicId = topicId;
  if (taskId) out.taskId = taskId;
  if (chatKey) out.chatKey = chatKey;
  return out;
}

function trackWindowNotification(notification: Notification, tag?: string) {
  const normalizedTag = String(tag ?? "").trim();
  if (!normalizedTag) return;
  const existing = activeWindowNotificationsByTag.get(normalizedTag);
  if (existing) {
    existing.add(notification);
  } else {
    activeWindowNotificationsByTag.set(normalizedTag, new Set([notification]));
  }

  const remove = () => {
    const current = activeWindowNotificationsByTag.get(normalizedTag);
    if (!current) return;
    current.delete(notification);
    if (current.size === 0) activeWindowNotificationsByTag.delete(normalizedTag);
  };
  notification.addEventListener("close", remove, { once: true });
  notification.addEventListener("error", remove, { once: true });
}

export async function closePwaNotificationsByTag(tags: string[]) {
  const normalizedTags = new Set(tags.map((tag) => String(tag ?? "").trim()).filter(Boolean));
  if (normalizedTags.size === 0) return;

  for (const tag of normalizedTags) {
    const tracked = activeWindowNotificationsByTag.get(tag);
    if (!tracked) continue;
    for (const notification of tracked) {
      try {
        notification.close();
      } catch {
        // Best-effort only.
      }
    }
    activeWindowNotificationsByTag.delete(tag);
  }

  try {
    const registration = await resolveReadyServiceWorkerRegistration();
    if (!registration?.getNotifications) return;
    const notifications = await registration.getNotifications();
    for (const notification of notifications) {
      const tag = String(notification.tag ?? "").trim();
      if (!tag || !normalizedTags.has(tag)) continue;
      notification.close();
    }
  } catch {
    // Best-effort only.
  }
}

export async function showPwaNotification(input: PwaNotificationInput, enabled = true) {
  if (!canSendPwaNotifications(enabled)) return false;

  const body = (input.body ?? "").trim();
  const tag = (input.tag ?? "").trim() || undefined;
  const url = (input.url ?? "").trim() || "/";
  // data payload can be used by the service worker or the click handler.
  const data = parsePwaNotificationClickData({ url, ...(input.data ?? {}) });

  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    try {
      const registration = await resolveReadyServiceWorkerRegistration();
      if (registration?.showNotification) {
        await registration.showNotification(input.title, {
          body,
          tag,
          icon: PWA_ICON,
          badge: PWA_BADGE,
          data,
        });
        return true;
      }
    } catch {
      // Fallback to window Notification below.
    }
  }

  try {
    const notification = new Notification(input.title, {
      body,
      tag,
      icon: PWA_ICON,
      data,
    });
    trackWindowNotification(notification, tag);
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // no-op
      }

      // Dispatch a custom event so the DataProvider can react to the click
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(CLAWBOARD_NOTIFICATION_CLICK_EVENT, { detail: data }));
      }

      if (url) {
        window.location.href = url;
      }
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

export async function setPwaBadge(count: number) {
  const normalizedCount = normalizeBadgeCount(count);
  // Keep a universal, host-agnostic signal for wrappers (Electron/Rambox, etc.)
  // that may ignore the native Badging API.
  setDocumentTitleBadge(normalizedCount);

  if (!supportsBadging()) {
    return;
  }
  const nav = navigator as NavigatorWithBadge;
  try {
    if (normalizedCount > 0 && typeof nav.setAppBadge === "function") {
      await nav.setAppBadge(normalizedCount);
      return;
    }
    if (typeof nav.clearAppBadge === "function") {
      await nav.clearAppBadge();
      return;
    }
    if (typeof nav.setAppBadge === "function") {
      await nav.setAppBadge(0);
      return;
    }
  } catch {
    // Title fallback already applied above.
  }
}

export function usePwaNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [isSupported, setIsSupported] = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);
  const storedEnabled = useLocalStorageItem(PUSH_ENABLED_KEY);
  const isEnabled = useMemo(() => notificationsEnabledFromStorage(storedEnabled), [storedEnabled]);
  const isSubscribed = permission === "granted";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const supported = supportsNotifications();
    setIsSupported(supported);
    if (supported) {
      setPermission(Notification.permission);
      if (storedEnabled === null && Notification.permission === "granted") {
        setLocalStorageItem(PUSH_ENABLED_KEY, "true");
      }
    }
  }, [storedEnabled]);

  const enableNotifications = useCallback(async () => {
    if (!isSupported) return;
    setIsEnabling(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === "granted") {
        setLocalStorageItem(PUSH_ENABLED_KEY, "true");
      }
    } catch {
      // Ignore permission errors.
    } finally {
      setIsEnabling(false);
    }
  }, [isSupported]);

  const toggleNotifications = useCallback((enabled: boolean) => {
    setLocalStorageItem(PUSH_ENABLED_KEY, enabled ? "true" : "false");
  }, []);

  return {
    isSupported,
    permission,
    isSubscribed,
    isEnabling,
    isEnabled,
    enableNotifications,
    toggleNotifications,
  };
}

export function usePwaBadging() {
  const [isSupported] = useState(() => {
    if (typeof window === "undefined") return false;
    return supportsBadging();
  });

  const setBadge = useCallback(async (count?: number) => {
    await setPwaBadge(count ?? 0);
  }, []);

  return {
    isSupported,
    setBadge,
  };
}
