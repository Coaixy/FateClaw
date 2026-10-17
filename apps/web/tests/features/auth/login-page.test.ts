import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ locale: 'zh-CN' }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('@/features/auth/hooks/use-auth', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
  }),
}));
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n')>()),
  useI18n: () => ({
    locale: state.locale,
    setLocale: vi.fn(),
    t: (key: string) => key,
    formatDate: (value: string) => value,
  }),
}));

import LoginPage from '../../../app/login/page';

describe('login methods by language', () => {
  it.each(['zh-CN', 'zh-TW', 'en'])(
    'offers phone authentication without Google in %s',
    (locale) => {
      state.locale = locale;
      const html = renderToStaticMarkup(createElement(LoginPage));

      expect(html).toContain('type="tel"');
      expect(html).toContain('type="password"');
      expect(html).toContain('login.authModes.register');
      expect(html).toContain('login.captcha');
      expect(html).not.toContain('registration-invite');
      expect(html).not.toMatch(/google|oauth/i);
    },
  );
});
