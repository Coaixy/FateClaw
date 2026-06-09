import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  buildSuggestedProviderKey,
  buildUniqueSuggestedProviderKey,
  setProviderDraftEnabled,
  type ProviderDraft,
} from '../../../../app/(dashboard)/system/provider-draft';
import {
  ProviderCreatePanel,
  ProviderRow,
} from '../../../../app/(dashboard)/system/model-provider-panels';

const draft: ProviderDraft = {
  model_key: 'anthropic-main',
  pi_api: 'anthropic-messages',
  display_name: 'Claude Main',
  description: '适合复杂推理和长文本问答。',
  enabled: false,
  priority: 10,
  base_url: 'https://api.anthropic.com',
  model_name: 'claude-sonnet-4-5',
  api_key: '',
  context_window_tokens: 0,
  input_token_price_per_million_coins: 1000,
  output_token_price_per_million_coins: 5000,
};

describe('provider draft helpers', () => {
  it('updates enabled state without discarding unsaved draft fields', () => {
    expect(setProviderDraftEnabled(draft, true)).toEqual({
      ...draft,
      enabled: true,
    });
  });

  it('uses model name when display name cannot form an ASCII key', () => {
    expect(
      buildSuggestedProviderKey({
        ...draft,
        display_name: '中文模型',
        model_name: 'gpt-4.1',
      }),
    ).toBe('anthropic-messages-gpt-4-1');
  });

  it('adds a suffix when generated model key already exists', () => {
    expect(
      buildUniqueSuggestedProviderKey(draft, [
        'anthropic-messages-claude-main',
      ]),
    ).toBe('anthropic-messages-claude-main-2');
  });

  it('keeps technical fields out of the collapsed provider row', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderRow, {
        provider: {
          id: 'provider-1',
          model_key: 'anthropic-main',
          pi_api: 'anthropic-messages',
          display_name: 'Claude Main',
          description: '适合复杂推理和长文本问答。',
          enabled: true,
          priority: 10,
          base_url: 'https://api.anthropic.com',
          model_name: 'claude-sonnet-4-5',
          context_window_tokens: null,
          api_key_secret_key: 'official-model:provider-1:secret',
          input_token_price_per_million_coins: 1000,
          output_token_price_per_million_coins: 5000,
          auth_mode: 'anthropic_api_key',
          has_secret: true,
          api_key: 'sk-test',
          secret_source: 'database',
          extra_json: {},
          created_at: '2026-05-04T00:00:00.000Z',
          updated_at: '2026-05-04T00:00:00.000Z',
        },
        busy: false,
        isActive: true,
        onSave: async () => {},
        onSetDefault: async () => {},
        onDelete: async () => {},
      }),
    );

    expect(markup).not.toContain('claude-sonnet-4-5');
    expect(markup).not.toContain('https://api.anthropic.com');
    expect(markup).not.toContain('已保存密钥');
  });

  it('requires an API key before creating a model', () => {
    const disabledMarkup = renderToStaticMarkup(
      createElement(ProviderCreatePanel, {
        draft: {
          ...draft,
          model_key: '',
          display_name: 'Claude Main',
          model_name: 'claude-sonnet-4-5',
        },
        busy: false,
        secret: '',
        onChange: () => {},
        onCreate: async () => {},
        onSecretChange: () => {},
      }),
    );
    const enabledMarkup = renderToStaticMarkup(
      createElement(ProviderCreatePanel, {
        draft: {
          ...draft,
          model_key: '',
          display_name: 'Claude Main',
          model_name: 'claude-sonnet-4-5',
        },
        busy: false,
        secret: 'sk-test',
        onChange: () => {},
        onCreate: async () => {},
        onSecretChange: () => {},
      }),
    );

    expect(disabledMarkup).toContain('保存模型');
    expect(disabledMarkup).toContain('disabled=""');
    expect(enabledMarkup).not.toContain('disabled=""');
  });

  it('renders API key as a normal text field', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderCreatePanel, {
        draft: {
          ...draft,
          model_key: '',
          display_name: 'Claude Main',
          model_name: 'claude-sonnet-4-5',
        },
        busy: false,
        secret: 'sk-test',
        onChange: () => {},
        onCreate: async () => {},
        onSecretChange: () => {},
      }),
    );

    expect(markup).toContain('API Key');
    expect(markup).toContain('type="text"');
    expect(markup).not.toContain('type="password"');
  });
});
