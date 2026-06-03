'use client';

import { AppShell } from '@/components/app-shell';
import { TabData } from '@/components/settings/tab-data';
import { DevicesPanel } from '@/components/workspace/devices-panel';
import { UserSoulCard } from '@/components/workspace/user-soul-card';

export function WorkspaceDashboard() {
  return (
    <AppShell wide>
      <div className="max-w-6xl mx-auto w-full">
        <div className="space-y-5 lg:space-y-6">
          <DashboardSection
            title="自定义人格"
            description="维护统一注入 Pi Runtime 的 Soul。"
          >
            <UserSoulCard />
          </DashboardSection>

          <DashboardSection
            title="宿主设备"
            description="查看微信接入状态。"
          >
            <DevicesPanel embedded />
          </DashboardSection>

          <DashboardSection
            title="数据管理"
            description="清理微信账号体系下的数据和当前用户 Soul。"
          >
            <TabData />
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
