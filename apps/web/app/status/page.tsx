import type { Metadata } from 'next';
import { ServiceStatusPage } from '@/components/service-status-page';

export const metadata: Metadata = {
  title: '服务状态 | FateClaw',
  description: '查看全站 Token 累计增长与 AI 服务检测记录。',
};

export default function StatusPage() {
  return <ServiceStatusPage />;
}
