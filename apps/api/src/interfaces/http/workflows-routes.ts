import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { WorkflowStepDto } from '@fateclaw/contracts/workflow';

import {
  createWorkflowDefinitionForOwnedUser,
  deleteWorkflowDefinitionForOwnedUser,
  getWorkflowDefinitionForOwnedUser,
  listWorkflowDefinitionsForOwnedUser,
  updateWorkflowDefinitionForOwnedUser,
} from '../../modules/chat/workflow-definition-service.js';
import {
  executeWorkflowRunStep,
  saveWorkflowStepOutput,
  startWorkflowRun,
} from '../../modules/chat/workflow-run-service.js';

/** 模型策略校验(对齐契约 SimpleModelPolicyDto)。 */
const ModelPolicySchema = z.object({
  mode: z.enum(['system-default', 'user-current', 'fixed']),
  fixedModelId: z.string().trim().min(1).optional(),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh']).optional(),
});

/** 步骤公共字段;id 必填、需稳定(前端新增步骤时生成、之后不变),且仅含字母数字下划线
 *  (运行侧用 `wf-<stepId>-…` 的消息 id 约定关联步骤产出,故 stepId 不能含 '-')。 */
const stepBase = {
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]+$/, '步骤 id 仅可含字母、数字、下划线'),
  title: z.string().trim().min(1, '请填写步骤名称').max(60),
  pauseAfter: z.boolean(),
};

/** 排盘步:固定机械流程,不经 AI。 */
const PaipanStepSchema = z.object({
  ...stepBase,
  type: z.literal('paipan'),
  skill: z.string().trim().min(1, '请选择术数'),
  inputDefaults: z.record(z.string(), z.unknown()).default({}),
});

/** AI 解读步。 */
const AiStepSchema = z.object({
  ...stepBase,
  type: z.literal('ai'),
  promptTemplate: z.string().trim().min(1, '请填写 prompt 模板').max(8000),
  skillIds: z.array(z.string().trim().min(1)).max(20).default([]),
  modelPolicy: ModelPolicySchema,
});

const StepSchema = z.discriminatedUnion('type', [PaipanStepSchema, AiStepSchema]);

/** 工作流创建/更新请求体校验(对齐契约 WorkflowDefinitionUpsertDto)。 */
const WorkflowUpsertSchema = z.object({
  name: z.string().trim().min(1, '请填写工作流名称').max(60),
  description: z.string().trim().max(500).optional().default(''),
  steps: z.array(StepSchema).min(1, '工作流至少要有一个步骤').max(20),
  enabled: z.boolean().optional().default(true),
  sort_order: z.number().int().optional().default(0),
});

/** 启动运行请求体校验。 */
const RunStartSchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  input: z.record(z.string(), z.string()).optional().default({}),
});

/** 保存某步润色结果请求体校验。 */
const StepOutputSchema = z.object({
  content: z.string().max(20000),
});

/**
 * 把校验后的步骤补成完整 WorkflowStepDto。
 *
 * @remarks AI 步加上 skillSnapshotIds(服务端写入,此处先置空,服务层会再次兜底)。
 */
function toFullSteps(
  steps: z.infer<typeof StepSchema>[],
): WorkflowStepDto[] {
  return steps.map((step) =>
    step.type === 'ai'
      ? { ...step, skillSnapshotIds: [] as string[] }
      : step,
  );
}

/**
 * 注册卦师自定义工作流 HTTP 路由。
 *
 * @param app Fastify 实例。
 */
export async function workflowsRoutes(app: FastifyInstance): Promise<void> {
  // 全部接口都要求登录,且只操作当前用户名下的工作流。
  app.addHook('onRequest', async (request) => {
    await request.requireAuth();
  });

  // GET /api/workflows — 列出当前用户的全部工作流
  app.get('/', async (request, reply) => {
    const result = await listWorkflowDefinitionsForOwnedUser(
      request.user.userId,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return { workflows: result.data };
  });

  // POST /api/workflows — 创建工作流
  app.post<{ Body: unknown }>('/', async (request, reply) => {
    const parsed = WorkflowUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    const result = await createWorkflowDefinitionForOwnedUser(
      request.user.userId,
      {
        name: parsed.data.name,
        description: parsed.data.description,
        steps: toFullSteps(parsed.data.steps),
        enabled: parsed.data.enabled,
        sortOrder: parsed.data.sort_order,
      },
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/workflows/:id — 读取单个工作流
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const result = await getWorkflowDefinitionForOwnedUser(
      request.user.userId,
      request.params.id,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // PUT /api/workflows/:id — 更新工作流
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/:id',
    async (request, reply) => {
      const parsed = WorkflowUpsertSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message || '参数错误' });
      }
      const result = await updateWorkflowDefinitionForOwnedUser(
        request.user.userId,
        request.params.id,
        {
          name: parsed.data.name,
          description: parsed.data.description,
          steps: toFullSteps(parsed.data.steps),
          enabled: parsed.data.enabled,
          sortOrder: parsed.data.sort_order,
        },
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // DELETE /api/workflows/:id — 软删除工作流
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const result = await deleteWorkflowDefinitionForOwnedUser(
      request.user.userId,
      request.params.id,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // POST /api/workflows/:id/runs — 启动一次运行(建会话,可关联客户)
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/:id/runs',
    async (request, reply) => {
      const parsed = RunStartSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message || '参数错误' });
      }
      const result = await startWorkflowRun(
        request.user.userId,
        request.params.id,
        { clientId: parsed.data.clientId, input: parsed.data.input },
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // POST /api/workflows/:id/runs/:sessionId/steps/:stepId/execute — 执行单步
  app.post<{
    Params: { id: string; sessionId: string; stepId: string };
  }>(
    '/:id/runs/:sessionId/steps/:stepId/execute',
    async (request, reply) => {
      const result = await executeWorkflowRunStep(
        request.user.userId,
        request.params.id,
        request.params.sessionId,
        request.params.stepId,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // PATCH /api/workflows/:id/runs/:sessionId/steps/:stepId/output — 保存某步润色结果
  app.patch<{
    Params: { id: string; sessionId: string; stepId: string };
    Body: unknown;
  }>(
    '/:id/runs/:sessionId/steps/:stepId/output',
    async (request, reply) => {
      const parsed = StepOutputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message || '参数错误' });
      }
      const result = await saveWorkflowStepOutput(
        request.user.userId,
        request.params.id,
        request.params.sessionId,
        request.params.stepId,
        parsed.data.content,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );
}
