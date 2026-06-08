'use client';

import { AppShell } from '@/components/app-shell';
import { TabData } from '@/components/settings/tab-data';
import { DevicesPanel } from '@/components/workspace/devices-panel';

/**
 * 微信对话工作区。
 *
 * @returns 仅包含微信连接和数据管理能力的工作区页面。
 */
export function WorkspaceDashboard() {
  return (
    <AppShell wide>
      <div className="max-w-6xl mx-auto w-full">
        <div className="space-y-5 lg:space-y-6">
          <DashboardSection
            id="weixin-connect"
            title="连接微信"
            description="查看微信对话接入状态。"
          >
            <DevicesPanel embedded />
          </DashboardSection>

          <DashboardSection
            id="data-management"
            title="数据管理"
            description="清理微信对话消息和长期记忆。"
          >
            <TabData />
          </DashboardSection>
        </div>
      </div>
    </AppShell>
  );
}

function DashboardSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-20 rounded-3xl border border-hairline bg-surface-card/50 p-4 lg:p-6"
    >
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
