/**
 * 卦师自定义工作流 —— 跨端契约 (DTO)。
 *
 * 设计稿: docs/spark/2026-06-21-guashi-workflow-dag-design.md
 * v1 形态: Dify/Coze 式画布 DAG; 并行分叉 + 汇总(fan-out / fan-in), 不做条件判断。
 *   - 一个排盘节点起盘 → 盘面分叉到多个 AI 节点(各绑不同 skill)。
 *   - 多条分支可汇入一个新 AI 节点(prompt 引用各上游产出)。
 *   - 多个末端(叶)节点 = 多份成品输出。
 * 运行: 混合(每节点可设 pauseAfter); 节点类型两种: 排盘 + AI 解读。
 *
 * schema 决策(2026-06-21):
 *   - 排盘节点是固定机械流程、不经 AI,因此只有 skill + inputDefaults,没有 prompt。
 *   - modelPolicy 每个 AI 节点独立(初断可用快模型、深化可用 high 思考)。
 *   - 引用语法: {{node.<上游id>.output}} 引上游 AI 产出、{{input.<key>}} 引本次输入。
 *     盘面不进引用语法,靠会话 selectedBoardMessageId 自动透传给 AI 节点。
 */

import type { ChatSessionDto, SimpleModelPolicyDto } from '../chat/index.js';

/** 画布坐标(React Flow 节点位置,仅用于编辑器渲染,不参与执行)。 */
export interface WorkflowNodePositionDto {
  x: number;
  y: number;
}

/** 节点公共字段(两种节点都有)。 */
export interface WorkflowNodeBaseDto {
  /**
   * 节点稳定 id —— 被引用语法 {{node.<id>.output}} 与运行消息 id 约定
   * (wf-<id>-<ts>-<rand>_reply)使用。因 '-' 是消息 id 的分隔符,id 仅允许 [A-Za-z0-9_]。
   */
  id: string;
  /** 卦师可读的节点名称。 */
  title: string;
  /** 此节点产出后是否暂停等卦师接管("自动过"= false,"停下来让我看/润色"= true)。 */
  pauseAfter: boolean;
  /** 画布坐标(编辑器布局用)。 */
  position: WorkflowNodePositionDto;
}

/** 排盘节点:跑某术数,产出盘面。排盘是固定机械流程,不经 AI。 */
export interface WorkflowPaipanNodeDto extends WorkflowNodeBaseDto {
  type: 'paipan';
  /** 术数,如 'bazi-paipan' / 'iching-paipan'。 */
  skill: string;
  /** 排盘默认参数(起卦方式、八字 include 等);运行时可被客户生辰预填覆盖。 */
  inputDefaults: Record<string, unknown>;
}

/** AI 解读节点:用 prompt 模板 + 绑定 skill + 模型,产出文本。 */
export interface WorkflowAiNodeDto extends WorkflowNodeBaseDto {
  type: 'ai';
  /** prompt 模板,可含 {{ 引用 }}(如 {{node.chuduan.output}}、{{input.question}})。 */
  promptTemplate: string;
  /** 卦师选定的源 skill id[](前端可编辑;保存定义时据此生成快照)。 */
  skillIds: string[];
  /** 冻结的 skill 快照 id[](服务端保存时写入,前端只读;对应"绑 skill 不漂移")。 */
  skillSnapshotIds: string[];
  /** 该节点的模型策略(每节点独立)。复用 chat 域 SimpleModelPolicyDto。 */
  modelPolicy: SimpleModelPolicyDto;
}

/** 工作流节点(判别联合)。 */
export type WorkflowNodeDto = WorkflowPaipanNodeDto | WorkflowAiNodeDto;

/** 有向边(上游 → 下游)。用于拓扑就绪判定:下游就绪 = 所有入边上游都已完成。 */
export interface WorkflowEdgeDto {
  id: string;
  /** 上游节点 id。 */
  source: string;
  /** 下游节点 id。 */
  target: string;
}

/** 工作流图(DAG):节点 + 边。约束:无环;节点 id 唯一。 */
export interface WorkflowGraphDto {
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
}

/**
 * 运行前要卦师填写的输入项(定义级配置)。
 *
 * @remarks key 用于 AI 节点 prompt 的 {{input.<key>}} 引用,仅允许 [A-Za-z0-9_]、定义内唯一。
 *          inputs 为空时,运行页回退为默认的单个 "question" 输入框(向后兼容旧工作流)。
 */
export interface WorkflowRunInputDto {
  /** 引用键,用于 {{input.<key>}}。 */
  key: string;
  /** 卦师可读的标签(运行表单显示)。 */
  label: string;
  /** 输入控件类型。 */
  type: 'text' | 'textarea';
  /** 是否必填。 */
  required: boolean;
}

