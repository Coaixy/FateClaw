import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { AuthProvider } from '@/features/auth/providers/auth-provider';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { PreUseNoticeDialog } from '@/components/compliance/pre-use-notice-dialog';
import './globals.css';

const kingHwaOldSong = localFont({
  src: './fonts/KingHwa_OldSong.ttf',
  variable: '--font-kinghwa-old-song',
  display: 'swap',
  preload: false,
});

export const metadata: Metadata = {
  title: '命枢 FateClaw',
  description: '面向命理创作者的 AI 分身平台 — 在微信对话中运行，沉淀方法，持续服务。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// Blocking script to prevent theme flash — runs before React hydrates
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='light')document.documentElement.classList.add('light');else if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className={kingHwaOldSong.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AuthProvider>
          <ToastProvider>
            <ConfirmProvider>
              {children}
              <PreUseNoticeDialog />
            </ConfirmProvider>
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
