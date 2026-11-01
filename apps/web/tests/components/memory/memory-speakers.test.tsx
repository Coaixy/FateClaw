import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryScopeDto } from '@fateclaw/contracts/memory';

import { MemorySpeakersPanel } from '@/components/memory/memory-speakers-panel';
import {
  createSpeakerBindingDraft,
  speakerBindingReducer,
} from '@/features/memory/speaker-binding';
import { I18nProvider } from '@/lib/i18n';

const scope: MemoryScopeDto = {
  id: 'scope-1',
  channel: 'wechat',
  display_name: '同名联系人',
  speaker_subject_id: null,
  share_subject_memory: false,
  binding_revision: 4,
};

describe('speaker binding consent', () => {
  it('does not turn a friendly-name edit into identity binding or memory sharing', () => {
    const draft = createSpeakerBindingDraft(scope);
    const renamed = speakerBindingReducer(draft, {
      type: 'name',
      value: '已有命主的同名',
    });
    expect(renamed.subjectId).toBeNull();
    expect(renamed.shareMemory).toBe(false);
    expect(renamed.base.id).toBe('scope-1');
    expect(renamed.base.binding_revision).toBe(4);
  });

  it('requires fresh sharing consent when changing or clearing the bound subject', () => {
    const shared = createSpeakerBindingDraft({
      ...scope,
      speaker_subject_id: 'client-1',
      share_subject_memory: true,
    });
    const rebound = speakerBindingReducer(shared, {
      type: 'subject',
      value: 'client-2',
    });
    expect(rebound.shareMemory).toBe(false);
    expect(
      speakerBindingReducer(rebound, { type: 'share', value: true })
        .shareMemory,
    ).toBe(true);
    const unbound = speakerBindingReducer(shared, {
      type: 'subject',
      value: null,
    });
    expect(
      speakerBindingReducer(unbound, { type: 'share', value: true })
        .shareMemory,
    ).toBe(false);
  });
});

describe('speaker management controls', () => {
  function render(speakers: MemoryScopeDto[]) {
    return renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <MemorySpeakersPanel
          scopes={speakers}
          subjects={[
            { id: 'self-1', kind: 'self', name: '用户本人' },
            { id: 'client-1', kind: 'client', name: '可绑定的命主' },
            { id: 'sender-2', kind: 'sender', name: '不应可选的其他说话人' },
          ]}
          loading={false}
          error=""
          disabled={false}
          onRefresh={vi.fn()}
          onSaved={vi.fn()}
          onSelectScope={vi.fn()}
        />
      </I18nProvider>,
    );
  }

  it('keeps web identity fixed to the owner without binding controls', () => {
    const html = render([
      { ...scope, channel: 'web', speaker_subject_id: 'self-1' },
    ]);
    expect(html).toContain('固定为本人');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('可绑定的命主');
  });

  it('limits explicit bindings to owner or clients and disables sharing while unbound', () => {
    const html = render([scope]);
    expect(html).toContain('可绑定的命主');
    expect(html).not.toContain('不应可选的其他说话人');
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).toContain(
      'disabled=""',
    );
    const viewButton = [
      ...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g),
    ].find(([, , content]) => content.includes('查看记忆'));
    expect(viewButton?.[1]).toContain('type="button"');
    expect(html).toContain('历史内容保留原始归属');
  });
});