/** 工作流定义(卦师作者作用域;运行不另建表,run = chat session,详见设计稿)。 */
export interface WorkflowDefinitionDto {
  id: string;
  name: string;
  description: string;
  /** 工作流图(DAG)。 */
  graph: WorkflowGraphDto;
  /** 运行前要填的输入项;空数组表示沿用默认 question 输入。 */
  inputs: WorkflowRunInputDto[];
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
 * 创建/更新时的节点输入。
 *
 * @remarks 与读取态 WorkflowNodeDto 的差别:AI 节点的 skillSnapshotIds 由服务端在保存时写入,
 *          故输入里不带它(传了也会被忽略)。节点 id 必填且需稳定——前端新增节点时生成、
 *          之后不变,因为它是引用语法与运行记录的锚点。
 */
export type WorkflowNodeInputDto =
  | WorkflowPaipanNodeDto
  | Omit<WorkflowAiNodeDto, 'skillSnapshotIds'>;

/** 创建/更新时的图输入(节点为输入态,边同读取态)。 */
export interface WorkflowGraphInputDto {
  nodes: WorkflowNodeInputDto[];
  edges: WorkflowEdgeDto[];
}

/** 工作流创建/更新请求体(整体覆盖语义)。 */
export interface WorkflowDefinitionUpsertDto {
  name: string;
  description?: string;
  /** 工作流图(至少 1 个节点)。 */
  graph: WorkflowGraphInputDto;
  /** 运行前要填的输入项;不传则视为空数组。 */
  inputs?: WorkflowRunInputDto[];
  enabled?: boolean;
  sort_order?: number;
}

// ───────────────────────────── 运行(run) ─────────────────────────────
// 运行不另建状态表:一次运行 = 一个 chat session,每节点产出 = 一条 message。
// 前端驱动循环:启动拿到图(节点+边)→ 按拓扑序逐个 execute 就绪节点 →
// 按 pauseAfter 决定自动续跑或停;末端(叶)节点各自是一份成品。

/** 启动一次运行的请求体。 */
export interface WorkflowRunStartRequestDto {
  /** 可选关联客户档案:排盘节点会用其生辰预填。 */
  clientId?: string;
  /** 卦师本次填写的输入(键为定义里 inputs 的 key);AI 节点可用 {{input.<key>}} 引用。 */
  input?: Record<string, string>;
}

/** 运行时节点的精简视图(前端拓扑执行只需这些)。 */
export interface WorkflowRunNodeDto {
  id: string;
  type: WorkflowNodeDto['type'];
  title: string;
  pauseAfter: boolean;
}

/** 启动运行的响应:新会话 + 图(节点清单 + 边,供前端算拓扑序)+ 本次运行的输入项定义。 */
export interface WorkflowRunStartResponseDto {
  session: ChatSessionDto;
  nodes: WorkflowRunNodeDto[];
  edges: WorkflowEdgeDto[];
  /** 运行前要填的输入项(供运行页渲染表单);空数组时前端回退默认 question 框。 */
  inputs: WorkflowRunInputDto[];
}

/** 一次工作流运行的摘要(运行历史列表用)。 */
export interface WorkflowRunSummaryDto {
  /** 运行会话 id(= 查看该次运行的入口)。 */
  sessionId: string;
  /** 运行开始时间(会话创建时间,ISO)。 */
  startedAt: string;
  /** 关联客户 id;未关联为空。 */
  clientId?: string;
  /** 运行标题(保存运行时的工作流名快照)。 */
  title: string;
}

/** 工作流运行历史响应(按工作流聚合,创建时间倒序)。 */
export interface WorkflowRunListResponseDto {
  runs: WorkflowRunSummaryDto[];
}

/** 单节点执行的请求体。 */
export interface WorkflowRunNodeExecuteRequestDto {
  /**
   * AI 节点**直接入边**排盘节点产出的盘面消息 id 列表 —— 前端按 graph 算出。
   * 后端只把这些盘注入该 AI(实现分支上下文隔离),首个作主盘面;空数组 = 不带任何盘
   * (如纯汇总节点,只吃上游 AI 的 output 文本)。
   */
  boardMessageIds?: string[];
}

/** 单节点执行的响应。 */
export interface WorkflowRunNodeExecuteResponseDto {
  nodeId: string;
  type: WorkflowNodeDto['type'];
  /** 此节点产出后前端是否应暂停等卦师接管。 */
  pauseAfter: boolean;
  /** AI 节点:预测的 assistant 回复消息 id(前端据此等待回复完成);排盘节点为空。 */
  assistantMessageId?: string;
  /** 排盘节点:生成的盘面消息 id;AI 节点为空。 */
  boardMessageId?: string;
}
