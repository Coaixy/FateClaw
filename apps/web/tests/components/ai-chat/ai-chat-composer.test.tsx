import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  AiChatComposer,
  shouldSendOnEnter,
} from '@/components/ai-chat/ai-chat-composer';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('chat composer', () => {
  it('keeps the textarea editable while generating and the stop action available', () => {
    const html = renderComposer({ sending: true });
    const textarea = html.match(/<textarea[^>]*>/)?.[0] ?? '';
    const stop =
      html.match(/<button[^>]*aria-label="aiChat\.composer\.stop"[^>]*>/)?.[0] ?? '';

    expect(textarea).not.toContain('disabled=');
    expect(textarea).toContain('aiChat.composer.nextDraftLabel');
    expect(stop).not.toBe('');
    expect(stop).not.toContain('disabled=');
  });

  it('keeps continuation restrictions and disables repeated stop requests', () => {
    const blocked = renderComposer({ sending: false, disabled: true });
    expect(blocked.match(/<textarea[^>]*>/)?.[0]).toContain('disabled=');

    const stopping = renderComposer({ sending: true, stopping: true });
    const stop =
      stopping.match(
        /<button[^>]*aria-label="aiChat\.composer\.stopping"[^>]*>/,
      )?.[0] ?? '';
    expect(stop).toContain('disabled=');
    expect(stop).toContain('aria-busy="true"');
    expect(stopping).toContain('role="status"');
    expect(stopping).toContain('aiChat.composer.stopping');
  });
});

describe('shouldSendOnEnter', () => {
  it('sends a plain Enter while keeping Shift+Enter for a newline', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldSendOnEnter({ key: 'a', shiftKey: false })).toBe(false);
  });

  it('ignores candidate confirmation across IME flags and the Safari composition boundary', () => {
    const enter = { key: 'Enter', shiftKey: false };
    expect(shouldSendOnEnter({ ...enter, isComposing: true })).toBe(false);
    expect(
      shouldSendOnEnter({ ...enter, nativeEvent: { isComposing: true } }),
    ).toBe(false);
    expect(shouldSendOnEnter({ ...enter, keyCode: 229 })).toBe(false);
    expect(
      shouldSendOnEnter({
        ...enter,
        nativeEvent: { isComposing: false, keyCode: 229 },
      }),
    ).toBe(false);
    expect(shouldSendOnEnter(enter, true)).toBe(false);
    expect(shouldSendOnEnter(enter, false)).toBe(true);
  });
});

function renderComposer(options: {
  sending: boolean;
  stopping?: boolean;
  disabled?: boolean;
}): string {
  return renderToStaticMarkup(
    <AiChatComposer
      {...options}
      inputRef={{ current: null }}
      input="Next question"
      selectedSession="session-1"
      pasteChoiceOpen={false}
      onInputChange={() => undefined}
      onPaste={() => undefined}
      onKeyDown={() => undefined}
      onUsePasteAsBoard={() => undefined}
      onKeepPasteAsMessage={() => undefined}
      onDismissPasteChoice={() => undefined}
      onSend={() => undefined}
      onStop={() => undefined}
    />,
  );
}
