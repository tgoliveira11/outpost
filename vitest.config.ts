import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/index.ts", // barrels — re-exports only
        "src/adapters/observability/telemetry.ts", // thin OTel wrapper, needs the SDK
        // Type-only modules (interfaces/types — no executable code at runtime):
        "src/ports/**",
        "src/domain/message.ts",
        "src/domain/audit.ts",
        "src/application/context.ts",
        "src/adapters/drizzle/db.ts",
        // DnsMxResolver requires live DNS; covered by integration, not unit tests.
        "src/adapters/services/system.ts",
      ],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
