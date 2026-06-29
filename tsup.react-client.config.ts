import { defineConfig } from "tsup";

/** Client-only helpers — runs after core build, before UI DTS. */
export default defineConfig({
  entry: {
    "react/client": "src/react/client.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: false,
  treeshake: true,
  banner: { js: '"use client";' },
  external: ["react", "react-dom", "next"],
});
