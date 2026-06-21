import type {
  WorkflowAiNodeDto,
  WorkflowDefinitionDto,
  WorkflowDefinitionListResponseDto,
  WorkflowDefinitionUpsertDto,
  WorkflowEdgeDto,
  WorkflowGraphDto,
  WorkflowGraphInputDto,
  WorkflowNodeDto,
  WorkflowNodeInputDto,
  WorkflowPaipanNodeDto,
  WorkflowRunInputDto,
  WorkflowRunListResponseDto,
  WorkflowRunNodeDto,
  WorkflowRunNodeExecuteRequestDto,
  WorkflowRunNodeExecuteResponseDto,
  WorkflowRunNodeStateDto,
  WorkflowRunNodeStatus as WorkflowRunNodeStatusDto,
  WorkflowRunStartRequestDto,
  WorkflowRunStartResponseDto,
  WorkflowRunStateDto,
  WorkflowRunStatus as WorkflowRunStatusDto,
  WorkflowRunSummaryDto,
} from '@fateclaw/contracts/workflow';
import type { SimpleModelPolicyDto } from '@fateclaw/contracts/chat';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { requestJson } from '@/lib/http/client';

// 本地 type 别名(避免前端 barrel 对 contracts 的 export* 星号透传踩 turbopack 坑)。
export type WorkflowDefinition = WorkflowDefinitionDto;
export type WorkflowDefinitionListResponse = WorkflowDefinitionListResponseDto;
export type WorkflowDefinitionUpsert = WorkflowDefinitionUpsertDto;
export type WorkflowNode = WorkflowNodeDto;
export type WorkflowPaipanNode = WorkflowPaipanNodeDto;
export type WorkflowAiNode = WorkflowAiNodeDto;
export type WorkflowNodeInput = WorkflowNodeInputDto;
export type WorkflowEdge = WorkflowEdgeDto;
export type WorkflowGraph = WorkflowGraphDto;
export type WorkflowGraphInput = WorkflowGraphInputDto;
export type WorkflowRunInput = WorkflowRunInputDto;
export type WorkflowRunNode = WorkflowRunNodeDto;
export type WorkflowNodeModelPolicy = SimpleModelPolicyDto;
export type WorkflowRunStartRequest = WorkflowRunStartRequestDto;
export type WorkflowRunStartResponse = WorkflowRunStartResponseDto;
export type WorkflowRunNodeExecuteRequest = WorkflowRunNodeExecuteRequestDto;
export type WorkflowRunNodeExecuteResponse = WorkflowRunNodeExecuteResponseDto;
export type WorkflowRunSummary = WorkflowRunSummaryDto;
export type WorkflowRunListResponse = WorkflowRunListResponseDto;
// 后端编排运行状态(架构升级 B 方案 P3 起前端用)。
export type WorkflowRunState = WorkflowRunStateDto;
export type WorkflowRunNodeState = WorkflowRunNodeStateDto;
export type WorkflowRunStatus = WorkflowRunStatusDto;
export type WorkflowRunNodeStatus = WorkflowRunNodeStatusDto;

const seg = (value: string) => encodeURIComponent(value);

/**
 * 卦师自定义工作流的浏览器侧 REST 封装,对接后端 `/api/workflows`。
 * 统一走 requestJson 处理鉴权与错误;写操作暴露服务端错误文案,便于卦师看到具体原因。
 */
