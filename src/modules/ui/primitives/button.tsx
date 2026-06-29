"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", className, children, ...props },
  ref,
) {
  const variants = {
    primary: "bg-[var(--primary)] text-white hover:bg-[var(--primary-hover)]",
    secondary:
      "border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--card-muted)]",
    danger: "bg-[var(--danger)] text-white hover:bg-red-800",
  };

  return (
    <button
      ref={ref}
      className={cn(
        "min-h-11 rounded-[var(--radius)] px-4 py-2.5 text-sm font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
