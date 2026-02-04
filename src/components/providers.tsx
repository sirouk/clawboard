"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { IntegrationLevel } from "@/lib/types";

export type AppConfig = {
  instanceTitle: string;
  token: string;
  tokenRequired: boolean;
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
    return window.localStorage.getItem("clawboard.token") ?? "";
  });
  const [tokenRequired, setTokenRequired] = useState(false);
  const [integrationLevel, setIntegrationLevelState] = useState<IntegrationLevel>(() => {
    if (typeof window === "undefined") return "manual";
    return (window.localStorage.getItem("clawboard.integrationLevel") as IntegrationLevel) ?? "manual";
  });

  useEffect(() => {
    const storedTitle = window.localStorage.getItem("clawboard.instanceTitle");
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        if (!storedTitle && data?.instance?.title) {
          setInstanceTitleState(data.instance.title);
        }
        if (data?.instance?.integrationLevel) {
          setIntegrationLevelState(data.instance.integrationLevel);
        }
        if (typeof data?.tokenRequired === "boolean") {
          setTokenRequired(data.tokenRequired);
        }
      })
      .catch(() => null);
  }, []);

  const setToken = (value: string) => {
    setTokenState(value);
    window.localStorage.setItem("clawboard.token", value);
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
      integrationLevel,
      setInstanceTitle,
      setToken,
      setIntegrationLevel,
    }),
    [instanceTitle, token, tokenRequired, integrationLevel]
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
