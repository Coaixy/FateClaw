'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { skillsApi, type Skill } from '@/features/skills/api';
import { useAuth } from '@/features/auth/hooks/use-auth';
import type { SkillFilter } from '@/components/settings/system-skills/system-skills-types';

export function useSystemSkills(
  notify: (type: 'success' | 'error', message: string) => void,
) {
  const { user } = useAuth();
  const [skillList, setSkillList] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SkillFilter>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    if (!user) {
      setSkillList([]);
      setLoadError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const nextSkills = await skillsApi.list();
      setSkillList(nextSkills);
      setLoadError(null);
    } catch (err) {
      setSkillList([]);
      setLoadError(
        err instanceof Error ? err.message : '加载技能列表失败，请稍后重试',
      );
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const toggleSkill = useCallback(
    async (skillName: string) => {
      try {
        const result = await skillsApi.toggle(skillName);
        setSkillList((previous) =>
          previous.map((skill) =>
            skill.name === skillName
              ? { ...skill, enabled: result.enabled }
              : skill,
          ),
        );
        notify('success', result.enabled ? '已启用' : '已禁用');
      } catch (err) {
        notify('error', err instanceof Error ? err.message : '操作失败');
      }
    },
    [notify],
  );

  const enabledCount = useMemo(
    () => skillList.filter((skill) => skill.enabled).length,
    [skillList],
  );

  const filtered = useMemo(
    () =>
      skillList.filter((skill) => {
        if (filter === 'enabled' && !skill.enabled) return false;
        if (filter === 'disabled' && skill.enabled) return false;
        if (search) {
          const query = search.toLowerCase();
          return (
            skill.name.toLowerCase().includes(query) ||
            skill.description.toLowerCase().includes(query) ||
            skill.trigger.toLowerCase().includes(query)
          );
        }
        return true;
      }),
    [filter, search, skillList],
  );

  const toggleExpanded = useCallback((skillName: string) => {
    setExpanded((current) => (current === skillName ? null : skillName));
  }, []);

  return {
    skillList,
    filtered,
    loading,
    loadError,
    filter,
    search,
    expanded,
    enabledCount,
    setFilter,
    setSearch,
    loadSkills,
    toggleSkill,
    toggleExpanded,
  };
}
