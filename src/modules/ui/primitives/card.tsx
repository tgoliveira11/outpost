import { cn } from "../lib/cn.js";

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  muted?: boolean;
};

export function Card({ className, muted, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border border-[var(--border)] p-5 shadow-[var(--shadow-sm)]",
        muted ? "bg-[var(--card-muted)]" : "bg-[var(--card)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("mb-4 space-y-1", className)} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cn("text-lg font-medium text-[var(--foreground)]", className)} {...props}>
      {children}
    </h2>
  );
}

export function CardDescription({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-sm leading-relaxed text-[var(--muted)]", className)} {...props}>
      {children}
    </p>
  );
}
