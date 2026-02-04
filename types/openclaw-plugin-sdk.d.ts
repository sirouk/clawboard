declare module "openclaw/plugin-sdk" {
  export type PluginHookMessageContext = {
    channelId?: string;
  };

  export type PluginHookToolContext = {
    agentId?: string;
    sessionKey?: string;
  };

  export type PluginHookAgentContext = {
    agentId?: string;
    sessionKey?: string;
  };

  export type PluginHookMessageReceivedEvent = {
    content?: string;
    metadata?: Record<string, unknown>;
  };

  export type PluginHookMessageSentEvent = {
    content?: string;
    summary?: string;
    sessionKey?: string;
  };

  export type PluginHookBeforeToolCallEvent = {
    toolName: string;
    params?: unknown;
  };

  export type PluginHookAfterToolCallEvent = {
    toolName: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
  };

  export type PluginHookAgentEndEvent = {
    success: boolean;
    error?: string;
    durationMs?: number;
    messages?: unknown[];
  };

  export type OpenClawPluginApi = {
    pluginConfig?: Record<string, unknown>;
    logger: {
      warn: (message: string) => void;
    };
    on(
      event: "message_received",
      handler: (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => void | Promise<void>
    ): void;
    on(
      event: "message_sent",
      handler: (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => void | Promise<void>
    ): void;
    on(
      event: "before_tool_call",
      handler: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => void | Promise<void>
    ): void;
    on(
      event: "after_tool_call",
      handler: (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => void | Promise<void>
    ): void;
    on(
      event: "agent_end",
      handler: (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => void | Promise<void>
    ): void;
  };
}
