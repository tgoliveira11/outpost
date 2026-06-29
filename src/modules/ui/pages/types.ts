export type PageWidth = "narrow" | "medium" | "wide";

/** Route paths for Outpost admin pages. Override per page or via `OutpostUIProvider`. */
export type OutpostPaths = {
  adminPanel?: string;
};

export const DEFAULT_OUTPOST_PATHS: Required<OutpostPaths> = {
  adminPanel: "/admin",
};

export function resolveOutpostPaths(overrides?: OutpostPaths): Required<OutpostPaths> {
  return { ...DEFAULT_OUTPOST_PATHS, ...overrides };
}
