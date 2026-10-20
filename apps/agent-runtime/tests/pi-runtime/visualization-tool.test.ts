import { describe, expect, it, vi } from 'vitest';
import { createPiCustomTools } from '#agent/pi-runtime/tools';
import { createRequestScope } from '#agent/request-scope';

const input = {
  type: 'mermaid' as const,
  title: '分析流程',
  summary: '解读步骤示意。',
  spec: 'flowchart LR\nA-->B',
};
const id = `visualization-${'a'.repeat(64)}`;

function setup(visualization?: ReturnType<typeof vi.fn>) {
  return createPiCustomTools({
    requestScope: createRequestScope(),
    accountId: 'web:synthetic-user',
    soulStore: { read: vi.fn(), canEdit: vi.fn(), update: vi.fn() },
    recordExecution: vi.fn(),
    visualization,
  });
}

describe('render_visualization', () => {
  it('exposes a durable reference only after the host confirms persistence', async () => {
    expect(setup().some((tool) => tool.name === 'render_visualization')).toBe(
      false,
    );
    const caller = vi.fn().mockResolvedValue({
      ok: true,
      sessionId: 'synthetic-session',
      artifact: { ...input, id, version: 1 },
      createdAt: '2026-10-20T00:00:00Z',
    });
    const tool = setup(caller).find(
      (tool) => tool.name === 'render_visualization',
    )!;
    const result = await tool.execute(
      'draw-1',
      input,
      undefined,
      undefined,
      undefined as never,
    );
    expect(caller).toHaveBeenCalledWith(
      { ...input, toolCallId: 'draw-1' },
      undefined,
    );
    expect(result.details).toMatchObject({
      isError: false,
      saved: true,
      id,
      reference: `\`\`\`visualization\n${id}\n\`\`\``,
    });
    expect(JSON.stringify(result)).not.toContain('flowchart');
  });

  it('rejects external data before dispatch and reports host failures without claiming success', async () => {
    const caller = vi.fn();
    const tool = setup(caller).find(
      (tool) => tool.name === 'render_visualization',
    )!;
    const invalid = await tool.execute(
      'invalid',
      {
        ...input,
        type: 'vega-lite',
        spec: { data: { url: 'https://example.test' }, mark: 'bar' },
      },
      undefined,
      undefined,
      undefined as never,
    );
    expect(invalid.details).toMatchObject({ isError: true });
    expect(caller).not.toHaveBeenCalled();
    caller.mockResolvedValueOnce({
      ok: false,
      code: 'VISUALIZATION.TIMEOUT',
      error: '没有收到结果',
    });
    const failed = await tool.execute(
      'timeout',
      input,
      undefined,
      undefined,
      undefined as never,
    );
    expect(failed.details).toMatchObject({
      isError: true,
      code: 'VISUALIZATION.TIMEOUT',
    });
    expect(JSON.stringify(failed)).not.toContain('"saved":true');
  });
});
