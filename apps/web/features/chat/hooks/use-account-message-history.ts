'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Account, accountsApi } from '@/features/accounts/api';
import { Message, messagesApi } from '@/features/chat/api';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { groupMessagesByDate } from '@/features/chat/utils/display';

const POLL_INTERVAL = 5000;
const FETCH_SIZE = 50;
const PAGE_SIZE = 20;

function mergeMessages(existing: Message[], fetched: Message[]) {
  const map = new Map<string, Message>();

  for (const message of existing) {
    if (!message.id.startsWith('optimistic-')) {
      map.set(message.id, message);
    }
  }

  for (const message of fetched) {
    map.set(message.id, message);
  }

  return Array.from(map.values()).sort(
    (left, right) =>
      new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
  );
}

export function useAccountMessageHistory() {
  const { user } = useAuth();
  const [accountList, setAccountList] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [allMessages, setAllMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(1);

  const pollingRef = useRef(true);
  const fetchVersionRef = useRef(0);

  useEffect(() => {
    if (!user) return;

    void accountsApi.list().then((list) => {
      setAccountList(list);
      if (list.length > 0) {
        setSelectedAccount(list[0].id);
      }
    });
  }, [user]);

  const fetchMessages = useCallback(
    async (accountId: string, isInitial = false) => {
      const version = ++fetchVersionRef.current;

      if (isInitial) {
        setLoading(true);
      }

      try {
        const data = await messagesApi.list(accountId, FETCH_SIZE);

        if (version !== fetchVersionRef.current) {
          return;
        }

        if (isInitial) {
          setAllMessages(data);
          setHasMore(data.length >= FETCH_SIZE);
          setPage(1);
          return;
        }

        setAllMessages((previous) => mergeMessages(previous, data));
      } catch {
        if (version === fetchVersionRef.current && isInitial) {
          setAllMessages([]);
          setHasMore(false);
        }
      } finally {
        if (version === fetchVersionRef.current && isInitial) {
          setLoading(false);
        }
      }
    },
    [],
  );

  const loadOlderMessages = useCallback(async () => {
    if (loadingMore || !hasMore || !selectedAccount) return;

    setLoadingMore(true);

    try {
      const oldestMessage = allMessages[allMessages.length - 1];
      if (!oldestMessage) return;

      const data = await messagesApi.list(
        selectedAccount,
        FETCH_SIZE,
        oldestMessage.timestamp,
      );

      setHasMore(data.length >= FETCH_SIZE);
      setAllMessages((previous) => mergeMessages(previous, data));
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  }, [allMessages, hasMore, loadingMore, selectedAccount]);

  useEffect(() => {
    if (!selectedAccount) return;

    pollingRef.current = true;
    setAllMessages([]);
    setHasMore(true);
    setPage(1);
    void fetchMessages(selectedAccount, true);

    const timer = window.setInterval(() => {
      if (pollingRef.current) {
        void fetchMessages(selectedAccount);
      }
    }, POLL_INTERVAL);

    return () => {
      pollingRef.current = false;
      window.clearInterval(timer);
    };
  }, [fetchMessages, selectedAccount]);

  const totalPages = Math.max(1, Math.ceil(allMessages.length / PAGE_SIZE));
  const sortedMessages = [...allMessages].reverse();
  const pageStart = Math.max(0, sortedMessages.length - page * PAGE_SIZE);
  const pageEnd = sortedMessages.length - (page - 1) * PAGE_SIZE;
  const pageMessages = sortedMessages.slice(pageStart, pageEnd);

  const groups = useMemo(
    () => groupMessagesByDate(pageMessages),
    [pageMessages],
  );

  const selectedAccountInfo = useMemo(
    () => accountList.find((account) => account.id === selectedAccount),
    [accountList, selectedAccount],
  );

  const goToPage = useCallback(
    (nextPage: number) => {
      const maxPage = Math.max(1, Math.ceil(allMessages.length / PAGE_SIZE));

      if (nextPage >= maxPage && hasMore) {
        void loadOlderMessages();
      }

      setPage(Math.max(1, Math.min(nextPage, maxPage)));
    },
    [allMessages.length, hasMore, loadOlderMessages],
  );

  return {
    accountList,
    selectedAccount,
    setSelectedAccount,
    selectedAccountInfo,
    allMessages,
    groups,
    loading,
    loadingMore,
    hasMore,
    page,
    totalPages,
    goToPage,
    pageSize: PAGE_SIZE,
  };
}
