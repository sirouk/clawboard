declare module "node:sqlite" {
  // Minimal typings for Node's experimental sqlite module.
  // This project uses it only inside the OpenClaw plugin extension code, not in the Next.js runtime.
  export type StatementSync = {
    run: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown;
  };

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
