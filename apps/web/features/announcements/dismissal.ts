import type { AnnouncementDto } from '@fateclaw/contracts';

const dismissed = new Map<string, number>();
const prefix = 'fateclaw:announcement:';

export function isAnnouncementDismissed(
  item: Pick<AnnouncementDto, 'id' | 'revision'>,
): boolean {
  if (dismissed.get(item.id) === item.revision) return true;
  try {
    return (
      window.localStorage.getItem(`${prefix}${item.id}`) ===
      String(item.revision)
    );
  } catch (error) {
    if (error instanceof DOMException) return false;
    throw error;
  }
}

export function dismissAnnouncement(
  item: Pick<AnnouncementDto, 'id' | 'revision'>,
) {
  // Keep dismissal for this page session even when browser storage is unavailable.
  dismissed.set(item.id, item.revision);
  try {
    window.localStorage.setItem(`${prefix}${item.id}`, String(item.revision));
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}

export function isAnnouncementStorageKey(key: string | null) {
  return key === null || key.startsWith(prefix);
}
