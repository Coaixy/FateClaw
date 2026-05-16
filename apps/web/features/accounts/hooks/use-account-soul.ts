'use client';

import { useCallback, useState } from 'react';

import { accountsApi } from '@/features/accounts/api';

export function useAccountSoul(
  notify: (type: 'success' | 'error', message: string) => void,
) {
  const [expandedSoul, setExpandedSoul] = useState<string | null>(null);
  const [soulContent, setSoulContent] = useState('');
  const [soulLoading, setSoulLoading] = useState(false);
  const [soulSaving, setSoulSaving] = useState(false);
  const [soulDirty, setSoulDirty] = useState(false);

  const toggleSoul = useCallback(
    async (accountId: string) => {
      if (expandedSoul === accountId) {
        setExpandedSoul(null);
        return;
      }

      setExpandedSoul(accountId);
      setSoulLoading(true);
      setSoulDirty(false);
      try {
        const res = await accountsApi.getSoul(accountId);
        setSoulContent(res.content);
      } catch (err) {
        setSoulContent('');
        notify(
          'error',
          err instanceof Error ? err.message : '加载灵魂记忆失败',
        );
      } finally {
        setSoulLoading(false);
      }
    },
    [expandedSoul, notify],
  );

  const changeSoulContent = useCallback((value: string) => {
    setSoulContent(value);
    setSoulDirty(true);
  }, []);

  const saveSoul = useCallback(async () => {
    if (!expandedSoul) return;
    setSoulSaving(true);
    try {
      await accountsApi.updateSoul(expandedSoul, soulContent);
      setSoulDirty(false);
      notify('success', '灵魂记忆已保存并注入');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '保存失败');
    } finally {
      setSoulSaving(false);
    }
  }, [expandedSoul, notify, soulContent]);

  const collapseIfExpanded = useCallback((accountId: string) => {
    setExpandedSoul((current) => {
      if (current !== accountId) return current;
      setSoulContent('');
      return null;
    });
  }, []);

  return {
    expandedSoul,
    soulContent,
    soulLoading,
    soulSaving,
    soulDirty,
    setSoulContent: changeSoulContent,
    setSoulDirty,
    toggleSoul,
    saveSoul,
    collapseIfExpanded,
  };
}
