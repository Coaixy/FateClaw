'use client';

import { type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';

/**
 * 单个生效筛选标签的数据描述。
 *
 * 采用声明式：调用方把"当前生效的筛选条件"映射成数组传入，
 * 组件负责渲染与空态隐藏，调用方不写条件渲染样板。
 *
 * @param key    稳定标识，仅作 React key 用，不展示。
 * @param label  chip 上展示的文案，如「用户 #123」「已支付」。
 * @param icon   可选前置图标，与筛选维度语义对齐（如用户用 User）。
 * @param onClear 点击该 chip 的 × 时回调，由调用方实现"清掉这一项"。
 */
export interface AdminFilterChipData {
  key: string;
  label: ReactNode;
  icon?: LucideIcon;
  onClear: () => void;
}

/**
 * 单个 chip：带前置图标与右侧 × 删除按钮的圆角标签。
 *
 * 视觉沿用后台次级控件收敛态（border-hairline / bg-surface-card / text-[12px]），
 * × 按钮单独可点，hover 加深背景给出可删除反馈。
 */
function AdminFilterChip({ chip }: { chip: AdminFilterChipData }) {
  const Icon = chip.icon;
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface-card pl-2 pr-1 text-[12px] font-medium text-body">
      {Icon ? <Icon size={12} className="text-muted" /> : null}
      <span className="max-w-[14rem] truncate">{chip.label}</span>
      <button
        type="button"
        onClick={chip.onClear}
        aria-label={`清除筛选 ${typeof chip.label === 'string' ? chip.label : chip.key}`}
        className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hairline/60 hover:text-ink"
      >
        <X size={12} />
      </button>
    </span>
  );
}

/**
 * 生效筛选集合：在筛选区下方渲染一行可单删的 chip + 「清空全部」按钮。
 *
 * 设计目标——把后台筛选的"隐形状态"变成显式可操作实体：
 * - chips 为空时整行不渲染（调用方无需手写空态）。
 * - 「清空全部」只在多于 1 项时出现；仅 1 项时直接用 chip 自身的 × 即可，
 *   避免单条筛选也顶个「清空全部」的冗余感。
 * - actions 插槽留给"应用筛选/手动搜索"等非删除类动作，保持筛选区动作聚合。
 *
 * @param chips    当前生效的筛选条件数组，通常由调用方从各筛选 state 派生。
 * @param onClear  「清空全部」回调，由调用方实现把所有筛选重置为默认。
 * @param actions  可选额外动作节点，渲染在行末（如手动触发的查询按钮）。
 */
export function AdminActiveFilters({
  chips,
  onClear,
  actions,
}: {
  chips: AdminFilterChipData[];
  onClear: () => void;
  actions?: ReactNode;
}) {
  if (chips.length === 0) return null;
  const showClearAll = chips.length > 1;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      <span className="text-[12px] text-muted">当前筛选</span>
      {chips.map((chip) => (
        <AdminFilterChip key={chip.key} chip={chip} />
      ))}
      {showClearAll ? (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted transition-colors hover:bg-hairline/60 hover:text-ink"
        >
          <X size={12} />
          清空全部
        </button>
      ) : null}
      {actions ? (
        <span className="ml-auto flex items-center gap-2">{actions}</span>
      ) : null}
    </div>
  );
}
