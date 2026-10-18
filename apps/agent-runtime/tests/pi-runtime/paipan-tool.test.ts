import { describe, expect, it, vi } from 'vitest';

import { createPiCustomTools } from '#agent/pi-runtime/tools';
import { createRequestScope } from '#agent/request-scope';

function setup(paipan = vi.fn()) {
  const recordExecution = vi.fn();
  const tools = createPiCustomTools({
    requestScope: createRequestScope(),
    accountId: 'web:synthetic-user',
    soulStore: { read: vi.fn(), canEdit: vi.fn(), update: vi.fn() },
    recordExecution,
    paipan,
  });
  return { tools, paipan, recordExecution };
}

describe('conversation paipan tool', () => {
  it('discovers authorized parameters and makes a newly saved board readable in the same turn', async () => {
    const { tools, paipan, recordExecution } = setup();
    const create = tools.find((tool) => tool.name === 'create_paipan');
    const read = tools.find((tool) => tool.name === 'get_session_board');
    expect(create).toBeDefined();
    expect(read).toBeDefined();

    const catalog = [
      {
        skill: 'jingzhan-paipan',
        name: '经占排盘',
        parameters: { type: 'object', properties: {} },
      },
    ];
    paipan.mockResolvedValueOnce({ ok: true, mode: 'catalog', catalog });
    const discovery = await create!.execute(
      'catalog-1',
      { mode: 'catalog' },
      undefined,
      undefined,
      undefined as never,
    );
    expect(discovery.details).toMatchObject({ isError: false, catalog });

    const board = {
      sourceMessageId: 'saved-board',
      source: 'official_paipan',
      skill: 'jingzhan-paipan',
      artifactTitle: '经占排盘',
      promptText: '本卦：乾为天',
      artifactData: { yao: '777777' },
      isCurrent: true,
    };
    paipan.mockResolvedValue({ ok: true, mode: 'create', board });
    const created = await create!.execute(
      'create-1',
      {
        mode: 'create',
        skill: 'jingzhan-paipan',
        input: { method: 'manual', yao: '777777' },
      },
      undefined,
      undefined,
      undefined as never,
    );
    expect(created.details).toMatchObject({
      isError: false,
      board: { sourceMessageId: 'saved-board', promptText: '本卦：乾为天' },
      interpretationGuidance: expect.stringContaining('不要使用六爻'),
    });
    expect(paipan).toHaveBeenLastCalledWith(
      {
        mode: 'create',
        skill: 'jingzhan-paipan',
        input: { method: 'manual', yao: '777777' },
        toolCallId: 'create-1',
      },
      undefined,
    );

    const detail = await read!.execute(
      'read-1',
      { mode: 'detail', sourceMessageId: 'saved-board' },
      undefined,
      undefined,
      undefined as never,
    );
    expect(detail.details).toMatchObject({
      isError: false,
      total: 1,
      board: { promptText: '本卦：乾为天', isCurrent: true },
    });
    // The API already owns the saved card; attaching it to the final reply would duplicate it.
    expect(
      recordExecution.mock.calls.some(([record]) => record.skillContextEntry),
    ).toBe(false);

    await create!.execute(
      'create-1',
      {
        mode: 'create',
        skill: 'jingzhan-paipan',
        input: { method: 'manual', yao: '777777' },
      },
      undefined,
      undefined,
      undefined as never,
    );
    const list = await read!.execute(
      'list-1',
      { mode: 'list' },
      undefined,
      undefined,
      undefined as never,
    );
    expect(list.details).toMatchObject({ total: 1 });
  });

  it('returns validation and transport failures without adding a fictional board', async () => {
    const { tools, paipan } = setup();
    const create = tools.find((tool) => tool.name === 'create_paipan');
    expect(create).toBeDefined();
    const missing = await create!.execute(
      'missing',
      { mode: 'create', skill: 'bazi-paipan' },
      undefined,
      undefined,
      undefined as never,
    );
    expect(missing.details).toMatchObject({ isError: true });
    expect(paipan).not.toHaveBeenCalled();
    paipan.mockResolvedValueOnce({
      ok: false,
      code: 'PAIPAN.PARAM_INVALID',
      error: '缺少必填参数 hour',
    });
    const invalid = await create!.execute(
      'invalid',
      { mode: 'create', skill: 'bazi-paipan', input: {} },
      undefined,
      undefined,
      undefined as never,
    );
    expect(invalid.details).toMatchObject({
      isError: true,
      error: '缺少必填参数 hour',
    });
    paipan.mockRejectedValueOnce(new Error('synthetic unavailable'));
    const unavailable = await create!.execute(
      'unavailable',
      { mode: 'catalog' },
      undefined,
      undefined,
      undefined as never,
    );
    expect(unavailable.details).toMatchObject({ isError: true });
    expect(JSON.stringify(unavailable)).not.toContain('synthetic unavailable');
    const list = await tools
      .find((tool) => tool.name === 'get_session_board')!
      .execute(
        'list',
        { mode: 'list' },
        undefined,
        undefined,
        undefined as never,
      );
    expect(list.details).toMatchObject({ total: 0 });
  });
});
