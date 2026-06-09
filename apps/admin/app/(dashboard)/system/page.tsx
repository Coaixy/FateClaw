'use client';

import { useEffect } from 'react';
import { replaceAdminDocument } from '@/lib/admin-navigation';

/**
 * 兼容旧系统配置入口，避免已有书签访问到空页面。
 */
export default function AdminSystemConfigRedirectPage() {
  useEffect(() => {
    replaceAdminDocument('/system/models');
  }, []);

  return (
    <div className="flex justify-center py-20">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
    </div>
  );
}
