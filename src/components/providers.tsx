"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { IntegrationLevel } from "@/lib/types";
import { apiFetch } from "@/lib/api";
import { normalizeTokenInput } from "@/lib/token";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";

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

function isIntegrationLevel(value: string): value is IntegrationLevel {
  return value === "manual" || value === "write" || value === "full";
}

export function AppConfigProvider({ children }: { children: React.ReactNode }) {
  const defaultToken = normalizeTokenInput(process.env.NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN ?? "");
  const storedTitle = useLocalStorageItem("clawboard.instanceTitle");
  const storedTokenRaw = useLocalStorageItem("clawboard.token");
  const storedLevelRaw = useLocalStorageItem("clawboard.integrationLevel");

  const [serverInstanceTitle, setServerInstanceTitle] = useState("Clawboard");
  const [tokenRequired, setTokenRequired] = useState(true);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [remoteReadLocked, setRemoteReadLocked] = useState(false);
  const [serverIntegrationLevel, setServerIntegrationLevel] = useState<IntegrationLevel>("write");

  const instanceTitle = storedTitle && storedTitle.trim().length > 0 ? storedTitle : serverInstanceTitle;
  const token = useMemo(() => {
    if (storedTokenRaw === null) return defaultToken;
    return normalizeTokenInput(storedTokenRaw);
  }, [defaultToken, storedTokenRaw]);
  const integrationLevel = useMemo(() => {
    if (storedLevelRaw && isIntegrationLevel(storedLevelRaw)) return storedLevelRaw;
    return serverIntegrationLevel;
  }, [serverIntegrationLevel, storedLevelRaw]);

  useEffect(() => {
    if (storedTokenRaw === null) return;
    const normalized = normalizeTokenInput(storedTokenRaw);
    if (normalized !== storedTokenRaw) {
      setLocalStorageItem("clawboard.token", normalized);
    }
  }, [storedTokenRaw]);

  useEffect(() => {
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
        if (data?.instance?.title) {
          setServerInstanceTitle(data.instance.title);
        }
        if (data?.instance?.integrationLevel) {
          setServerIntegrationLevel(data.instance.integrationLevel);
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
    setLocalStorageItem("clawboard.token", normalized);
  };

  const setInstanceTitle = (value: string) => {
    setLocalStorageItem("clawboard.instanceTitle", value);
  };

  const setIntegrationLevel = (value: IntegrationLevel) => {
    setLocalStorageItem("clawboard.integrationLevel", value);
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
