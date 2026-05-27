import { describe, expect, it } from 'vitest';

import type { LlmRuntimeSnapshot } from '../types.js';
import { createPiProviderRuntime } from './provider.js';

const runtime: LlmRuntimeSnapshot = {
  source: 'custom',
  billingMode: 'none',
  modelConfigId: 'user-1',
  provider: 'openai-compatible',
  model: 'gpt-4o',
  contextWindowTokens: 8192,
  maxOutputTokens: 1024,
  apiKey: 'request-scoped-key',
  baseUrl: 'https://llm.example.test/v1',
  authMode: 'openai_api_key',
  providerKey: 'main-openai',
};

describe('createPiProviderRuntime', () => {
  it('registers request runtime auth as an in-memory Pi provider', async () => {
    const pi = createPiProviderRuntime(runtime);

    expect(pi.model.provider).toBe('fateclaw-openai-compatible-main-openai');
    expect(pi.model.id).toBe('gpt-4o');
    expect(pi.model.baseUrl).toBe('https://llm.example.test/v1');
    expect(pi.model.contextWindow).toBe(8192);
    expect(pi.model.maxTokens).toBe(1024);
    await expect(
      pi.authStorage.getApiKey('fateclaw-openai-compatible-main-openai'),
    ).resolves.toBe('request-scoped-key');
    expect(
      pi.authStorage.getAuthStatus('fateclaw-openai-compatible-main-openai')
        .source,
    ).toBe('runtime');
  });
});
