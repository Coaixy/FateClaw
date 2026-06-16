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
export type PaipanCommitRequest = PaipanCommitRequestDto;
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
