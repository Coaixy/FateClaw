import type {
  RuntimeConfigDto,
  RuntimeConfigUpdateDto,
} from '@fateclaw/contracts/model-settings';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';

const COLUMNS = `agent_concurrency_limit, agent_account_concurrency,
  local_agent_max_processes, local_agent_idle_ttl_ms,
  pi_session_health_enabled, pi_session_inactive_cleanup_days,
  pi_session_orphan_grace_days, skill_bundle_max_files,
  skill_bundle_max_file_chars, skill_bundle_max_total_chars,
  skill_bundle_max_zip_bytes, user_skill_max_count,
  wechat_claw_enabled, revision, updated_at::text AS updated_at`;

export class RuntimeConfigConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('运行配置已被其他管理员更新，请刷新后重试');
  }
}

export async function getRuntimeConfig(
  db: DbQueryable = getDbPool(),
): Promise<RuntimeConfigDto> {
  const { rows } = await db.query<RuntimeConfigDto>(
    `SELECT ${COLUMNS} FROM runtime_config WHERE id = 'default'`,
  );
  if (!rows[0]) throw new Error('Runtime configuration migration is missing');
  return rows[0];
}

export async function saveRuntimeConfig(
  input: RuntimeConfigUpdateDto,
  actor: string,
): Promise<RuntimeConfigDto> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const before = await getRuntimeConfig(client);
    const { rows } = await client.query<RuntimeConfigDto>(
      `UPDATE runtime_config SET
        agent_concurrency_limit=$1, agent_account_concurrency=$2,
        local_agent_max_processes=$3, local_agent_idle_ttl_ms=$4,
        pi_session_health_enabled=$5, pi_session_inactive_cleanup_days=$6,
        pi_session_orphan_grace_days=$7, skill_bundle_max_files=$8,
        skill_bundle_max_file_chars=$9, skill_bundle_max_total_chars=$10,
        skill_bundle_max_zip_bytes=$11, user_skill_max_count=$12,
        wechat_claw_enabled=$13, revision=revision+1, updated_at=clock_timestamp()
      WHERE id='default' AND revision=$14 RETURNING ${COLUMNS}`,
      [
        input.agent_concurrency_limit,
        input.agent_account_concurrency,
        input.local_agent_max_processes,
        input.local_agent_idle_ttl_ms,
        input.pi_session_health_enabled,
        input.pi_session_inactive_cleanup_days,
        input.pi_session_orphan_grace_days,
        input.skill_bundle_max_files,
        input.skill_bundle_max_file_chars,
        input.skill_bundle_max_total_chars,
        input.skill_bundle_max_zip_bytes,
        input.user_skill_max_count,
        input.wechat_claw_enabled,
        input.revision,
      ],
    );
    const saved = rows[0];
    if (!saved) throw new RuntimeConfigConflictError();
    await client.query(
      `INSERT INTO config_audit_logs
        (id, actor_user_id, action, target_type, target_key, before_json, after_json)
       VALUES (gen_random_uuid()::text, $1, 'update', 'runtime_config', 'default', $2, $3)`,
      [actor, JSON.stringify(before), JSON.stringify(saved)],
    );
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
