interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = "Loading" }: LoadingStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-16 text-center"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div
        className="h-8 w-8 animate-pulse rounded-full border-2 border-[var(--border)] border-t-[var(--primary)]"
        aria-hidden="true"
      />
      <p className="text-sm text-[var(--muted)]">{label}…</p>
    </div>
  );
}
