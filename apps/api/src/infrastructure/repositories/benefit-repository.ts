import type {
  BenefitPolicyDto,
  BenefitSupplyState,
  ModelPoolKey,
} from '@fateclaw/contracts/model-settings';
import { getDbPool, type DbQueryable } from '../db-pool.js';
import { getActiveMembershipForUserUsing } from './billing-repository.js';

export class BenefitAdmissionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 403 | 429 = 429,
  ) {
    super(message);
  }
}
export class ModelSelectionError extends Error {
  readonly statusCode = 409;
}

export async function getPreferredModelPool(
  userId: string,
): Promise<ModelPoolKey> {
  const { rows } = await getDbPool().query<{ pool_key: ModelPoolKey }>(
    `SELECT COALESCE((SELECT pool_key FROM user_model_preferences WHERE user_id=$1),
      CASE WHEN EXISTS(SELECT 1 FROM official_model_pool_settings WHERE id='benefit' AND enabled)
      THEN 'benefit' ELSE 'official' END) AS pool_key`,
    [userId],
  );
  return rows[0].pool_key;
}

export async function saveModelPoolPreference(
  userId: string,
  poolKey: ModelPoolKey,
  sessionId?: string,
): Promise<void> {
  const db = await getDbPool().connect();
  try {
    await db.query('BEGIN');
    if (sessionId) {
      await db.query(
        'SELECT id FROM chat_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [sessionId, userId],
      );
      const active = await db.query(
        "SELECT 1 FROM agent_requests WHERE session_id=$1 AND state IN ('queued','dispatched','running') LIMIT 1",
        [sessionId],
      );
      if (active.rowCount)
        throw new ModelSelectionError('请等待当前回复结束后再切换模型');
      const result = await db.query(
        `UPDATE chat_sessions SET model_pool_key=$3
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING id`,
        [sessionId, userId, poolKey],
      );
      if (!result.rowCount) throw new Error('会话不存在或无权访问');
    }
    await db.query(
      `INSERT INTO user_model_preferences(user_id,pool_key) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET pool_key=EXCLUDED.pool_key,updated_at=now()`,
      [userId, poolKey],
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function getBenefitAllowance(
  userId: string | undefined,
  dailyTurns: number,
) {
  const { rows } = await getDbPool().query<{
    remaining: number;
    resets_at: Date;
  }>(
    `SELECT COALESCE((SELECT GREATEST(0,$2-consumed_turns-reserved_turns) FROM benefit_daily_usage
       WHERE user_id=$1 AND allowance_date=(now() AT TIME ZONE 'Asia/Shanghai')::date),$2) AS remaining,
       ((now() AT TIME ZONE 'Asia/Shanghai')::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai' AS resets_at`,
    [userId ?? null, dailyTurns],
  );
  return {
    remaining_turns: userId ? rows[0].remaining : null,
    resets_at: rows[0].resets_at.toISOString(),
  };
}

export async function getBenefitSupply(): Promise<BenefitSupplyState> {
  const { rows } = await getDbPool().query<{
    enabled: boolean;
    configured: number;
    exhausted: number;
    ready: number;
  }>(
    `SELECT pool.enabled,
      count(node.model_config_id) FILTER(WHERE model.enabled AND secret.configured)::integer AS configured,
      count(node.model_config_id) FILTER(WHERE model.enabled AND secret.configured
        AND node.cooldown_until>now() AND node.cooldown_reason='quota')::integer AS exhausted,
      count(node.model_config_id) FILTER(WHERE model.enabled AND secret.configured
        AND (node.cooldown_until IS NULL OR (node.cooldown_until<=now()
          AND (node.probe_until IS NULL OR node.probe_until<=now()))))::integer AS ready
      FROM official_model_pool_settings pool LEFT JOIN official_model_pool_nodes node ON node.pool_id=pool.id
      LEFT JOIN official_model_configs model ON model.id=node.model_config_id
      LEFT JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM system_secrets
        WHERE key=model.api_key_secret_key AND secret_value<>'') AS configured) secret ON true
      WHERE pool.id='benefit' GROUP BY pool.id`,
  );
  const row = rows[0];
  if (!row?.enabled) return 'disabled';
  if (!row.configured) return 'unknown';
  if (row.exhausted === row.configured) return 'exhausted';
  return row.ready ? 'available' : 'busy';
}

export async function getRecentBenefitSuccess(): Promise<string | null> {
  const { rows } = await getDbPool().query<{
    completed_at: Date;
  }>(`SELECT attempt.completed_at FROM benefit_model_attempts attempt
    JOIN official_model_pool_nodes node ON node.model_config_id=attempt.node_id AND node.pool_id='benefit'
    JOIN official_model_pool_settings pool ON pool.id=node.pool_id AND pool.enabled
    WHERE attempt.outcome='success' AND NOT attempt.is_probe AND attempt.created_at>=pool.updated_at
      AND attempt.completed_at>now()-interval '12 hours' ORDER BY attempt.completed_at DESC LIMIT 1`);
  return rows[0]?.completed_at.toISOString() ?? null;
}

/** Called only inside the durable request admission transaction. */
export async function reserveBenefitTurn(
  db: DbQueryable,
  userId: string,
  requestId: string,
  policy: BenefitPolicyDto,
  deadlineAt: number,
  revision?: number,
): Promise<void> {
  const settings = await db.query(
    `SELECT enabled,revision FROM official_model_pool_settings WHERE id='benefit' FOR UPDATE`,
  );
  if (!settings.rows[0]?.enabled)
    throw new BenefitAdmissionError('免费服务暂未开放');
  if (revision !== undefined && revision !== settings.rows[0].revision)
    throw new ModelSelectionError('免费模型配置已更新，请刷新模型状态后重试');
  // Gate admission only: an accepted request keeps its allowance after membership expires.
  if (!(await getActiveMembershipForUserUsing(db, userId)))
    throw new BenefitAdmissionError(
      '免费模型仅限有效会员使用，请开通或续费会员',
      403,
    );
  await db.query(
    `INSERT INTO benefit_daily_usage(user_id,allowance_date) VALUES($1,(now() AT TIME ZONE 'Asia/Shanghai')::date)
    ON CONFLICT DO NOTHING`,
    [userId],
  );
  const { rows } = await db.query<{
    allowance_date: string;
    consumed_turns: number;
    reserved_turns: number;
  }>(
    `SELECT * FROM benefit_daily_usage WHERE user_id=$1 AND allowance_date=(now() AT TIME ZONE 'Asia/Shanghai')::date FOR UPDATE`,
    [userId],
  );
  const day = rows[0];
  if (day.consumed_turns + day.reserved_turns >= policy.daily_turns)
    throw new BenefitAdmissionError('今日免费额度已用完，明日 00:00 恢复');
  const active = await db.query(
    `SELECT user_id FROM benefit_requests WHERE state IN ('reserved','running')`,
  );
  if (active.rows.some((row) => row.user_id === userId))
    throw new BenefitAdmissionError('已有免费请求正在处理，请等待完成');
  await db.query(
    `UPDATE benefit_daily_usage SET reserved_turns=reserved_turns+1 WHERE user_id=$1 AND allowance_date=$2`,
    [userId, day.allowance_date],
  );
  await db.query(
    `INSERT INTO benefit_requests(request_id,user_id,allowance_date,policy,queue_deadline_at)
    VALUES($1,$2,$3,$4,$5)`,
    [
      requestId,
      userId,
      day.allowance_date,
      JSON.stringify(policy),
      new Date(deadlineAt),
    ],
  );
}

export async function tryAcquireBenefitExecutionSlot(
  requestId: string,
): Promise<boolean> {
  const db = await getDbPool().connect();
  try {
    await db.query('BEGIN');
    await db.query(
      "SELECT id FROM official_model_pool_settings WHERE id='benefit' FOR UPDATE",
    );
    const { rows } = await db.query(
      `SELECT * FROM benefit_requests WHERE request_id=$1 AND state='reserved' FOR UPDATE`,
      [requestId],
    );
    const request = rows[0];
    if (!request || new Date(request.queue_deadline_at).getTime() <= Date.now())
      throw new BenefitAdmissionError('免费服务排队超时，本次未扣免费次数');
    if (request.slot_claimed_at) {
      await db.query('COMMIT');
      return true;
    }
    const active = await db.query(
      `SELECT count(*)::integer AS count FROM benefit_requests WHERE state IN ('reserved','running') AND slot_claimed_at IS NOT NULL`,
    );
    const head = await db.query(
      `SELECT request_id FROM benefit_requests WHERE state='reserved' AND slot_claimed_at IS NULL AND queue_deadline_at>now() ORDER BY created_at,request_id LIMIT 1`,
    );
    const acquired =
      active.rows[0].count < request.policy.concurrency_limit &&
      head.rows[0]?.request_id === requestId;
    if (acquired)
      await db.query(
        'UPDATE benefit_requests SET slot_claimed_at=now() WHERE request_id=$1',
        [requestId],
      );
    await db.query('COMMIT');
    return acquired;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

/** Reply persistence and the allowance transition share the caller's transaction. */
export async function settleBenefitTurn(
  db: DbQueryable,
  requestId: string,
  success: boolean,
  cancelled = false,
): Promise<'consumed' | 'released' | null> {
  const { rows } = await db.query(
    `SELECT * FROM benefit_requests WHERE request_id=$1 FOR UPDATE`,
    [requestId],
  );
  const request = rows[0];
  if (!request) return null;
  if (request.state === 'consumed' || request.state === 'released')
    return request.state;
  const cancellation = await db.query<{ cancelled: boolean }>(
    'SELECT cancel_requested_at IS NOT NULL AS cancelled FROM agent_requests WHERE request_id=$1',
    [requestId],
  );
  const stopped = cancelled || cancellation.rows[0]?.cancelled;
  const consume = stopped ? request.answer_visible : success;
  await db.query(
    `UPDATE benefit_daily_usage SET reserved_turns=GREATEST(0,reserved_turns-1),
    consumed_turns=consumed_turns+$3 WHERE user_id=$1 AND allowance_date=$2`,
    [request.user_id, request.allowance_date, consume ? 1 : 0],
  );
  await db.query('UPDATE benefit_requests SET state=$2 WHERE request_id=$1', [
    requestId,
    consume ? 'consumed' : 'released',
  ]);
  return consume ? 'consumed' : 'released';
}
