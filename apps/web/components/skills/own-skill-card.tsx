'use client';

import {
  BookOpen,
  Check,
  Download,
  Globe2,
  KeyRound,
  Link2,
  Pencil,
  Share2,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Unlink,
} from 'lucide-react';

import { UserCustomSkillSummary } from '@/features/skills/api';

export function OwnSkillCard({
  sk,
  copiedId,
  onToggle,
  onCopyLink,
  onCopyInviteLink,
  onUnshare,
  onPublish,
  onUnpublish,
  onEdit,
  onExport,
  onDelete,
  selectionMode = false,
  selected = false,
  onToggleSelect,
}: {
  sk: UserCustomSkillSummary;
  copiedId: string | null;
  onToggle: (id: string) => void;
  onCopyLink: (id: string) => void;
  onCopyInviteLink: (id: string) => void;
  onUnshare: (id: string) => void;
  onPublish: (id: string) => void;
  onUnpublish: (id: string) => void;
  onEdit: (sk: UserCustomSkillSummary) => void;
  onExport: (sk: UserCustomSkillSummary) => void;
  onDelete: (id: string) => void;
  /** 是否处于批量选择模式;为真时整卡可点选中、内部操作禁用 */
  selectionMode?: boolean;
  /** 当前卡片是否被选中 */
  selected?: boolean;
  /** 切换选中状态,入参为技能 id */
  onToggleSelect?: (id: string) => void;
}) {
  const isPublic = sk.visibility === 'shared';
  const isLinkShared = sk.visibility === 'link_shared';
  const isShared = isPublic || isLinkShared;
  const distributionSummary = isPublic
    ? '会展示在技能市场'
    : isLinkShared
      ? '仅通过链接访问'
      : '可先私密分享再公开';

  return (
    <div
      className={`group relative rounded-2xl border bg-surface-raised transition-all duration-300 ${
        selectionMode
          ? selected
            ? 'cursor-pointer border-primary ring-1 ring-primary/40'
            : 'cursor-pointer border-hairline hover:border-primary/40'
          : 'border-hairline hover:border-primary/40'
      }`}
      onClick={selectionMode ? () => onToggleSelect?.(sk.id) : undefined}
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
              sk.enabled
                ? 'bg-primary/15'
                : 'bg-surface-cream-strong'
            }`}
          >
            <BookOpen
              size={16}
              className={`transition-colors duration-300 ${
                sk.enabled
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
            onClick={() => onToggle(sk.id)}
            className="shrink-0 p-1.5 rounded-xl hover:bg-surface-cream-strong transition-all cursor-pointer"
            title={sk.enabled ? '禁用' : '启用'}
            aria-label={sk.enabled ? '禁用' : '启用'}
          >
            {sk.enabled ? (
              <ToggleRight size={24} className="text-primary" />
            ) : (
              <ToggleLeft size={24} className="text-muted" />
            )}
          </button>
        </div>

        <div className="mt-4 pt-3 border-t border-hairline/50">
          <div className="flex items-center gap-2 overflow-hidden flex-wrap">
            <span
              className={`shrink-0 inline-flex items-center h-6 px-2 rounded-md text-[11px] font-medium ${
                sk.enabled
                  ? 'bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] text-primary'
                  : 'bg-surface-cream-strong text-muted'
              }`}
            >
            {sk.enabled ? '已启用' : '未启用'}
            </span>
            <span className="shrink-0 inline-flex items-center h-6 px-2 rounded-md text-[11px] bg-surface-cream-strong text-muted tabular-nums">
              {sk.content_length.toLocaleString()} 字
            </span>
            {isShared && (
              <span className="shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] bg-primary/10 text-primary">
                <Share2 size={10} />
                {isPublic ? '公开上架' : '私密链接'}
              </span>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span
              className={`shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-medium ${
                isShared
                  ? 'bg-primary/10 text-primary'
                  : 'bg-surface-cream-strong text-muted'
              }`}
            >
              {isPublic ? <Globe2 size={11} /> : <Link2 size={11} />}
              {isPublic ? '市场可见' : isLinkShared ? '仅链接访问' : '未分发'}
            </span>
            <p className="text-[11px] text-muted leading-relaxed">
              {distributionSummary}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap mt-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => onCopyLink(sk.id)}
                className={`h-8 px-2.5 rounded-lg inline-flex items-center justify-center gap-1.5 text-[11px] font-medium transition-all cursor-pointer ${
                  isShared
                    ? 'text-primary bg-primary/10 hover:bg-primary/15'
                    : 'text-ink bg-surface-cream-strong hover:bg-surface-cream-strong'
                }`}
                title={isShared ? '复制私密链接' : '开启私密链接分享'}
                aria-label={isShared ? '复制私密链接' : '开启私密链接分享'}
              >
                {copiedId === sk.id ? (
                  <>
                    <Check size={13} className="text-primary" />
                    已复制
                  </>
                ) : (
                  <>
                    <Link2 size={13} />
                    {isShared ? '复制链接' : '开启链接'}
                  </>
                )}
              </button>
              <button
                onClick={() => onCopyInviteLink(sk.id)}
                className="h-8 px-2.5 rounded-lg inline-flex items-center justify-center gap-1.5 text-[11px] font-medium text-primary bg-primary/10 hover:bg-primary/15 transition-all cursor-pointer"
                title="生成作者授权链接"
                aria-label="生成作者授权链接"
              >
                <KeyRound size={13} />
                授权链接
              </button>
              <button
                onClick={() =>
                  isPublic ? onUnpublish(sk.id) : onPublish(sk.id)
                }
                className={`h-8 px-2.5 rounded-lg inline-flex items-center justify-center gap-1.5 text-[11px] font-medium transition-all cursor-pointer ${
                  isPublic
                    ? 'text-primary bg-primary/10 hover:bg-primary/15'
                    : 'text-ink bg-surface-cream-strong hover:text-primary hover:bg-primary/10'
                }`}
                title={isPublic ? '取消公开上架' : '公开上架'}
                aria-label={isPublic ? '取消公开上架' : '公开上架'}
              >
                <Globe2 size={13} />
                {isPublic ? '取消公开' : '公开上架'}
              </button>
              {isLinkShared && (
                <button
                  onClick={() => onUnshare(sk.id)}
                  className="h-8 px-2.5 rounded-lg inline-flex items-center justify-center gap-1.5 text-[11px] font-medium text-primary bg-primary/10 hover:bg-primary/15 transition-all cursor-pointer"
                  title="关闭私密链接分享"
                  aria-label="关闭私密链接分享"
                >
                  <Unlink size={13} />
                  关闭链接
                </button>
              )}
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => onExport(sk)}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-surface-cream-strong transition-all cursor-pointer"
                title="导出 ZIP"
                aria-label="导出 ZIP"
              >
                <Download size={13} />
              </button>
              <button
                onClick={() => onEdit(sk)}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-surface-cream-strong transition-all cursor-pointer"
                title="编辑"
                aria-label="编辑"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => onDelete(sk.id)}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-error hover:bg-error/10 transition-all cursor-pointer"
                title="删除"
                aria-label="删除"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
