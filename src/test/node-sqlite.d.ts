// Minimal ambient typing for Node's built-in `node:sqlite` (stable since
// Node 22.5, used here via sqliteDevice.ts). The project has no `@types/node`
// dependency, so this declares only the surface this test harness touches
// rather than pulling in a full types package for one test-only import.
declare module "node:sqlite" {
    export interface StatementResultingChanges {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    }

    export class StatementSync {
        run(namedParams?: Record<string, unknown>): StatementResultingChanges;
        all(namedParams?: Record<string, unknown>): unknown[];
    }

    export class DatabaseSync {
        constructor(location: string);
        exec(sql: string): void;
        prepare(sql: string): StatementSync;
        close(): void;
    }
}
