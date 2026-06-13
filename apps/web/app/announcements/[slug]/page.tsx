import type { Metadata } from 'next';

import { AnnouncementDetailWorkspace } from '@/components/announcements/announcement-detail-workspace';

export const metadata: Metadata = {
  title: '公告详情',
};

/**
 * 为静态导出生成一份公告详情占位页。
 *
 * 实际公告 slug 由 API 静态文件解析层映射到该占位产物，客户端再从当前 URL
 * 读取真实 slug 并请求详情接口。
 *
 * @returns 静态导出需要的占位参数。
 */
export function generateStaticParams() {
  return [{ slug: 'detail' }];
}

/**
 * 公告详情页。
 *
 * @returns 公开公告详情工作区。
 */
export default function AnnouncementDetailPage() {
  return <AnnouncementDetailWorkspace />;
}
