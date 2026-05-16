import { describe, expect, it, vi } from 'vitest';

import { AnthropicAdapter } from './anthropic-adapter.js';

describe('AnthropicAdapter', () => {
  it('maps maxOutputTokens to Anthropic max_tokens', async () => {
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: '好' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    }));
    const adapter = new AnthropicAdapter({
      messages: { create },
    } as never);

    await adapter.createCompletion([{ role: 'user', content: '看这个盘' }], {
      model: 'claude-sonnet-4-20250514',
      maxOutputTokens: 24_000,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 24_000,
      }),
      expect.any(Object),
    );
  });

  it('uses modelOutput when building Anthropic tool results', () => {
    const adapter = new AnthropicAdapter({} as never);

    expect(
      adapter.buildToolResultMessages([
        {
          toolCall: {
            id: 'toolu-1',
            type: 'tool_use',
            caller: { type: 'direct' },
            name: 'iching-paipan',
            input: {},
          },
          result: {
            output: '{"raw":true}',
            modelOutput: '【六爻排盘 AI摘要】\n卦: 既济 -> 随',
          },
        },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-1',
            content: '【六爻排盘 AI摘要】\n卦: 既济 -> 随',
            is_error: false,
          },
        ],
      },
    ]);
  });
});
