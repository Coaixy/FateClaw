'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { accountsApi, type Account } from '@/features/accounts/api';
import { tasksApi, type Task } from '@/features/tasks/api';
import { useAuth } from '@/features/auth/hooks/use-auth';

export function useAccountTasks() {
  const { user } = useAuth();
  const [accountList, setAccountList] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccountState] = useState('');
  const [taskList, setTaskList] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const selectedAccountRef = useRef('');

  useEffect(() => {
    selectedAccountRef.current = selectedAccount;
  }, [selectedAccount]);

  const loadTasks = useCallback(async (accountId: string) => {
    setLoading(true);
    setExpandedTaskId(null);
    try {
      const nextTasks = await tasksApi.list(accountId);
      setTaskList(nextTasks);
      setLoadError(null);
    } catch (err) {
      setTaskList([]);
      setLoadError(
        err instanceof Error ? err.message : '加载任务列表失败，请稍后重试',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    if (!user) {
      setAccountList([]);
      setTaskList([]);
      setSelectedAccountState('');
      setLoadError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const list = await accountsApi.list();
      const nextSelected = list.some(
        (account) => account.id === selectedAccountRef.current,
      )
        ? selectedAccountRef.current
        : list[0]?.id || '';
      setAccountList(list);
      setLoadError(null);
      setSelectedAccountState(nextSelected);
      if (nextSelected) {
        await loadTasks(nextSelected);
        return;
      }
      setExpandedTaskId(null);
      setTaskList([]);
      setLoading(false);
    } catch (err) {
      setAccountList([]);
      setTaskList([]);
      setSelectedAccountState('');
      setLoadError(
        err instanceof Error ? err.message : '加载任务列表失败，请稍后重试',
      );
      setLoading(false);
    }
  }, [loadTasks, user]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const selectAccount = useCallback(
    (accountId: string) => {
      setSelectedAccountState(accountId);
      void loadTasks(accountId);
    },
    [loadTasks],
  );

  const removeTaskFromList = useCallback((taskId: string) => {
    setTaskList((previous) => previous.filter((task) => task.id !== taskId));
    setExpandedTaskId((current) => (current === taskId ? null : current));
  }, []);

  const toggleExpandedTask = useCallback((taskId: string) => {
    setExpandedTaskId((current) => (current === taskId ? null : taskId));
  }, []);

  return {
    accountList,
    selectedAccount,
    taskList,
    loading,
    loadError,
    expandedTaskId,
    setExpandedTaskId,
    loadAccounts,
    loadTasks,
    selectAccount,
    removeTaskFromList,
    toggleExpandedTask,
  };
}
