import { defineConfig } from "tsup";

/**
 * Core build — server/runtime entries. Runs first with `clean: true`.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/index": "src/adapters/index.ts",
    "adapters/drizzle/index": "src/adapters/drizzle/index.ts",
    "http/index": "src/http/index.ts",
    "admin/index": "src/admin/create-outpost-admin.ts",
    "workers/index": "src/workers/index.ts",
    "testing/index": "src/testing/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: [
    "drizzle-orm",
    "nodemailer",
    "@opentelemetry/api",
    "zod",
    "react",
    "react-dom",
    "next",
  ],
});
