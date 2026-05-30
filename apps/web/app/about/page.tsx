import type { Metadata } from 'next';
import {
  Landmark,
  NotebookText,
  ReceiptText,
  ShieldAlert,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';

const costItems = [
  { label: '服务器成本', amount: 500 },
  { label: '域名成本', amount: 100 },
  { label: '开发成本', amount: 300 },
];

const totalCost = costItems.reduce((sum, item) => sum + item.amount, 0);

export const metadata: Metadata = {
  title: '关于我们',
};

/**
 * 关于我们页面。
 *
 * 说明 LetFate·Claw 的传统文化定位、非盈利运营原则和 AI 输出边界。
 */
export default function AboutPage() {
  return (
    <AppShell>
      <div className="min-h-[70vh]">
        <section className="relative overflow-hidden rounded-2xl border border-hairline bg-surface-card shadow-[0_10px_28px_rgba(15,23,42,0.04)]">
          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_31px,color-mix(in_srgb,var(--color-hairline)_55%,transparent)_32px)] bg-[size:100%_32px] opacity-70" />
          <div className="absolute bottom-0 left-11 top-0 w-px bg-error/25 md:left-14" />

          <div className="relative space-y-7 px-5 py-5 pl-16 md:px-7 md:py-7 md:pl-20">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-semibold text-primary">
                <NotebookText size={14} />
                公开记事本
              </div>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
                LetFate·Claw
              </h1>
            </div>

            <div className="space-y-4 text-[14px] leading-7 text-ink/85">
              <p>
                LetFate·Claw 致力于以现代方式弘扬中国优良传统文化瑰宝——八字命理、奇门遁甲，六爻纳甲等皆为中华先民的智慧结晶。
              </p>
              <p>
                本站为非盈利性质，收费部分覆盖服务器与 AI 算力等运营成本后，结余将用于支持中国公益事业。
              </p>
            </div>

            <div className="rounded-xl border border-hairline/70 bg-canvas/65 p-4">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink">
                <ReceiptText size={15} className="text-primary" />
                当前成本记录
              </div>
              <div className="space-y-2">
                {costItems.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-3 border-b border-hairline/50 pb-2 text-[13px] last:border-0 last:pb-0"
                  >
                    <span className="text-muted">{item.label}</span>
                    <span className="font-semibold tabular-nums text-ink">
                      {item.amount.toLocaleString('zh-CN')} 元
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between rounded-lg bg-surface-card px-3 py-2 text-[13px]">
                <span className="font-medium text-ink">目前合计</span>
                <span className="font-semibold tabular-nums text-primary">
                  {totalCost.toLocaleString('zh-CN')} 元
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-hairline/70 bg-canvas/65 p-4">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink">
                <ShieldAlert size={15} className="text-primary" />
                娱乐参考声明
              </div>
              <p className="text-[13px] leading-6 text-muted">
                站内所有 AI 输出仅供娱乐参考，不构成任何人生、健康、财务、婚恋等决策建议。开心第一，命运在己。
              </p>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-muted/75">
              <Landmark size={13} />
              <span>以现代工具记录传统文化、运营成本与公益初心。</span>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
