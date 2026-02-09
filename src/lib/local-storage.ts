"use client";

import { useSyncExternalStore } from "react";

const LOCAL_STORAGE_EVENT = "clawboard:local-storage";

function emitLocalStorageChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(LOCAL_STORAGE_EVENT));
}

function subscribe(callback: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const handler = () => callback();
  window.addEventListener("storage", handler);
  window.addEventListener(LOCAL_STORAGE_EVENT, handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener(LOCAL_STORAGE_EVENT, handler);
  };
}

export function useLocalStorageItem(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(key),
    // Server snapshot: no localStorage.
    () => null
  );
}

export function setLocalStorageItem(key: string, value: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value);
  emitLocalStorageChange();
}

export function removeLocalStorageItem(key: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(key);
  emitLocalStorageChange();
}

