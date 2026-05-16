import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { setProviderDraftEnabled, type ProviderDraft } from './provider-draft';
import { ProviderRow } from './model-provider-panels';

const draft: ProviderDraft = {
  model_key: 'anthropic-main',
  protocol: 'anthropic',
  display_name: 'Claude Main',
  enabled: false,
  priority: 10,
  base_url: 'https://api.anthropic.com',
  model_name: 'claude-sonnet-4-5',
  context_window_tokens: 0,
  input_token_price_per_million_points: 1000,
  output_token_price_per_million_points: 5000,
};

describe('provider draft helpers', () => {
  it('updates enabled state without discarding unsaved draft fields', () => {
    expect(setProviderDraftEnabled(draft, true)).toEqual({
      ...draft,
      enabled: true,
    });
  });

  it('renders status badges as single-line pills', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderRow, {
        provider: {
          id: 'provider-1',
          model_key: 'anthropic-main',
          protocol: 'anthropic',
          display_name: 'Claude Main',
          enabled: true,
          priority: 10,
          base_url: 'https://api.anthropic.com',
          model_name: 'claude-sonnet-4-5',
          context_window_tokens: null,
          api_key_secret_key: 'official-model:provider-1:secret',
          input_token_price_per_million_points: 1000,
          output_token_price_per_million_points: 5000,
          auth_mode: 'anthropic_api_key',
          has_secret: true,
          secret_source: 'database',
          extra_json: {},
          created_at: '2026-05-04T00:00:00.000Z',
          updated_at: '2026-05-04T00:00:00.000Z',
        },
        busy: false,
        isActive: true,
        onSave: async () => {},
        onSaveSecret: async () => {},
        onSetDefault: async () => {},
        onDelete: async () => {},
      }),
    );

    expect(markup).toContain('whitespace-nowrap');
  });
});
