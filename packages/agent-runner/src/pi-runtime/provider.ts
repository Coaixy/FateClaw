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
  return runtime.piApi;
}

function resolvePiProvider(runtime: LlmRuntimeSnapshot): string {
  return `fateclaw-${runtime.piApi}-${runtime.providerKey}`;
}

function resolveBaseUrl(runtime: LlmRuntimeSnapshot): string {
  if (runtime.baseUrl) return runtime.baseUrl;
  switch (runtime.piApi) {
    case 'anthropic-messages':
      return 'https://api.anthropic.com';
    case 'google-generative-ai':
      return 'https://generativelanguage.googleapis.com';
    case 'openai-completions':
    case 'openai-responses':
      return 'https://api.openai.com/v1';
  }
}

function resolveOpenAiCompat(
  runtime: LlmRuntimeSnapshot,
): OpenAICompletionsCompat | undefined {
  if (runtime.piApi !== 'openai-completions') return undefined;
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
