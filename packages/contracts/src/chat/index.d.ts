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
}
