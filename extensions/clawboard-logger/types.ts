export type HookEvent = {
  [key: string]: unknown;
};

export type PluginHookBeforeAgentStartEvent = HookEvent & {
  prompt?: string;
  messages?: unknown[];
};

export type PluginHookMessageReceivedEvent = HookEvent & {
  content?: string;
  metadata?: {
    sessionKey?: string;
    [key: string]: unknown;
  };
  sessionKey?: string;
};

export type PluginHookMessageSentEvent = HookEvent & {
  content?: string;
  metadata?: {
    sessionKey?: string;
    [key: string]: unknown;
  };
  sessionKey?: string;
};

export type PluginHookBeforeToolCallEvent = HookEvent & {
  toolName?: string;
  input?: unknown;
};

export type PluginHookAfterToolCallEvent = HookEvent & {
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
};

export type PluginHookToolResultPersistEvent = HookEvent & {
  toolName?: string;
  toolCallId?: string;
  message?: unknown;
  metadata?: {
    sessionKey?: string;
    [key: string]: unknown;
  };
  sessionKey?: string;
  isSynthetic?: boolean;
};

export type PluginHookBeforeMessageWriteEvent = HookEvent & {
  message?: unknown;
  metadata?: {
    sessionKey?: string;
    [key: string]: unknown;
  };
  sessionKey?: string;
};

export type PluginHookAgentEndEvent = HookEvent & {
  output?: unknown;
  message?: string;
  messages?: unknown[];
};

export type PluginHookContextBase = {
  agentId?: string;
  sessionKey?: string;
  channelId?: string;
  conversationId?: string;
  accountId?: string;
  messageProvider?: string;
  provider?: string;
  [key: string]: unknown;
};

export type PluginHookMessageContext = PluginHookContextBase;
export type PluginHookToolContext = PluginHookContextBase;
export type PluginHookAgentContext = PluginHookContextBase;

export type BoardScope =
  | {
      topicId: string;
      kind: "topic";
      sessionKey: string;
      inherited: boolean;
      updatedAt: number;
    }
  | {
      topicId: string;
      taskId: string;
      kind: "task";
      sessionKey: string;
      inherited: boolean;
      updatedAt: number;
    };

export type RoutingScope = {
  topicId?: string;
  boardScope?: BoardScope;
};

export type ActorFlow = {
  speakerId?: string;
  speakerLabel?: string;
  audienceId?: string;
  audienceLabel?: string;
};

export type ClawBoardLoggerConfig = {
  baseUrl: string;
  /** Optional fallback base URLs used when baseUrl has transient network failures. */
  baseUrlFallbacks?: string[];
  token?: string;
  enabled?: boolean;
  debug?: boolean;
  queuePath?: string;
  /** Timeout (ms) for POST /api/log or POST /api/ingest requests. */
  postTimeoutMs?: number;
  /**
   * Optional: send logs to /api/ingest for async queueing (server-side).
   * Note: this is independent of the plugin's local durable queue.
   */
  queue?: boolean;
  /** Optional: override ingest path (default /api/log or /api/ingest when queue=true). */
  ingestPath?: string;
  /** Optional: force all logs into a single topic. */
  defaultTopicId?: string;
  /** Optional: additional hook names to register with generic capture handlers. */
  extraHooks?: string[];
  /** When true (default), auto-create a topic per OpenClaw sessionKey and attach logs to it. */
  autoTopicBySession?: boolean;
  /** When true (default), prepend retrieved ClawBoard context before agent start. */
  contextAugment?: boolean;
  /**
   * Context retrieval mode (passed to ClawBoard `/api/context`):
   * - auto: Layer A always, Layer B conditional
   * - cheap: Layer A only
   * - full: Layer A + Layer B
   * - patient: like full, but server may use larger bounded recall limits
   */
  contextMode?: ContextMode;
  /** Timeout (ms) for context GET calls (e.g. `/api/context`, `/api/search`) in before_agent_start. */
  contextFetchTimeoutMs?: number;
  /** Hard cap for prepended context characters. */
  contextMaxChars?: number;
  /** Max topics to include in context block. */
  contextTopicLimit?: number;
  /** Max recent conversation entries to include in context block. */
  contextLogLimit?: number;
  /** Retries per mode when context fetch fails (default 1). */
  contextFetchRetries?: number;
  /**
   * Ordered fallback modes when primary mode fails.
   * Example: ["full","auto","cheap"]
   */
  contextFallbackModes?: ContextMode[];
  /** Cache TTL for context blocks (ms). */
  contextCacheTtlMs?: number;
  /** Max in-memory cached context blocks. */
  contextCacheMaxEntries?: number;
  /** If true, return cached context when live fetch fails. */
  contextUseCacheOnFailure?: boolean;
  /** Cache TTL for board-scope routing hints (ms). */
  boardScopeCacheTtlMs?: number;
  /** Max in-memory cached board-scope routing hints. */
  boardScopeCacheMaxEntries?: number;
  /**
   * When true, allow the agent to use OpenClaw memory_search/memory_get alongside
   * ClawBoard retrieval context/tools for recall.
   */
  enableOpenClawMemorySearch?: boolean;
  /**
   * Deprecated backward-compatibility alias for older configs.
   * Prefer `enableOpenClawMemorySearch`.
   */
  disableOpenClawMemorySearch?: boolean;
};

export type ContextMode = "auto" | "cheap" | "full" | "patient";

export type QueryParamValue = string | number | boolean | undefined | null;
