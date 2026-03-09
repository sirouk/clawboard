"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { IntegrationLevel, OpenClawWorkspace } from "@/lib/types";
import { apiFetch } from "@/lib/api";
import { normalizeTokenInput } from "@/lib/token";
import { setLocalStorageItem, useLocalStorageItem } from "@/lib/local-storage";
import { CLAWBOARD_CONFIG_UPDATED_EVENT } from "@/lib/config-events";

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

type OpenClawWorkspaceContextValue = {
  loading: boolean;
  error: string | null;
  configured: boolean;
  provider: string | null;
  baseUrl: string | null;
  workspaces: OpenClawWorkspace[];
  refresh: () => void;
};

const AppConfigContext = createContext<AppConfigContextValue | null>(null);
const OpenClawWorkspaceContext = createContext<OpenClawWorkspaceContextValue | null>(null);

function isIntegrationLevel(value: string): value is IntegrationLevel {
  return value === "manual" || value === "write" || value === "full";
}

export function AppConfigProvider({ children }: { children: React.ReactNode }) {
  const defaultToken = normalizeTokenInput(process.env.NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN ?? "");
  const storedTitle = useLocalStorageItem("clawboard.instanceTitle");
  const storedTokenRaw = useLocalStorageItem("clawboard.token");
  const storedLevelRaw = useLocalStorageItem("clawboard.integrationLevel");
  const storedApiBaseRaw = useLocalStorageItem("clawboard.apiBase");

  const [serverInstanceTitle, setServerInstanceTitle] = useState("Clawboard");
  const [tokenRequired, setTokenRequired] = useState(true);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [remoteReadLocked, setRemoteReadLocked] = useState(false);
  const [serverIntegrationLevel, setServerIntegrationLevel] = useState<IntegrationLevel>("write");
  const [configRefreshNonce, setConfigRefreshNonce] = useState(0);
  const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0);
  const [workspaceLoadedRequestKey, setWorkspaceLoadedRequestKey] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceConfigured, setWorkspaceConfigured] = useState(false);
  const [workspaceProvider, setWorkspaceProvider] = useState<string | null>(null);
  const [workspaceBaseUrl, setWorkspaceBaseUrl] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<OpenClawWorkspace[]>([]);

  const instanceTitle = storedTitle && storedTitle.trim().length > 0 ? storedTitle : serverInstanceTitle;
  const token = useMemo(() => {
    if (storedTokenRaw === null) return defaultToken;
    return normalizeTokenInput(storedTokenRaw);
  }, [defaultToken, storedTokenRaw]);
  const integrationLevel = useMemo(() => {
    if (storedLevelRaw && isIntegrationLevel(storedLevelRaw)) return storedLevelRaw;
    return serverIntegrationLevel;
  }, [serverIntegrationLevel, storedLevelRaw]);
  const workspaceRequestKey = useMemo(
    () => `${storedApiBaseRaw ?? ""}::${token}::${workspaceRefreshNonce}`,
    [storedApiBaseRaw, token, workspaceRefreshNonce]
  );
  const workspaceLoading = workspaceLoadedRequestKey !== workspaceRequestKey;

  useEffect(() => {
    if (storedTokenRaw === null) return;
    const normalized = normalizeTokenInput(storedTokenRaw);
    if (normalized !== storedTokenRaw) {
      setLocalStorageItem("clawboard.token", normalized);
    }
  }, [storedTokenRaw]);

  useEffect(() => {
    const handleConfigUpdated = () => {
      setConfigRefreshNonce((prev) => prev + 1);
      setWorkspaceRefreshNonce((prev) => prev + 1);
    };
    window.addEventListener(CLAWBOARD_CONFIG_UPDATED_EVENT, handleConfigUpdated);
    return () => window.removeEventListener(CLAWBOARD_CONFIG_UPDATED_EVENT, handleConfigUpdated);
  }, []);

  useEffect(() => {
    let alive = true;
    apiFetch("/api/config", { cache: "no-store" }, token)
      .then(async (res) => {
        if (!alive) return null;
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
    return () => {
      alive = false;
    };
  }, [configRefreshNonce, storedApiBaseRaw, token]);

  useEffect(() => {
    let alive = true;
    apiFetch("/api/openclaw/workspaces", { cache: "no-store" }, token)
      .then(async (res) => {
        if (!alive) return null;
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          const message =
            typeof detail?.detail === "string" ? detail.detail : `Workspace request failed (${res.status})`;
          throw new Error(message);
        }
        const data = await res.json().catch(() => null);
        if (!alive) return null;
        setWorkspaceConfigured(Boolean(data?.configured));
        setWorkspaceProvider(typeof data?.provider === "string" ? data.provider : null);
        setWorkspaceBaseUrl(typeof data?.baseUrl === "string" ? data.baseUrl : null);
        setWorkspaces(Array.isArray(data?.workspaces) ? data.workspaces : []);
        setWorkspaceError(null);
        setWorkspaceLoadedRequestKey(workspaceRequestKey);
        return null;
      })
      .catch((error) => {
        if (!alive) return null;
        setWorkspaceConfigured(false);
        setWorkspaceProvider(null);
        setWorkspaceBaseUrl(null);
        setWorkspaces([]);
        setWorkspaceError(error instanceof Error ? error.message : "Failed to load workspaces.");
        setWorkspaceLoadedRequestKey(workspaceRequestKey);
        return null;
      });

    return () => {
      alive = false;
    };
  }, [token, workspaceRequestKey]);

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

  const workspaceValue = useMemo(
    () => ({
      loading: workspaceLoading,
      error: workspaceError,
      configured: workspaceConfigured,
      provider: workspaceProvider,
      baseUrl: workspaceBaseUrl,
      workspaces,
      refresh: () => setWorkspaceRefreshNonce((prev) => prev + 1),
    }),
    [workspaceBaseUrl, workspaceConfigured, workspaceError, workspaceLoading, workspaceProvider, workspaces]
  );

  return (
    <AppConfigContext.Provider value={value}>
      <OpenClawWorkspaceContext.Provider value={workspaceValue}>{children}</OpenClawWorkspaceContext.Provider>
    </AppConfigContext.Provider>
  );
}

export function useAppConfig() {
  const context = useContext(AppConfigContext);
  if (!context) {
    throw new Error("useAppConfig must be used within AppConfigProvider");
  }
  return context;
}

export function useOpenClawWorkspaces() {
  const context = useContext(OpenClawWorkspaceContext);
  if (!context) {
    throw new Error("useOpenClawWorkspaces must be used within AppConfigProvider");
  }
  return context;
}
