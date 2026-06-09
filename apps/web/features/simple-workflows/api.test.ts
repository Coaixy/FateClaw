import { beforeEach, describe, expect, it, vi } from 'vitest';

import { simpleWorkflowsApi } from './api';

import { requestJson } from '@/lib/http/client';

vi.mock('@/lib/http/client', () => ({
  requestJson: vi.fn(),
}));

const requestJsonMock = vi.mocked(requestJson);

describe('simpleWorkflowsApi.start', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({
      session: {
        id: 'session-1',
        account_id: 'web:user-1',
        title: '占卜问事',
        created_at: '2026-06-09T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
        deleted_at: null,
      },
      boardMessageId: 'board-1',
    });
  });

  it('serializes divination workflow starts', async () => {
    await simpleWorkflowsApi.start({
      kind: 'divination',
      question: '看看工作',
      background: '最近纠结',
    });

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/simple-workflows/start',
      {
        method: 'POST',
        body: JSON.stringify({
          kind: 'divination',
          question: '看看工作',
          background: '最近纠结',
        }),
        exposeServerErrorMessage: true,
      },
    );
  });

  it('serializes natal workflow starts', async () => {
    await simpleWorkflowsApi.start({
      kind: 'natal',
      solarDate: '1990-01-02',
      hour: 8,
      minute: 30,
      gender: '男',
      questionDirection: '事业方向',
    });

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/simple-workflows/start',
      {
        method: 'POST',
        body: JSON.stringify({
          kind: 'natal',
          solarDate: '1990-01-02',
          hour: 8,
          minute: 30,
          gender: '男',
          questionDirection: '事业方向',
        }),
        exposeServerErrorMessage: true,
      },
    );
  });
});
