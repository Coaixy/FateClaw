'use client';

import { useMemo, type ReactNode } from 'react';
import type { MessageDto } from '@fateclaw/contracts/chat';

import { AiChatMessageList } from './ai-chat-message-list';
import { filterProgressMessages } from '../../features/chat/utils/display';
import { I18nProvider } from '../../lib/i18n';

export { ToastContext as ChatToastContext } from '../../lib/use-toast';
export { filterProgressMessages } from '../../features/chat/utils/display';

export function ReadOnlyChat({
  messages,
  renderMessageContext,
}: {
  messages: MessageDto[];
  renderMessageContext?: (message: MessageDto) => ReactNode;
}) {
  const visibleMessages = useMemo(
    () => filterProgressMessages(messages),
    [messages],
  );

  return (
    <I18nProvider locale="zh-CN">
      <AiChatMessageList
        messages={visibleMessages}
        loading={false}
        sending={false}
        progressLabel={null}
        selectedSession=""
        switchingSession={false}
        showCenteredComposer={false}
        composer={null}
        readOnly
        renderMessageContext={renderMessageContext}
      />
    </I18nProvider>
  );
}
