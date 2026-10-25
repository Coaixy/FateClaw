'use client';

import { useMemo, type ReactNode } from 'react';
import type { MessageDto } from '@fateclaw/contracts/chat';
import { ChatToastContext, ReadOnlyChat } from 'fateclaw-web/chat';

import { useToast } from '@/lib/use-toast';

export function AdminConversation({
  messages,
  renderMessageContext,
}: {
  messages: MessageDto[];
  renderMessageContext?: (message: MessageDto) => ReactNode;
}) {
  const { toast } = useToast();
  const context = useMemo(() => ({ toast }), [toast]);

  return (
    <ChatToastContext value={context}>
      <ReadOnlyChat
        messages={messages}
        renderMessageContext={renderMessageContext}
      />
    </ChatToastContext>
  );
}
