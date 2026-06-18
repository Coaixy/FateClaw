import type { Metadata } from 'next';
import {
  HeartHandshake,
  ImageIcon,
  ShieldCheck,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';

export const metadata: Metadata = {
  title: '公益',
};

interface CharityScreenshot {
  src: string;
  alt: string;
  title: string;
  date: string;
  description: string;
}

const CHARITY_SCREENSHOTS: CharityScreenshot[] = [
  {
    src: '/charity/2026.6.18.PNG',
    alt: '希望工程捐赠回执截图',
    title: '捐赠回执',
    date: '2026-06-18',
    description: '希望工程',
  },
];

/**
 * 渲染公益页面。
 *
 * @returns 面向公开访问者的公益记录和截图展示页。
 */
export default function CharityPage() {
  return (
    <AppShell wide requireAuth={false}>
      <div className="min-h-[70vh] space-y-4">
        <section className="relative overflow-hidden rounded-lg border border-primary/20 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-surface-card)_88%,var(--color-canvas)),color-mix(in_srgb,var(--color-surface-soft)_70%,var(--color-canvas)))] p-5 shadow-[0_18px_48px_rgba(15,23,42,0.1)]">
          <div className="pointer-events-none absolute inset-0 opacity-35" aria-hidden="true">
            <div className="absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-ink)_6%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--color-ink)_6%,transparent)_1px,transparent_1px)] bg-[size:32px_32px]" />
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
          </div>

          <div className="relative grid gap-5 md:grid-cols-[minmax(0,1fr)_280px] md:items-end">
            <div className="min-w-0">
              <span className="inline-flex min-h-8 items-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-3 text-[12px] font-semibold text-primary">
                <HeartHandshake size={14} />
                公益记录
              </span>
              <h1 className="mt-5 text-[30px] font-semibold leading-tight tracking-tight text-ink md:text-[44px]">
                公益
              </h1>
            </div>

            <div className="rounded-lg border border-hairline bg-canvas/70 p-4 shadow-sm">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <ShieldCheck size={15} className="text-primary" />
                展示原则
              </div>
              <p className="mt-2 text-[12px] leading-5 text-muted">
                涉及个人隐私、交易流水号和联系方式的内容会先做遮挡处理，再作为截图公开展示。
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-hairline bg-surface-card/80 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">
                公益截图
              </h2>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                {CHARITY_SCREENSHOTS.length > 0
                  ? '按时间展示已公开的公益凭证，点击图片可查看原图。'
                  : '当前暂无已公开截图。'}
              </p>
            </div>
            <span className="inline-flex min-h-7 shrink-0 items-center rounded-lg border border-hairline bg-canvas/70 px-2.5 text-[11px] font-medium text-muted">
              {CHARITY_SCREENSHOTS.length} 张
            </span>
          </div>

          {CHARITY_SCREENSHOTS.length > 0 ? (
            <div className="columns-1 gap-3 md:columns-2 2xl:columns-3">
              {CHARITY_SCREENSHOTS.map((item) => (
                <article
                  key={`${item.date}-${item.src}`}
                  className="mb-3 break-inside-avoid overflow-hidden rounded-lg border border-hairline bg-canvas"
                >
                  <a
                    href={item.src}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block bg-surface-soft"
                  >
                    <img
                      src={item.src}
                      alt={item.alt}
                      className="h-auto w-full object-contain"
                    />
                  </a>
                  <div className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-[13px] font-semibold text-ink">
                        {item.title}
                      </h3>
                      <time className="shrink-0 text-[11px] tabular-nums text-muted">
                        {item.date}
                      </time>
                    </div>
                    <p className="mt-1 text-[12px] leading-5 text-muted">
                      {item.description}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-hairline bg-canvas/70 px-4 py-8 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <ImageIcon size={18} />
              </div>
              <h3 className="mt-3 text-[14px] font-semibold text-ink">
                暂无公开截图
              </h3>
              <p className="mt-1 max-w-md text-[12px] leading-5 text-muted">
                后续确认可公开的公益凭证后，会在这里按时间展示。
              </p>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