export const workflowsApi = {
  /** 列出当前卦师的全部工作流。 */
  list: () => requestJson<WorkflowDefinitionListResponse>('/api/workflows'),

  /** 读取单个工作流定义。 */
  get: (id: string) =>
    requestJson<WorkflowDefinition>(`/api/workflows/${seg(id)}`),

  /** 创建工作流。 */
  create: (data: WorkflowDefinitionUpsert) =>
    requestJson<WorkflowDefinition>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify(data),
      exposeServerErrorMessage: true,
    }),

  /** 更新工作流(整体覆盖)。 */
  update: (id: string, data: WorkflowDefinitionUpsert) =>
    requestJson<WorkflowDefinition>(`/api/workflows/${seg(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
      exposeServerErrorMessage: true,
    }),

  /** 软删除工作流。 */
  remove: (id: string) =>
    requestJson<SuccessResponse>(`/api/workflows/${seg(id)}`, {
      method: 'DELETE',
    }),

  /** 列出某工作流的运行历史。 */
  listRuns: (id: string) =>
    requestJson<WorkflowRunListResponse>(`/api/workflows/${seg(id)}/runs`),

  /** 启动一次运行(建会话,可关联客户)。 */
  runStart: (id: string, data: WorkflowRunStartRequest) =>
    requestJson<WorkflowRunStartResponse>(`/api/workflows/${seg(id)}/runs`, {
      method: 'POST',
      body: JSON.stringify(data),
      exposeServerErrorMessage: true,
    }),

  /** 执行运行中的某个节点;boardMessageIds 为该 AI 直接入边排盘的盘面列表(只注入这些盘、隔离分支)。 */
  runNode: (
    id: string,
    sessionId: string,
    nodeId: string,
    boardMessageIds: string[] = [],
  ) =>
    requestJson<WorkflowRunNodeExecuteResponse>(
      `/api/workflows/${seg(id)}/runs/${seg(sessionId)}/nodes/${seg(nodeId)}/execute`,
      {
        method: 'POST',
        body: JSON.stringify({
          boardMessageIds,
        } satisfies WorkflowRunNodeExecuteRequest),
        exposeServerErrorMessage: true,
      },
    ),

  /** 保存某节点润色结果(改该节点 AI 产出正文,供下游节点读到润色版)。 */
  runNodeSaveOutput: (
    id: string,
    sessionId: string,
    nodeId: string,
    content: string,
  ) =>
    requestJson<SuccessResponse>(
      `/api/workflows/${seg(id)}/runs/${seg(sessionId)}/nodes/${seg(nodeId)}/output`,
      {
        method: 'PATCH',
        body: JSON.stringify({ content }),
        exposeServerErrorMessage: true,
      },
    ),

  /**
   * 后端编排运行 API(架构升级 B 方案):前端只"提交输入 + 订阅 run 快照",拓扑推进在后端。
   * 所有方法返回完整运行状态快照 WorkflowRunState。
   */
  run: {
    /** 启动一次后端编排运行。 */
    start: (workflowId: string, data: WorkflowRunStartRequest) =>
      requestJson<WorkflowRunState>(`/api/workflows/${seg(workflowId)}/run`, {
        method: 'POST',
        body: JSON.stringify(data),
        exposeServerErrorMessage: true,
      }),

    /** 读取运行状态快照(后端会先回灌已落库产出再返回)。 */
    get: (runId: string) =>
      requestJson<WorkflowRunState>(`/api/workflows/run/${seg(runId)}`),

    /** 从暂停续跑。 */
    resume: (runId: string) =>
      requestJson<WorkflowRunState>(
        `/api/workflows/run/${seg(runId)}/resume`,
        { method: 'POST', exposeServerErrorMessage: true },
      ),

    /** 卦师起盘提交(input 为 PaipanSheet 填写的排盘参数)。 */
    commitPaipan: (
      runId: string,
      nodeId: string,
      input: Record<string, unknown>,
    ) =>
      requestJson<WorkflowRunState>(
        `/api/workflows/run/${seg(runId)}/nodes/${seg(nodeId)}/paipan`,
        {
          method: 'POST',
          body: JSON.stringify({ input }),
          exposeServerErrorMessage: true,
        },
      ),

    /** 从该节点级联重跑下游。 */
    rerun: (runId: string, nodeId: string) =>
      requestJson<WorkflowRunState>(
        `/api/workflows/run/${seg(runId)}/nodes/${seg(nodeId)}/rerun`,
        { method: 'POST', exposeServerErrorMessage: true },
      ),

    /** 跳过该节点。 */
    skip: (runId: string, nodeId: string) =>
      requestJson<WorkflowRunState>(
        `/api/workflows/run/${seg(runId)}/nodes/${seg(nodeId)}/skip`,
        { method: 'POST', exposeServerErrorMessage: true },
      ),

    /** 润色 / 手填某节点产出。 */
    saveOutput: (runId: string, nodeId: string, content: string) =>
      requestJson<WorkflowRunState>(
        `/api/workflows/run/${seg(runId)}/nodes/${seg(nodeId)}/output`,
        {
          method: 'PATCH',
          body: JSON.stringify({ content }),
          exposeServerErrorMessage: true,
        },
      ),
  },
};
