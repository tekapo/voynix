import Database from "@tauri-apps/plugin-sql";
import { MIGRATIONS } from "./migrations";
import { createRunOnce } from "../lib/singleFlight";

const DB_NAME = "sqlite:voynix.db";

let db: Database | null = null;

export async function getDb(): Promise<Database> {
    if (!db) {
        db = await Database.load(DB_NAME);
    }
    return db;
}

async function getUserVersion(db: Database): Promise<number> {
    const rows: any[] = await db.select("PRAGMA user_version");
    return rows[0]?.user_version ?? 0;
}

export interface BatchOpts<T> {
    onChunk?: (done: number, total: number) => void;
    /** Called with a failing chunk's items; default behavior is to rethrow. */
    onError?: (items: T[], e: unknown) => Promise<void> | void;
}

// React StrictMode double-invokes effects in dev, so initDb() can be called
// twice concurrently. Without this guard both runs race the same ALTER TABLE
// and the second fails with "duplicate column name".
const initOnce = createRunOnce(() => runMigrations());

/** Test-only: drop the cached init promise so each test re-runs migrations. */
export function _resetCoreForTests() {
    initOnce.reset();
    db = null;
}

export async function initDb() {
    return initOnce.run();
}

async function runMigrations() {
    const db = await getDb();

    // WAL lets the Rust-side sync server read the DB while the app writes it.
    try {
        await db.execute("PRAGMA journal_mode=WAL");
    } catch (e) {
        console.warn("Could not enable WAL mode:", e);
    }

    let version = await getUserVersion(db);
    while (version < MIGRATIONS.length) {
        console.log(`Running DB migration ${version + 1}/${MIGRATIONS.length}...`);
        await MIGRATIONS[version](db);
        version += 1;
        await db.execute(`PRAGMA user_version = ${version}`);
    }
}
