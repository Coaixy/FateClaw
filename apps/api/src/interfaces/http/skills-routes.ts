import crypto from 'crypto';

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  CreatorWithdrawalDto,
  WithdrawalBalanceDto,
  WithdrawalRequestResponseDto,
} from '@fateclaw/contracts/skills';

import {
  createSkillBundle,
  createUserCustomSkill,
  createWithdrawalRequest,
  deleteSkillBundle,
  deleteUserCustomSkill,
  getBundleByToken,
  getCreatorBundleConfig,
  getCreatorEarnings,
  getSkillByShareToken,
  getSubscribedSkills,
  getUserById,
  getUserCustomSkill,
  getUserCustomSkillCount,
  getUserCustomSkills,
  listCreatorSharedSkills,
  listMarketBundles,
  listMarketSkills,
  listUserBundles,
  listWithdrawalsForCreator,
  publishSkillBundle,
  publishUserCustomSkill,
  MAX_SKILL_BUNDLE_FILE_LENGTH,
  MAX_SKILL_BUNDLE_FILES,
  MAX_USER_SKILLS,
  promoteUserToCreator,
  shareSkillBundle,
  shareUserCustomSkill,
  slugifySkillName,
  subscribeToBundle,
  subscribeToCreatorBundle,
  subscribeToSkill,
  subscribeToSkillPaid,
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
  upsertCreatorBundleConfig,
} from '../../modules/skills/skills-service.js';

import {
  toCreatorEarningsMonthlyDtos,
  toCreatorWithdrawalDto,
  toMarketBundleDtos,
  toMarketSkillDtos,
  toSharedBundlePreviewDto,
  toSharedSkillPreviewDto,
  toSubscribedSkillDtos,
  toWithdrawalBalanceDto,
  toWithdrawalRequestResponseDto,
} from '../../contracts-adapter/skills-contract.js';
import type {
  CreatorBundleTier,
  SkillPriceTier,
  TextSkillBundleFile,
} from '../../shared/types.js';

