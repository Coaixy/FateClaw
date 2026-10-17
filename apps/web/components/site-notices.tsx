'use client';

import { useCallback, useState } from 'react';
import { usePathname } from 'next/navigation';
import { PreUseNoticeDialog } from '@/components/compliance/pre-use-notice-dialog';
import { AnnouncementDialog } from '@/components/announcements/announcement-dialog';

function NoticeSequence() {
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);
  return (
    <>
      <PreUseNoticeDialog onReady={handleReady} />
      <AnnouncementDialog enabled={ready} />
    </>
  );
}

export function SiteNotices() {
  const pathname = usePathname();
  if (pathname === '/status' || pathname === '/status/') return null;
  return <NoticeSequence />;
}
