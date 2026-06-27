import type { Metadata } from 'next';

import { ApiDocsContent } from '@/components/docs/api-docs-content';

export const metadata: Metadata = {
  title: '开发者 API 文档 | FateClaw',
  description: 'FateClaw 开放 API：用 API Key 程序化调用排盘与 AI Agent。',
};

export default function ApiDocsPage() {
  return <ApiDocsContent />;
}
