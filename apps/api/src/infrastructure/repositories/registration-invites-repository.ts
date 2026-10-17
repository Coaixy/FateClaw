import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  CompletedRechargeRefundDto,
  CompletedRechargeRefundRequestDto,
  CreatedRegistrationInviteDto,
  RegistrationInviteAccountUpdateDto,
  RegistrationInviteDto,
  RegistrationInvitePolicyDto,
  RegistrationInvitePolicyUpdateDto,
  RegistrationInvitePreviewDto,
  RegistrationInviteSummaryDto,
} from '@fateclaw/contracts/auth';
import { RegistrationInviteError } from '../../modules/user/registration-invite-errors.js';
import type { User } from '../../shared/types.js';
import { getDbPool, type DbQueryable } from '../db-pool.js';
import { queryOne, queryRows } from '../typed-query.js';
import { createUserUsing } from './users-repository.js';

interface PolicyRow {
  tiers: Array<{ threshold_cents: number; total_slots: number }>;
  expires_in_days: number;
  revision: number;
}
interface AccountRow extends PolicyRow {
  base_slots: number;
  extra_slots: number;
  suspended: boolean;
  account_revision: number;
  net_cents: string;
  used_slots: number;
  reserved_slots: number;
}
interface InviteRow {
  id: string;
  code_suffix: string;
  source: 'user' | 'admin';
  inviter_user_id: string | null;
  status: 'active' | 'used' | 'revoked';
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  unexpired: boolean;
  owner_eligible?: boolean;
}
interface RefundRow {
  id: string;
  trade_id: string;
  amount_cents: string;
  reference: string;
  reason: string;
  created_at: Date;
}

const INVALID_INVITE = '邀请码无效、已使用、已过期或暂不可用';
const INVITE_COLUMNS = 'i.*, i.expires_at > clock_timestamp() AS unexpired';

function toPolicy(row: PolicyRow): RegistrationInvitePolicyDto {
  return {
    tiers: row.tiers.map((tier) => ({
      threshold_yuan: tier.threshold_cents / 100,
      total_slots: tier.total_slots,
    })),
    expires_in_days: row.expires_in_days,
    revision: row.revision,
  };
}
function eligible(row: AccountRow): boolean {
  return !row.suspended && row.base_slots > 0;
}
function capacity(row: AccountRow): number {
  return Math.max(0, Math.min(1000, row.base_slots + row.extra_slots));
}
function toInvite(row: InviteRow, ownerEligible = true): RegistrationInviteDto {
  const status =
    row.status !== 'active'
      ? row.status
      : !row.unexpired
        ? 'expired'
        : !ownerEligible
          ? 'suspended'
          : 'active';
  return {
    id: row.id,
    code_suffix: row.code_suffix,
    source: row.source,
    status,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    used_at: row.used_at?.toISOString() ?? null,
  };
}
function toRefund(row: RefundRow): CompletedRechargeRefundDto {
  return {
    id: row.id,
    trade_id: row.trade_id,
    amount_yuan: Number(row.amount_cents) / 100,
    reference: row.reference,
    reason: row.reason,
    created_at: row.created_at.toISOString(),
  };
}

