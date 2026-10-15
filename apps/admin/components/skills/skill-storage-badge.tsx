import type { AdminSkillStorageDto } from '@fateclaw/contracts/skills';
import { SKILL_STORAGE_META } from '@/lib/skill-storage';

export function SkillStorageBadge({
  storage,
}: {
  storage: AdminSkillStorageDto;
}) {
  const meta = SKILL_STORAGE_META[storage.state];
  const style = {
    success: 'border-success/30 bg-success/10',
    pending: 'border-hairline bg-canvas',
    warning: 'border-warning/30 bg-warning/10',
  }[meta.tone];
  const dot = {
    success: 'bg-success',
    pending: 'bg-muted-soft',
    warning: 'bg-warning',
  }[meta.tone];
  return (
    <span
      title={meta.description}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-5 text-ink ${style}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {meta.label}
    </span>
  );
}
