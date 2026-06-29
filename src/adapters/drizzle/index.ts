/**
 * Drizzle/Postgres adapter barrel — exported at `@tgoliveira/outpost/drizzle`.
 *
 * Pass `outpostSchema` to `drizzle(client, { schema })`, generate a migration
 * from the schema with drizzle-kit, then construct the repositories with your
 * db instance and hand them to `createOutpost`.
 */
export * from "./schema.js";
export * from "./db.js";
export * from "./repositories.js";
export * from "./mappers.js";
