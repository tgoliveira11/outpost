/**
 * Reference drizzle-kit config for a CONSUMING application.
 *
 * This file is NOT used to build the `@tgoliveira/outpost` package itself — it
 * is an example of how an app that installs Outpost wires drizzle-kit to
 * generate and run the migrations for Outpost's tables (outbox, audit_events,
 * suppressions, webhook_events, api_keys). Copy it into your app and adjust.
 *
 * Two ways to point `schema` at Outpost's table definitions:
 *
 *   1. Directly at the published schema module (shown below). Outpost re-exports
 *      its Drizzle tables from the `/drizzle` subpath; the compiled file lives at
 *      `node_modules/@tgoliveira/outpost/dist/adapters/drizzle/index.js`.
 *
 *   2. Re-export it from your own file so it sits alongside your app's own
 *      tables, then point `schema` there. For example, create
 *      `src/db/schema.ts` with:
 *
 *        export { outpostSchema } from "@tgoliveira/outpost/drizzle";
 *        // ...plus your own table exports
 *
 *      and set `schema: "./src/db/schema.ts"`. This is the recommended option
 *      if you have other Drizzle tables in the same database.
 *
 * Uses the drizzle-kit v0.x `defineConfig` shape. See docs/database.md.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // Option 1: point straight at the published, compiled schema module.
  schema: "./node_modules/@tgoliveira/outpost/dist/adapters/drizzle/index.js",
  // Option 2 (recommended when you have your own tables): re-export
  // `outpostSchema` from your own file and point here instead, e.g.
  // schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
