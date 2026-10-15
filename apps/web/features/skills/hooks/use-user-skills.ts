'use client';

import { useCallback, useState } from 'react';

import {
  skillsApi,
  type SubscribedSkillSummary,
  type UserCustomSkillSummary,
} from '@/features/skills/api';

export function useUserSkills(
  notify: (type: 'success' | 'error', message: string) => void,
) {
  const [ownSkills, setOwnSkills] = useState<UserCustomSkillSummary[]>([]);
  const [subscribedSkills, setSubscribedSkills] = useState<SubscribedSkillSummary[]>(
    [],
  );

  const loadUserSkills = useCallback(async () => {
    try {
      const res = await skillsApi.userList();
      setOwnSkills(res.own ?? []);
      setSubscribedSkills(res.subscribed ?? []);
      return res;
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '加载技能失败');
      throw err;
    }
  }, [notify]);

  const applyUserSkills = useCallback(
    (next: { own?: UserCustomSkillSummary[]; subscribed?: SubscribedSkillSummary[] }) => {
      setOwnSkills(next.own ?? []);
      setSubscribedSkills(next.subscribed ?? []);
    },
    [],
  );

  return { ownSkills, subscribedSkills, loadUserSkills, applyUserSkills };
}
