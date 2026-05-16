import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import { AnthropicAdapter } from './anthropic-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { OpenAIResponsesAdapter } from './openai-responses-adapter.js';
import { createGeminiClient } from './tools/skill/gemini-client.js';
import type { LoopAdapter } from './base-loop.js';
import type { LlmRuntimeSnapshot } from './types.js';

export interface LoopAdapterFactoryOptions {
  protectedToolNames?: Set<string>;
}

export interface LoopAdapterFactoryResult {
  adapter: LoopAdapter<unknown, unknown>;
  model: string;
}

function requireAuthMode(
  runtime: LlmRuntimeSnapshot,
  allowed: readonly LlmRuntimeSnapshot['authMode'][],
): void {
  if (!allowed.includes(runtime.authMode)) {
    throw new Error(
      `provider ${runtime.provider} 不支持 authMode=${runtime.authMode}`,
    );
  }
}

function createAnthropicClient(runtime: LlmRuntimeSnapshot): Anthropic {
  requireAuthMode(runtime, [
    'anthropic_api_key',
    'claude_code_oauth_token',
  ]);
  if (runtime.authMode === 'claude_code_oauth_token') {
    return new Anthropic({
      apiKey: 'oauth-token',
      authToken: runtime.apiKey,
      baseURL: runtime.baseUrl,
      maxRetries: 2,
      timeout: 120_000,
    });
  }
  return new Anthropic({
    apiKey: runtime.apiKey,
    baseURL: runtime.baseUrl,
    maxRetries: 2,
    timeout: 120_000,
  });
}

export function createLoopAdapterFromRuntime(
  runtime: LlmRuntimeSnapshot,
  options: LoopAdapterFactoryOptions = {},
): LoopAdapterFactoryResult {
  switch (runtime.provider) {
    case 'openai-compatible': {
      requireAuthMode(runtime, ['openai_api_key']);
      const client = new OpenAI({
        apiKey: runtime.apiKey,
        baseURL: runtime.baseUrl,
        maxRetries: 2,
        timeout: 120_000,
      });
      return {
        adapter: new OpenAIAdapter(client, options),
        model: runtime.model,
      };
    }
    case 'openai-response': {
      requireAuthMode(runtime, ['openai_api_key']);
      const client = new OpenAI({
        apiKey: runtime.apiKey,
        baseURL: runtime.baseUrl,
        maxRetries: 2,
        timeout: 120_000,
      });
      return {
        adapter: new OpenAIResponsesAdapter(client, options),
        model: runtime.model,
      };
    }
    case 'anthropic': {
      return {
        adapter: new AnthropicAdapter(createAnthropicClient(runtime), options),
        model: runtime.model,
      };
    }
    case 'gemini': {
      requireAuthMode(runtime, ['gemini_api_key']);
      const client = createGeminiClient({
        apiKey: runtime.apiKey,
        baseURL: runtime.baseUrl ?? 'https://generativelanguage.googleapis.com',
        model: runtime.model,
      });
      return {
        adapter: new GeminiAdapter(client, options),
        model: runtime.model,
      };
    }
  }
}
