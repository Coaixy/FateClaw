'use client';

import { useMemo, useState } from 'react';
import { BookOpen, Check, Loader2, Share2, XCircle } from 'lucide-react';

import { SkillBundle, UserCustomSkill } from '@/features/skills/api';
import { useConfirm } from '@/lib/use-confirm';
import { BottomSheet } from '@/components/ui/bottom-sheet';

export type BundleFormData = {
  name: string;
  description: string;
  skill_ids: string[];
};

export function BundleForm({
  initial,
  ownSkills,
  onSave,
  onCancel,
  variant = 'sheet',
}: {
  initial?: SkillBundle;
  ownSkills: UserCustomSkill[];
  onSave: (data: BundleFormData) => Promise<void>;
  onCancel: () => void;
  variant?: 'sheet' | 'page';
}) {
  const { confirm: confirmDialog } = useConfirm();
  const [name, setName] = useState(initial?.name || '');
  const [desc, setDesc] = useState(initial?.description || '');
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initial?.skill_ids || []),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sortedSkills = useMemo(() => {
    return [...ownSkills].sort((a, b) => {
      const aSelected = selected.has(a.id) ? 0 : 1;
      const bSelected = selected.has(b.id) ? 0 : 1;
      if (aSelected !== bSelected) return aSelected - bSelected;
      return a.skill_name.localeCompare(b.skill_name);
    });
  }, [ownSkills, selected]);

  const isDirty = useMemo(() => {
    const initialIds = new Set(initial?.skill_ids || []);
    const sameIds =
      initialIds.size === selected.size &&
      [...selected].every((id) => initialIds.has(id));
    return (
      name !== (initial?.name || '') ||
      desc !== (initial?.description || '') ||
      !sameIds
    );
  }, [name, desc, selected, initial]);

  const handleCloseAttempt = async () => {
    if (!isDirty || saving) {
      onCancel();
      return;
    }
    const ok = await confirmDialog({
      title: '放弃未保存的修改？',
      message: '你改过的内容将会丢失。',
      confirmLabel: '放弃',
      cancelLabel: '继续编辑',
      variant: 'danger',
    });
    if (ok) onCancel();
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('请输入捆绑包名称');
      return;
    }
    if (selected.size === 0) {
      setError('至少选择 1 个技能');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({
        name: name.trim(),
        description: desc.trim(),
        skill_ids: Array.from(selected),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full h-11 px-3.5 rounded-xl border border-hairline bg-canvas text-[13px] placeholder:text-muted focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-primary)_8%,transparent)] transition-all duration-200';

  const titleExtra = (
    <span className="shrink-0 inline-flex items-center h-6 px-2 rounded-md bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] text-primary text-[11px] font-medium tabular-nums">
      {selected.size} / {ownSkills.length}
    </span>
  );

  const footer = (
    <div className="flex items-center gap-2.5 sm:gap-3 px-4 sm:px-6 py-3 sm:py-4">
      <button
        onClick={handleCloseAttempt}
        className="flex-1 sm:flex-none h-12 sm:h-10 px-4 sm:px-5 text-[13px] rounded-xl border border-hairline text-muted active:bg-surface-cream-strong sm:hover:text-ink sm:hover:bg-surface-cream-strong transition-all duration-200 cursor-pointer"
      >
        取消
      </button>
      <button
        onClick={handleSubmit}
        disabled={saving || selected.size === 0}
        className="flex-1 sm:flex-none h-12 sm:h-10 px-4 sm:px-6 text-[13px] font-medium rounded-xl bg-primary text-white active:opacity-80 sm:hover:shadow-[0_4px_20px_color-mix(in_srgb,var(--color-primary)_35%,transparent)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2 transition-all duration-300"
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        {initial ? '保存' : '创建'}
      </button>
    </div>
  );

  const body = (
    <div className="px-4 sm:px-6 py-4 sm:py-5">
      {error && (
        <div
          className="text-[12px] text-red-400 bg-red-400/10 border border-red-400/20 px-4 py-3 rounded-xl flex items-center gap-2.5 mb-5"
          role="alert"
        >
          <div className="w-6 h-6 rounded-lg bg-red-400/15 flex items-center justify-center shrink-0">
            <XCircle size={14} />
          </div>
          {error}
        </div>
      )}

      <div className="mb-5 sm:mb-6">
        <div className="flex items-center gap-2 mb-3 sm:mb-4">
          <div className="w-1 h-4 rounded-full bg-primary" />
          <span className="text-[11px] sm:text-[12px] font-semibold text-ink uppercase tracking-wider">
            基础信息
          </span>
        </div>
        <div className="space-y-3 sm:space-y-4">
          <div>
            <label className="text-[11px] sm:text-[12px] font-medium text-muted mb-1.5 sm:mb-2 flex items-center gap-1.5">
              名称 <span className="text-red-400">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="例如：八字入门合集"
              autoFocus
              className={inputClass}
            />
            <div className="flex justify-end items-center mt-1">
              <span className="text-[10px] text-muted tabular-nums">
                {name.length}/80
              </span>
            </div>
          </div>

          <div>
            <label className="text-[11px] sm:text-[12px] font-medium text-muted mb-1.5 sm:mb-2 block">
              描述
            </label>
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              maxLength={300}
              placeholder="简单介绍一下这个捆绑包"
              className={inputClass}
            />
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3 sm:mb-4">
          <div className="w-1 h-4 rounded-full bg-blue-400" />
          <span className="text-[11px] sm:text-[12px] font-semibold text-ink uppercase tracking-wider">
            包含的技能
          </span>
        </div>

        {ownSkills.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-muted border border-dashed border-hairline rounded-xl">
            你还没有自有技能，先创建技能再组合捆绑包
          </div>
        ) : (
          <div className="space-y-2">
            {sortedSkills.map((sk) => {
              const isSelected = selected.has(sk.id);
              return (
                <button
                  key={sk.id}
                  type="button"
                  onClick={() => toggle(sk.id)}
                  className={`w-full text-left p-3 rounded-xl border transition-all duration-200 cursor-pointer flex items-start gap-3 ${
                    isSelected
                      ? 'border-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)]'
                      : 'border-hairline hover:border-hairline hover:bg-surface-cream-strong'
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-md shrink-0 flex items-center justify-center mt-0.5 transition-all ${
                      isSelected
                        ? 'bg-primary'
                        : 'border border-hairline'
                    }`}
                  >
                    {isSelected && <Check size={12} className="text-white" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <BookOpen
                        size={13}
                        className="text-muted shrink-0"
                      />
                      <span className="text-[13px] font-medium truncate">
                        {sk.skill_name}
                      </span>
                      {sk.visibility !== 'private' && (
                        <Share2
                          size={10}
                          className={`shrink-0 ${
                            sk.visibility === 'shared'
                              ? 'text-amber-400'
                              : 'text-blue-400'
                          }`}
                          aria-label={
                            sk.visibility === 'shared'
                              ? '已公开上架'
                              : '已私密链接分享'
                          }
                        />
                      )}
                    </div>
                    {sk.description && (
                      <p className="text-[11px] text-muted mt-0.5 line-clamp-2 leading-relaxed">
                        {sk.description}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <span className="inline-flex items-center h-5 px-1.5 rounded text-[10px] bg-surface-cream-strong text-muted tabular-nums">
                        {sk.content_length.toLocaleString()} 字
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  if (variant === 'page') {
    return (
      <div className="overflow-hidden rounded-[28px] border border-hairline bg-surface-card shadow-[0_24px_80px_color-mix(in_srgb,var(--color-ink)_10%,transparent)]">
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-5 sm:px-6">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted">
              Bundle Builder
            </p>
            <h2 className="mt-2 text-lg font-semibold tracking-tight">
              {initial ? '编辑捆绑包' : '创建捆绑包'}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              组合多个技能，统一生成分享入口，管理起来更清晰。
            </p>
          </div>
          {titleExtra}
        </div>
        {body}
        <div className="border-t border-hairline bg-[color-mix(in_srgb,var(--color-surface-card)_70%,var(--color-canvas))]">
          {footer}
        </div>
      </div>
    );
  }

  return (
    <BottomSheet
      open
      onClose={handleCloseAttempt}
      variant="fullscreen-sheet"
      size="md"
      title={initial ? '编辑捆绑包' : '创建捆绑包'}
      titleExtra={titleExtra}
      aria-label={initial ? '编辑捆绑包' : '创建捆绑包'}
      footer={footer}
    >
      {body}
    </BottomSheet>
  );
}
