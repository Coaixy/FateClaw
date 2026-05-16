import { describe, expect, it, vi } from 'vitest';

import { OpenAIAdapter } from './openai-adapter.js';
import type { ToolDefinition } from './types.js';

function toolDefinition(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} description`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  };
}

describe('OpenAIAdapter', () => {
  it('preserves provider reasoning_content on assistant tool-call messages', async () => {
    const create = vi.fn(async () => ({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: '需要先查询知识库。',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'read_knowledge_section',
                  arguments: '{}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
      },
    }));
    const adapter = new OpenAIAdapter({
      baseURL: 'https://compatible.example/v1',
      chat: {
        completions: {
          create,
        },
      },
    } as never);

    const result = await adapter.createCompletion(
      [{ role: 'user', content: '看这个盘' }],
      {
        model: 'deepseek-reasoner',
        maxOutputTokens: 24_000,
        tools: [toolDefinition('read_knowledge_section')],
      },
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 24_000,
      }),
      expect.any(Object),
    );
    expect(result.rawAssistantMessage).toMatchObject({
      role: 'assistant',
      content: null,
      reasoning_content: '需要先查询知识库。',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
        },
      ],
    });
  });

  it('uses modelOutput when building OpenAI-compatible tool results', () => {
    const adapter = new OpenAIAdapter({
      baseURL: 'https://compatible.example/v1',
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    } as never);

    expect(
      adapter.buildToolResultMessages([
        {
          toolCall: {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'iching-paipan',
              arguments: '{}',
            },
          },
          result: {
            output: '{"raw":true}',
            modelOutput: '【六爻排盘 AI摘要】\n卦: 既济 -> 随',
          },
        },
      ]),
    ).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: '【六爻排盘 AI摘要】\n卦: 既济 -> 随',
      },
    ]);
  });

  it('converts optional properties to nullable required fields for OpenAI strict tools', async () => {
    const create = vi.fn(async () => ({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [],
          },
        },
      ],
      usage: null,
    }));
    const adapter = new OpenAIAdapter({
      baseURL: 'https://api.openai.com/v1',
      chat: {
        completions: {
          create,
        },
      },
    } as never);

    await adapter.createCompletion(
      [{ role: 'user', content: '看八字' }],
      {
        model: 'gpt-4o',
        tools: [
          {
            type: 'function',
            function: {
              name: 'interpret_xuanxue',
              description: '玄学解读',
              parameters: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  question: { type: 'string' },
                },
                required: [],
              },
            },
          },
        ],
      },
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            function: expect.objectContaining({
              strict: true,
              parameters: {
                type: 'object',
                properties: {
                  content: { type: ['string', 'null'] },
                  question: { type: ['string', 'null'] },
                },
                required: ['content', 'question'],
                additionalProperties: false,
              },
            }),
          }),
        ],
      }),
      expect.any(Object),
    );
  });
});
