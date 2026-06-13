import type { Metadata } from 'next';

import { AnnouncementsWorkspace } from '@/components/announcements/announcements-workspace';

export const metadata: Metadata = {
  title: '公告中心',
};

/**
 * 公告中心列表页。
 *
 * @returns 公开公告列表工作区。
 */
export default function AnnouncementsPage() {
  return <AnnouncementsWorkspace />;
}
