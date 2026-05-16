'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { TabTasks } from '@/components/settings/tab-tasks';
import { DevicesPanel } from '@/components/workspace/devices-panel';

export function WorkspaceDashboard() {
  return (
    <AppShell wide>
      <div className="max-w-6xl mx-auto w-full">
        <div className="mb-6 lg:mb-8 rounded-3xl border border-hairline bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-surface-card)_92%,transparent),color-mix(in_srgb,var(--color-canvas)_82%,transparent))] px-5 py-5 lg:px-7 lg:py-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.22em] uppercase text-primary/75 mb-2">
                WeChat Bot
              </p>
              <h1 className="text-[24px] lg:text-[30px] font-semibold tracking-tight text-ink">
                微信 BOT 工作区
              </h1>
              <p className="text-[13px] lg:text-[14px] text-muted mt-2 max-w-2xl leading-relaxed">
                这里处理机器人设备、定时任务和账号配置。微信对话保持独立，后台管理更清楚。
              </p>
            </div>
            <Link
              href="/chat"
              className="inline-flex items-center justify-center gap-1.5 h-11 px-5 rounded-2xl bg-primary/12 text-primary hover:bg-primary/18 transition-colors shrink-0"
            >
              进入微信对话
              <ArrowUpRight size={15} />
            </Link>
          </div>
        </div>

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
