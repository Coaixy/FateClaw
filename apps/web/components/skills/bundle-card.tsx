'use client';

import {
  Check,
  Globe2,
  Layers,
  Link2,
  Pencil,
  Share2,
  Trash2,
  Unlink,
} from 'lucide-react';

import { SkillBundle } from '@/features/skills/api';

export function BundleCard({
  bundle,
  copiedId,
  onCopyLink,
  onUnshare,
  onPublish,
  onUnpublish,
  onEdit,
  onDelete,
}: {
  bundle: SkillBundle;
  copiedId: string | null;
  onCopyLink: (id: string) => void;
  onUnshare: (id: string) => void;
  onPublish: (id: string) => void;
  onUnpublish: (id: string) => void;
  onEdit: (bundle: SkillBundle) => void;
  onDelete: (id: string) => void;
}) {
  const isPublic = bundle.visibility === 'shared';
  const isLinkShared = bundle.visibility === 'link_shared';
  const shared = isPublic || isLinkShared;
  const distributionSummary = isPublic
    ? '会展示在技能市场'
    : isLinkShared
      ? '仅通过链接访问'
      : '可先私密分享再公开';

  return (
    <div className="group relative rounded-2xl border border-hairline bg-surface-card hover:border-[color-mix(in_srgb,var(--color-primary)_40%,var(--color-hairline))] transition-all duration-300">
      <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-primary)_6%,transparent),transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

      <div className="relative p-3.5 sm:p-4">
        <div className="flex items-start gap-3">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-300 ${
              shared
                ? 'bg-[color-mix(in_srgb,var(--color-primary)_15%,transparent)] shadow-[0_0_12px_color-mix(in_srgb,var(--color-primary)_10%,transparent)]'
                : 'bg-surface-cream-strong'
            }`}
          >
            <Layers
              size={16}
              className={`transition-colors duration-300 ${
                shared
                  ? 'text-primary'
                  : 'text-muted'
              }`}
            />
          </div>

          <div className="flex-1 min-w-0 pt-0.5">
            <p className="text-[13px] font-semibold truncate tracking-tight">
              {bundle.name}
            </p>
            {bundle.description && (
              <p className="text-[12px] text-muted mt-1 line-clamp-2 leading-relaxed">
                {bundle.description}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-hairline/50">
          <div className="flex items-center gap-2 overflow-hidden flex-wrap">
            <span className="shrink-0 inline-flex items-center h-6 px-2 rounded-md text-[11px] bg-surface-cream-strong text-muted tabular-nums">
              {bundle.skill_ids.length} 个技能
            </span>
            {shared && (
              <span
                className={`shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] ${
                  isPublic
                    ? 'bg-amber-500/10 text-amber-400'
                    : 'bg-blue-500/10 text-blue-400'
                }`}
              >
                <Share2 size={10} />
                {isPublic ? '公开上架' : '私密链接'}
              </span>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span
              className={`shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-medium ${
                isPublic
                  ? 'bg-amber-500/10 text-amber-400'
                  : isLinkShared
                    ? 'bg-blue-500/10 text-blue-400'
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
                onClick={() => onCopyLink(bundle.id)}
                className={`h-8 px-2.5 rounded-lg inline-flex items-center justify-center gap-1.5 text-[11px] font-medium transition-all cursor-pointer ${
                  shared
                    ? 'text-blue-400 bg-blue-500/10 hover:bg-blue-500/15'
                    : 'text-ink bg-surface-cream-strong hover:bg-surface-cream-strong'
                }`}
                title={shared ? '复制私密链接' : '开启私密链接分享'}
                aria-label={shared ? '复制私密链接' : '开启私密链接分享'}
              >
                {copiedId === bundle.id ? (
                  <>
                    <Check size={13} className="text-green-400" />
                    已复制
                  </>
                ) : (
                  <>
                    <Link2 size={13} />
                    {shared ? '复制链接' : '开启链接'}
                  </>
                )}
              </button>
              <button
                onClick={() =>
                  isPublic ? onUnpublish(bundle.id) : onPublish(bundle.id)
                }
                className={`h-8 px-2.5 rounded-lg inline-flex items-center justify-center gap-1.5 text-[11px] font-medium transition-all cursor-pointer ${
                  isPublic
                    ? 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/15'
                    : 'text-ink bg-surface-cream-strong hover:text-amber-400 hover:bg-amber-500/10'
                }`}
                title={isPublic ? '取消公开上架' : '公开上架'}
                aria-label={isPublic ? '取消公开上架' : '公开上架'}
              >
                <Globe2 size={13} />
                {isPublic ? '取消公开' : '公开上架'}
              </button>
              {isLinkShared && (
                <button
                  onClick={() => onUnshare(bundle.id)}
                  className="h-8 px-2.5 rounded-lg inline-flex items-center justify-center gap-1.5 text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/15 transition-all cursor-pointer"
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
                onClick={() => onEdit(bundle)}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-surface-cream-strong transition-all cursor-pointer"
                title="编辑"
                aria-label="编辑"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => onDelete(bundle.id)}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-red-400 hover:bg-red-500/10 transition-all cursor-pointer"
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
