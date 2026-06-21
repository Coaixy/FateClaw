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
  WorkflowRunNodeDto,
  WorkflowRunNodeExecuteResponseDto,
  WorkflowRunStartRequestDto,
  WorkflowRunStartResponseDto,
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
export type WorkflowRunNode = WorkflowRunNodeDto;
export type WorkflowNodeModelPolicy = SimpleModelPolicyDto;
export type WorkflowRunStartRequest = WorkflowRunStartRequestDto;
export type WorkflowRunStartResponse = WorkflowRunStartResponseDto;
export type WorkflowRunNodeExecuteResponse = WorkflowRunNodeExecuteResponseDto;

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

  /** 启动一次运行(建会话,可关联客户)。 */
  runStart: (id: string, data: WorkflowRunStartRequest) =>
    requestJson<WorkflowRunStartResponse>(`/api/workflows/${seg(id)}/runs`, {
      method: 'POST',
      body: JSON.stringify(data),
      exposeServerErrorMessage: true,
    }),

  /** 执行运行中的某个节点。 */
  runNode: (id: string, sessionId: string, nodeId: string) =>
    requestJson<WorkflowRunNodeExecuteResponse>(
      `/api/workflows/${seg(id)}/runs/${seg(sessionId)}/nodes/${seg(nodeId)}/execute`,
      { method: 'POST', exposeServerErrorMessage: true },
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
};
