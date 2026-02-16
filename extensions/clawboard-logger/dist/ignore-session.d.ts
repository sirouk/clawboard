export declare const DEFAULT_IGNORE_SESSION_PREFIXES: readonly ["internal:clawboard-classifier:", "agent:main:cron:"];
export declare function parseIgnoreSessionPrefixes(raw: string | undefined | null): string[];
export declare function getIgnoreSessionPrefixesFromEnv(env: NodeJS.ProcessEnv): string[];
export declare function shouldIgnoreSessionKey(sessionKey: string | undefined | null, prefixes?: string[]): boolean;
