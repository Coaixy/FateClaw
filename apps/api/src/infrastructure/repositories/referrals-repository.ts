import crypto from 'node:crypto';

import type pg from 'pg';

import { getDbPool } from '../db-pool.js';
import { queryOne } from '../typed-query.js';
import type { DbQueryable } from '../db-pool.js';
import type { UserMembership } from '../../shared/types.js';

const MEMBERSHIP_PLAN_KEY = 'fateclaw_plus';
const DEFAULT_MAX_REDEMPTIONS = 1_000_000;

type ReferralQueryable = DbQueryable | pg.PoolClient;

/** 邀请关系绑定来源。 */
export type ReferralBindSource = 'register' | 'redeem';

/** 邀请会员奖励的处理状态。 */
export type ReferralRewardStatus =
  | 'pending'
  | 'granted'
  | 'skipped'
  | 'ineligible';

/** 邀请返会员全局配置行。 */
export interface ReferralConfigRow {
  id: string;
  enabled: boolean;
  inviter_reward_days: number;
  monthly_reward_cap_days: number;
  reward_first_membership_only: boolean;
  updated_at: string;
}

/** 用户邀请码行；一个邀请者默认持有一个长期邀请码。 */
export interface UserInviteCodeRow {
  id: string;
  inviter_id: string;
  code: string;
  max_redemptions: number;
  redeemed_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 用户邀请关系行；invitee_id 唯一，保证单父级邀请树。 */
export interface UserReferralRow {
  id: string;
  invite_code_id: string;
  inviter_id: string;
  invitee_id: string;
  bind_source: ReferralBindSource;
  reward_status: ReferralRewardStatus;
  reward_days: number;
  reward_event_id: string | null;
  rewarded_at: string | null;
  skip_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** 邀请奖励结算事件行，用于审计发放或跳过原因。 */
export interface ReferralRewardEventRow {
  id: string;
  referral_id: string;
  inviter_id: string;
  invitee_id: string;
  reward_days: number;
  trigger_wallet_transaction_id: string | null;
  status: 'granted' | 'skipped' | 'ineligible';
  reason: string;
  created_at: string;
}

/** 管理后台邀请关系列表行，附带脱敏前的用户手机号。 */
export interface AdminReferralListRow extends UserReferralRow {
  invite_code: string;
  inviter_phone: string | null;
  invitee_phone: string | null;
}

/** 管理后台邀请关系列表分页结果。 */
export interface AdminReferralListResult {
  referrals: AdminReferralListRow[];
  total: number;
}

/** 邀请码公开预览状态。 */
export type ReferralInviteStatus =
  | 'active'
  | 'disabled'
  | 'expired'
  | 'revoked'
  | 'used_up'
  | 'invalid';

/** 邀请码领取结果；重复领取同一关系时 created 为 false。 */
export interface ReferralRedeemResult {
  referral: UserReferralRow;
  created: boolean;
}

/** 邀请码领取阶段可展示给用户的业务错误。 */
export class ReferralRedeemError extends Error {
  constructor(
    public code:
      | 'disabled'
      | 'invalid'
      | 'expired'
      | 'revoked'
      | 'used_up'
      | 'self_invite'
      | 'already_bound'
      | 'cycle',
    message: string,
  ) {
    super(message);
  }
}

function toInt(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function normalizeReferralConfigRow(row: ReferralConfigRow): ReferralConfigRow {
  return {
    ...row,
    inviter_reward_days: toInt(row.inviter_reward_days),
    monthly_reward_cap_days: toInt(row.monthly_reward_cap_days),
  };
}

function normalizeReferralRow(row: UserReferralRow): UserReferralRow {
  return {
    ...row,
    reward_days: toInt(row.reward_days),
  };
}

function normalizeAdminReferralRow(
  row: AdminReferralListRow,
): AdminReferralListRow {
  return {
    ...normalizeReferralRow(row),
    invite_code: row.invite_code,
    inviter_phone: row.inviter_phone ?? null,
    invitee_phone: row.invitee_phone ?? null,
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function monthStartIso(reference = new Date()): string {
  return new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1),
  ).toISOString();
}

function nextMonthStartIso(reference = new Date()): string {
  return new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 1),
  ).toISOString();
}

function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}

function generateInviteCode(): string {
  return crypto.randomBytes(5).toString('base64url').toUpperCase();
}

/**
 * 读取邀请配置；首次访问会补齐默认行。
 */
