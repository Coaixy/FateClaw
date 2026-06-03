import crypto from 'crypto';

import { FastifyInstance } from 'fastify';
import type {
  CreateSkillAccessInviteRequestDto,
  SkillAccessInviteTargetTypeDto,
} from '@fateclaw/contracts/skills';

import {
  createSkillAccessInvite,
  createSkillBundle,
  createUserCustomSkill,
  deleteSkillBundle,
  deleteUserCustomSkill,
  getBundleByToken,
  getSkillAccessInvitePreviewByToken,
  getSkillByShareToken,
  getSubscribedSkills,
  getUserCustomSkill,
  getUserCustomSkillCount,
  getUserCustomSkills,
  listMarketBundles,
  listMarketSkills,
  listSkillAccessInvites,
  listUserBundles,
  publishSkillBundle,
  publishUserCustomSkill,
  redeemSkillAccessInvite,
  revokeSkillAccessInvite,
  MAX_SKILL_BUNDLE_FILE_LENGTH,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH,
  MAX_USER_SKILLS,
  shareSkillBundle,
  shareUserCustomSkill,
  slugifySkillName,
  subscribeToBundle,
  subscribeToSkill,
  toggleSubscription,
  toggleUserCustomSkill,
  unsubscribeFromBundle,
  unshareSkillBundle,
  unshareUserCustomSkill,
  unpublishSkillBundle,
  unpublishUserCustomSkill,
  unsubscribeFromSkill,
  updateSkillBundle,
  updateUserCustomSkill,
} from '../../modules/skills/skills-service.js';

import {
  toMarketBundleDtos,
  toMarketSkillDtos,
  toSkillAccessInviteDto,
  toSkillAccessInvitePreviewDto,
  toSkillAccessInviteRedeemResultDto,
  toSharedBundlePreviewDto,
  toSharedSkillPreviewDto,
  toSubscribedSkillDtos,
} from '../../contracts-adapter/skills-contract.js';
import type { TextSkillBundleFile } from '../../shared/types.js';

function parseBundleFilesPayload(
  files: unknown,
): TextSkillBundleFile[] | null {
  if (!Array.isArray(files)) return null;
  const parsed: TextSkillBundleFile[] = [];

  if (files.length > MAX_SKILL_BUNDLE_FILES) {
    throw new Error(`Bundle 文件数不超过 ${MAX_SKILL_BUNDLE_FILES} 个`);
  }

  let totalLength = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object') return null;
    const { path, content } = file as { path?: unknown; content?: unknown };
    if (typeof path !== 'string' || typeof content !== 'string') return null;
    if (content.length > MAX_SKILL_BUNDLE_FILE_LENGTH) {
      throw new Error(
        `单个文件内容不超过 ${MAX_SKILL_BUNDLE_FILE_LENGTH} 字`,
      );
    }
    totalLength += content.length;
    parsed.push({ path, content });
  }
  if (totalLength > MAX_SKILL_BUNDLE_TOTAL_LENGTH) {
    throw new Error(
      `Bundle 总内容不超过 ${MAX_SKILL_BUNDLE_TOTAL_LENGTH} 字`,
    );
  }

  return parsed;
}

function isAccessInviteTargetType(
  value: unknown,
): value is SkillAccessInviteTargetTypeDto {
  return value === 'skill' || value === 'bundle';
}

function accessInviteRedeemError(status: string): string {
  switch (status) {
    case 'expired':
      return '授权链接已过期';
    case 'revoked':
      return '授权链接已撤销';
    case 'used_up':
      return '授权链接领取名额已满';
    case 'own_target':
      return '不能领取自己的授权链接';
    case 'invalid':
    default:
      return '授权链接无效';
  }
}

