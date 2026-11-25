import type { MembershipConfig, UserMembership, User } from '#shared/types';
import {
  toCoins,
  deductBalanceCoins,
  normalizeUserCoins,
  insertWalletTransaction,
} from './wallet-repository.js';
import {
  DEFAULT_MEMBERSHIP_NAME,
  type MembershipPlanKey,
  MEMBERSHIP_PLAN_KEY,
} from '@fateclaw/contracts/membership';
import type pg from 'pg';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import { getUserByIdUsing } from './users-repository.js';
import { roundCoinsToCents } from '#shared/balance-coins';
import { resolveMembershipPeriodStart } from '#shared/membership-cycle';

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  const originalDate = next.getUTCDate();
  // 先落到月初再切月，避免月底日期被 JS Date 自动溢出到下下个月。
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(originalDate, lastDayOfTargetMonth));
  return next;
}

function normalizeMembershipConfigRow(row: MembershipConfig): MembershipConfig {
  const monthlyPriceCoins = toCoins(row.monthly_price_coins);
  return {
    ...row,
    name: row.name || DEFAULT_MEMBERSHIP_NAME,
    monthly_price_coins: monthlyPriceCoins,
    display_price_coins: Math.max(
      monthlyPriceCoins,
      toCoins(row.display_price_coins),
    ),
  };
}

export type MembershipConfigRow = MembershipConfig;

export type UserMembershipRow = UserMembership;

export interface MembershipOverviewRow {
  config: MembershipConfigRow;
  membership: UserMembershipRow | null;
  active: boolean;
}

/** Membership periods exposed by the billing API. */
export interface MembershipEntitlementRow {
  plan_key: MembershipPlanKey;
  name: string;
  effective_start: string;
  effective_end: string;
  is_current: boolean;
}

