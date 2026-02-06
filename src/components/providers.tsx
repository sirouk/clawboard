"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { IntegrationLevel } from "@/lib/types";
import { apiFetch } from "@/lib/api";
import { normalizeTokenInput } from "@/lib/token";

export type AppConfig = {
  instanceTitle: string;
  token: string;
  tokenRequired: boolean;
  tokenConfigured: boolean;
  remoteReadLocked: boolean;
  integrationLevel: IntegrationLevel;
};

type AppConfigContextValue = AppConfig & {
  setInstanceTitle: (value: string) => void;
  setToken: (value: string) => void;
  setIntegrationLevel: (value: IntegrationLevel) => void;
};

const AppConfigContext = createContext<AppConfigContextValue | null>(null);

export function AppConfigProvider({ children }: { children: React.ReactNode }) {
  const [instanceTitle, setInstanceTitleState] = useState(() => {
    if (typeof window === "undefined") return "Clawboard";
    return window.localStorage.getItem("clawboard.instanceTitle") ?? "Clawboard";
  });
  const [token, setTokenState] = useState(() => {
    if (typeof window === "undefined") return "";
    return normalizeTokenInput(window.localStorage.getItem("clawboard.token") ?? "");
  });
  const [tokenRequired, setTokenRequired] = useState(true);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [remoteReadLocked, setRemoteReadLocked] = useState(false);
  const [integrationLevel, setIntegrationLevelState] = useState<IntegrationLevel>(() => {
    if (typeof window === "undefined") return "write";
    return (window.localStorage.getItem("clawboard.integrationLevel") as IntegrationLevel) ?? "write";
  });

  useEffect(() => {
    const storedTitle = window.localStorage.getItem("clawboard.instanceTitle");
    apiFetch("/api/config", { cache: "no-store" }, token)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 401) {
            setRemoteReadLocked(true);
            return null;
          }
          throw new Error(`Config request failed (${res.status})`);
        }
        const data = await res.json().catch(() => null);
        if (!data) return null;
        setRemoteReadLocked(false);
        if (!storedTitle && data?.instance?.title) {
          setInstanceTitleState(data.instance.title);
        }
        if (data?.instance?.integrationLevel) {
          setIntegrationLevelState(data.instance.integrationLevel);
        }
        if (typeof data?.tokenRequired === "boolean") {
          setTokenRequired(data.tokenRequired);
        }
        if (typeof data?.tokenConfigured === "boolean") {
          setTokenConfigured(data.tokenConfigured);
        }
        return null;
      })
      .catch(() => null);
  }, [token]);

  const setToken = (value: string) => {
    const normalized = normalizeTokenInput(value);
    setTokenState(normalized);
    window.localStorage.setItem("clawboard.token", normalized);
  };

  const setInstanceTitle = (value: string) => {
    setInstanceTitleState(value);
    window.localStorage.setItem("clawboard.instanceTitle", value);
  };

  const setIntegrationLevel = (value: IntegrationLevel) => {
    setIntegrationLevelState(value);
    window.localStorage.setItem("clawboard.integrationLevel", value);
  };

  const value = useMemo(
    () => ({
      instanceTitle,
      token,
      tokenRequired,
      tokenConfigured,
      remoteReadLocked,
      integrationLevel,
      setInstanceTitle,
      setToken,
      setIntegrationLevel,
    }),
    [instanceTitle, token, tokenRequired, tokenConfigured, remoteReadLocked, integrationLevel]
  );

  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig() {
  const context = useContext(AppConfigContext);
  if (!context) {
    throw new Error("useAppConfig must be used within AppConfigProvider");
  }
  return context;
}
