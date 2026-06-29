import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]",
          "placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]",
          className,
        )}
        {...props}
      />
    );
  },
);
