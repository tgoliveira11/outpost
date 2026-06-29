export { OutpostUIProvider, useOutpostUi } from "./outpost-ui-provider.js";
export type { OutpostUIProviderProps } from "./outpost-ui-provider.js";

export { PageShell } from "./layouts/page-shell.js";
export type { PageShellProps } from "./layouts/page-shell.js";

export { Button } from "./primitives/button.js";
export { Alert } from "./primitives/alert.js";
export { Badge } from "./primitives/badge.js";
export { Card, CardHeader, CardTitle, CardDescription } from "./primitives/card.js";
export { PageHeader } from "./primitives/page-header.js";
export { LoadingState } from "./primitives/loading-state.js";
export { EmptyState } from "./primitives/empty-state.js";
export { Input } from "./primitives/input.js";

export * from "./pages/index.js";
export { useUiPaths } from "./pages/use-page-ui.js";
export type { OutpostPaths, PageWidth } from "./pages/types.js";
export { DEFAULT_OUTPOST_PATHS, resolveOutpostPaths } from "./pages/types.js";
