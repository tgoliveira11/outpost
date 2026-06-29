import { defineConfig } from "tsup";

/**
 * Build configuration.
 *
 * Each public subpath export (see package.json `exports`) is its own entry so
 * consumers only pull in what they import. Heavy/optional adapters (nodemailer,
 * @opentelemetry/api) are kept external so they remain peer dependencies and
 * are never bundled into the package.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/index": "src/adapters/index.ts",
    "adapters/drizzle/index": "src/adapters/drizzle/index.ts",
    "http/index": "src/http/index.ts",
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
  ],
});
