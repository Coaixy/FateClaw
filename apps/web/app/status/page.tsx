import type { Metadata } from 'next';
import { ServiceStatusPage } from '@/components/service-status-page';

export const metadata: Metadata = {
  title: '服务状态 | FateClaw',
  description: '查看全站 Token 累计增长与模型上游的网络探测记录。',
};

export default function StatusPage() {
  return <ServiceStatusPage />;
}
