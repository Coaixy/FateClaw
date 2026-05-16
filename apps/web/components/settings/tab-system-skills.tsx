'use client';

import { useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';

import { useSystemSkills } from '@/features/skills/hooks/use-system-skills';
import { SystemSkillsEmptyState } from '@/components/settings/system-skills/system-skills-empty-state';
import { SystemSkillsList } from '@/components/settings/system-skills/system-skills-list';
import { SystemSkillsToolbar } from '@/components/settings/system-skills/system-skills-toolbar';
import { useToast } from '@/lib/use-toast';
import { SkillSkeleton } from '@/components/skills/skill-skeleton';
import { EmptyState } from '@/components/ui/empty-state';

export function TabSystemSkills() {
  const { toast } = useToast();
  const notify = useCallback(
    (type: 'success' | 'error', message: string) => toast(type, message),
    [toast],
  );
  const systemSkills = useSystemSkills(notify);

  if (systemSkills.loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <SkillSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (systemSkills.loadError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="技能列表加载失败"
        description={systemSkills.loadError}
        action={{ label: '重试', onClick: () => void systemSkills.loadSkills() }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {systemSkills.skillList.length > 0 && (
        <SystemSkillsToolbar
          totalCount={systemSkills.skillList.length}
          enabledCount={systemSkills.enabledCount}
          filter={systemSkills.filter}
          search={systemSkills.search}
          onFilterChange={systemSkills.setFilter}
          onSearchChange={systemSkills.setSearch}
        />
      )}

      {systemSkills.skillList.length === 0 ? (
        <SystemSkillsEmptyState />
      ) : systemSkills.filtered.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-[13px] text-muted">
            没有匹配的技能
          </p>
        </div>
      ) : (
        <SystemSkillsList
          skills={systemSkills.filtered}
          expandedSkill={systemSkills.expanded}
          onToggleExpanded={systemSkills.toggleExpanded}
          onToggleEnabled={(skillName) => void systemSkills.toggleSkill(skillName)}
        />
      )}
    </div>
  );
}
