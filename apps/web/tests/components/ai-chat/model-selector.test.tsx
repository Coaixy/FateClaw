import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ModelSelector } from '@/components/ai-chat/model-selector';
import { I18nProvider } from '@/lib/i18n';
import type { ModelSettingsOverviewDto } from '@fateclaw/contracts/model-settings';

function render(eligible: boolean, enabled = true) {
  const model = {
    id: 'synthetic-model',
    model_key: 'official',
    display_name: 'Model',
    description: '',
    model_name: 'synthetic',
    context_window_tokens: 32000,
    input_token_price_per_million_coins: 1,
    output_token_price_per_million_coins: 2,
    has_secret: true,
  };
  const overview: ModelSettingsOverviewDto = {
    model,
    benefit: {
      model: enabled ? model : null,
      enabled,
      eligible,
      supply: enabled ? 'available' : 'disabled',
      daily_turns: 7,
      remaining_turns: eligible ? 5 : null,
      resets_at: '2026-10-18T00:00:00+08:00',
    },
  };
  return renderToStaticMarkup(
    <I18nProvider>
      <ModelSelector
        overview={overview}
        poolKey="benefit"
        busy={false}
        error=""
        onChange={vi.fn()}
        onRetry={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe('free model membership access', () => {
  it('does not offer membership as a way to unlock a disabled free service', () => {
    const html = render(false, false);
    expect(html).toContain('免费服务暂未开放');
    expect(html).not.toContain('开通或续费会员');
  });
  it('blocks a saved free-model choice for non-members and offers membership while leaving the paid option available', () => {
    const html = render(false);
    expect(html).toContain('开通或续费会员');
    expect(html).toContain('href="/membership"');
    const buttons = html.match(/<button\b[^>]*>/g)!;
    expect(buttons[0]).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(buttons[1]).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).not.toContain('今日剩余');
  });
  it('shows the server-provided allowance for eligible members', () => {
    const html = render(true);
    expect(html).toContain('今日剩余 5 次');
    expect(html).not.toContain('开通或续费会员');
    expect(
      html
        .match(/<button\b[^>]*>/g)!
        .every((button) => !/\sdisabled(?:=|\s|>)/.test(button)),
    ).toBe(true);
  });
});
