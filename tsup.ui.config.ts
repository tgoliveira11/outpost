import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { defineConfig } from "tsup";

function collectUiEntries(dir: string, relativeBase: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const filePath = path.join(dir, name);
    const relativePath = path.join(relativeBase, name);
    if (statSync(filePath).isDirectory()) {
      if (relativePath.endsWith("/components")) continue;
      Object.assign(entries, collectUiEntries(filePath, relativePath));
      continue;
    }
    if (!/\.tsx?$/.test(name) || name.includes(".test.")) continue;
    entries[relativePath.replace(/\.tsx?$/, "")] = filePath;
  }
  return entries;
}

const uiEntries = collectUiEntries(path.resolve("src/modules/ui"), "modules/ui");

/** React admin UI — runs after core + react/client builds. */
export default defineConfig({
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  splitting: false,
  target: "es2022",
  esbuildOptions(options: { sourcesContent?: boolean }) {
    options.sourcesContent = false;
  },
  external: [
    "react",
    "react-dom",
    "next",
    "@tgoliveira/outpost/react/client",
  ],
  entry: {
    "react/index": "src/react/index.ts",
    ...uiEntries,
  },
  outDir: "dist",
  clean: false,
  bundle: true,
});
