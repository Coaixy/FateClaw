import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: '公益',
};

/**
 * 将旧关于页入口迁移到公益页。
 *
 * @returns 不渲染页面内容，直接跳转到公益页。
 */
export default function AboutPage() {
  redirect('/charity');
}
