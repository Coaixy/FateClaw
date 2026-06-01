'use client';

import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';

import { SharedChatSessionView } from '@/components/ai-chat/shared-chat-session-view';

export default function AiChatSharePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center">
          <Loader2 size={18} className="animate-spin text-muted" />
        </div>
      }
    >
      <SharedChatSessionView />
    </Suspense>
  );
}
