/**
 * 聊天域跨端契约。
 */

import type { TextResponse } from '../common/api.js';

export interface MessageMetadataDto {
  kind?: string;
  stage?: string;
  workflow?: string;
  board_skill?: string;
  query_text?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_label?: string;
  tool_status?: 'running' | 'completed' | 'failed';
  tool_path?: string;
  turn_complete?: boolean;
  request_id?: string;
  /** 本轮 AI 回复从提交到最终响应的耗时，单位毫秒。 */
  duration_ms?: number;
  /** 本轮 AI 回复实际结算的积分金额。 */
  actual_charge_coins?: number;
  /** 本轮 AI 回复按模型价格计算的原始积分金额。 */
  raw_charge_coins?: number;
}

export interface MessageDto {
  id: string;
  account_id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
  metadata?: MessageMetadataDto | null;
  tool_context?: string | null;
}

export interface SessionMessageListResponseDto {
  messages: MessageDto[];
  processing: boolean;
  /** 当前会话是否因 Pi session 本地状态缺失而禁止继续追问。 */
  continuation_blocked?: boolean;
  /** 禁止追问的机器可读原因。 */
  continuation_block_reason?: 'pi_session_missing';
  /** 禁止追问时展示给用户的提示文案。 */
  continuation_block_message?: string;
}

export interface ChatSessionDto {
  id: string;
  account_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  share_token?: string | null;
  /** 会话归档时间；未归档时为空。 */
  deleted_at?: string | null;
  /** 关联的客户档案 id；未关联时为空。 */
  client_id?: string | null;
}

/** 客户（被算者）档案。卦师为客户建档，发起排盘时关联并用生辰预填。 */
export interface ClientProfileDto {
  id: string;
  name: string;
  gender?: '男' | '女' | null;
  /** 阳历生日 YYYY-MM-DD。 */
  solar_date?: string | null;
  /** 出生小时 0-23。 */
  hour?: number | null;
  /** 出生分钟 0-59。 */
  minute?: number | null;
  birthplace?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  /** 该客户的解读会话数（列表统计用，可选）。 */
  session_count?: number;
  /** 该客户最近一次解读时间（可选）。 */
  last_session_at?: string | null;
}

/** 创建/更新客户档案的请求体。 */
export interface ClientProfileUpsertDto {
  name: string;
  gender?: '男' | '女' | null;
  solar_date?: string | null;
  hour?: number | null;
  minute?: number | null;
  birthplace?: string | null;
  notes?: string | null;
}

export interface ClientProfileListResponseDto {
  clients: ClientProfileDto[];
}

export interface ChatSessionShareResponseDto {
  share_token: string;
  share_url_path: string;
  session: ChatSessionDto;
}

export interface SharedChatSessionDto {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: MessageDto[];
}

export type ChatInputKindDto = 'normal' | 'user_pasted_board';

export interface UserPastedBoardInputDto {
  category: string;
  content: string;
  question: string;
}

export interface NormalChatSessionSendRequestDto {
  content: string;
  selected_board_message_id?: string;
  input_kind?: 'normal';
}

export interface UserPastedBoardChatSessionSendRequestDto {
  content?: string;
  selected_board_message_id?: string;
  input_kind: 'user_pasted_board';
  pasted_board: UserPastedBoardInputDto;
}

export type ChatSessionSendRequestDto =
  | NormalChatSessionSendRequestDto
  | UserPastedBoardChatSessionSendRequestDto;

export type SkillParamTypeDto =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object';

export interface SkillParamItemSchemaDto {
  type: SkillParamTypeDto;
  enum?: unknown[];
}

export interface SkillParamPropertyDto {
  type: SkillParamTypeDto | SkillParamTypeDto[];
  description: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: SkillParamItemSchemaDto;
  properties?: Record<string, SkillParamPropertyDto>;
  required?: string[];
}

export interface SkillConditionalRequirementDto {
  when: {
    field: string;
    equals: unknown;
  };
  required: string[];
  description?: string;
}

export interface SkillExamplePayloadDto {
  name?: string;
  description?: string;
  value: Record<string, unknown>;
}

