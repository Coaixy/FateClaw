import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  MemoryRuntimePolicy,
  MemoryRuntimeStatusDto,
} from '@fateclaw/contracts/memory';
import { MEMORY_POLICY_INTEGER_MAX } from '@fateclaw/contracts/memory';

import { getDbPool } from '#infrastructure/db-pool';
import { getPlatformModelSettings } from '#infrastructure/repositories/config-repository';
import { MemoryError } from '#modules/memory/domain';
import {
  getMemoryRuntimePolicy,
  saveMemoryRuntimePolicy,
  validateMemoryRuntimePolicy,
} from '#modules/memory/policy';
import { memoryStatus } from '#modules/memory/service';
import { retryMemoryJob } from '#modules/memory/jobs';
import { registerMemoryHttpErrors } from './memory-routes.js';

const empty = z.strictObject({});
const identifier = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().max(MEMORY_POLICY_INTEGER_MAX);
const modelId = identifier.nullable();
const policySchema = z.strictObject({
  enabled: z.boolean(),
  extraction_model_id: modelId,
  default_learning_enabled: z.boolean(),
  worker_concurrency: positive,
  job_timeout_ms: positive,
  max_attempts: positive,
  extraction_input_tokens: positive,
  extraction_output_tokens: positive,
  recall_token_budget: positive,
  recall_max_results: positive,
  recall_timeout_ms: positive,
  recent_source_limit: positive,
  daily_token_budget: positive,
  backfill_batch_size: positive,
  revision: positive,
});

async function assertPolicyModels(policy: MemoryRuntimePolicy): Promise<void> {
  const id = policy.extraction_model_id;
  if (!id) return;
  const settings = await getPlatformModelSettings();
  const node = settings.nodes.find((entry) => entry.model.id === id);
  if (!settings.pool.enabled || !node?.model.enabled)
    throw new MemoryError(
      '记忆模型节点不存在或已停用',
      400,
      'MEMORY.MODEL_UNAVAILABLE',
    );
}

// Register inside adminRoutes to inherit owner authentication and scope checks.
export async function adminMemoryRoutes(app: FastifyInstance): Promise<void> {
  registerMemoryHttpErrors(app);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Vary', 'X-Admin-Key');
  });
  app.get('/memory', async (request): Promise<MemoryRuntimeStatusDto> => {
    empty.parse(request.query);
    const [policy, status, settings, usage] = await Promise.all([
      getMemoryRuntimePolicy(),
      memoryStatus(),
      getPlatformModelSettings(),
      getDbPool().query<{
        purpose: string;
        calls: string;
        input_tokens: string;
        output_tokens: string;
      }>(
        `SELECT purpose,count(*)::text AS calls,COALESCE(sum(input_tokens),0)::text AS input_tokens,
         COALESCE(sum(output_tokens),0)::text AS output_tokens FROM memory_usage
         WHERE created_at >= $1::timestamptz GROUP BY purpose ORDER BY purpose`,
        [`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`],
      ),
    ]);
    return {
      ...status,
      policy,
      model_choices: settings.nodes
        .filter((node) => settings.pool.enabled && node.model.enabled)
        .map((node) => ({
          id: node.model.id,
          display_name: node.model.display_name,
          model_name: node.model.model_name,
        })),
      usage_today: usage.rows.map((row) => ({
        purpose: row.purpose,
        calls: Number(row.calls),
        input_tokens: Number(row.input_tokens),
        output_tokens: Number(row.output_tokens),
      })),
    };
  });
  app.put('/memory/policy', async (request) => {
    empty.parse(request.query);
    const policy = validateMemoryRuntimePolicy(
      policySchema.parse(request.body),
    );
    await assertPolicyModels(policy);
    return saveMemoryRuntimePolicy(
      policy,
      request.adminPrincipal?.role ?? 'owner',
    );
  });
  app.post('/memory/jobs/:id/retry', async (request) => {
    empty.parse(request.query);
    empty.parse(request.body === undefined ? {} : request.body);
    return retryMemoryJob(
      z.strictObject({ id: identifier }).parse(request.params).id,
    );
  });
}
