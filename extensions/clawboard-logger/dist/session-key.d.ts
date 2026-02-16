type MessageHookContext = {
    channelId?: string;
    conversationId?: string;
    sessionKey?: string;
};
export type BoardSessionRoute = {
    kind: "topic";
    topicId: string;
} | {
    kind: "task";
    topicId: string;
    taskId: string;
};
export declare function parseBoardSessionKey(sessionKey: string | undefined | null): BoardSessionRoute | null;
export declare function computeEffectiveSessionKey(meta: Record<string, unknown> | undefined, ctx: MessageHookContext): string | undefined;
export {};
