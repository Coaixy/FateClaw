'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { messages } from './messages';

export type Locale = keyof typeof messages;
type Messages = typeof messages;
type MessageTree = Messages[Locale];
type Primitive = string | number | boolean | null | undefined;

const DEFAULT_LOCALE: Locale = 'zh-CN';
const STORAGE_KEY = 'fateclaw:locale';

export const LOCALE_OPTIONS: readonly {
  value: Locale;
  labelKey: 'language.zhCN' | 'language.zhTW' | 'language.en';
  htmlLang: string;
}[] = [
  { value: 'zh-CN', labelKey: 'language.zhCN', htmlLang: 'zh-CN' },
  { value: 'zh-TW', labelKey: 'language.zhTW', htmlLang: 'zh-TW' },
  { value: 'en', labelKey: 'language.en', htmlLang: 'en' },
];

interface I18nContextValue {
  locale: Locale;
  htmlLang: string;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, Primitive>) => string;
  formatDate: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatNumber: (
    value: number,
    options?: Intl.NumberFormatOptions,
  ) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function isLocale(value: string | null): value is Locale {
  return value === 'zh-CN' || value === 'zh-TW' || value === 'en';
}

function getInitialLocale(): Locale {
  if (typeof window === 'undefined') {
    return DEFAULT_LOCALE;
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (isLocale(stored)) {
    return stored;
  }

  const preferred = window.navigator.languages.find((language) =>
    language.toLowerCase().startsWith('zh-tw'),
  );
  if (preferred) {
    return 'zh-TW';
  }

  const english = window.navigator.languages.find((language) =>
    language.toLowerCase().startsWith('en'),
  );
  return english ? 'en' : DEFAULT_LOCALE;
}

function resolveMessage(tree: MessageTree, key: string): string | null {
  let cursor: unknown = tree;
  for (const segment of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' ? cursor : null;
}

function interpolate(
  template: string,
  params?: Record<string, Primitive>,
): string {
  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === null || value === undefined ? match : String(value);
  });
}

function localeToHtmlLang(locale: Locale): string {
  return (
    LOCALE_OPTIONS.find((option) => option.value === locale)?.htmlLang ??
    DEFAULT_LOCALE
  );
}

/**
 * 提供前端展示语言状态和格式化能力。
 *
 * @param props.children 需要读取多语言状态的前端组件树。
 * @returns 多语言上下文 Provider。
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    setLocaleState(getInitialLocale());
  }, []);

  const htmlLang = localeToHtmlLang(locale);

  useEffect(() => {
    document.documentElement.lang = htmlLang;
    document.documentElement.dataset.locale = locale;
    window.localStorage.setItem(STORAGE_KEY, locale);
  }, [htmlLang, locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, Primitive>) => {
      const template =
        resolveMessage(messages[locale], key) ??
        resolveMessage(messages[DEFAULT_LOCALE], key) ??
        key;
      return interpolate(template, params);
    },
    [locale],
  );

  const formatDate = useCallback(
    (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => {
      // 非法日期（空串 / 后端脏数据串 / NaN / '0000-00-00' 等）传给 Intl.format 会抛
      // RangeError: Invalid time value，在渲染期冒泡到 ErrorBoundary 直接整页「页面渲染出错」。
      // 这里统一在格式化根因处兜底为空串，调用方拿到空文案即可，避免单条坏数据拖垮整页。
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return new Intl.DateTimeFormat(htmlLang, options).format(date);
    },
    [htmlLang],
  );

  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(htmlLang, options).format(value),
    [htmlLang],
  );

  const contextValue = useMemo<I18nContextValue>(
    () => ({
      locale,
      htmlLang,
      setLocale,
      t,
      formatDate,
      formatNumber,
    }),
    [formatDate, formatNumber, htmlLang, locale, setLocale, t],
  );

  return <I18nContext value={contextValue}>{children}</I18nContext>;
}

/**
 * 读取当前前端展示语言和翻译函数。
 *
 * @returns 当前语言、语言切换函数、翻译函数与本地化格式化函数。
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}

