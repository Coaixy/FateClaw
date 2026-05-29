'use client';

import { AppShell } from '@/components/app-shell';
import { TabTasks } from '@/components/settings/tab-tasks';
import { DevicesPanel } from '@/components/workspace/devices-panel';

export function WorkspaceDashboard() {
  return (
    <AppShell wide>
      <div className="max-w-6xl mx-auto w-full">
        <div className="space-y-5 lg:space-y-6">
          <DashboardSection
            title="宿主设备"
            description="查看接入状态、扫码新增设备，并按账号维护灵魂记忆。"
          >
            <DevicesPanel embedded />
          </DashboardSection>

          <DashboardSection
            title="定时任务"
            description="统一查看任务状态、下次执行时间和删除操作。"
          >
            <TabTasks />
          </DashboardSection>
        </div>
      </div>
    </AppShell>
  );
}

function DashboardSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-hairline bg-surface-card/50 p-4 lg:p-6">
      <div className="mb-4 lg:mb-5">
        <h2 className="text-[18px] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <p className="text-[12px] text-muted mt-1">{description}</p>
      </div>
      {children}
    </section>
  );
}
