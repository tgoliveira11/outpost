"use client";

import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { MAIN_CONTENT_ID } from "../lib/main-content.js";
import type { PageWidth } from "../pages/types.js";

const widthClass: Record<PageWidth, string> = {
  narrow: "max-w-md",
  medium: "max-w-xl",
  wide: "max-w-6xl",
};

export type PageShellProps = {
  children: ReactNode;
  width?: PageWidth;
  className?: string;
};

/** Domain-neutral page shell — consumers add navigation in their layout. */
export function PageShell({ children, width = "wide", className }: PageShellProps) {
  return (
    <main
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      className={cn("mx-auto px-4 py-8 md:py-10", widthClass[width], className)}
    >
      {children}
    </main>
  );
}
