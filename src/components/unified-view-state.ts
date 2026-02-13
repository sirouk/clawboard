"use client";

import { useCallback, useReducer, type SetStateAction } from "react";

export type UnifiedMobileLayer = "board" | "chat";

export type UnifiedMobileChatTarget =
  | { kind: "topic"; topicId: string }
  | { kind: "task"; topicId: string; taskId: string }
  | null;

type UnifiedExpansionState = {
  expandedTopics: Set<string>;
  expandedTasks: Set<string>;
  expandedTopicChats: Set<string>;
  mobileLayer: UnifiedMobileLayer;
  mobileChatTarget: UnifiedMobileChatTarget;
};

type UnifiedExpansionAction =
  | { type: "setExpandedTopics"; next: SetStateAction<Set<string>> }
  | { type: "setExpandedTasks"; next: SetStateAction<Set<string>> }
  | { type: "setExpandedTopicChats"; next: SetStateAction<Set<string>> }
  | { type: "setMobileLayer"; next: SetStateAction<UnifiedMobileLayer> }
  | { type: "setMobileChatTarget"; next: SetStateAction<UnifiedMobileChatTarget> };

function resolveSetState<T>(next: SetStateAction<T>, previous: T): T {
  if (typeof next === "function") {
    return (next as (prev: T) => T)(previous);
  }
  return next;
}

function unifiedExpansionReducer(state: UnifiedExpansionState, action: UnifiedExpansionAction): UnifiedExpansionState {
  switch (action.type) {
    case "setExpandedTopics":
      return { ...state, expandedTopics: resolveSetState(action.next, state.expandedTopics) };
    case "setExpandedTasks":
      return { ...state, expandedTasks: resolveSetState(action.next, state.expandedTasks) };
    case "setExpandedTopicChats":
      return { ...state, expandedTopicChats: resolveSetState(action.next, state.expandedTopicChats) };
    case "setMobileLayer":
      return { ...state, mobileLayer: resolveSetState(action.next, state.mobileLayer) };
    case "setMobileChatTarget":
      return { ...state, mobileChatTarget: resolveSetState(action.next, state.mobileChatTarget) };
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
      // Topic chat visibility is independent from topic expansion.
      expandedTopicChats: new Set(),
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

  const setExpandedTopicChats = useCallback((next: SetStateAction<Set<string>>) => {
    dispatch({ type: "setExpandedTopicChats", next });
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
    setExpandedTopicChats,
    setMobileLayer,
    setMobileChatTarget,
  };
}
