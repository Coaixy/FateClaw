import { describe, expect, it, vi } from 'vitest';

import { GeminiAdapter } from './gemini-adapter.js';

describe('GeminiAdapter', () => {
  it('maps maxOutputTokens to Gemini generationConfig.maxOutputTokens', async () => {
    const generateContent = vi.fn(async () => ({
      candidates: [
        {
          content: { parts: [{ text: '好' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      },
    }));
    const adapter = new GeminiAdapter({ generateContent } as never);

    await adapter.createCompletion(
      [{ role: 'user', parts: [{ text: '看这个盘' }] }],
      {
        model: 'gemini-2.5-pro',
        maxOutputTokens: 24_000,
      },
    );

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        generationConfig: expect.objectContaining({
          maxOutputTokens: 24_000,
        }),
      }),
      expect.any(Object),
    );
  });

  it('uses modelOutput when building Gemini function responses', () => {
    const adapter = new GeminiAdapter({} as never);

    expect(
      adapter.buildToolResultMessages([
        {
          toolCall: {
            name: 'iching-paipan',
            args: {},
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
        parts: [
          {
            functionResponse: {
              name: 'iching-paipan',
              response: {
                output: '【六爻排盘 AI摘要】\n卦: 既济 -> 随',
              },
            },
          },
        ],
      },
    ]);
  });
});
