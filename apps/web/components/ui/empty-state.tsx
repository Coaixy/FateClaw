import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-14 h-14 rounded-2xl bg-surface-card border border-hairline flex items-center justify-center mb-4">
        <Icon size={22} className="text-muted/50" />
      </div>
      <h3 className="text-[14px] font-medium mb-1">{title}</h3>
      {description && (
        <p className="text-[12px] text-muted text-center max-w-[240px]">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 h-8 px-4 rounded-lg text-[12px] font-medium bg-ink text-canvas hover:opacity-90 transition-opacity cursor-pointer active:scale-[0.97]"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
