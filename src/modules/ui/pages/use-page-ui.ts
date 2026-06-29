"use client";

import { useOutpostUi } from "../outpost-ui-provider.js";
import { resolveOutpostPaths, type OutpostPaths } from "./types.js";

/** Merges provider paths with page-level overrides. */
export function useUiPaths(overrides?: OutpostPaths) {
  const ui = useOutpostUi();
  return resolveOutpostPaths({ ...ui?.paths, ...overrides });
}
