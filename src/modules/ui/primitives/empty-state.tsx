interface EmptyStateProps {
  title: string;
  description?: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm font-medium text-[var(--foreground)]">{title}</p>
      {description && <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>}
    </div>
  );
}
