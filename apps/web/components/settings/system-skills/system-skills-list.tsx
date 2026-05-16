'use client';

import type { Skill } from '@/features/skills/api';
import { SystemSkillsCard } from '@/components/settings/system-skills/system-skills-card';

export function SystemSkillsList({
  skills,
  expandedSkill,
  onToggleExpanded,
  onToggleEnabled,
}: {
  skills: Skill[];
  expandedSkill: string | null;
  onToggleExpanded: (skillName: string) => void;
  onToggleEnabled: (skillName: string) => void;
}) {
  return (
    <div className="space-y-2">
      {skills.map((skill) => (
        <SystemSkillsCard
          key={skill.name}
          skill={skill}
          expanded={expandedSkill === skill.name}
          onToggleExpanded={() => onToggleExpanded(skill.name)}
          onToggleEnabled={() => onToggleEnabled(skill.name)}
        />
      ))}
    </div>
  );
}
