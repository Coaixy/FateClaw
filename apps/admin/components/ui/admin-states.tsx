'use client';

import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

type AdminAlertTone = 'error' | 'success' | 'warning' | 'info';

const alertToneClass: Record<AdminAlertTone, string> = {
  error: 'border-error/25 bg-error/10 text-error',
  success: 'border-success/25 bg-success/10 text-success',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  info: 'border-hairline bg-surface-card text-muted',
};

const alertToneIcon: Record<AdminAlertTone, LucideIcon> = {
  error: XCircle,
  success: Info,
  warning: AlertTriangle,
  info: Info,
};

/**
 * 管理后台通用页头，统一标题、说明、统计信息和右侧操作位。
 */
export function AdminPageHeader({
  icon: Icon,
  title,
  description,
  meta,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Icon size={16} className="shrink-0 text-muted" />
          <h2 className="text-lg font-semibold">{title}</h2>
          {meta}
        </div>
        {description ? (
          <p className="mt-1 text-[12px] leading-5 text-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/**
 * 管理后台通用提示条，用于展示错误、成功、警告和说明信息。
 */
export function AdminAlert({
  tone,
  children,
}: {
  tone: AdminAlertTone;
  children: React.ReactNode;
}) {
  const Icon = alertToneIcon[tone];
  return (
    <div
      className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-[13px] ${alertToneClass[tone]}`}
    >
      <Icon size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * 管理后台通用加载占位，避免每个页面重复 spinner 样式。
 */
export function AdminLoadingState({ label = '加载中' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-muted">
      <Loader2 size={18} className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}

/**
 * 管理后台通用空状态，用于列表无数据或筛选无结果。
 */
export function AdminEmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-card px-4 py-12 text-center">
      {Icon ? <Icon size={22} className="mx-auto mb-2 text-muted" /> : null}
      <p className="text-[13px] text-muted">{title}</p>
      {description ? (
        <p className="mt-1 text-[12px] leading-5 text-muted">{description}</p>
      ) : null}
    </div>
  );
}

/**
 * 管理后台通用分页控件，统一上一页、下一页和范围文案。
 */
export function AdminPagination({
  rangeLabel,
  pageLabel,
  canPrevious,
  canNext,
  disabled,
  onPrevious,
  onNext,
}: {
  rangeLabel: string;
  pageLabel: string;
  canPrevious: boolean;
  canNext: boolean;
  disabled?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <span className="min-w-[92px] text-right tabular-nums">{rangeLabel}</span>
      <div className="inline-flex overflow-hidden rounded-lg border border-hairline bg-surface-card">
        <button
          type="button"
          onClick={onPrevious}
          disabled={disabled || !canPrevious}
          className="inline-flex h-10 min-w-10 cursor-pointer items-center justify-center border-r border-hairline px-2 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="上一页"
        >
          <ChevronLeft size={15} />
        </button>
        <span className="inline-flex h-10 min-w-14 items-center justify-center px-3 tabular-nums">
          {pageLabel}
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={disabled || !canNext}
          className="inline-flex h-10 min-w-10 cursor-pointer items-center justify-center border-l border-hairline px-2 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="下一页"
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

/**
 * 管理后台通用筛选区，统一筛选标题和响应式内容布局。
 */
export function AdminFilterSection({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon size={14} className="text-muted" />
        <h3 className="text-[14px] font-semibold">{title}</h3>
      </div>
      {children}
    </section>
  );
}
