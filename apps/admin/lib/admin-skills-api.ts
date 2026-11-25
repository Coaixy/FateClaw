import { adminRequest } from './admin-http';
import type {
  AdminSkillGlobalConfig,
  AdminCustomSkill,
  AdminCustomSkillSummary,
  AdminSkillComment,
  AdminSkillCommentStatus,
  AdminSkillCommentsResponse,
} from './admin-api';

export const adminSkillsApi = {
  globalSkills: () =>
    adminRequest<AdminSkillGlobalConfig[]>('/api/admin/skills/global'),
  setSkillGlobalEnabled: (name: string, enabled: boolean) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/skills/global/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST' },
    ),
  customSkills: (opts?: { user_id?: string }) => {
    const params = new URLSearchParams();
    if (opts?.user_id) params.set('user_id', opts.user_id);
    const qs = params.toString();
    return adminRequest<AdminCustomSkillSummary[]>(
      `/api/admin/skills/custom${qs ? `?${qs}` : ''}`,
    );
  },
  customSkill: (id: string) =>
    adminRequest<AdminCustomSkill>(
      `/api/admin/skills/custom/${encodeURIComponent(id)}`,
    ),
  updateCustomSkillState: (
    id: string,
    data: {
      enabled?: boolean;
      visibility?: 'private' | 'link_shared' | 'shared';
    },
  ) =>
    adminRequest<AdminCustomSkill>(
      `/api/admin/skills/custom/${encodeURIComponent(id)}/state`,
      { method: 'PATCH', body: JSON.stringify(data) },
    ),
  skillComments: (opts?: {
    status?: AdminSkillCommentStatus;
    skill_id?: string;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.skill_id) params.set('skill_id', opts.skill_id);
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return adminRequest<AdminSkillCommentsResponse>(
      `/api/admin/skills/comments${qs ? `?${qs}` : ''}`,
    );
  },
  reviewSkillComment: (
    id: string,
    status: Exclude<AdminSkillCommentStatus, 'pending'>,
  ) =>
    adminRequest<AdminSkillComment>(
      `/api/admin/skills/comments/${encodeURIComponent(id)}/review`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
    ),
  pinSkillComment: (id: string, pinned: boolean) =>
    adminRequest<AdminSkillComment>(
      `/api/admin/skills/comments/${encodeURIComponent(id)}/pin`,
      { method: 'PATCH', body: JSON.stringify({ pinned }) },
    ),
};
