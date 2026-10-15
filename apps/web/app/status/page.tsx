import type { Metadata } from 'next';
import { ServiceStatusPage } from '@/components/service-status-page';

export const metadata: Metadata = {
  title: '服务状态 | FateClaw',
  description: '查看 AI 服务整体可用性、最近检测时间与响应延迟。',
};

export default function StatusPage() {
  return <ServiceStatusPage />;
}
