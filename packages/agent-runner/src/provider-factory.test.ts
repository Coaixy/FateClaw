import { describe, expect, it } from 'vitest';

import { AnthropicAdapter } from './anthropic-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { OpenAIResponsesAdapter } from './openai-responses-adapter.js';
import { createLoopAdapterFromRuntime } from './provider-factory.js';
import type { LlmRuntimeSnapshot } from './types.js';

function runtime(
  provider: LlmRuntimeSnapshot['provider'],
): LlmRuntimeSnapshot {
  return {
    source: 'official',
    billingMode: 'metered',
    modelConfigId: `official-${provider}`,
    provider,
    model:
      provider === 'anthropic'
        ? 'claude-sonnet-4-20250514'
        : provider === 'gemini'
          ? 'gemini-2.5-pro'
          : 'gpt-4.1',
    apiKey: 'db-secret',
    authMode:
      provider === 'anthropic'
        ? 'anthropic_api_key'
        : provider === 'gemini'
          ? 'gemini_api_key'
          : 'openai_api_key',
    providerKey: `main-${provider}`,
  };
}

describe('createLoopAdapterFromRuntime', () => {
  it('creates an OpenAI-compatible adapter from explicit runtime', () => {
    const result = createLoopAdapterFromRuntime(runtime('openai-compatible'));

    expect(result.model).toBe('gpt-4.1');
    expect(result.adapter).toBeInstanceOf(OpenAIAdapter);
  });

  it('creates an OpenAI Responses adapter from explicit runtime', () => {
    const result = createLoopAdapterFromRuntime(runtime('openai-response'));

    expect(result.model).toBe('gpt-4.1');
    expect(result.adapter).toBeInstanceOf(OpenAIResponsesAdapter);
  });

  it('creates an Anthropic adapter from explicit runtime', () => {
    const result = createLoopAdapterFromRuntime(runtime('anthropic'));

    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.adapter).toBeInstanceOf(AnthropicAdapter);
  });

  it('creates a Gemini adapter from explicit runtime', () => {
    const result = createLoopAdapterFromRuntime(runtime('gemini'));

    expect(result.model).toBe('gemini-2.5-pro');
    expect(result.adapter).toBeInstanceOf(GeminiAdapter);
  });
});
