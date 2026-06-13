import type { PublicAnnouncement } from '@/features/announcements/api';

type AnnouncementStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * 生成公告横幅关闭状态的本地存储 key。
 *
 * @param announcement 公告数据。
 * @returns 包含公告 ID 和更新时间的稳定 key。
 */
export function getAnnouncementDismissKey(
  announcement: Pick<PublicAnnouncement, 'id' | 'updated_at'>,
): string {
  return `fateclaw:announcement:dismissed:${announcement.id}:${announcement.updated_at}`;
}

/**
 * 判断公告是否已在当前浏览器关闭。
 *
 * @param storage 浏览器本地存储；测试可传入内存实现。
 * @param announcement 公告数据。
 * @returns 已关闭返回 true，读取失败时按未关闭处理。
 */
export function isAnnouncementDismissed(
  storage: AnnouncementStorage | null | undefined,
  announcement: Pick<PublicAnnouncement, 'id' | 'updated_at'>,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(getAnnouncementDismissKey(announcement)) === '1';
  } catch {
    return false;
  }
}

/**
 * 记录公告已在当前浏览器关闭。
 *
 * @param storage 浏览器本地存储；测试可传入内存实现。
 * @param announcement 公告数据。
 * @returns 写入成功返回 true，写入失败返回 false。
 */
export function dismissAnnouncement(
  storage: AnnouncementStorage | null | undefined,
  announcement: Pick<PublicAnnouncement, 'id' | 'updated_at'>,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(getAnnouncementDismissKey(announcement), '1');
    return true;
  } catch {
    return false;
  }
}