export interface SkillParametersSchemaDto {
  type: 'object';
  properties: Record<string, SkillParamPropertyDto>;
  required?: string[];
  conditionalRequired?: SkillConditionalRequirementDto[];
  atLeastOneOf?: string[][];
  allOrNoneOf?: string[][];
  examples?: SkillExamplePayloadDto[];
}

export interface SkillContextEntryDto {
  skill: string;
  output: string;
  artifactType?: string;
  artifactTitle?: string;
  artifactData?: unknown;
}

export interface PaipanCatalogItemDto {
  skill: string;
  name: string;
  description: string;
  parameters?: SkillParametersSchemaDto;
  examples?: SkillExamplePayloadDto[];
}

export interface PaipanPreviewResponseDto {
  previewId: string;
  skillContextEntry: SkillContextEntryDto;
  expiresAt: string;
}

/**
 * 八字干支反推请求。
 *
 * year/month/day 为必填三柱；hour 为空时只反推公历日期，传入时反推具体时间。
 */
export interface PaipanGanzhiReverseRequestDto {
  year: string;
  month: string;
  day: string;
  hour?: string;
  startYear: number;
  endYear: number;
  limit?: number;
}

/**
 * 干支反推命中的单个公历候选。
 */
export interface PaipanGanzhiReverseMatchDto {
  solar: string;
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/**
 * 八字干支反推响应。
 */
export interface PaipanGanzhiReverseResponseDto {
  mode: 'three_pillars' | 'eight_char';
  input: PaipanGanzhiReverseRequestDto;
  matches: PaipanGanzhiReverseMatchDto[];
  total: number;
  truncated: boolean;
}

export interface PaipanCommitRequestDto {
  target: 'new_session_from_preview' | 'current_session';
  previewId?: string;
  sessionId?: string;
  skill?: string;
  input?: Record<string, unknown>;
}

export interface PaipanCommitResponseDto {
  session: ChatSessionDto;
  requestMessage: MessageDto;
  resultMessage: MessageDto;
}

export type QueryProcessStepType =
  | 'matched_skills'
  | 'interpretation_start'
  | 'view_index'
  | 'read_section'
  | 'completed'
  | 'fallback';

export interface QueryProcessStepDto {
  type: QueryProcessStepType;
  timestamp: string;
  title: string;
  detail?: string;
  queryText?: string;
  skillDir?: string;
  skillName?: string;
  sectionTitle?: string;
}

export interface QueryProcessResponseDto {
  available: boolean;
  request_id: string | null;
  timeline: QueryProcessStepDto[];
}

export interface ChatSessionSendResponseDto extends TextResponse {
  session_title?: string;
  /** 异步提交后的后台请求 ID，可用于关联流式事件和查询过程。 */
  request_id?: string;
  /** 为 true 表示服务端已接收并开始后台处理，text 可为空。 */
  accepted?: true;
}

export type SimpleWorkflowKindDto = 'divination' | 'natal';

export type SimpleWorkflowPaipanSkillDto = 'iching-paipan' | 'bazi-paipan';

export type SimpleModelPolicyModeDto =
  | 'system-default'
  | 'user-current'
  | 'fixed';

export type SimpleModelThinkingLevelDto =
  | 'off'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface SimpleModelPolicyDto {
  mode: SimpleModelPolicyModeDto;
  fixedModelId?: string;
  thinkingLevel?: SimpleModelThinkingLevelDto;
}

export interface SimpleWorkflowPresetDto {
  id: string;
  kind: SimpleWorkflowKindDto;
  name: string;
  enabled: boolean;
  is_default: boolean;
  entry_title: string;
  entry_description: string;
  paipan_skill: SimpleWorkflowPaipanSkillDto;
  paipan_input_defaults: Record<string, unknown>;
  model_policy: SimpleModelPolicyDto;
  skill_bundle_ids: string[];
  skill_ids: string[];
  skill_snapshot_ids: string[];
  prompt_template: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type SimpleWorkflowStartRequestDto =
  | {
      kind: 'divination';
      question: string;
      background?: string;
    }
  | {
      kind: 'natal';
      solarDate: string;
      hour: number;
      minute?: number;
      gender: '男' | '女';
      questionDirection: string;
    };

export interface SimpleWorkflowStartResponseDto {
  session: ChatSessionDto;
  boardMessageId: string;
  assistantMessageId?: string;
  requestId?: string;
  warning?: string;
}
