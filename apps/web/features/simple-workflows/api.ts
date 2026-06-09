import type {
  SimpleWorkflowStartRequestDto,
  SimpleWorkflowStartResponseDto,
} from '@fateclaw/contracts/chat';

import { requestJson } from '@/lib/http/client';

export type SimpleWorkflowStartRequest = SimpleWorkflowStartRequestDto;
export type SimpleWorkflowStartResponse = SimpleWorkflowStartResponseDto;

export const simpleWorkflowsApi = {
  start: (input: SimpleWorkflowStartRequest) =>
    requestJson<SimpleWorkflowStartResponse>('/api/simple-workflows/start', {
      method: 'POST',
      body: JSON.stringify(input),
      exposeServerErrorMessage: true,
    }),
};
