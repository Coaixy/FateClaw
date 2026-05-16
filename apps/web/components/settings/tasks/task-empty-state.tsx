import { Bell } from 'lucide-react';

export function TaskEmptyState({ canUseWeixin }: { canUseWeixin: boolean }) {
  return (
    <div className="py-16 text-center">
      <div className="w-14 h-14 rounded-2xl bg-surface-card border border-hairline flex items-center justify-center mx-auto mb-4">
        <Bell size={24} strokeWidth={1.2} className="text-muted/40" />
      </div>
      <p className="text-[15px] font-medium mb-1">暂无定时任务</p>
      <p className="text-[13px] text-muted max-w-[260px] mx-auto">
        {canUseWeixin
          ? '在微信中对 AI 说“每天早上 8 点提醒我…”即可创建'
          : '接入微信 BOT 后，可在微信中创建定时任务'}
      </p>
    </div>
  );
}