export async function getReferralConfigUsing(
  queryable: ReferralQueryable,
): Promise<ReferralConfigRow> {
  const row = await queryOne<ReferralConfigRow>(
    queryable,
    `INSERT INTO referral_config (id)
     VALUES ('default')
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
  );
  return normalizeReferralConfigRow(row as ReferralConfigRow);
}

/**
 * 读取邀请配置。
 */
export async function getReferralConfig(): Promise<ReferralConfigRow> {
  return getReferralConfigUsing(getDbPool());
}

/**
 * 更新邀请配置。
 */
export async function updateReferralConfig(input: {
  enabled: boolean;
  inviterRewardDays: number;
  monthlyRewardCapDays: number;
  rewardFirstMembershipOnly: boolean;
}): Promise<ReferralConfigRow> {
  const { rows } = await getDbPool().query(
    `INSERT INTO referral_config (
       id, enabled, inviter_reward_days, monthly_reward_cap_days,
       reward_first_membership_only, updated_at
     )
     VALUES ('default', $1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       inviter_reward_days = EXCLUDED.inviter_reward_days,
       monthly_reward_cap_days = EXCLUDED.monthly_reward_cap_days,
       reward_first_membership_only = EXCLUDED.reward_first_membership_only,
       updated_at = NOW()
     RETURNING *`,
    [
      input.enabled,
      input.inviterRewardDays,
      input.monthlyRewardCapDays,
      input.rewardFirstMembershipOnly,
    ],
  );
  return normalizeReferralConfigRow(rows[0] as ReferralConfigRow);
}

async function getInviteCodeByCodeUsing(
  queryable: ReferralQueryable,
  code: string,
  opts?: { forUpdate?: boolean },
): Promise<UserInviteCodeRow | null> {
  const { rows } = await queryable.query(
    `SELECT *
     FROM user_invite_codes
     WHERE code = $1
     ${opts?.forUpdate ? 'FOR UPDATE' : ''}`,
    [normalizeInviteCode(code)],
  );
  return (rows[0] as UserInviteCodeRow | undefined) ?? null;
}

function resolveInviteStatus(
  config: Pick<ReferralConfigRow, 'enabled'>,
  invite: UserInviteCodeRow | null,
  now = new Date(),
): ReferralInviteStatus {
  if (!config.enabled) return 'disabled';
  if (!invite) return 'invalid';
  if (invite.revoked_at) return 'revoked';
  if (
    invite.expires_at &&
    new Date(invite.expires_at).getTime() <= now.getTime()
  ) {
    return 'expired';
  }
  if (invite.redeemed_count >= invite.max_redemptions) return 'used_up';
  return 'active';
}

/**
 * 预览邀请码状态。
 */
export async function previewReferralInviteCode(
  code: string,
): Promise<{ code: string; status: ReferralInviteStatus }> {
  const config = await getReferralConfig();
  const invite = await getInviteCodeByCodeUsing(getDbPool(), code);
  return {
    code: normalizeInviteCode(code),
    status: resolveInviteStatus(config, invite),
  };
}

/**
 * 读取或创建用户默认邀请码。
 */
export async function ensureUserInviteCode(
  inviterId: string,
): Promise<UserInviteCodeRow> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const existing = await queryOne<UserInviteCodeRow>(
      client,
      `SELECT *
       FROM user_invite_codes
       WHERE inviter_id = $1
       FOR UPDATE`,
      [inviterId],
    );
    if (existing) {
      await client.query('COMMIT');
      return existing;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateInviteCode();
      const { rows } = await client.query(
        `INSERT INTO user_invite_codes (
           id, inviter_id, code, max_redemptions, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (code) DO NOTHING
         RETURNING *`,
        [crypto.randomUUID(), inviterId, code, DEFAULT_MAX_REDEMPTIONS],
      );
      const inserted = rows[0] as UserInviteCodeRow | undefined;
      if (inserted) {
        await client.query('COMMIT');
        return inserted;
      }
    }

    throw new Error('邀请码生成失败，请重试');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getReferralByInviteeUsing(
  queryable: ReferralQueryable,
  inviteeId: string,
  opts?: { forUpdate?: boolean },
): Promise<UserReferralRow | null> {
  const { rows } = await queryable.query(
    `SELECT *
     FROM user_referrals
     WHERE invitee_id = $1
     ${opts?.forUpdate ? 'FOR UPDATE' : ''}`,
    [inviteeId],
  );
  const row = rows[0] as UserReferralRow | undefined;
  return row ? normalizeReferralRow(row) : null;
}

/**
 * 读取用户已经绑定的邀请关系。
 *
 * @param userId 当前登录用户 ID。
 * @returns 用户作为被邀请人时的绑定关系；尚未绑定时返回 null。
 * @remarks 该查询只用于页面展示状态，写入前校验仍由 redeemReferralInviteCodeUsing 在事务内加锁完成。
 */
export async function getBoundReferralForUser(
  userId: string,
): Promise<UserReferralRow | null> {
  return getReferralByInviteeUsing(getDbPool(), userId);
}

async function wouldCreateReferralCycleUsing(
  queryable: ReferralQueryable,
  input: {
    inviterId: string;
    inviteeId: string;
  },
): Promise<boolean> {
  const row = await queryOne<{ found: boolean }>(
    queryable,
    `WITH RECURSIVE descendants AS (
       SELECT invitee_id
       FROM user_referrals
       WHERE inviter_id = $1
       UNION
       SELECT r.invitee_id
       FROM user_referrals r
       JOIN descendants d ON r.inviter_id = d.invitee_id
     )
     SELECT EXISTS (SELECT 1 FROM descendants WHERE invitee_id = $2) AS found`,
    [input.inviteeId, input.inviterId],
  );
  return Boolean(row?.found);
}

async function lockReferralBindParticipantsUsing(
  client: pg.PoolClient,
  input: {
    inviterId: string;
    inviteeId: string;
  },
): Promise<void> {
  const [firstUserId, secondUserId] = [input.inviterId, input.inviteeId].sort();
  // 绑定关系是全局图结构；同一用户参与的并发绑定必须串行化，否则可能绕过递归成环检查。
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('referral:bind:' || $1))`,
    [firstUserId],
  );
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('referral:bind:' || $1))`,
    [secondUserId],
  );
}

/**
 * 领取邀请码并建立单父级邀请关系。
 *
 * @remarks 注册流程会复用该事务函数，避免用户创建成功但邀请绑定失败。
 */
export async function redeemReferralInviteCodeUsing(
  client: pg.PoolClient,
  input: {
    inviteeId: string;
    code: string;
    source: ReferralBindSource;
  },
): Promise<ReferralRedeemResult> {
  const config = await getReferralConfigUsing(client);
  const invite = await getInviteCodeByCodeUsing(client, input.code, {
    forUpdate: true,
  });
  const status = resolveInviteStatus(config, invite);
  if (status !== 'active') {
    throw new ReferralRedeemError(status, referralRedeemErrorMessage(status));
  }
  if (!invite) {
    throw new ReferralRedeemError('invalid', '邀请码无效');
  }
  if (invite.inviter_id === input.inviteeId) {
    throw new ReferralRedeemError('self_invite', '不能绑定自己的邀请码');
  }

  await lockReferralBindParticipantsUsing(client, {
    inviterId: invite.inviter_id,
    inviteeId: input.inviteeId,
  });

  const existing = await getReferralByInviteeUsing(client, input.inviteeId, {
    forUpdate: true,
  });
  if (existing) {
    if (existing.invite_code_id === invite.id) {
      return { referral: existing, created: false };
    }
    throw new ReferralRedeemError('already_bound', '当前账号已绑定过邀请人');
  }

  // 新边 inviter -> invitee 若让 inviter 成为 invitee 的后代，就会形成环。
  if (
    await wouldCreateReferralCycleUsing(client, {
      inviterId: invite.inviter_id,
      inviteeId: input.inviteeId,
    })
  ) {
    throw new ReferralRedeemError('cycle', '不能绑定下级用户的邀请码');
  }

  const { rows } = await client.query(
    `INSERT INTO user_referrals (
       id, invite_code_id, inviter_id, invitee_id, bind_source,
       reward_status, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), NOW())
     RETURNING *`,
    [
      crypto.randomUUID(),
      invite.id,
      invite.inviter_id,
      input.inviteeId,
      input.source,
    ],
  );
  await client.query(
    `UPDATE user_invite_codes
     SET redeemed_count = redeemed_count + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [invite.id],
  );

  return {
    referral: normalizeReferralRow(rows[0] as UserReferralRow),
    created: true,
  };
}

