"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";

export const PUSH_ENABLED_KEY = "clawboard:push-enabled";
const PWA_ICON = "/icons/icon-192.png";
const PWA_BADGE = "/icons/icon-192.png";

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

export function canSendPwaNotifications(enabled = true) {
  if (!enabled) return false;
  if (!supportsNotifications()) return false;
  return Notification.permission === "granted";
}

type PwaNotificationInput = {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
};

export async function showPwaNotification(input: PwaNotificationInput, enabled = true) {
  if (!canSendPwaNotifications(enabled)) return false;

  const body = (input.body ?? "").trim();
  const tag = (input.tag ?? "").trim() || undefined;
  const url = (input.url ?? "").trim() || "/";
  const data = { url };

  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;
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
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // no-op
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
  if (!supportsBadging()) return;
  const nav = navigator as NavigatorWithBadge;
  try {
    if (count > 0 && typeof nav.setAppBadge === "function") {
      await nav.setAppBadge(count);
      return;
    }
    if (typeof nav.clearAppBadge === "function") {
      await nav.clearAppBadge();
      return;
    }
    if (typeof nav.setAppBadge === "function") {
      await nav.setAppBadge(0);
    }
  } catch {
    // Best-effort only.
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
  const isSupported = useMemo(() => supportsBadging(), []);

  const setBadge = useCallback(async (count?: number) => {
    await setPwaBadge(count ?? 0);
  }, []);

  return {
    isSupported,
    setBadge,
  };
}
