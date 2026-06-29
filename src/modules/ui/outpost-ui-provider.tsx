"use client";

import { createContext, useContext, type ReactNode } from "react";
import { resolveOutpostPaths, type OutpostPaths } from "./pages/types.js";

type OutpostUiContextValue = {
  paths: Required<OutpostPaths>;
};

const OutpostUiContext = createContext<OutpostUiContextValue | null>(null);

export type OutpostUIProviderProps = {
  children: ReactNode;
  paths?: OutpostPaths;
};

export function OutpostUIProvider({ children, paths }: OutpostUIProviderProps) {
  return (
    <OutpostUiContext.Provider value={{ paths: resolveOutpostPaths(paths) }}>
      {children}
    </OutpostUiContext.Provider>
  );
}

export function useOutpostUi(): OutpostUiContextValue | null {
  return useContext(OutpostUiContext);
}
