// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageDto } from '@fateclaw/contracts/chat';

import { AdminConversation } from '../components/chat/admin-conversation';
import { ToastProvider } from '../components/ui/toast';

const message: MessageDto = {
  id: 'reply',
  account_id: 'account-1',
  sender: 'assistant',
  sender_name: 'AI',
  content: '## 共享渲染\n\n**同一条回答**',
  timestamp: '2026-10-25T10:00:00.000Z',
  is_from_me: true,
  is_bot_message: true,
  metadata: { kind: 'final' },
};

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('embedded admin conversation', () => {
  it('renders frontend Markdown without changing the admin document language or stored preference', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    document.documentElement.lang = 'zh-CN';
    window.localStorage.setItem('fateclaw:locale', 'en');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <ToastProvider>
            <AdminConversation messages={[message]} />
          </ToastProvider>,
        );
        await import('../../web/components/chat/markdown-content');
      });
      expect(container.querySelector('h2')?.textContent).toBe('共享渲染');
      expect(container.querySelector('strong')?.textContent).toBe('同一条回答');
      expect(container.querySelector('[aria-label="复制回答"]')).not.toBeNull();
      expect(document.documentElement.lang).toBe('zh-CN');
      expect(window.localStorage.getItem('fateclaw:locale')).toBe('en');
    } finally {
      await act(async () => root.unmount());
      window.localStorage.removeItem('fateclaw:locale');
    }
  });
});
