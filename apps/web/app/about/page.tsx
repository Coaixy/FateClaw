import type { Metadata } from 'next';

import { AboutClient } from './about-client';

export const metadata: Metadata = {
  title: '关于我们',
};

/**
 * 关于我们页面。
 *
 * 保留静态 metadata，页面内容由客户端读取公开收支流水。
 */
export default function AboutPage() {
  return <AboutClient />;
}