function parseBundleFilesPayload(
  files: unknown,
): TextSkillBundleFile[] | null {
  if (!Array.isArray(files)) return null;
  const parsed: TextSkillBundleFile[] = [];

  if (files.length > MAX_SKILL_BUNDLE_FILES) {
    throw new Error(`Bundle 文件数不超过 ${MAX_SKILL_BUNDLE_FILES} 个`);
  }

  for (const file of files) {
    if (!file || typeof file !== 'object') return null;
    const { path, content } = file as { path?: unknown; content?: unknown };
    if (typeof path !== 'string' || typeof content !== 'string') return null;
    if (content.length > MAX_SKILL_BUNDLE_FILE_LENGTH) {
      throw new Error(
        `单个文件内容不超过 ${MAX_SKILL_BUNDLE_FILE_LENGTH} 字`,
      );
    }
    parsed.push({ path, content });
  }

  return parsed;
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

  // POST /api/skills/subscribe/:token/paid — 付费订阅单个 Skill
  app.post('/subscribe/:token/paid', async (request, reply) => {
    await request.requireAuth();
    const { token } = request.params as { token: string };
    const { tier_key } = (request.body as { tier_key?: string }) || {};
    if (!tier_key) return reply.code(400).send({ error: '缺少 tier_key' });

    const skill = await getSkillByShareToken(token);
    if (!skill) return reply.code(404).send({ error: '分享链接无效' });

    const tier = (skill.price_tiers as SkillPriceTier[]).find(
      (t) => t.key === tier_key,
    );
    if (!tier) return reply.code(400).send({ error: '档位不存在' });

    const result = await subscribeToSkillPaid({
      subscriberId: request.user.userId,
      skillId: skill.id,
      tierKey: tier_key,
      priceCents: tier.price_cents,
      durationDays: tier.duration_days,
    });
    return result;
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

  // GET /api/skills/earnings/mine — 创作者收益
  app.get('/earnings/mine', async (request) => {
    await request.requireAuth();
    const earnings = await getCreatorEarnings(request.user.userId);
    return toCreatorEarningsMonthlyDtos(earnings);
  });

  // GET /api/skills/creator/:creatorId/bundle — 获取创作者整包信息
  app.get('/creator/:creatorId/bundle', async (request) => {
    const { creatorId } = request.params as { creatorId: string };
    const config = await getCreatorBundleConfig(creatorId);
    const skills = await listCreatorSharedSkills(creatorId);
    return {
      bundle_tiers: config?.bundle_tiers ?? [],
      skills,
    };
  });

  // PUT /api/skills/creator/bundle/tiers — 创作者设置整包档位
  app.put('/creator/bundle/tiers', async (request, reply) => {
    await request.requireAuth();
    const { bundle_tiers } =
      (request.body as { bundle_tiers?: CreatorBundleTier[] }) || {};
    if (!Array.isArray(bundle_tiers)) {
      return reply.code(400).send({ error: 'bundle_tiers 必须是数组' });
    }
    await promoteUserToCreator(request.user.userId);
    await upsertCreatorBundleConfig(request.user.userId, bundle_tiers);
    return { ok: true };
  });

  // POST /api/skills/creator/:creatorId/bundle/subscribe — 整包订阅
  app.post('/creator/:creatorId/bundle/subscribe', async (request, reply) => {
    await request.requireAuth();
    const { creatorId } = request.params as { creatorId: string };
    const { tier_key } = (request.body as { tier_key?: string }) || {};
    if (!tier_key) return reply.code(400).send({ error: '缺少 tier_key' });

    const config = await getCreatorBundleConfig(creatorId);
    if (!config) return reply.code(404).send({ error: '创作者未设置整包档位' });

    const tier = (config.bundle_tiers as CreatorBundleTier[]).find(
      (t) => t.key === tier_key,
    );
    if (!tier) return reply.code(400).send({ error: '档位不存在' });

    const result = await subscribeToCreatorBundle({
      subscriberId: request.user.userId,
      creatorId,
      tierKey: tier_key,
      priceCents: tier.price_cents,
      durationDays: tier.duration_days,
    });
    return result;
  });

  // POST /api/skills/creator/withdrawal/request — 创作者发起提现申请
  const WithdrawalRequestSchema = z.object({
    amount_cents: z.number().int().positive(),
    bank_name: z.string().max(80).optional(),
    bank_account: z.string().max(40).optional(),
    account_name: z.string().max(80).optional(),
    id_number: z.string().max(40).optional(), // 明文，服务端加密后入库
    tax_type: z.enum(['personal', 'company']).optional(),
    company_name: z.string().max(120).optional(),
    tax_id: z.string().max(40).optional(),
  });
  app.post('/creator/withdrawal/request', async (request, reply) => {
    await request.requireAuth();
    const body = WithdrawalRequestSchema.parse(request.body);
    try {
      const wd = await createWithdrawalRequest({
        creatorId: request.user.userId,
        amountCents: body.amount_cents,
        bankName: body.bank_name ?? null,
        bankAccount: body.bank_account ?? null,
        accountName: body.account_name ?? null,
        idNumber: body.id_number ?? null,
        taxType: body.tax_type ?? null,
        companyName: body.company_name ?? null,
        taxId: body.tax_id ?? null,
      });
      return toWithdrawalRequestResponseDto(wd) as WithdrawalRequestResponseDto;
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : '申请失败' });
    }
  });

  // GET /api/skills/creator/withdrawal/list — 查询本人提现记录
  app.get('/creator/withdrawal/list', async (request) => {
    await request.requireAuth();
    const rows = await listWithdrawalsForCreator(request.user.userId, 50);
    return rows.map((r) => toCreatorWithdrawalDto(r)) as CreatorWithdrawalDto[];
  });

  // GET /api/skills/creator/withdrawal/balance — 查询可提现金额汇总
  app.get('/creator/withdrawal/balance', async (request, reply) => {
    await request.requireAuth();
    const user = await getUserById(request.user.userId);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    return toWithdrawalBalanceDto(user) as WithdrawalBalanceDto;
  });
}
