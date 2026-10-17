import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingGuideDialog } from '@/components/ai-chat/onboarding-guide-dialog';
import { I18nProvider } from '@/lib/i18n';

describe('onboarding model access', () => {
  it('offers membership for a configured free-only service without reporting a model outage', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OnboardingGuideDialog
          open
          step="model"
          modelReady={false}
          modelMembershipRequired
          skillReady={false}
          modelLoading={false}
          skillLoading={false}
          modelError=""
          skillError=""
          hasAnyInstalledSkill={false}
          onClose={vi.fn()}
          onSaveStep={vi.fn()}
          onRetry={vi.fn()}
          onOpenSkillMarket={vi.fn()}
          onComplete={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(html).toContain('免费模型仅限有效会员使用');
    expect(html).toContain('href="/membership"');
    expect(html).not.toContain('当前暂无可用官方模型');
    expect(html).not.toContain('联系管理员');
  });
});
