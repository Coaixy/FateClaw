import { describe, expect, it, vi } from 'vitest';

import { OpenAIResponsesAdapter } from './openai-responses-adapter.js';
import type { ToolDefinition } from './types.js';

function toolDefinition(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} description`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
  };
}

describe('OpenAIResponsesAdapter', () => {
  it('maps Responses API function calls into loop tool calls', async () => {
    const create = vi.fn(async () => ({
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'read_knowledge_section',
          arguments: '{"query":"财运"}',
        },
      ],
      output_text: '',
      usage: {
        input_tokens: 12,
        output_tokens: 8,
      },
      error: null,
      incomplete_details: null,
    }));
    const adapter = new OpenAIResponsesAdapter({
      responses: { create },
    } as never);

    const result = await adapter.createCompletion(
      [{ role: 'user', content: '看财运' }],
      {
        model: 'gpt-5',
        maxOutputTokens: 24_000,
        tools: [toolDefinition('read_knowledge_section')],
        toolChoice: 'required',
      },
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5',
        max_output_tokens: 24_000,
        tool_choice: 'required',
        tools: [
          expect.objectContaining({
            type: 'function',
            name: 'read_knowledge_section',
            strict: true,
          }),
        ],
      }),
      expect.any(Object),
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(adapter.getToolName(result.toolCalls[0])).toBe(
      'read_knowledge_section',
    );
    expect(adapter.getToolArgs(result.toolCalls[0])).toEqual({
      query: '财运',
    });
    expect(result.rawAssistantMessage).toEqual([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call-1',
      }),
    ]);
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 8 });
  });

  it('converts optional properties to nullable required fields for strict tools', async () => {
    const create = vi.fn(async () => ({
      status: 'completed',
      output: [],
      usage: null,
      error: null,
      incomplete_details: null,
    }));
    const adapter = new OpenAIResponsesAdapter({
      responses: { create },
    } as never);

    await adapter.createCompletion(
      [{ role: 'user', content: '看八字' }],
      {
        model: 'gpt-5',
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
        ],
      }),
      expect.any(Object),
    );
  });

  it('builds Responses API function_call_output items', () => {
    const adapter = new OpenAIResponsesAdapter({
      responses: { create: vi.fn() },
    } as never);

    expect(
      adapter.buildToolResultMessages([
        {
          toolCall: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'read_knowledge_section',
            arguments: '{}',
          },
          result: { output: '工具结果' },
        },
      ]),
    ).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '工具结果',
      },
    ]);
  });

  it('uses modelOutput when building Responses API tool results', () => {
    const adapter = new OpenAIResponsesAdapter({
      responses: { create: vi.fn() },
    } as never);

    expect(
      adapter.buildToolResultMessages([
        {
          toolCall: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'iching-paipan',
            arguments: '{}',
          },
          result: {
            output: '{"raw":true}',
            modelOutput: '【六爻排盘 AI摘要】\n卦: 既济 -> 随',
          },
        },
      ]),
    ).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '【六爻排盘 AI摘要】\n卦: 既济 -> 随',
      },
    ]);
  });
});