export async function skillsRoutes(app: FastifyInstance): Promise<void> {
  // =====================
  // --- User custom skill CRUD ---
  // =====================

  // GET /api/skills/user — 列出自有 + 订阅 skill
  app.get('/user', async (request) => {
    await request.requireAuth();
    const userId = request.user.userId;

    const own = await getUserCustomSkills(userId);
    const subscribed = toSubscribedSkillDtos(await getSubscribedSkills(userId));

    return { own, subscribed };
  });

  // POST /api/skills/user — 创建
  app.post('/user', async (request, reply) => {
    await request.requireAuth();
    const userId = request.user.userId;
    const body = request.body as {
      skill_name?: string;
      dir_name?: string;
      files?: unknown;
    };

    const skillName = body.skill_name?.trim() ?? '';
    if (!skillName || skillName.length > 50) {
      return reply.code(400).send({ error: '技能名称必填且不超过 50 字' });
    }
    let files: TextSkillBundleFile[] | null;
    try {
      files = parseBundleFilesPayload(body.files);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Bundle 文件不符合限制',
      });
    }
    if (!files) {
      return reply.code(400).send({ error: 'files 必须是文本文件数组' });
    }

    const count = await getUserCustomSkillCount(userId);
    if (count >= MAX_USER_SKILLS) {
      return reply
        .code(400)
        .send({ error: `自定义技能数量已达上限（${MAX_USER_SKILLS}）` });
    }

    try {
      const skill = await createUserCustomSkill({
        id: crypto.randomUUID(),
        user_id: userId,
        skill_name: skillName,
        dir_name: slugifySkillName(body.dir_name || skillName),
        files,
      });

      return skill;
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : '创建失败' });
    }
  });

  // GET /api/skills/user/:id — 详情
  app.get('/user/:id', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const skill = await getUserCustomSkill(id, request.user.userId);
    if (!skill) return reply.code(404).send({ error: '技能不存在' });
    return skill;
  });

  // PUT /api/skills/user/:id — 更新
  app.put('/user/:id', async (request, reply) => {
    await request.requireAuth();
    const userId = request.user.userId;
    const { id } = request.params as { id: string };
    const body = request.body as {
      skill_name?: string;
      files?: unknown;
    };

    if (
      body.skill_name !== undefined &&
      body.skill_name.trim().length > 50
    ) {
      return reply.code(400).send({ error: '技能名称不超过 50 字' });
    }

    let files: TextSkillBundleFile[] | undefined;
    if (body.files !== undefined) {
      try {
        const parsed = parseBundleFilesPayload(body.files);
        if (!parsed) {
          return reply
            .code(400)
            .send({ error: 'files 必须是文本文件数组' });
        }
        files = parsed;
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Bundle 文件不符合限制',
        });
      }
    }

    const updates: {
      skill_name?: string;
      files?: TextSkillBundleFile[];
    } = {};
    if (body.skill_name !== undefined) {
      updates.skill_name = body.skill_name.trim();
    }
    if (files !== undefined) updates.files = files;

    let skill;
    try {
      skill = await updateUserCustomSkill(id, userId, updates);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : '更新失败' });
    }
    if (!skill) return reply.code(404).send({ error: '技能不存在' });

    return skill;
  });

  // DELETE /api/skills/user/:id — 软删除
  app.delete('/user/:id', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const ok = await deleteUserCustomSkill(id, request.user.userId);
    if (!ok) return reply.code(404).send({ error: '技能不存在' });

    return { ok: true };
  });

  // PATCH /api/skills/user/:id/toggle — 启用/禁用
  app.patch('/user/:id/toggle', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const skill = await toggleUserCustomSkill(id, request.user.userId);
    if (!skill) return reply.code(404).send({ error: '技能不存在' });

    return skill;
  });

  // =====================
  // --- Share & Subscribe ---
  // =====================

  // POST /api/skills/user/:id/share — 开启私密链接分享
  app.post('/user/:id/share', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const token = crypto.randomUUID();
    const skill = await shareUserCustomSkill(id, request.user.userId, token);
    if (!skill) return reply.code(404).send({ error: '技能不存在' });
    return { share_token: token, skill };
  });

  // DELETE /api/skills/user/:id/share — 关闭分享
  app.delete('/user/:id/share', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const skill = await unshareUserCustomSkill(id, request.user.userId);
    if (!skill) return reply.code(404).send({ error: '技能不存在' });

    return skill;
  });

  // POST /api/skills/user/:id/publish — 公开上架
  app.post('/user/:id/publish', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const token = crypto.randomUUID();
    const skill = await publishUserCustomSkill(id, request.user.userId, token);
    if (!skill) return reply.code(404).send({ error: '技能不存在' });
    return { share_token: skill.share_token ?? token, skill };
  });

  // DELETE /api/skills/user/:id/publish — 取消公开，保留链接分享
  app.delete('/user/:id/publish', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const skill = await unpublishUserCustomSkill(id, request.user.userId);
    if (!skill) return reply.code(404).send({ error: '技能不存在' });

    return skill;
  });

  // GET /api/skills/shared/:token — 预览分享 skill（链接可访问，无需认证）
  app.get('/shared/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const skill = await getSkillByShareToken(token);
    if (!skill) return reply.code(404).send({ error: '分享链接无效' });
    return toSharedSkillPreviewDto(skill);
  });

  // POST /api/skills/subscribe/:token — 订阅
  app.post('/subscribe/:token', async (request, reply) => {
    await request.requireAuth();
    const { token } = request.params as { token: string };
    const sub = await subscribeToSkill(
      crypto.randomUUID(),
      request.user.userId,
      token,
    );
    if (!sub)
      return reply
        .code(400)
        .send({ error: '分享链接无效或无法订阅自己的技能' });

    return sub;
  });

  // PATCH /api/skills/subscribe/:id/toggle — 启用/禁用订阅
  app.patch('/subscribe/:id/toggle', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const enabled = await toggleSubscription(id, request.user.userId);
    if (enabled === null) return reply.code(404).send({ error: '订阅不存在' });

    return { enabled };
  });

  // DELETE /api/skills/subscribe/:id — 取消订阅
  app.delete('/subscribe/:id', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const ok = await unsubscribeFromSkill(id, request.user.userId);
    if (!ok) return reply.code(404).send({ error: '订阅不存在' });

    return { ok: true };
  });

  // POST /api/skills/access-invites — 作者创建私密授权链接
  app.post('/access-invites', async (request, reply) => {
    await request.requireAuth();
    const body = (request.body || {}) as CreateSkillAccessInviteRequestDto;
    if (!isAccessInviteTargetType(body.target_type)) {
      return reply.code(400).send({ error: '授权目标类型无效' });
    }
    const targetId = body.target_id?.trim() ?? '';
    if (!targetId) {
      return reply.code(400).send({ error: '授权目标不能为空' });
    }
    const maxRedemptions =
      body.max_redemptions === undefined ? 1 : body.max_redemptions;
    if (
      !Number.isInteger(maxRedemptions) ||
      maxRedemptions < 1 ||
      maxRedemptions > 1000
    ) {
      return reply.code(400).send({ error: '领取次数必须在 1 到 1000 之间' });
    }
    let expiresAt: string | null = null;
    if (body.expires_at) {
      const date = new Date(body.expires_at);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
        return reply.code(400).send({ error: '过期时间必须是未来时间' });
      }
      expiresAt = date.toISOString();
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 200) {
      return reply.code(400).send({ error: '备注不超过 200 字' });
    }

    const invite = await createSkillAccessInvite({
      id: crypto.randomUUID(),
      creatorId: request.user.userId,
      targetType: body.target_type,
      targetId,
      token: crypto.randomUUID(),
      maxRedemptions,
      expiresAt,
      note,
    });
    if (!invite) return reply.code(404).send({ error: '授权目标不存在' });
    return toSkillAccessInviteDto(invite);
  });

  // GET /api/skills/access-invites — 作者查看自己创建的私密授权链接
  app.get('/access-invites', async (request, reply) => {
    await request.requireAuth();
    const query = (request.query || {}) as {
      target_type?: string;
      target_id?: string;
    };
    const targetType = query.target_type?.trim();
    if (targetType && !isAccessInviteTargetType(targetType)) {
      return reply.code(400).send({ error: '授权目标类型无效' });
    }
    const inviteTargetType = isAccessInviteTargetType(targetType)
      ? targetType
      : undefined;
    const invites = await listSkillAccessInvites(request.user.userId, {
      targetType: inviteTargetType,
      targetId: query.target_id?.trim() || undefined,
    });
    return invites.map(toSkillAccessInviteDto);
  });

  // GET /api/skills/access-invites/:token — 预览私密授权链接（无需认证）
  app.get('/access-invites/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const preview = await getSkillAccessInvitePreviewByToken(token);
    if (!preview) return reply.code(404).send({ error: '授权链接无效' });
    return toSkillAccessInvitePreviewDto(preview);
  });

  // POST /api/skills/access-invites/:token/redeem — 领取私密授权
  app.post('/access-invites/:token/redeem', async (request, reply) => {
    await request.requireAuth();
    const { token } = request.params as { token: string };
    const result = await redeemSkillAccessInvite(request.user.userId, token);
    if (result.status !== 'redeemed') {
      const code = result.status === 'invalid' ? 404 : 400;
      return reply
        .code(code)
        .send({ error: accessInviteRedeemError(result.status) });
    }
    return toSkillAccessInviteRedeemResultDto(result);
  });

  // DELETE /api/skills/access-invites/:id — 作者撤销私密授权链接
  app.delete('/access-invites/:id', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const invite = await revokeSkillAccessInvite(id, request.user.userId);
    if (!invite) return reply.code(404).send({ error: '授权链接不存在' });
    return toSkillAccessInviteDto(invite);
  });

  // =====================
  // --- Skill Bundles ---
  // =====================

  // POST /api/skills/bundles — 创建捆绑包
  app.post('/bundles', async (request, reply) => {
    await request.requireAuth();
    const body =
      (request.body as {
        name?: string;
        description?: string;
        skill_ids?: string[];
      }) || {};
    const name = (body.name || '').trim();
    if (!name) return reply.code(400).send({ error: '请填写捆绑包名称' });
    if (name.length > 80)
      return reply.code(400).send({ error: '名称过长（≤80 字）' });
    const description = (body.description || '').trim();
    if (description.length > 300)
      return reply.code(400).send({ error: '描述过长（≤300 字）' });
    const skillIds = Array.isArray(body.skill_ids) ? body.skill_ids : [];
    if (skillIds.length === 0)
      return reply.code(400).send({ error: '至少选择 1 个技能' });
    try {
      const bundle = await createSkillBundle(
        crypto.randomUUID(),
        request.user.userId,
        name,
        description,
        skillIds,
      );
      return bundle;
    } catch (e) {
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : '创建失败' });
    }
  });

  // GET /api/skills/bundles — 自有捆绑包列表
  app.get('/bundles', async (request) => {
    await request.requireAuth();
    return listUserBundles(request.user.userId);
  });

  // PUT /api/skills/bundles/:id — 更新
  app.put('/bundles/:id', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const body =
      (request.body as {
        name?: string;
        description?: string;
        skill_ids?: string[];
      }) || {};
    const patch: { name?: string; description?: string; skill_ids?: string[] } =
      {};
    if (body.name !== undefined) {
      const v = body.name.trim();
      if (!v) return reply.code(400).send({ error: '名称不能为空' });
      if (v.length > 80)
        return reply.code(400).send({ error: '名称过长（≤80 字）' });
      patch.name = v;
    }
    if (body.description !== undefined) {
      const v = body.description.trim();
      if (v.length > 300)
        return reply.code(400).send({ error: '描述过长（≤300 字）' });
      patch.description = v;
    }
    if (body.skill_ids !== undefined) {
      if (!Array.isArray(body.skill_ids))
        return reply.code(400).send({ error: 'skill_ids 必须是数组' });
      patch.skill_ids = body.skill_ids;
    }
    try {
      const bundle = await updateSkillBundle(id, request.user.userId, patch);
      if (!bundle) return reply.code(404).send({ error: '捆绑包不存在' });
      return bundle;
    } catch (e) {
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : '更新失败' });
    }
  });

  // DELETE /api/skills/bundles/:id — 删除（软删）
  app.delete('/bundles/:id', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const ok = await deleteSkillBundle(id, request.user.userId);
    if (!ok) return reply.code(404).send({ error: '捆绑包不存在' });
    return { ok: true };
  });

  // POST /api/skills/bundles/:id/share — 开启私密链接分享
  app.post('/bundles/:id/share', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const token = crypto.randomUUID();
    const bundle = await shareSkillBundle(id, request.user.userId, token);
    if (!bundle) return reply.code(404).send({ error: '捆绑包不存在' });
    return { bundle_token: token, bundle };
  });

  // DELETE /api/skills/bundles/:id/share — 取消分享
  app.delete('/bundles/:id/share', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const bundle = await unshareSkillBundle(id, request.user.userId);
    if (!bundle) return reply.code(404).send({ error: '捆绑包不存在' });
    return bundle;
  });

  // POST /api/skills/bundles/:id/publish — 公开上架
  app.post('/bundles/:id/publish', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const token = crypto.randomUUID();
    const bundle = await publishSkillBundle(id, request.user.userId, token);
    if (!bundle) return reply.code(404).send({ error: '捆绑包不存在' });
    return { bundle_token: bundle.bundle_token ?? token, bundle };
  });

  // DELETE /api/skills/bundles/:id/publish — 取消公开，保留链接分享
  app.delete('/bundles/:id/publish', async (request, reply) => {
    await request.requireAuth();
    const { id } = request.params as { id: string };
    const bundle = await unpublishSkillBundle(id, request.user.userId);
    if (!bundle) return reply.code(404).send({ error: '捆绑包不存在' });
    return bundle;
  });

  // GET /api/skills/bundles/shared/:token — 链接预览（无需认证）
  app.get('/bundles/shared/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const info = await getBundleByToken(token);
    if (!info) return reply.code(404).send({ error: '分享链接无效' });
    return toSharedBundlePreviewDto(info);
  });

  // POST /api/skills/bundles/subscribe/:token — 批量订阅
  app.post('/bundles/subscribe/:token', async (request, reply) => {
    await request.requireAuth();
    const { token } = request.params as { token: string };
    try {
      const result = await subscribeToBundle(request.user.userId, token);
      if (!result)
        return reply
          .code(400)
          .send({ error: '分享链接无效或无法订阅自己的捆绑包' });
      return {
        subscribed_count: result.subscribedCount,
        skipped_count: result.skippedCount,
        subscription_ids: result.subscriptionIds,
      };
    } catch (e) {
      return reply
        .code(500)
        .send({ error: e instanceof Error ? e.message : '订阅失败' });
    }
  });

  // DELETE /api/skills/bundles/subscriptions/:bundleId — 取消整包订阅
  app.delete('/bundles/subscriptions/:bundleId', async (request, reply) => {
    await request.requireAuth();
    const { bundleId } = request.params as { bundleId: string };
    const unsubscribedCount = await unsubscribeFromBundle(
      bundleId,
      request.user.userId,
    );
    if (unsubscribedCount === 0) {
      return reply.code(404).send({ error: '捆绑包订阅不存在' });
    }
    return { unsubscribed_count: unsubscribedCount };
  });

  // GET /api/skills/market — 公开 Skill 市场
  app.get('/market', async (request) => {
    const { limit, offset } = request.query as {
      limit?: string;
      offset?: string;
    };
    return toMarketSkillDtos(
      await listMarketSkills({
        limit: parseInt(limit || '50', 10) || 50,
        offset: parseInt(offset || '0', 10) || 0,
      }),
    );
  });

  // GET /api/skills/bundles/market — 公开 Bundle 市场
  app.get('/bundles/market', async (request) => {
    const { limit, offset } = request.query as {
      limit?: string;
      offset?: string;
    };
    return toMarketBundleDtos(
      await listMarketBundles({
        limit: parseInt(limit || '20', 10) || 20,
        offset: parseInt(offset || '0', 10) || 0,
      }),
    );
  });

  // GET /api/skills/subscriptions/mine — 查我的 Skill 订阅
  app.get('/subscriptions/mine', async (request) => {
    await request.requireAuth();
    return toSubscribedSkillDtos(
      await getSubscribedSkills(request.user.userId),
    );
  });
}
