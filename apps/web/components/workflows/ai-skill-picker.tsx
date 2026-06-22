'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Check, Search, Sparkles } from 'lucide-react';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import type { SubscribedSkill } from '@/features/skills/api';
import { groupSubscribedSkills } from '@/features/skills/subscription-groups';
import { useI18n } from '@/lib/i18n';

/** 选择器里的自有技能项(结构与 builder 的 OwnSkill 一致)。 */
export interface SkillOption {
  id: string;
  name: string;
}

interface AiSkillPickerProps {
  open: boolean;
  onClose: () => void;
  /** 卦师自有技能。 */
  ownSkills: SkillOption[];
  /** 卦师订阅的技能(含捆绑包来源,用于分组)。 */
  subscribedSkills: SubscribedSkill[];
  /** 当前已绑定的 skill id。 */
  selectedIds: string[];
  /** 勾选 / 取消某 skill。 */
  onToggle: (skillId: string) => void;
}

/**
 * AI 节点「绑定技能」选择弹窗。
 *
 * 把可绑技能按「自有 / 直接订阅 / 各捆绑包」分组并带本地搜索;技能多时比 inline chip 列表好用。
 * 仅负责选择,绑定技能的快照冻结与访问校验在保存时由后端处理。
 */
export function AiSkillPicker({
  open,
  onClose,
  ownSkills,
  subscribedSkills,
  selectedIds,
  onToggle,
}: AiSkillPickerProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  const keyword = query.trim().toLowerCase();
  const matches = (name: string) =>
    keyword === '' || name.toLowerCase().includes(keyword);

  // 订阅技能按捆绑包 / 直接订阅分组(复用已有且有测试的 groupSubscribedSkills)。
  const grouped = useMemo(
    () => groupSubscribedSkills(subscribedSkills),
    [subscribedSkills],
  );

  // 各分组按搜索词过滤,空组不渲染。
  const ownFiltered = ownSkills.filter((s) => matches(s.name));
  const directFiltered = grouped.direct.filter((s) => matches(s.skill_name));
  const bundleGroups = grouped.bundles
    .map((g) => ({ ...g, skills: g.skills.filter((s) => matches(s.skill_name)) }))
    .filter((g) => g.skills.length > 0);

  const isEmpty =
    ownFiltered.length === 0 &&
    directFiltered.length === 0 &&
    bundleGroups.length === 0;

  const renderRow = (id: string, name: string) => {
    const active = selectedIds.includes(id);
    return (
      <button
        key={id}
        type="button"
        onClick={() => onToggle(id)}
        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors ${
          active
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'border-hairline bg-canvas text-ink hover:border-primary/30'
        }`}
      >
        <Sparkles size={13} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {active && <Check size={14} className="shrink-0 text-primary" />}
      </button>
    );
  };

  const renderGroup = (title: string, rows: ReactNode) => (
    <div key={title} className="space-y-1.5">
      <p className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        {title}
      </p>
      <div className="space-y-1.5">{rows}</div>
    </div>
  );

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      size="md"
      title={t('workflows.builder.skillPickerTitle')}
      titleExtra={
        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
          {t('workflows.builder.skillSelectedCount', {
            count: String(selectedIds.length),
          })}
        </span>
      }
      footer={
        <div className="px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-xl bg-primary py-2.5 text-[14px] font-medium text-white hover:opacity-90"
          >
            {t('workflows.builder.skillPickerDone')}
          </button>
        </div>
      }
    >
      <div className="space-y-4 px-4 py-4 sm:px-6">
        {/* 本地搜索:技能多时按名字过滤 */}
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('workflows.builder.skillPickerSearch')}
            className="w-full rounded-lg border border-hairline bg-canvas py-2 pl-9 pr-3 text-[13px] outline-none focus:border-primary/40"
          />
        </div>

        {isEmpty ? (
          <p className="py-8 text-center text-[12px] text-muted">
            {keyword
              ? t('workflows.builder.skillPickerNoMatch')
              : t('workflows.builder.skillPickerEmpty')}
          </p>
        ) : (
          <div className="space-y-4">
            {ownFiltered.length > 0 &&
              renderGroup(
                t('workflows.builder.skillGroupOwn'),
                ownFiltered.map((s) => renderRow(s.id, s.name)),
              )}
            {directFiltered.length > 0 &&
              renderGroup(
                t('workflows.builder.skillGroupSubscribed'),
                directFiltered.map((s) => renderRow(s.id, s.skill_name)),
              )}
            {bundleGroups.map((g) =>
              renderGroup(
                t('workflows.builder.skillGroupBundle', { name: g.bundleName }),
                g.skills.map((s) => renderRow(s.id, s.skill_name)),
              ),
            )}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
