import {
  DEFAULT_MEMORY_RUNTIME_POLICY,
  MEMORY_POLICY_INTEGER_MAX,
  type MemoryRuntimePolicy,
} from '@fateclaw/contracts/memory';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import { MemoryError } from './domain.js';

export async function getMemoryRuntimePolicy(
  db: DbQueryable = getDbPool(),
): Promise<MemoryRuntimePolicy> {
  const { rows } = await db.query<{
    memory_policy: Partial<MemoryRuntimePolicy>;
  }>("SELECT memory_policy FROM runtime_config WHERE id='default'");
  if (!rows[0])
    throw new MemoryError(
      '记忆数据库迁移尚未完成',
      503,
      'MEMORY.MIGRATION_MISSING',
    );
  return { ...DEFAULT_MEMORY_RUNTIME_POLICY, ...rows[0].memory_policy };
}

export function validateMemoryRuntimePolicy(
  input: unknown,
): MemoryRuntimePolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new MemoryError('记忆运行配置格式错误');
  const candidate = input as Record<string, unknown>;
  const result = { ...DEFAULT_MEMORY_RUNTIME_POLICY };
  for (const key of Object.keys(DEFAULT_MEMORY_RUNTIME_POLICY) as Array<
    keyof MemoryRuntimePolicy
  >) {
    const value = candidate[key];
    if (key === 'enabled' || key === 'default_learning_enabled') {
      if (typeof value !== 'boolean')
        throw new MemoryError(`缺少有效配置：${key}`);
      Object.assign(result, { [key]: value });
    } else if (key === 'extraction_model_id') {
      if (
        value !== null &&
        (typeof value !== 'string' || !value.trim() || value.length > 256)
      )
        throw new MemoryError(`模型配置格式错误：${key}`);
      Object.assign(result, {
        [key]: typeof value === 'string' ? value.trim() : null,
      });
    } else {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > MEMORY_POLICY_INTEGER_MAX
      )
        throw new MemoryError(`配置必须是正整数：${key}`);
      Object.assign(result, { [key]: value });
    }
  }
  if (
    result.worker_concurrency > 32 ||
    result.max_attempts > 20 ||
    result.recall_max_results > 100 ||
    result.recent_source_limit > 100 ||
    result.backfill_batch_size > 1000
  )
    throw new MemoryError('记忆运行配置超出支持范围');
  // A single extraction call reserves input plus output; a smaller daily budget could never run one.
  if (
    result.extraction_input_tokens + result.extraction_output_tokens >
    result.daily_token_budget
  )
    throw new MemoryError('单次提炼的输入与输出预算之和不能超过每日记忆预算');
  return result;
}

export async function saveMemoryRuntimePolicy(
  input: unknown,
  actor: string,
): Promise<MemoryRuntimePolicy> {
  const policy = validateMemoryRuntimePolicy(input);
  const db = await getDbPool().connect();
  try {
    await db.query('BEGIN');
    const before = await getMemoryRuntimePolicy(db);
    const saved = { ...policy, revision: policy.revision + 1 };
    const result = await db.query(
      "UPDATE runtime_config SET memory_policy=$1,revision=revision+1,updated_at=clock_timestamp() WHERE id='default' AND (memory_policy->>'revision')::int=$2",
      [JSON.stringify(saved), policy.revision],
    );
    if (!result.rowCount)
      throw new MemoryError(
        '记忆配置已被其他管理员更新，请刷新后重试',
        409,
        'MEMORY.CONFIG_CONFLICT',
      );
    await db.query(
      `UPDATE memory_jobs SET state='pending',attempts=0,error_code=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE state='failed' AND error_code IN ('MEMORY_MODEL_UNAVAILABLE','MEMORY.BUDGET_EXHAUSTED')`,
    );
    await db.query(
      "INSERT INTO config_audit_logs(id,actor_user_id,action,target_type,target_key,before_json,after_json) VALUES(gen_random_uuid()::text,$1,'update','runtime_config','memory',$2,$3)",
      [actor, JSON.stringify(before), JSON.stringify(saved)],
    );
    await db.query('COMMIT');
    return saved;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