async function transaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lockAccount(client: PoolClient, userId: string): Promise<void> {
  const user = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',
    [userId],
  );
  if (!user) throw new RegistrationInviteError(404, '用户不存在');
  await client.query('SELECT reconcile_registration_invites($1)', [userId]);
}
async function accountRow(
  db: DbQueryable,
  userId: string,
): Promise<AccountRow> {
  const row = await queryOne<AccountRow>(
    db,
    `
    SELECT p.*, a.base_slots, a.extra_slots, a.suspended, a.revision AS account_revision,
      registration_net_recharge_cents(a.user_id)::text AS net_cents,
      (SELECT count(*)::int FROM registration_invites i
       WHERE i.inviter_user_id=a.user_id AND i.status='used') AS used_slots,
      (SELECT count(*)::int FROM registration_invites i
       WHERE i.inviter_user_id=a.user_id AND i.status='active'
         AND i.expires_at > clock_timestamp()) AS reserved_slots
    FROM registration_invite_accounts a CROSS JOIN registration_invite_policy p
    WHERE a.user_id=$1`,
    [userId],
  );
  if (!row) throw new RegistrationInviteError(404, '用户不存在');
  return row;
}
async function summaryUsing(
  client: PoolClient,
  userId: string,
): Promise<RegistrationInviteSummaryDto> {
  const row = await accountRow(client, userId);
  const isEligible = eligible(row);
  const total = Math.max(row.used_slots, capacity(row));
  const invites = await queryRows<InviteRow>(
    client,
    `SELECT ${INVITE_COLUMNS}
    FROM registration_invites i WHERE i.inviter_user_id=$1
    ORDER BY i.created_at DESC, i.id LIMIT 100`,
    [userId],
  );
  return {
    user_id: userId,
    policy: toPolicy(row),
    net_recharge_yuan: Number(row.net_cents) / 100,
    eligible: isEligible,
    eligibility_reason: row.suspended
      ? 'suspended'
      : isEligible
        ? 'eligible'
        : 'below_threshold',
    total_slots: total,
    automatic_slots: row.base_slots,
    manual_slot_adjustment: row.extra_slots,
    used_slots: row.used_slots,
    reserved_slots: row.reserved_slots,
    available_slots: isEligible
      ? Math.max(0, total - row.used_slots - row.reserved_slots)
      : 0,
    suspended: row.suspended,
    revision: row.account_revision,
    invitations: invites.map((invite) => toInvite(invite, isEligible)),
  };
}

export async function getRegistrationInviteSummary(
  userId: string,
): Promise<RegistrationInviteSummaryDto> {
  return transaction(async (client) => {
    await lockAccount(client, userId);
    return summaryUsing(client, userId);
  });
}
export async function getRegistrationInvitePolicy(): Promise<RegistrationInvitePolicyDto> {
  const row = await queryOne<PolicyRow>(
    getDbPool(),
    'SELECT * FROM registration_invite_policy',
  );
  if (!row) throw new Error('Registration invitation policy is missing');
  return toPolicy(row);
}
export async function saveRegistrationInvitePolicy(
  input: RegistrationInvitePolicyUpdateDto,
): Promise<RegistrationInvitePolicyDto> {
  const row = await queryOne<PolicyRow>(
    getDbPool(),
    `UPDATE registration_invite_policy
    SET tiers=$1::jsonb, expires_in_days=$2, revision=revision+1
    WHERE revision=$3 RETURNING *`,
    [
      JSON.stringify(
        input.tiers.map((tier) => ({
          threshold_cents: Math.round(tier.threshold_yuan * 100),
          total_slots: tier.total_slots,
        })),
      ),
      input.expires_in_days,
      input.expected_revision,
    ],
  );
  if (!row)
    throw new RegistrationInviteError(409, '邀请规则已更新，请刷新后重试');
  return toPolicy(row);
}
export async function updateRegistrationInviteAccount(
  userId: string,
  input: RegistrationInviteAccountUpdateDto,
): Promise<RegistrationInviteSummaryDto> {
  return transaction(async (client) => {
    await lockAccount(client, userId);
    const row = await accountRow(client, userId);
    if (row.account_revision !== input.expected_revision)
      throw new RegistrationInviteError(409, '邀请名额已更新，请刷新后重试');
    if (input.total_slots < row.used_slots + row.reserved_slots)
      throw new RegistrationInviteError(
        409,
        '总名额不能少于已使用和已占用名额，请先撤销未使用的邀请码',
      );
    // Historical usage can hold the displayed total above current tier capacity.
    const adjustment =
      input.total_slots === Math.max(row.used_slots, capacity(row))
        ? row.extra_slots
        : input.total_slots - row.base_slots;
    await client.query(
      `UPDATE registration_invite_accounts SET extra_slots=$2,
      suspended=$3, revision=revision+1 WHERE user_id=$1`,
      [userId, adjustment, input.suspended],
    );
    return summaryUsing(client, userId);
  });
}

function hashCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(code))
    throw new RegistrationInviteError(400, INVALID_INVITE);
  return createHash('sha256').update(code).digest('hex');
}

