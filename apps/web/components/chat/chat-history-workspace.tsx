'use client';

import { useEffect, useRef } from 'react';

import { AppShell } from '@/components/app-shell';
import { ChatHistoryMessageList } from '@/components/chat/chat-history-message-list';
import { useAccountMessageHistory } from '@/features/chat/hooks/use-account-message-history';

export function ChatHistoryWorkspace() {
  const {
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
    pageSize,
  } = useAccountMessageHistory();

  const scrollAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollAreaRef.current) return;

    if (page === 1) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
      return;
    }

    scrollAreaRef.current.scrollTop = 0;
  }, [loading, page]);

  return (
    <AppShell>
      <div className="flex flex-col h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-4rem)] pt-2 lg:pt-0">
        {accountList.length > 1 && (
          <div className="shrink-0 pb-2 mb-2 border-b border-hairline/40">
            <div className="flex gap-1.5 overflow-x-auto scrollbar-hide px-1">
              {accountList.map((account) => {
                const active = account.id === selectedAccount;

                return (
                  <button
                    key={account.id}
                    onClick={() => setSelectedAccount(account.id)}
                    className={`shrink-0 flex items-center gap-2 h-9 px-3.5 rounded-full text-[12px] font-medium transition-all duration-200 cursor-pointer ${
                      active
                        ? 'bg-primary/15 text-primary shadow-sm'
                        : 'text-muted hover:text-ink hover:bg-surface-card'
                    }`}
                  >
                    <span className="relative flex h-2 w-2 shrink-0">
                      {account.enabled && active && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-40" />
                      )}
                      <span
                        className={`relative inline-flex rounded-full h-2 w-2 ${
                          account.enabled
                            ? 'bg-success'
                            : 'bg-muted/30'
                        }`}
                      />
                    </span>
                    {account.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div ref={scrollAreaRef} className="flex-1 overflow-y-auto py-3 scroll-smooth">
          <ChatHistoryMessageList
            groups={groups}
            allMessages={allMessages}
            loading={loading}
            selectedAccountName={selectedAccountInfo?.name}
            page={page}
            totalPages={totalPages}
            hasMore={hasMore}
            pageSize={pageSize}
            loadingMore={loadingMore}
            onPageChange={goToPage}
          />
        </div>
      </div>
    </AppShell>
  );
}
