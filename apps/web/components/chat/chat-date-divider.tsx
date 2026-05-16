export function ChatDateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 my-6">
      <div className="flex-1 h-px bg-gradient-to-r from-transparent via-hairline/60 to-transparent" />
      <span className="text-[10px] text-muted shrink-0 px-3 py-1 rounded-full bg-surface-card border border-hairline/60 font-medium">
        {label}
      </span>
      <div className="flex-1 h-px bg-gradient-to-r from-transparent via-hairline/60 to-transparent" />
    </div>
  );
}
