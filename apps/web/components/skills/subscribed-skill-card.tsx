'use client';

import { Check, Share2, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';

import { SubscribedSkill } from '@/features/skills/api';

export function SubscribedSkillCard({
  sk,
  onToggle,
  onUnsubscribe,
  selectionMode = false,
  selected = false,
  onToggleSelect,
}: {
  sk: SubscribedSkill;
  onToggle: (id: string) => void;
  onUnsubscribe: (id: string) => void;
  /** 是否处于批量选择模式;为真时整卡可点选中、内部操作禁用 */
  selectionMode?: boolean;
  /** 当前卡片是否被选中 */
  selected?: boolean;
  /** 切换选中状态,入参为订阅 id(subscription_id) */
  onToggleSelect?: (id: string) => void;
}) {
  return (
    <div
      className={`group relative rounded-2xl border bg-surface-raised transition-all duration-300 ${
        selectionMode
          ? selected
            ? 'cursor-pointer border-primary ring-1 ring-primary/40'
            : 'cursor-pointer border-hairline hover:border-primary/40'
          : 'border-hairline hover:border-primary/40'
      }`}
      onClick={
        selectionMode ? () => onToggleSelect?.(sk.subscription_id) : undefined
      }
    >
      {/* 选择模式下内容区禁用指针事件,避免点到内部操作按钮;选中态由外层整卡点击处理 */}
      <div className={`relative p-3.5 sm:p-4 ${selectionMode ? 'pointer-events-none' : ''}`}>
        <div className="flex items-start gap-3">
          {selectionMode && (
            <div
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                selected
                  ? 'border-primary btn-tactile-primary text-on-primary'
                  : 'border-hairline bg-surface-card'
              }`}
            >
              {selected && <Check size={13} />}
            </div>
          )}
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-300 ${
              sk.subscription_enabled
                ? 'bg-primary/15'
                : 'bg-surface-cream-strong'
            }`}
          >
            <Share2
              size={16}
              className={`transition-colors duration-300 ${
                sk.subscription_enabled
                  ? 'text-primary'
                  : 'text-muted'
              }`}
            />
          </div>

          <div className="flex-1 min-w-0 pt-0.5">
            <p className="text-[13px] font-semibold truncate tracking-tight">
              {sk.skill_name}
            </p>
            {sk.description && (
              <p className="text-[12px] text-muted mt-1 line-clamp-2 leading-relaxed">
                {sk.description}
              </p>
            )}
          </div>

          <button
            onClick={() => onToggle(sk.subscription_id)}
            className="shrink-0 p-1.5 rounded-xl hover:bg-surface-cream-strong transition-all cursor-pointer"
            title={sk.subscription_enabled ? '禁用' : '启用'}
            aria-label={sk.subscription_enabled ? '禁用' : '启用'}
          >
            {sk.subscription_enabled ? (
              <ToggleRight size={24} className="text-primary" />
            ) : (
              <ToggleLeft size={24} className="text-muted" />
            )}
          </button>
        </div>

        <div className="flex items-center justify-between mt-4 pt-3 border-t border-hairline/50">
          <div className="flex items-center gap-2 overflow-hidden">
            <span
              className={`shrink-0 inline-flex items-center h-6 px-2 rounded-md text-[11px] font-medium ${
                sk.subscription_enabled
                  ? 'bg-primary/10 text-primary'
                  : 'bg-surface-cream-strong text-muted'
              }`}
            >
              {sk.subscription_enabled ? '已启用' : '未启用'}
            </span>
            <span className="shrink-0 inline-flex items-center h-6 px-2 rounded-md text-[11px] bg-surface-cream-strong text-muted truncate max-w-[140px]">
              {sk.author_label}
            </span>
            <span className="shrink-0 inline-flex items-center h-6 px-2 rounded-md text-[11px] bg-surface-cream-strong text-muted tabular-nums">
              {sk.content_length.toLocaleString()} 字
            </span>
          </div>

          <button
            onClick={() => onUnsubscribe(sk.subscription_id)}
            className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-muted hover:text-error hover:bg-error/10 transition-all cursor-pointer ml-2"
            title="取消订阅"
            aria-label="取消订阅"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
