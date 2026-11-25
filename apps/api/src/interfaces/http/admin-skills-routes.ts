import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getUserCustomSkillById,
  hasOfficialSkill,
  listAdminGlobalSkills,
  listSkillCommentsForAdmin,
  setSkillGlobalEnabled,
  setSkillCommentPinnedForAdmin,
  setUserCustomSkillAdminState,
  reviewSkillCommentForAdmin,
} from '#modules/admin/admin-service';
import {
  toAdminSkillCommentDto,
  toAdminSkillCommentDtos,
} from '#contracts-adapter/skills-contract';

export async function adminSkillsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/skills/custom — 查看所有用户自定义知识技能
  app.get('/skills/custom', async (request) => {
    const query = request.query as {
      user_id?: string;
    };
    return getCustomSkillsForAdmin({
      userId: query.user_id,
    });
  });

  // GET /api/admin/skills/custom/:id — 查看单个用户自定义知识技能详情
  app.get<{ Params: { id: string } }>(
    '/skills/custom/:id',
    async (request, reply) => {
      const { id } = request.params;
      const skill = await getCustomSkillForAdmin(id);
      if (!skill) {
        return reply.code(404).send({ error: '技能不存在' });
      }
      return skill;
    },
  );

  // PATCH /api/admin/skills/custom/:id/state — 管理员修改用户自定义技能状态/可见性
  app.patch<{
    Params: { id: string };
    Body: {
      enabled?: boolean;
      visibility?: 'private' | 'link_shared' | 'shared';
    };
  }>('/skills/custom/:id/state', async (request, reply) => {
    const { id } = request.params;
    const { enabled, visibility } = request.body || {};

    if (enabled === undefined && visibility === undefined) {
      return reply
        .code(400)
        .send({ error: 'enabled 或 visibility 至少提供一个' });
    }
    if (
      visibility !== undefined &&
      !['private', 'link_shared', 'shared'].includes(visibility)
    ) {
      return reply.code(400).send({ error: 'visibility 值无效' });
    }

    const current = await getUserCustomSkillById(id);
    if (!current) {
      return reply.code(404).send({ error: '技能不存在' });
    }

    await setUserCustomSkillAdminState(id, {
      enabled,
      visibility,
      shareToken:
        visibility && visibility !== 'private' && !current.share_token
          ? crypto.randomUUID()
          : current.share_token,
    });

    const updated = await getCustomSkillForAdmin(id);
    if (!updated) {
      return reply.code(404).send({ error: '技能不存在' });
    }
    return updated;
  });

  // GET /api/admin/skills/comments — 管理员查看 Skill 评论审核列表
  app.get('/skills/comments', async (request, reply) => {
    const query = request.query as {
      status?: string;
      skill_id?: string;
      limit?: string;
    };
    const status = query.status?.trim();
    if (status && !['pending', 'approved', 'rejected'].includes(status)) {
      return reply.code(400).send({ error: 'status 值无效' });
    }
    const rawLimit = query.limit ? Number(query.limit) : undefined;
    if (
      rawLimit !== undefined &&
      (!Number.isInteger(rawLimit) || rawLimit < 1)
    ) {
      return reply.code(400).send({ error: 'limit 必须是正整数' });
    }

    const comments = await listSkillCommentsForAdmin({
      status: status as 'pending' | 'approved' | 'rejected' | undefined,
      skillId: query.skill_id?.trim() || undefined,
      limit: rawLimit,
    });
    return { items: toAdminSkillCommentDtos(comments) };
  });

  // PATCH /api/admin/skills/comments/:id/review — 管理员通过或拒绝评论
  app.patch<{
    Params: { id: string };
    Body: { status?: 'pending' | 'approved' | 'rejected' };
  }>('/skills/comments/:id/review', async (request, reply) => {
    const status = request.body?.status;
    if (!['approved', 'rejected'].includes(status ?? '')) {
      return reply
        .code(400)
        .send({ error: 'status 只能是 approved 或 rejected' });
    }
    const comment = await reviewSkillCommentForAdmin({
      id: request.params.id,
      status: status as 'approved' | 'rejected',
      reviewedBy: request.adminPrincipal?.role ?? 'admin',
    });
    if (!comment) return reply.code(404).send({ error: '评论不存在' });
    return toAdminSkillCommentDto(comment);
  });

  // PATCH /api/admin/skills/comments/:id/pin — 管理员置顶或取消置顶已通过评论
  app.patch<{
    Params: { id: string };
    Body: { pinned?: boolean };
  }>('/skills/comments/:id/pin', async (request, reply) => {
    if (typeof request.body?.pinned !== 'boolean') {
      return reply.code(400).send({ error: 'pinned 必须是布尔值' });
    }
    const comment = await setSkillCommentPinnedForAdmin(
      request.params.id,
      request.body.pinned,
    );
    if (!comment) {
      return reply.code(404).send({ error: '评论不存在或尚未通过审核' });
    }
    return toAdminSkillCommentDto(comment);
  });

  // GET /api/admin/skills/global — 查看所有系统排盘的全局开关状态
  // 以文件系统为主，数据库配置为辅
  app.get('/skills/global', async () => {
    return listAdminGlobalSkills();
  });

  // POST /api/admin/skills/global/:name/enable — 全局开启一个系统排盘
  app.post<{ Params: { name: string } }>(
    '/skills/global/:name/enable',
    async (request, reply) => {
      const { name } = request.params;
      if (!hasOfficialSkill(name)) {
        return reply.code(404).send({ error: `系统排盘 "${name}" 不存在` });
      }
      await setSkillGlobalEnabled(name, true);

      return { success: true };
    },
  );

  // POST /api/admin/skills/global/:name/disable — 全局关闭一个系统排盘
  app.post<{ Params: { name: string } }>(
    '/skills/global/:name/disable',
    async (request, reply) => {
      const { name } = request.params;
      if (!hasOfficialSkill(name)) {
        return reply.code(404).send({ error: `系统排盘 "${name}" 不存在` });
      }
      await setSkillGlobalEnabled(name, false);

      return { success: true };
    },
  );
}
