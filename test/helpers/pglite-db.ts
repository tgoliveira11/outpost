import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { outpostSchema } from "../../src/adapters/drizzle/schema.js";
import type { OutpostDb } from "../../src/adapters/drizzle/db.js";

/**
 * Spin up an in-memory Postgres (PGlite) with Outpost's schema applied from the
 * generated drizzle migration, and return a real Drizzle db. This exercises the
 * actual SQL in the repositories — no mocks.
 */
export async function createTestDb(): Promise<{ db: OutpostDb; close: () => Promise<void> }> {
  const client = new PGlite(); // ephemeral in-memory
  const migrationsDir = join(process.cwd(), "drizzle");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    // drizzle-kit separates statements with this marker.
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  const db = drizzle(client, { schema: outpostSchema }) as unknown as OutpostDb;
  return { db, close: () => client.close() };
}
