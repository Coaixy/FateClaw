import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ModelSettingsOverviewDto } from '@fateclaw/contracts/model-settings';

import { ModelSettingsContent } from '@/components/settings/model-settings-panel';
import { I18nProvider } from '@/lib/i18n';

const model = {
  id: 'synthetic-paid',
  model_key: 'official',
  display_name: 'Paid model',
  description: '',
  model_name: 'synthetic',
  context_window_tokens: 32000,
  input_token_price_per_million_coins: 4,
  output_token_price_per_million_coins: 8,
  has_secret: true,
};
const overview: ModelSettingsOverviewDto = {
  model,
  preferred_pool: 'official',
  benefit: {
    model: { ...model, id: 'synthetic-free', display_name: 'Free model' },
    enabled: true,
    eligible: true,
    supply: 'available',
    daily_turns: 7,
    remaining_turns: 5,
    resets_at: '2026-10-19T00:00:00+08:00',
  },
};

function render(
  patch: Partial<ComponentProps<typeof ModelSettingsContent>> = {},
) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ModelSettingsContent
        overview={overview}
        loading={false}
        error=""
        onRefresh={vi.fn()}
        onChange={vi.fn()}
        {...patch}
      />
    </I18nProvider>,
  );
}

function choices(html: string) {
  return html.match(/<button\b[^>]*aria-pressed[^>]*>/g)!;
}

describe('model settings choices', () => {
  it('offers both pools directly with distinct models, paid rates and the free allowance', () => {
    const html = render();
    expect(choices(html)).toHaveLength(2);
    expect(choices(html)[0]).toContain('aria-pressed="true"');
    expect(choices(html)[1]).toContain('aria-pressed="false"');
    expect(choices(html).every((button) => !button.includes('disabled='))).toBe(
      true,
    );
    expect(html).toContain('Paid model');
    expect(html).toContain('Free model');
    expect(html).toContain('4.00 积分');
    expect(html).toContain('8.00 积分');
    expect(html).toContain('今日剩余 5 次');
    expect(html).not.toContain('<details');
  });

  it('keeps a saved free choice visible after membership expires without selecting paid use', () => {
    const html = render({
      overview: {
        ...overview,
        preferred_pool: 'benefit',
        benefit: {
          ...overview.benefit!,
          eligible: false,
          remaining_turns: null,
        },
      },
    });
    expect(choices(html)[0]).toContain('aria-pressed="false"');
    expect(choices(html)[0]).not.toContain('disabled=');
    expect(choices(html)[1]).toContain('aria-pressed="true"');
    expect(choices(html)[1]).toContain('disabled=');
    expect(html).toContain('免费模型仅限有效会员使用');
    expect(html).toContain('href="/membership"');
    expect(html).not.toContain('今日剩余');
  });

  it('allows eligible free use when the paid pool is absent', () => {
    const freeOnly = render({ overview: { ...overview, model: null } });
    expect(choices(freeOnly)[0]).toContain('disabled=');
    expect(choices(freeOnly)[1]).not.toContain('disabled=');
  });
});
