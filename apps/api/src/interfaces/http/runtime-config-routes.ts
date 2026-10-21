import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RUNTIME_CONFIG_LIMITS } from '@fateclaw/contracts/model-settings';
import {
  getRuntimeConfig,
  saveRuntimeConfig,
} from '#infrastructure/repositories/runtime-config-repository';

function integer(key: keyof typeof RUNTIME_CONFIG_LIMITS) {
  const { min, max } = RUNTIME_CONFIG_LIMITS[key];
  return z.number().int().min(min).max(max);
}

const RuntimeConfigSchema = z
  .strictObject({
    revision: z.number().int().positive(),
    agent_concurrency_limit: integer('agent_concurrency_limit'),
    agent_account_concurrency: integer('agent_account_concurrency'),
    local_agent_max_processes: integer('local_agent_max_processes'),
    local_agent_idle_ttl_ms: integer('local_agent_idle_ttl_ms'),
    pi_session_health_enabled: z.boolean(),
    pi_session_inactive_cleanup_days: integer(
      'pi_session_inactive_cleanup_days',
    ),
    pi_session_orphan_grace_days: integer('pi_session_orphan_grace_days'),
    skill_bundle_max_files: integer('skill_bundle_max_files'),
    skill_bundle_max_file_chars: integer('skill_bundle_max_file_chars'),
    skill_bundle_max_total_chars: integer('skill_bundle_max_total_chars'),
    skill_bundle_max_zip_bytes: integer('skill_bundle_max_zip_bytes'),
    user_skill_max_count: integer('user_skill_max_count'),
    wechat_claw_enabled: z.boolean(),
  })
  .refine(
    (value) =>
      value.skill_bundle_max_total_chars >= value.skill_bundle_max_file_chars,
    { message: 'Skill 总字数上限不能小于单文件字数上限' },
  );

export async function runtimeConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/system-config/runtime', async () => getRuntimeConfig());
  app.put('/system-config/runtime', async (request, reply) => {
    const parsed = RuntimeConfigSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: '运行配置参数不正确，请检查数值范围及总字数上限' });
    return saveRuntimeConfig(
      parsed.data,
      request.adminPrincipal?.role ?? 'owner',
    );
  });
}
