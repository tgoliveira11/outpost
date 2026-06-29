import { cn } from "../lib/cn.js";

type BadgeVariant = "default" | "success" | "info" | "danger" | "muted" | "warning";

const styles: Record<BadgeVariant, string> = {
  default: "bg-[var(--accent-muted)] text-[var(--foreground)]",
  success: "bg-[var(--success-muted)] text-[var(--success)]",
  info: "bg-[var(--info-muted)] text-[var(--info)]",
  danger: "bg-[var(--danger-muted)] text-[var(--danger)]",
  muted: "bg-[var(--card-muted)] text-[var(--muted)]",
  warning: "bg-[var(--warning-muted)] text-[var(--warning)]",
};

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ variant = "default", className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        styles[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
