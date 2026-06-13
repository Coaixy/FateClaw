import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: '关于我们',
};

/**
 * 临时隐藏关于页面。
 *
 * @returns 不渲染页面内容，直接回到主聊天入口。
 */
export default function AboutPage() {
  redirect('/ai-chat');
}
