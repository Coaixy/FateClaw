import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/features/auth/providers/auth-provider';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { SiteNotices } from '@/components/site-notices';
import { I18nProvider } from '@/lib/i18n';
// 标题与正文均走系统楷体（Kaiti SC / STKaiti / KaiTi / BiauKai），不再额外加载网络字体。
import './globals.css';

export const metadata: Metadata = {
  title: '小奕想要三合木｜守义AI',
  description: '面向卦师的 AI 断卦副驾 — 自动排盘、辅助解读，助你服务客户。',
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
                <SiteNotices />
              </ConfirmProvider>
            </ToastProvider>
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
