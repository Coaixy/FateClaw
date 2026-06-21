import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { WorkflowGraphDto, WorkflowNodeDto } from '@fateclaw/contracts/workflow';

import {
  createWorkflowDefinitionForOwnedUser,
  deleteWorkflowDefinitionForOwnedUser,
  getWorkflowDefinitionForOwnedUser,
  listWorkflowDefinitionsForOwnedUser,
  updateWorkflowDefinitionForOwnedUser,
} from '../../modules/chat/workflow-definition-service.js';
import {
  executeWorkflowRunNode,
  listWorkflowRuns,
  saveWorkflowNodeOutput,
  startWorkflowRun,
} from '../../modules/chat/workflow-run-service.js';
import {
  commitWorkflowPaipanNodeV2,
  getWorkflowRunStateV2,
  listWorkflowRunHistoryV2,
  rerunWorkflowNodeV2,
  resumeWorkflowRunV2,
  saveWorkflowNodeOutputV2,
  skipWorkflowNodeV2,
  startWorkflowRunV2,
} from '../../modules/workflow/workflow-run-engine.js';

/** 模型策略校验(对齐契约 SimpleModelPolicyDto)。 */
const ModelPolicySchema = z.object({
  mode: z.enum(['system-default', 'user-current', 'fixed']),
  fixedModelId: z.string().trim().min(1).optional(),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh']).optional(),
});

/** 画布坐标。 */
const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/** 节点公共字段;id 必填、需稳定(前端新增节点时生成、之后不变),且仅含字母数字下划线
 *  (运行侧用 `wf-<nodeId>-…` 的消息 id 约定关联节点产出,故 nodeId 不能含 '-')。 */
const nodeBase = {
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]+$/, '节点 id 仅可含字母、数字、下划线'),
  title: z.string().trim().min(1, '请填写节点名称').max(60),
  pauseAfter: z.boolean(),
  position: PositionSchema,
};

/** 排盘节点:固定机械流程,不经 AI。 */
const PaipanNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('paipan'),
  skill: z.string().trim().min(1, '请选择术数'),
  inputDefaults: z.record(z.string(), z.unknown()).default({}),
});

/** AI 解读节点。 */
const AiNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('ai'),
  promptTemplate: z.string().trim().min(1, '请填写 prompt 模板').max(8000),
  skillIds: z.array(z.string().trim().min(1)).max(20).default([]),
  modelPolicy: ModelPolicySchema,
});

const NodeSchema = z.discriminatedUnion('type', [PaipanNodeSchema, AiNodeSchema]);

/** 有向边。 */
const EdgeSchema = z.object({
  id: z.string().trim().min(1),
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
});

/**
 * 校验图为合法 DAG:节点 id 唯一、边两端都指向存在的节点、无自环、无环。
 *
 * @remarks 前端连线时已防环,这里是服务端二次兜底,挡住非法/构造的请求体。
 */
function validateGraphShape(
  graph: { nodes: { id: string }[]; edges: { source: string; target: string }[] },
  ctx: z.RefinementCtx,
): void {
  const ids = graph.nodes.map((node) => node.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: '节点 id 重复' });
    return;
  }
  for (const edge of graph.edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) {
      ctx.addIssue({ code: 'custom', message: '存在指向不存在节点的连线' });
      return;
    }
    if (edge.source === edge.target) {
      ctx.addIssue({ code: 'custom', message: '节点不能连向自身' });
      return;
    }
  }
  // 拓扑排序(Kahn):若有节点入度始终不为 0,则存在环。
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of graph.edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    adjacency.get(edge.source)?.push(edge.target);
  }
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift() as string;
    visited += 1;
    for (const next of adjacency.get(current) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (visited !== ids.length) {
    ctx.addIssue({ code: 'custom', message: '工作流不能有环路' });
  }
}

/** 图(节点 + 边)。 */
const GraphSchema = z
  .object({
    nodes: z.array(NodeSchema).min(1, '工作流至少要有一个节点').max(40),
    edges: z.array(EdgeSchema).max(120).default([]),
  })
  .superRefine(validateGraphShape);

/** 运行前输入项校验(对齐契约 WorkflowRunInputDto);key 用于 {{input.<key>}} 引用,限 [A-Za-z0-9_]。 */
const RunInputSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]+$/, '输入键仅可含字母、数字、下划线')
    .max(40),
  label: z.string().trim().min(1, '请填写输入项标签').max(60),
  type: z.enum(['text', 'textarea']),
  required: z.boolean(),
});

/** 工作流创建/更新请求体校验(对齐契约 WorkflowDefinitionUpsertDto)。 */
const WorkflowUpsertSchema = z.object({
  name: z.string().trim().min(1, '请填写工作流名称').max(60),
  description: z.string().trim().max(500).optional().default(''),
  graph: GraphSchema,
  inputs: z
    .array(RunInputSchema)
    .max(10)
    .default([])
    .superRefine((inputs, ctx) => {
      const keys = inputs.map((item) => item.key);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({ code: 'custom', message: '输入项的键不能重复' });
      }
    }),
  enabled: z.boolean().optional().default(true),
  sort_order: z.number().int().optional().default(0),
});

/** 启动运行请求体校验。 */
const RunStartSchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  input: z.record(z.string(), z.string()).optional().default({}),
});

/** 执行单个节点请求体校验。 */
const NodeExecuteSchema = z.object({
  boardMessageIds: z
    .array(z.string().trim().min(1))
    .max(20)
    .optional()
    .default([]),
});

