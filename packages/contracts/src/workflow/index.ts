/**
 * 卦师自定义工作流 —— 跨端契约 (DTO)。
 *
 * 设计稿: docs/spark/2026-06-21-guashi-custom-workflow-design.md
 * v1 形态: 多步线性流程; 运行混合(每步可设 pauseAfter); 步骤类型两种: 排盘 + AI 解读。
 *
 * schema 决策(2026-06-21):
 *   - 排盘步是固定机械流程、不经 AI,因此只有 skill + inputDefaults,没有 prompt。
 *   - modelPolicy 每个 AI 步独立(初断可用快模型、深化可用 high 思考)。
 *   - 引用字段命名: 排盘盘面 = board,AI 产出 = output。
 */

import type { ChatSessionDto, SimpleModelPolicyDto } from '../chat/index.js';

/** 步骤公共字段(两种步骤都有)。 */
export interface WorkflowStepBaseDto {
  /** 步骤稳定 id —— 被"插入引用"语法和运行记录(metadata.workflow_step_id)使用,不可随意变更。 */
  id: string;
  /** 卦师可读的步骤名称。 */
  title: string;
  /** 此步产出后是否暂停等卦师接管("自动过"= false,"停下来让我看"= true)。 */
  pauseAfter: boolean;
}

/** 排盘步骤:跑某术数,产出盘面。排盘是固定机械流程,不经 AI。 */
export interface WorkflowPaipanStepDto extends WorkflowStepBaseDto {
  type: 'paipan';
  /** 术数,如 'bazi-paipan' / 'iching-paipan'。 */
  skill: string;
  /** 排盘默认参数(起卦方式、八字 include 等);运行时可被客户生辰预填覆盖。 */
  inputDefaults: Record<string, unknown>;
}

/** AI 解读步骤:用 prompt 模板 + 绑定 skill + 模型,产出文本。 */
export interface WorkflowAiStepDto extends WorkflowStepBaseDto {
  type: 'ai';
  /** prompt 模板,可含 {{ 引用 }}(如 {{排盘.board}}、{{初断.output}}、{{input.问题}})。 */
  promptTemplate: string;
  /** 卦师选定的源 skill id[](前端可编辑;保存定义时据此生成快照)。 */
  skillIds: string[];
  /** 冻结的 skill 快照 id[](服务端保存时写入,前端只读;对应"绑 skill 不漂移")。 */
  skillSnapshotIds: string[];
  /** 该步的模型策略(每步独立)。复用 chat 域 SimpleModelPolicyDto。 */
  modelPolicy: SimpleModelPolicyDto;
}

/** 工作流步骤(判别联合)。 */
export type WorkflowStepDto = WorkflowPaipanStepDto | WorkflowAiStepDto;

/** 工作流定义(卦师作者作用域;运行不另建表,run = chat session,详见设计稿)。 */
export interface WorkflowDefinitionDto {
  id: string;
  name: string;
  description: string;
  /** 有序的步骤数组。 */
  steps: WorkflowStepDto[];
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** 工作流列表响应。 */
export interface WorkflowDefinitionListResponseDto {
  workflows: WorkflowDefinitionDto[];
}

/**
 * 创建/更新时的步骤输入。
 *
 * @remarks 与读取态 WorkflowStepDto 的差别:AI 步的 skillSnapshotIds 由服务端在保存时写入,
 *          故输入里不带它(传了也会被忽略)。步骤 id 必填且需稳定——前端新增步骤时生成、
 *          之后不变,因为它是"插入引用"与运行记录的锚点。
 */
export type WorkflowStepInputDto =
  | WorkflowPaipanStepDto
  | Omit<WorkflowAiStepDto, 'skillSnapshotIds'>;

/** 工作流创建/更新请求体(整体覆盖语义)。 */
export interface WorkflowDefinitionUpsertDto {
  name: string;
  description?: string;
  /** 有序步骤(至少 1 个)。 */
  steps: WorkflowStepInputDto[];
  enabled?: boolean;
  sort_order?: number;
}

// ───────────────────────────── 运行(run) ─────────────────────────────
// 运行不另建状态表:一次运行 = 一个 chat session,每步产出 = 一条 message。
// 前端驱动循环:启动拿到步骤清单 → 逐步 execute → 按 pauseAfter 决定自动续跑或停。

/** 启动一次运行的请求体。 */
export interface WorkflowRunStartRequestDto {
  /** 可选关联客户档案:排盘步会用其生辰预填。 */
  clientId?: string;
  /** 卦师本次填写的输入(如 { question: '今年事业' });AI 步可用 {{input.<key>}} 引用。 */
  input?: Record<string, string>;
}

/** 运行时步骤的精简视图(前端逐步执行只需这些)。 */
export interface WorkflowRunStepDto {
  id: string;
  type: WorkflowStepDto['type'];
  title: string;
  pauseAfter: boolean;
}

/** 启动运行的响应:新会话 + 步骤清单。 */
export interface WorkflowRunStartResponseDto {
  session: ChatSessionDto;
  steps: WorkflowRunStepDto[];
}

/** 单步执行的响应。 */
export interface WorkflowRunStepExecuteResponseDto {
  stepId: string;
  type: WorkflowStepDto['type'];
  /** 此步产出后前端是否应暂停等卦师接管。 */
  pauseAfter: boolean;
  /** AI 步:预测的 assistant 回复消息 id(前端据此等待回复完成);排盘步为空。 */
  assistantMessageId?: string;
  /** 排盘步:生成的盘面消息 id;AI 步为空。 */
  boardMessageId?: string;
}
