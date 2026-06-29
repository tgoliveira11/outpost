import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { outpostSchema } from "./schema.js";

/**
 * Driver-agnostic Drizzle database type. Works with any pg driver
 * (`drizzle-orm/node-postgres`, `drizzle-orm/postgres-js`, Neon, etc.) — the
 * repositories only use the dialect-level query builder, not driver specifics.
 *
 *   import { drizzle } from "drizzle-orm/node-postgres";
 *   import { outpostSchema } from "@tgoliveira/outpost/drizzle";
 *   const db = drizzle(pool, { schema: outpostSchema });
 */
export type OutpostDb = PgDatabase<PgQueryResultHKT, typeof outpostSchema>;