/** 保存某节点润色结果请求体校验。 */
const NodeOutputSchema = z.object({
  content: z.string().max(20000),
});

/** 起盘提交请求体校验(后端编排版:PaipanSheet 自落盘面后返回的盘面消息 id,后端认领之)。 */
const PaipanCommitSchema = z.object({
  boardMessageId: z.string().trim().min(1, '缺少盘面消息 id'),
});

/**
 * 把校验后的图补成完整 WorkflowGraphDto。
 *
 * @remarks AI 节点加上 skillSnapshotIds(服务端写入,此处先置空,仓储层会再次兜底)。
 */
function toFullGraph(graph: z.infer<typeof GraphSchema>): WorkflowGraphDto {
  return {
    nodes: graph.nodes.map((node): WorkflowNodeDto =>
      node.type === 'ai'
        ? { ...node, skillSnapshotIds: [] as string[] }
        : node,
    ),
    edges: graph.edges,
  };
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
        graph: toFullGraph(parsed.data.graph),
        inputs: parsed.data.inputs,
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
          graph: toFullGraph(parsed.data.graph),
          inputs: parsed.data.inputs,
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

  // GET /api/workflows/:id/runs — 列出该工作流的运行历史
  app.get<{ Params: { id: string } }>('/:id/runs', async (request, reply) => {
    const result = await listWorkflowRuns(
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

  // POST /api/workflows/:id/runs/:sessionId/nodes/:nodeId/execute — 执行单个节点
  app.post<{
    Params: { id: string; sessionId: string; nodeId: string };
    Body: unknown;
  }>(
    '/:id/runs/:sessionId/nodes/:nodeId/execute',
    async (request, reply) => {
      const parsed = NodeExecuteSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message || '参数错误' });
      }
      const result = await executeWorkflowRunNode(
        request.user.userId,
        request.params.id,
        request.params.sessionId,
        request.params.nodeId,
        parsed.data.boardMessageIds,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // PATCH /api/workflows/:id/runs/:sessionId/nodes/:nodeId/output — 保存某节点润色结果
  app.patch<{
    Params: { id: string; sessionId: string; nodeId: string };
    Body: unknown;
  }>(
    '/:id/runs/:sessionId/nodes/:nodeId/output',
    async (request, reply) => {
      const parsed = NodeOutputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message || '参数错误' });
      }
      const result = await saveWorkflowNodeOutput(
        request.user.userId,
        request.params.id,
        request.params.sessionId,
        request.params.nodeId,
        parsed.data.content,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // ───────────── 后端编排运行(架构升级 B 方案 P2;按 runId 寻址,与上面旧端点共存)─────────────

  // POST /api/workflows/:id/run — 启动一次后端编排运行,返回运行状态快照
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/:id/run',
    async (request, reply) => {
      const parsed = RunStartSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message || '参数错误' });
      }
      const result = await startWorkflowRunV2(
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

  // GET /api/workflows/:id/run-history — 后端编排运行历史(按 runId)
  app.get<{ Params: { id: string } }>(
    '/:id/run-history',
    async (request, reply) => {
      const result = await listWorkflowRunHistoryV2(
        request.user.userId,
        request.params.id,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // GET /api/workflows/run/:runId — 读取运行状态(自动 reconcile 已落库产出)
  app.get<{ Params: { runId: string } }>(
    '/run/:runId',
    async (request, reply) => {
      const result = await getWorkflowRunStateV2(
        request.user.userId,
        request.params.runId,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // POST /api/workflows/run/:runId/resume — 从暂停续跑
  app.post<{ Params: { runId: string } }>(
    '/run/:runId/resume',
    async (request, reply) => {
      const result = await resumeWorkflowRunV2(
        request.user.userId,
        request.params.runId,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // POST /api/workflows/run/:runId/nodes/:nodeId/paipan — 卦师起盘提交
  app.post<{ Params: { runId: string; nodeId: string }; Body: unknown }>(
    '/run/:runId/nodes/:nodeId/paipan',
    async (request, reply) => {
      const parsed = PaipanCommitSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message || '参数错误' });
      }
      const result = await commitWorkflowPaipanNodeV2(
        request.user.userId,
        request.params.runId,
        request.params.nodeId,
        parsed.data.boardMessageId,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // POST /api/workflows/run/:runId/nodes/:nodeId/rerun — 从该节点级联重跑
  app.post<{ Params: { runId: string; nodeId: string } }>(
    '/run/:runId/nodes/:nodeId/rerun',
    async (request, reply) => {
      const result = await rerunWorkflowNodeV2(
        request.user.userId,
        request.params.runId,
        request.params.nodeId,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // POST /api/workflows/run/:runId/nodes/:nodeId/skip — 跳过该节点
  app.post<{ Params: { runId: string; nodeId: string } }>(
    '/run/:runId/nodes/:nodeId/skip',
    async (request, reply) => {
      const result = await skipWorkflowNodeV2(
        request.user.userId,
        request.params.runId,
        request.params.nodeId,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // PATCH /api/workflows/run/:runId/nodes/:nodeId/output — 润色 / 手填节点产出
  app.patch<{ Params: { runId: string; nodeId: string }; Body: unknown }>(
    '/run/:runId/nodes/:nodeId/output',
    async (request, reply) => {
      const parsed = NodeOutputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message || '参数错误' });
      }
      const result = await saveWorkflowNodeOutputV2(
        request.user.userId,
        request.params.runId,
        request.params.nodeId,
        parsed.data.content,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );
}
