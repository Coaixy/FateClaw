import type { AdminSkillStorageDto } from '@fateclaw/contracts/skills';

export const SKILL_STORAGE_META = {
  stored: {
    label: '已入库',
    tone: 'success',
    description: '完整正文已保存到数据库，其他部署可以按需恢复本地缓存。',
  },
  pending: {
    label: '待迁移',
    tone: 'pending',
    description:
      '尚无数据库内容修订。请在保留原文件的部署启动新版 API，完成内容迁移。',
  },
  missing: {
    label: '原文件缺失',
    tone: 'warning',
    description:
      '迁移时没有找到完整的原文件。恢复原部署的文件后，重启 API 重试。',
  },
  mismatched: {
    label: '校验不一致',
    tone: 'warning',
    description:
      '原文件与记录的内容校验值不一致。请确认完整的原始内容后再迁移。',
  },
  invalid: {
    label: '文件格式异常',
    tone: 'warning',
    description:
      '原文件未通过内容格式校验。修复文件后，重启原部署的 API 重试。',
  },
} as const;

export type SkillStorageFilter = '' | 'stored' | 'pending' | 'attention';

export function matchesSkillStorage(
  storage: AdminSkillStorageDto,
  filter: SkillStorageFilter,
): boolean {
  if (!filter) return true;
  if (filter === 'attention')
    return ['missing', 'mismatched', 'invalid'].includes(storage.state);
  return storage.state === filter;
}

export function formatSkillDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortRevision(value: string | null): string {
  return value ? value.slice(0, 8) : '尚无修订';
}
