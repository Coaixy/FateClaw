'use client';

import { useCallback, useState } from 'react';

import {
  skillsApi,
  type SubscribedSkill,
  type UserCustomSkill,
} from '@/features/skills/api';

export function useUserSkills(
  notify: (type: 'success' | 'error', message: string) => void,
) {
  const [ownSkills, setOwnSkills] = useState<UserCustomSkill[]>([]);
  const [subscribedSkills, setSubscribedSkills] = useState<SubscribedSkill[]>(
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
    (next: { own?: UserCustomSkill[]; subscribed?: SubscribedSkill[] }) => {
      setOwnSkills(next.own ?? []);
      setSubscribedSkills(next.subscribed ?? []);
    },
    [],
  );

  return { ownSkills, subscribedSkills, loadUserSkills, applyUserSkills };
}
