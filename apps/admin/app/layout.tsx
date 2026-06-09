import type { Metadata, Viewport } from 'next';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import './globals.css';

export const metadata: Metadata = {
  title: '命枢 Admin｜守义AI',
  description: '命枢管理后台',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// 阻塞式主题脚本需要先于 React hydration 执行，避免管理后台首屏闪烁。
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='light')document.documentElement.classList.add('light');else if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ToastProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
