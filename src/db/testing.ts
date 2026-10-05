import { _resetCoreForTests } from "./core";
import { _resetLegacyImportForTests } from "./legacyImport";

/** Test-only: drop the cached init/migrate promises and the db handle so each test re-runs migrations. */
export function _resetInitForTests() {
    _resetCoreForTests();
    _resetLegacyImportForTests();
}