async function validInviteUsing(
  client: PoolClient,
  rawCode: string,
): Promise<InviteRow> {
  const hash = hashCode(rawCode);
  const found = await queryOne<InviteRow>(
    client,
    `SELECT ${INVITE_COLUMNS} FROM registration_invites i WHERE code_hash=$1`,
    [hash],
  );
  if (!found) throw new RegistrationInviteError(400, INVALID_INVITE);
  // Owner first, then code, matching issuance and administrative revocation.
  if (found.inviter_user_id) {
    await lockAccount(client, found.inviter_user_id);
    if (!eligible(await accountRow(client, found.inviter_user_id)))
      throw new RegistrationInviteError(400, INVALID_INVITE);
  }
  const row = await queryOne<InviteRow>(
    client,
    `SELECT ${INVITE_COLUMNS} FROM registration_invites i WHERE id=$1 FOR UPDATE`,
    [found.id],
  );
  if (!row || row.status !== 'active' || !row.unexpired)
    throw new RegistrationInviteError(400, INVALID_INVITE);
  return row;
}

export async function assertRegistrationInviteValid(
  code: string,
): Promise<RegistrationInvitePreviewDto> {
  return transaction(async (client) => {
    const invite = await validInviteUsing(client, code);
    return { valid: true, expires_at: invite.expires_at.toISOString() };
  });
}

export async function createInvitedUser(
  user: User,
  code: string,
): Promise<void> {
  try {
    await transaction(async (client) => {
      const invite = await validInviteUsing(client, code);
      await createUserUsing(client, user);
      await client.query(
        `UPDATE registration_invites SET status='used', used_by_user_id=$2,
        used_at=clock_timestamp() WHERE id=$1`,
        [invite.id, user.id],
      );
    });
  } catch (error) {
    const conflict = error as { code?: unknown; constraint?: unknown } | null;
    if (
      conflict?.code === '23505' &&
      conflict.constraint === 'idx_users_phone_unique'
    )
      throw new RegistrationInviteError(400, '该手机号已被注册');
    throw error;
  }
}

export async function createRegistrationInvite(
  userId: string | null,
  requestKey: string,
): Promise<CreatedRegistrationInviteDto> {
  return transaction(async (client) => {
    if (userId) await lockAccount(client, userId);
    // Operational codes have no owner row; the request key supplies their retry boundary.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`registration-invite:${requestKey}`],
    );
    const existing = await queryOne<InviteRow>(
      client,
      `SELECT ${INVITE_COLUMNS} FROM registration_invites i WHERE id=$1`,
      [requestKey],
    );
    if (existing) {
      if (existing.inviter_user_id !== userId)
        throw new RegistrationInviteError(409, '邀请请求已被使用，请重新生成');
      const ownerEligible = userId
        ? eligible(await accountRow(client, userId))
        : true;
      return { invite: toInvite(existing, ownerEligible), code: null };
    }
    if (userId) {
      const account = await accountRow(client, userId);
      if (!eligible(account))
        throw new RegistrationInviteError(403, '当前账号暂未获得邀请资格');
      if (capacity(account) <= account.used_slots + account.reserved_slots)
        throw new RegistrationInviteError(
          409,
          '邀请名额已用完，请等待邀请码过期或撤销未使用的邀请码',
        );
    }
    const code = randomBytes(12).toString('hex').toUpperCase();
    const invite = await queryOne<InviteRow>(
      client,
      `
      INSERT INTO registration_invites(id, code_hash, code_suffix, source, inviter_user_id, expires_at)
      SELECT $1,$2,$3,$4,$5,clock_timestamp()+make_interval(days=>expires_in_days)
      FROM registration_invite_policy
      RETURNING *, expires_at > clock_timestamp() AS unexpired`,
      [
        requestKey,
        hashCode(code),
        code.slice(-4),
        userId ? 'user' : 'admin',
        userId,
      ],
    );
    if (!invite) throw new Error('Registration invitation creation failed');
    return { invite: toInvite(invite), code };
  });
}

export async function revokeRegistrationInvite(
  id: string,
  ownerId?: string,
): Promise<void> {
  await transaction(async (client) => {
    const found = await queryOne<InviteRow>(
      client,
      `SELECT ${INVITE_COLUMNS} FROM registration_invites i WHERE id=$1`,
      [id],
    );
    if (!found || (ownerId && found.inviter_user_id !== ownerId))
      throw new RegistrationInviteError(404, '邀请码不存在');
    if (found.inviter_user_id) await lockAccount(client, found.inviter_user_id);
    const row = await queryOne<InviteRow>(
      client,
      `SELECT ${INVITE_COLUMNS} FROM registration_invites i WHERE id=$1 FOR UPDATE`,
      [id],
    );
    if (!row) throw new RegistrationInviteError(404, '邀请码不存在');
    if (row.status === 'used')
      throw new RegistrationInviteError(409, '邀请码已被使用，无法撤销');
    await client.query(
      "UPDATE registration_invites SET status='revoked' WHERE id=$1",
      [id],
    );
  });
}

