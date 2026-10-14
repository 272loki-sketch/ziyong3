import { rmSync } from "node:fs";
import { closeMemoryDatabase } from "../../src/memory/store.ts";

/**
 * Close the SQLite handle owned by a temporary memory fixture before removing
 * its directory. Call only after the fixture has awaited all started work.
 */
export function cleanupMemoryFixture(cwd: string): void {
	closeMemoryDatabase(cwd);
	rmSync(cwd, { recursive: true, force: true });
}