/**
 * 独立事务领取邀请码，用于已注册用户绑定。
 */
export async function redeemReferralInviteCode(input: {
  inviteeId: string;
  code: string;
  source: ReferralBindSource;
}): Promise<ReferralRedeemResult> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const result = await redeemReferralInviteCodeUsing(client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function referralRedeemErrorMessage(
  code: ReferralRedeemError['code'] | ReferralInviteStatus,
): string {
  switch (code) {
    case 'disabled':
      return '邀请功能暂未开放';
    case 'expired':
      return '邀请码已过期';
    case 'revoked':
      return '邀请码已撤销';
    case 'used_up':
      return '邀请码领取名额已满';
    case 'self_invite':
      return '不能绑定自己的邀请码';
    case 'already_bound':
      return '当前账号已绑定过邀请人';
    case 'cycle':
      return '不能绑定下级用户的邀请码';
    case 'invalid':
    default:
      return '邀请码无效';
  }
}

export async function getReferralSummaryForUser(userId: string): Promise<{
  inviteCode: UserInviteCodeRow;
  invitedCount: number;
  rewardedCount: number;
  totalRewardDays: number;
}> {
  const inviteCode = await ensureUserInviteCode(userId);
  const row = await queryOne<{
    invited_count: string | number;
    rewarded_count: string | number;
    total_reward_days: string | number;
  }>(
    getDbPool(),
    `SELECT
       COUNT(*)::int AS invited_count,
       COUNT(*) FILTER (WHERE reward_status = 'granted')::int AS rewarded_count,
       COALESCE(SUM(reward_days) FILTER (WHERE reward_status = 'granted'), 0)::int
         AS total_reward_days
     FROM user_referrals
     WHERE inviter_id = $1`,
    [userId],
  );
  return {
    inviteCode,
    invitedCount: toInt(row?.invited_count),
    rewardedCount: toInt(row?.rewarded_count),
    totalRewardDays: toInt(row?.total_reward_days),
  };
}

async function insertReferralRewardEventUsing(
  client: pg.PoolClient,
  input: {
    referral: UserReferralRow;
    rewardDays: number;
    status: 'granted' | 'skipped' | 'ineligible';
    reason: string;
    triggerWalletTransactionId?: string | null;
  },
): Promise<ReferralRewardEventRow> {
  const { rows } = await client.query(
    `INSERT INTO referral_reward_events (
       id, referral_id, inviter_id, invitee_id, reward_days,
       trigger_wallet_transaction_id, status, reason, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      crypto.randomUUID(),
      input.referral.id,
      input.referral.inviter_id,
      input.referral.invitee_id,
      input.rewardDays,
      input.triggerWalletTransactionId ?? null,
      input.status,
      input.reason,
    ],
  );
  const inserted = rows[0] as ReferralRewardEventRow | undefined;
  if (inserted) return inserted;

  const existing = await queryOne<ReferralRewardEventRow>(
    client,
    `SELECT *
     FROM referral_reward_events
     WHERE referral_id = $1 AND status = 'granted'
     LIMIT 1`,
    [input.referral.id],
  );
  if (!existing) {
    throw new Error('邀请奖励事件写入失败');
  }
  return existing;
}

async function getCurrentMembershipForUserUsing(
  client: pg.PoolClient,
  userId: string,
): Promise<UserMembership | null> {
  const { rows } = await client.query(
    `SELECT *
     FROM user_memberships
     WHERE user_id = $1
     FOR UPDATE`,
    [userId],
  );
  return (rows[0] as UserMembership | undefined) ?? null;
}

async function grantReferralMembershipDaysUsing(
  client: pg.PoolClient,
  input: {
    userId: string;
    rewardDays: number;
  },
): Promise<UserMembership> {
  const now = new Date();
  const current = await getCurrentMembershipForUserUsing(client, input.userId);
  const activeBase =
    current && new Date(current.current_period_end).getTime() > now.getTime()
      ? new Date(current.current_period_end)
      : now;
  const periodEnd = addDays(activeBase, input.rewardDays);
  const periodStart =
    current && new Date(current.current_period_end).getTime() > now.getTime()
      ? current.current_period_start
      : now.toISOString();

  const { rows } = await client.query(
    `INSERT INTO user_memberships (
       user_id, plan_key, status, current_period_start,
       current_period_end, created_at, updated_at
     )
     VALUES ($1, $2, 'active', $3, $4, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       plan_key = EXCLUDED.plan_key,
       status = 'active',
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       updated_at = NOW()
     RETURNING *`,
    [input.userId, MEMBERSHIP_PLAN_KEY, periodStart, periodEnd.toISOString()],
  );
  return rows[0] as UserMembership;
}

async function getMonthlyRewardedDaysUsing(
  client: pg.PoolClient,
  inviterId: string,
): Promise<number> {
  const row = await queryOne<{ total_days: string | number }>(
    client,
    `SELECT COALESCE(SUM(reward_days), 0)::int AS total_days
     FROM referral_reward_events
     WHERE inviter_id = $1
       AND status = 'granted'
       AND created_at >= $2
       AND created_at < $3`,
    [inviterId, monthStartIso(), nextMonthStartIso()],
  );
  return toInt(row?.total_days);
}

/**
 * 在会员购买事务内结算邀请会员天数奖励。
 */
export async function settleReferralMembershipRewardUsing(
  client: pg.PoolClient,
  input: {
    inviteeId: string;
    bonusDeducted: number;
    purchasedDeducted: number;
    priceCoins: number;
    triggerWalletTransactionId?: string | null;
  },
): Promise<ReferralRewardEventRow | null> {
  const referral = await getReferralByInviteeUsing(client, input.inviteeId, {
    forUpdate: true,
  });
  if (!referral) return null;

  const config = await getReferralConfigUsing(client);
  if (!config.enabled) return null;
  if (referral.reward_status === 'granted') return null;
  if (
    config.reward_first_membership_only &&
    referral.reward_status !== 'pending'
  ) {
    return null;
  }

  const markReferral = async (
    status: ReferralRewardStatus,
    rewardDays: number,
    eventId: string,
    reason: string | null,
  ) => {
    await client.query(
      `UPDATE user_referrals
       SET reward_status = $1,
           reward_days = $2,
           reward_event_id = $3,
           rewarded_at = CASE WHEN $1 = 'granted' THEN NOW() ELSE rewarded_at END,
           skip_reason = $4,
           updated_at = NOW()
       WHERE id = $5`,
      [status, rewardDays, eventId, reason, referral.id],
    );
  };

  if (input.bonusDeducted > 0 || input.purchasedDeducted < input.priceCoins) {
    const event = await insertReferralRewardEventUsing(client, {
      referral,
      rewardDays: 0,
      status: 'ineligible',
      reason: 'membership_not_paid_by_purchased_balance_only',
      triggerWalletTransactionId: input.triggerWalletTransactionId,
    });
    await markReferral('ineligible', 0, event.id, event.reason);
    return event;
  }

  const monthlyRewardedDays = await getMonthlyRewardedDaysUsing(
    client,
    referral.inviter_id,
  );
  const remainingMonthlyDays = Math.max(
    0,
    config.monthly_reward_cap_days - monthlyRewardedDays,
  );
  const rewardDays = Math.min(config.inviter_reward_days, remainingMonthlyDays);
  if (rewardDays <= 0) {
    const event = await insertReferralRewardEventUsing(client, {
      referral,
      rewardDays: 0,
      status: 'skipped',
      reason: 'monthly_reward_cap_reached',
      triggerWalletTransactionId: input.triggerWalletTransactionId,
    });
    await markReferral('skipped', 0, event.id, event.reason);
    return event;
  }

  await grantReferralMembershipDaysUsing(client, {
    userId: referral.inviter_id,
    rewardDays,
  });
  const event = await insertReferralRewardEventUsing(client, {
    referral,
    rewardDays,
    status: 'granted',
    reason: 'first_paid_membership',
    triggerWalletTransactionId: input.triggerWalletTransactionId,
  });
  await markReferral('granted', rewardDays, event.id, null);
  return event;
}

export async function listReferralsForAdmin(input: {
  inviterId?: string;
  inviteeId?: string;
  rewardStatus?: ReferralRewardStatus;
  limit?: number;
  offset?: number;
}): Promise<AdminReferralListResult> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.inviterId) {
    params.push(input.inviterId);
    conditions.push(`r.inviter_id = $${params.length}`);
  }
  if (input.inviteeId) {
    params.push(input.inviteeId);
    conditions.push(`r.invitee_id = $${params.length}`);
  }
  if (input.rewardStatus) {
    params.push(input.rewardStatus);
    conditions.push(`r.reward_status = $${params.length}`);
  }
  const whereClause = conditions.length
    ? `WHERE ${conditions.join(' AND ')}`
    : '';
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const countParams = [...params];
  const rowParams = [...params, limit, offset];

  const countRow = await queryOne<{ cnt: string | number }>(
    getDbPool(),
    `SELECT COUNT(*) AS cnt
     FROM user_referrals r
     ${whereClause}`,
    countParams,
  );
  const { rows } = await getDbPool().query(
    `SELECT r.*,
            c.code AS invite_code,
            inviter.phone AS inviter_phone,
            invitee.phone AS invitee_phone
     FROM user_referrals r
     JOIN user_invite_codes c ON c.id = r.invite_code_id
     LEFT JOIN users inviter ON inviter.id = r.inviter_id
     LEFT JOIN users invitee ON invitee.id = r.invitee_id
     ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
    rowParams,
  );
  return {
    referrals: (rows as AdminReferralListRow[]).map(normalizeAdminReferralRow),
    total: toInt(countRow?.cnt),
  };
}
