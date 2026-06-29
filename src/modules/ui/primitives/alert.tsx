import { cn } from "../lib/cn.js";

type AlertVariant = "info" | "success" | "warning" | "danger" | "muted";

const variantStyles: Record<AlertVariant, string> = {
  info: "border-[var(--info-muted)] bg-[var(--info-muted)] text-[var(--info)]",
  success: "border-[var(--success-muted)] bg-[var(--success-muted)] text-[var(--success)]",
  warning: "border-[var(--warning-muted)] bg-[var(--warning-muted)] text-[var(--warning)]",
  danger: "border-[var(--danger-muted)] bg-[var(--danger-muted)] text-[var(--danger)]",
  muted: "border-[var(--border)] bg-[var(--card-muted)] text-[var(--muted)]",
};

interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
  title?: string;
}

export function Alert({ variant = "muted", title, className, children, ...props }: AlertProps) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-[var(--radius)] border px-4 py-3 text-sm leading-relaxed",
        variantStyles[variant],
        className,
      )}
      {...props}
    >
      {title && <p className="mb-1 font-medium">{title}</p>}
      {children}
    </div>
  );
}
