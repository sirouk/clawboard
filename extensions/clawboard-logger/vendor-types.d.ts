/**
 * Local type stubs for modules resolved at runtime by the OpenClaw host but not available
 * as npm packages in this repo's node_modules. Do not export from index.ts — these are
 * ambient declarations used only during TypeScript compilation of the plugin.
 */

declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    pluginConfig?: Record<string, unknown>;
    logger: {
      info(msg: string): void;
      warn(msg: string): void;
      error(msg: string): void;
      debug(msg: string): void;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
  }
}

declare module "node:sqlite" {
  interface StatementResultingChanges {
    lastInsertRowid: number | bigint;
    changes: number;
  }
  interface StatementSync {
    run(...args: (string | number | bigint | null | Uint8Array)[]): StatementResultingChanges;
    all(...args: (string | number | bigint | null | Uint8Array)[]): unknown[];
    get(...args: (string | number | bigint | null | Uint8Array)[]): unknown;
  }
  interface DatabaseSyncInstance {
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  const DatabaseSync: new (path: string, options?: { open?: boolean; readOnly?: boolean }) => DatabaseSyncInstance;
  type DatabaseSync = DatabaseSyncInstance;
  export { DatabaseSync, StatementSync };
}