async function getMembershipConfigUsing(
  db: DbQueryable,
): Promise<MembershipConfigRow> {
  // Existing installations retain their configured price, name and sale status.
  const { rows } = await db.query(
    `INSERT INTO membership_config (
       id, name, monthly_price_coins, display_price_coins
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
    [MEMBERSHIP_PLAN_KEY, DEFAULT_MEMBERSHIP_NAME, 10, 10],
  );
  return normalizeMembershipConfigRow(rows[0] as MembershipConfigRow);
}

export async function getMembershipConfig(): Promise<MembershipConfigRow> {
  return getMembershipConfigUsing(getDbPool());
}

export async function getMembershipPlanConfigs(): Promise<
  MembershipConfigRow[]
> {
  const config = await getMembershipConfig();
  return config.enabled ? [config] : [];
}

/**
 * 更新指定会员套餐的可配置字段（价格 / 名称 / 启用状态）。
 *
 * 仅 UPDATE 既有行（不 INSERT），调用前应确保该行已 ensure（getMembershipConfig 会补齐）。
 * 动态拼接 SET，只更新传入字段，未传字段保持原值。
 *
 * @param input.id The membership configuration ID.
 * @param input.monthlyPriceCoins 月费积分，可选。
 * @param input.displayPriceCoins 展示价积分，可选。
 * @param input.name 套餐名称，可选。
 * @param input.enabled 是否启用，可选。
 * @returns 更新后的套餐行；套餐不存在时返回 undefined。
 */
export async function updateMembershipConfig(input: {
  id: MembershipPlanKey;
  monthlyPriceCoins?: number;
  displayPriceCoins?: number;
  name?: string;
  enabled?: boolean;
}): Promise<MembershipConfigRow | undefined> {
  const sets: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let idx = 1;

  if (input.monthlyPriceCoins !== undefined) {
    sets.push(`monthly_price_coins = $${idx++}`);
    values.push(input.monthlyPriceCoins);
  }
  if (input.displayPriceCoins !== undefined) {
    sets.push(`display_price_coins = $${idx++}`);
    values.push(input.displayPriceCoins);
  }
  if (input.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(input.name);
  }
  if (input.enabled !== undefined) {
    sets.push(`enabled = $${idx++}`);
    values.push(input.enabled);
  }

  values.push(input.id);
  const { rows } = await getDbPool().query(
    `UPDATE membership_config
     SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING *`,
    values,
  );
  const row = rows[0] as MembershipConfigRow | undefined;
  return row ? normalizeMembershipConfigRow(row) : undefined;
}

export async function getActiveMembershipForUserUsing(
  client: { query(sql: string, params?: unknown[]): Promise<pg.QueryResult> },
  userId: string,
  opts?: { forUpdate?: boolean },
): Promise<UserMembershipRow | null> {
  const { rows } = await client.query(
    `SELECT *
     FROM user_memberships
     WHERE user_id = $1
       AND status = 'active'
       AND current_period_end > NOW()
     ${opts?.forUpdate ? 'FOR UPDATE' : ''}`,
    [userId],
  );
  return (rows[0] as UserMembershipRow | undefined) ?? null;
}

export async function getMembershipOverview(
  userId: string,
): Promise<MembershipOverviewRow> {
  const membership = await getActiveMembershipForUserUsing(getDbPool(), userId);
  const config = await getMembershipConfig();
  return { config, membership, active: membership !== null };
}

export async function getMembershipOverviewsByUserIds(
  userIds: string[],
): Promise<Map<string, MembershipOverviewRow>> {
  if (userIds.length === 0) return new Map();
  // Disabling new purchases must not hide an existing user's membership.
  const config = await getMembershipConfig();
  const result = new Map<string, MembershipOverviewRow>(
    userIds.map((userId) => [
      userId,
      { config, membership: null, active: false },
    ]),
  );
  const { rows } = await getDbPool().query(
    `SELECT *
     FROM user_memberships
     WHERE user_id = ANY($1::text[])
       AND status = 'active'
       AND current_period_end > NOW()`,
    [userIds],
  );
  for (const membership of rows as UserMembershipRow[]) {
    result.set(membership.user_id, { config, membership, active: true });
  }
  return result;
}

export async function getMembershipEntitlements(
  userId: string,
): Promise<MembershipEntitlementRow[]> {
  const membership = await getActiveMembershipForUserUsing(getDbPool(), userId);
  if (!membership) return [];
  const config = await getMembershipConfig();
  return [
    {
      plan_key: membership.plan_key,
      name: config.name,
      effective_start: new Date(membership.current_period_start).toISOString(),
      effective_end: new Date(membership.current_period_end).toISOString(),
      is_current:
        new Date(membership.current_period_start).getTime() <= Date.now(),
    },
  ];
}

/** 会员订阅 DB 层幂等去抖窗口：与 billing-service 的 Redis 去抖同量级，作为 Redis 失效时的兜底。 */
const MEMBERSHIP_SUBSCRIBE_IDEMPOTENCY_WINDOW_MS = 10_000;

/**
 * 会员订阅在 DB 幂等去抖窗口内被判定为重复提交时抛出。
 *
 * @remarks 上层（billing-service）据此返回 409「请勿重复提交」，语义与 Redis 去抖一致；
 *   且不应据此删除 Redis 去抖锁——这是正常的重复拦截，不是开通失败。
 */
export class MembershipSubscribeDebounceError extends Error {
  constructor() {
    super('订阅处理中，请勿重复提交');
    this.name = 'MembershipSubscribeDebounceError';
  }
}

/**
 * 使用积分余额开通或续费一个月指定 FateClaw 会员套餐。
 */
export async function subscribeMembershipWithWallet(
  userId: string,
  planKey: MembershipPlanKey = MEMBERSHIP_PLAN_KEY,
): Promise<{ user: User; overview: MembershipOverviewRow }> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const config = await getMembershipConfigUsing(client);
    if (!config.enabled) {
      throw new Error('会员暂未开放');
    }
    const user = await getUserByIdUsing(client, userId, { forUpdate: true });
    if (!user) {
      throw new Error('用户不存在');
    }

    // DB 层幂等去抖：user 行 FOR UPDATE 锁已串行化同一用户的并发订阅，但串行后第二个事务
    // 仍会重复扣费。这里在锁内检查「距上次会员订阅是否在去抖窗口内」，命中即判定为连点/重试/
    // Redis 去抖失效导致的重复提交，抛错交上层拦截，杜绝 Redis 不可用时的重复扣费与周期叠加。
    // 全程用数据库时钟：created_at 由 NOW() 写入，若改用应用侧 Date.now() 比较，应用机与 DB 机的
    // 时钟偏移会让窗口失真（偏快则去抖永不命中、偏慢则误拦正常续费）。WHERE 直接带窗口条件，命中
    // (kind, created_at DESC) 索引后在窗口边界即终止，不做「取最近一条再回表」的全量倒序扫描。
    const { rows: dupRows } = await client.query<{ duplicate: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM wallet_transactions
         WHERE user_id = $1 AND kind = 'membership_subscription'
           AND created_at > NOW() - ($2::int * interval '1 millisecond')
       ) AS duplicate`,
      [userId, MEMBERSHIP_SUBSCRIBE_IDEMPOTENCY_WINDOW_MS],
    );
    if (dupRows[0]?.duplicate) {
      throw new MembershipSubscribeDebounceError();
    }

    const priceCoins = roundCoinsToCents(config.monthly_price_coins);
    const deduction = await deductBalanceCoins(
      client,
      normalizeUserCoins(user),
      priceCoins,
    );
    const updatedUser = await getUserByIdUsing(client, userId, {
      forUpdate: true,
    });
    if (!updatedUser) {
      throw new Error('用户不存在');
    }

    const currentMembership = await getActiveMembershipForUserUsing(
      client,
      userId,
      { forUpdate: true },
    );
    const now = new Date();
    const membershipActive = Boolean(
      currentMembership &&
      new Date(currentMembership.current_period_end).getTime() > now.getTime(),
    );
    // Renewals preserve the original period anchor and extend the existing end date.
    const periodStart =
      membershipActive && currentMembership
        ? resolveMembershipPeriodStart(currentMembership, now)
        : now;
    const periodEnd = addMonths(
      membershipActive && currentMembership
        ? new Date(currentMembership.current_period_end)
        : now,
      1,
    );
    const { rows: membershipRows } = await client.query(
      `INSERT INTO user_memberships (
         user_id, plan_key, status, current_period_start,
         current_period_end, created_at, updated_at
       )
       VALUES ($1, $2, 'active', $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, plan_key) DO UPDATE SET
         status = 'active',
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = NOW()
       RETURNING *`,
      [userId, planKey, periodStart.toISOString(), periodEnd.toISOString()],
    );
    const membership = membershipRows[0] as UserMembershipRow;

    // membership_subscription 是历史钱包流水 kind，代表会员购买/续费流水，不是 Skill subscription。
    await insertWalletTransaction(client, {
      userId,
      kind: 'membership_subscription',
      amountCoins: -priceCoins,
      balanceSource: deduction.balanceSource,
      note: `${config.name} 会员月费`,
      metadata: {
        planKey,
        periodStart: membership.current_period_start,
        periodEnd: membership.current_period_end,
        bonusDeducted: deduction.bonusDeducted,
        purchasedDeducted: deduction.purchasedDeducted,
      },
    });

    await client.query('COMMIT');
    return {
      user: normalizeUserCoins(updatedUser),
      overview: {
        config,
        membership,
        active: true,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 管理员直接设置用户会员有效期，不扣减用户积分余额。
 *
 * @param input.userId 目标用户 ID。
 * @param input.planKey The membership identity validated by the HTTP boundary.
 * @param input.currentPeriodEnd 会员有效期结束时间，必须晚于当前时间。
 * @returns 写入后的会员周期记录。
 * @remarks 仅供管理后台人工处理补偿、续期或纠错；正常购买仍应使用钱包订阅流程。
 */
export async function setUserMembershipForAdmin(input: {
  userId: string;
  planKey: MembershipPlanKey;
  currentPeriodEnd: string;
}): Promise<UserMembershipRow> {
  const periodEnd = new Date(input.currentPeriodEnd);
  if (!Number.isFinite(periodEnd.getTime())) {
    throw new Error('会员有效期格式不正确');
  }
  if (periodEnd.getTime() <= Date.now()) {
    throw new Error('会员有效期必须晚于当前时间');
  }

  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const config = await getMembershipConfigUsing(client);
    if (!config.enabled) {
      throw new Error('会员套餐未启用');
    }

    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const now = new Date();
    const { rows: existingRows } = await client.query(
      `SELECT *
       FROM user_memberships
       WHERE user_id = $1 AND plan_key = $2
       FOR UPDATE`,
      [input.userId, input.planKey],
    );
    const existing = existingRows[0] as UserMembershipRow | undefined;
    const existingEnd = existing
      ? new Date(existing.current_period_end).getTime()
      : 0;
    // 同套餐续期保留原周期锚点，避免重置当前会员周期。
    const periodStart =
      existing?.status === 'active' && existingEnd > now.getTime()
        ? existing.current_period_start
        : now.toISOString();

    const { rows: membershipRows } = await client.query(
      `INSERT INTO user_memberships (
         user_id, plan_key, status, current_period_start,
         current_period_end, created_at, updated_at
       )
       VALUES ($1, $2, 'active', $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, plan_key) DO UPDATE SET
         status = 'active',
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = NOW()
       RETURNING *`,
      [input.userId, input.planKey, periodStart, periodEnd.toISOString()],
    );
    const membership = membershipRows[0] as UserMembershipRow;
    await client.query('COMMIT');
    return membership;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 管理员立即停用用户当前和未来的会员权益。
 *
 * @param userId 目标用户 ID。
 * @returns 被停用的会员记录数量。
 * @remarks 不删除历史额度流水，只将有效会员周期标记为 cancelled 以保留审计线索。
 */
export async function cancelUserMembershipsForAdmin(
  userId: string,
): Promise<{ cancelledCount: number }> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, userId, { forUpdate: true });
    if (!user) {
      throw new Error('用户不存在');
    }
    const result = await client.query(
      `UPDATE user_memberships
       SET status = 'cancelled',
           current_period_end = CASE
             WHEN current_period_start < NOW() THEN LEAST(current_period_end, NOW())
             ELSE current_period_start + INTERVAL '1 millisecond'
           END,
           updated_at = NOW()
       WHERE user_id = $1
         AND status = 'active'
         AND current_period_end > NOW()`,
      [userId],
    );
    await client.query('COMMIT');
    return { cancelledCount: result.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
