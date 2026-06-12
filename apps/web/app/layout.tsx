import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/features/auth/providers/auth-provider';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { PreUseNoticeDialog } from '@/components/compliance/pre-use-notice-dialog';
import { I18nProvider } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: '小奕想要三合木｜守义AI',
  description: '面向命理创作者的 AI 分身平台 — 在微信对话中运行，沉淀方法，持续服务。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// 阻塞脚本在 React hydration 前同步主题和语言，避免首屏闪烁。
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='light')document.documentElement.classList.add('light');else if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`;
const localeScript = `(function(){try{var l=localStorage.getItem('fateclaw:locale');if(l==='zh-CN'||l==='zh-TW'||l==='en'){document.documentElement.lang=l==='en'?'en':l;document.documentElement.dataset.locale=l}}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script dangerouslySetInnerHTML={{ __html: localeScript }} />
      </head>
      <body>
        <I18nProvider>
          <AuthProvider>
            <ToastProvider>
              <ConfirmProvider>
                {children}
                <PreUseNoticeDialog />
              </ConfirmProvider>
            </ToastProvider>
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
