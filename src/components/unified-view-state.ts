"use client";

import { useCallback, useReducer, type SetStateAction } from "react";

export type UnifiedMobileLayer = "board" | "chat";

export type UnifiedMobileChatTarget =
  | { topicId: string; taskId: string }
  | null;

type UnifiedExpansionState = {
  expandedTopics: Set<string>;
  expandedTasks: Set<string>;
  mobileLayer: UnifiedMobileLayer;
  mobileChatTarget: UnifiedMobileChatTarget;
};

type UnifiedExpansionAction =
  | { type: "setExpandedTopics"; next: SetStateAction<Set<string>> }
  | { type: "setExpandedTasks"; next: SetStateAction<Set<string>> }
  | { type: "setMobileLayer"; next: SetStateAction<UnifiedMobileLayer> }
  | { type: "setMobileChatTarget"; next: SetStateAction<UnifiedMobileChatTarget> };

function resolveSetState<T>(next: SetStateAction<T>, previous: T): T {
  if (typeof next === "function") {
    return (next as (prev: T) => T)(previous);
  }
  return next;
}

function setsEqual(a: Set<string>, b: Set<string>) {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function mobileTargetsEqual(a: UnifiedMobileChatTarget, b: UnifiedMobileChatTarget) {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return a.topicId === b.topicId && a.taskId === b.taskId;
}

function unifiedExpansionReducer(state: UnifiedExpansionState, action: UnifiedExpansionAction): UnifiedExpansionState {
  switch (action.type) {
    case "setExpandedTopics": {
      const next = resolveSetState(action.next, state.expandedTopics);
      return setsEqual(next, state.expandedTopics) ? state : { ...state, expandedTopics: next };
    }
    case "setExpandedTasks": {
      const next = resolveSetState(action.next, state.expandedTasks);
      return setsEqual(next, state.expandedTasks) ? state : { ...state, expandedTasks: next };
    }
    case "setMobileLayer": {
      const next = resolveSetState(action.next, state.mobileLayer);
      return next === state.mobileLayer ? state : { ...state, mobileLayer: next };
    }
    case "setMobileChatTarget": {
      const next = resolveSetState(action.next, state.mobileChatTarget);
      return mobileTargetsEqual(next, state.mobileChatTarget) ? state : { ...state, mobileChatTarget: next };
    }
    default:
      return state;
  }
}

export function useUnifiedExpansionState(initialTopics: string[], initialTasks: string[]) {
  const [state, dispatch] = useReducer(
    unifiedExpansionReducer,
    { initialTopics, initialTasks },
    (init: { initialTopics: string[]; initialTasks: string[] }): UnifiedExpansionState => ({
      expandedTopics: new Set(init.initialTopics),
      expandedTasks: new Set(init.initialTasks),
      mobileLayer: "board",
      mobileChatTarget: null,
    })
  );

  const setExpandedTopics = useCallback((next: SetStateAction<Set<string>>) => {
    dispatch({ type: "setExpandedTopics", next });
  }, []);

  const setExpandedTasks = useCallback((next: SetStateAction<Set<string>>) => {
    dispatch({ type: "setExpandedTasks", next });
  }, []);

  const setMobileLayer = useCallback((next: SetStateAction<UnifiedMobileLayer>) => {
    dispatch({ type: "setMobileLayer", next });
  }, []);

  const setMobileChatTarget = useCallback((next: SetStateAction<UnifiedMobileChatTarget>) => {
    dispatch({ type: "setMobileChatTarget", next });
  }, []);

  return {
    state,
    setExpandedTopics,
    setExpandedTasks,
    setMobileLayer,
    setMobileChatTarget,
  };
}