export async function listRegistrationInvites(
  userId?: string,
): Promise<RegistrationInviteDto[]> {
  const rows = await queryRows<InviteRow>(
    getDbPool(),
    `SELECT ${INVITE_COLUMNS},
    (i.inviter_user_id IS NULL OR (NOT a.suspended AND
      registration_invite_tier_slots(registration_net_recharge_cents(i.inviter_user_id))>0)) AS owner_eligible
    FROM registration_invites i LEFT JOIN registration_invite_accounts a ON a.user_id=i.inviter_user_id
    WHERE ($1::text IS NULL OR i.inviter_user_id=$1)
    ORDER BY i.created_at DESC,i.id LIMIT 100`,
    [userId ?? null],
  );
  return rows.map((row) => toInvite(row, row.owner_eligible ?? false));
}

export async function listCompletedRechargeRefunds(
  userId?: string,
): Promise<CompletedRechargeRefundDto[]> {
  const rows = await queryRows<RefundRow>(
    getDbPool(),
    `SELECT r.*,o.trade_id
    FROM completed_recharge_refunds r JOIN recharge_orders o ON o.id=r.recharge_order_id
    WHERE ($1::text IS NULL OR o.user_id=$1) ORDER BY r.created_at DESC,r.id LIMIT 100`,
    [userId ?? null],
  );
  return rows.map(toRefund);
}

export async function recordCompletedRechargeRefund(
  input: CompletedRechargeRefundRequestDto,
): Promise<CompletedRechargeRefundDto> {
  const amountCents = Math.round(input.amount_yuan * 100);
  return transaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`registration-refund:${input.reference}`],
    );
    const previous = await queryOne<RefundRow>(
      client,
      `SELECT r.*,o.trade_id FROM completed_recharge_refunds r
      JOIN recharge_orders o ON o.id=r.recharge_order_id WHERE r.reference=$1`,
      [input.reference],
    );
    if (previous) {
      if (
        previous.trade_id !== input.trade_id ||
        BigInt(previous.amount_cents) !== BigInt(amountCents) ||
        previous.reason !== input.reason
      )
        throw new RegistrationInviteError(
          409,
          '退款凭据已登记，不能用相同凭据登记不同内容',
        );
      return toRefund(previous);
    }
    const order = await queryOne<{
      id: string;
      user_id: string;
      status: string;
      paid_cents: string;
    }>(
      client,
      'SELECT id,user_id,status,(amount_coins*100)::bigint::text AS paid_cents FROM recharge_orders WHERE trade_id=$1 FOR UPDATE',
      [input.trade_id],
    );
    if (!order || order.status !== 'paid')
      throw new RegistrationInviteError(400, '只能登记已支付订单的已完成退款');
    await lockAccount(client, order.user_id);
    const refunded = await queryOne<{ cents: string }>(
      client,
      'SELECT COALESCE(sum(amount_cents),0)::text AS cents FROM completed_recharge_refunds WHERE recharge_order_id=$1',
      [order.id],
    );
    if (
      BigInt(amountCents) + BigInt(refunded?.cents ?? '0') >
      BigInt(order.paid_cents)
    )
      throw new RegistrationInviteError(409, '累计退款不能超过该订单实付金额');
    const row = await queryOne<RefundRow>(
      client,
      `INSERT INTO completed_recharge_refunds
      (id,recharge_order_id,amount_cents,reference,reason) VALUES($1,$2,$3,$4,$5)
      RETURNING *, $6::text AS trade_id`,
      [
        randomUUID(),
        order.id,
        amountCents,
        input.reference,
        input.reason,
        input.trade_id,
      ],
    );
    if (!row) throw new Error('Completed recharge refund recording failed');
    await client.query('SELECT reconcile_registration_invites($1)', [
      order.user_id,
    ]);
    return toRefund(row);
  });
}
