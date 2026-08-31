export function Brand({
  compact = false,
  label,
}: {
  compact?: boolean;
  label: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5" aria-label={label}>
      <span
        className="inline-grid h-[1.0625rem] w-[0.8125rem] grid-cols-3 items-end gap-0.5"
        aria-hidden="true"
      >
        <i className="h-2 bg-current" />
        <i className="h-[1.0625rem] bg-accent" />
        <i className="h-3 bg-current" />
      </span>
      <span className="font-mono text-[0.8125rem] font-bold tracking-[0.12em]">BUGTRACE</span>
      {!compact && (
        <span className="truncate border-s border-separator ps-2 font-mono text-[0.5625rem] font-semibold tracking-[0.12em] text-muted">
          REC / 01
        </span>
      )}
    </div>
  );
}
