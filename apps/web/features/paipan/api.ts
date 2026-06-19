import type {
  PaipanCatalogItemDto,
  PaipanCommitRequestDto,
  PaipanCommitResponseDto,
  PaipanGanzhiReverseRequestDto,
  PaipanGanzhiReverseResponseDto,
  PaipanPreviewResponseDto,
  SkillParametersSchemaDto,
} from '@fateclaw/contracts/chat';

import { requestJson } from '@/lib/http/client';

export type PaipanCatalogItem = PaipanCatalogItemDto;
export type PaipanPreviewResponse = PaipanPreviewResponseDto;
export type PaipanCommitResponse = PaipanCommitResponseDto;
/**
 * 排盘提交请求。
 *
 * 在契约 `PaipanCommitRequestDto` 基础上附加可选 `client_id`：选择客户档案发起排盘时，
 * 把客户关联透传给后端，后端据此把生成的会话与客户绑定。契约本身不含该字段，故在 web 层扩展。
 */
export type PaipanCommitRequest = PaipanCommitRequestDto & {
  client_id?: string | null;
};
export type PaipanGanzhiReverseRequest = PaipanGanzhiReverseRequestDto;
export type PaipanGanzhiReverseResponse = PaipanGanzhiReverseResponseDto;
export type PaipanSchema = SkillParametersSchemaDto;

export const paipanApi = {
  catalog: () => requestJson<PaipanCatalogItem[]>('/api/paipan/catalog'),
  preview: (input: {
    skill: string;
    input: Record<string, unknown>;
  }) =>
    requestJson<PaipanPreviewResponse>('/api/paipan/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  ganzhiReverse: (input: PaipanGanzhiReverseRequest) =>
    requestJson<PaipanGanzhiReverseResponse>('/api/paipan/ganzhi-reverse', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  commit: (input: PaipanCommitRequest) =>
    requestJson<PaipanCommitResponse>('/api/paipan/commit', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
