import {
  AuthStorage,
  ModelRegistry,
} from '@earendil-works/pi-coding-agent';
import type {
  Api,
  Model,
  OpenAICompletionsCompat,
} from '@earendil-works/pi-ai';

import type { LlmRuntimeSnapshot } from '../types.js';

export interface PiProviderRuntime {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Model<Api>;
}

function resolvePiApi(runtime: LlmRuntimeSnapshot): Api {
  switch (runtime.provider) {
    case 'openai-compatible':
      return 'openai-completions';
    case 'openai-response':
      return 'openai-responses';
    case 'anthropic':
      return 'anthropic-messages';
    case 'gemini':
      return 'google-generative-ai';
  }
}

function resolvePiProvider(runtime: LlmRuntimeSnapshot): string {
  return `fateclaw-${runtime.provider}-${runtime.providerKey}`;
}

function resolveBaseUrl(runtime: LlmRuntimeSnapshot): string {
  if (runtime.baseUrl) return runtime.baseUrl;
  switch (runtime.provider) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com';
    case 'openai-compatible':
    case 'openai-response':
      return 'https://api.openai.com/v1';
  }
}

function resolveOpenAiCompat(
  runtime: LlmRuntimeSnapshot,
): OpenAICompletionsCompat | undefined {
  if (runtime.provider !== 'openai-compatible') return undefined;
  return {
    supportsStrictMode: false,
    supportsDeveloperRole: false,
  };
}

export function createPiProviderRuntime(
  runtime: LlmRuntimeSnapshot,
): PiProviderRuntime {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const provider = resolvePiProvider(runtime);
  const api = resolvePiApi(runtime);

  authStorage.setRuntimeApiKey(provider, runtime.apiKey);
  modelRegistry.registerProvider(provider, {
    name: runtime.providerKey || provider,
    api,
    baseUrl: resolveBaseUrl(runtime),
    apiKey: runtime.apiKey,
    models: [
      {
        id: runtime.model,
        name: runtime.model,
        api,
        reasoning: false,
        input: ['text'],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: runtime.contextWindowTokens ?? 128_000,
        maxTokens: runtime.maxOutputTokens ?? 16_384,
        compat: resolveOpenAiCompat(runtime),
      },
    ],
  });

  const model = modelRegistry.find(provider, runtime.model);
  if (!model) {
    throw new Error(`Pi model registration failed: ${provider}/${runtime.model}`);
  }

  return {
    authStorage,
    modelRegistry,
    model,
  };
}
