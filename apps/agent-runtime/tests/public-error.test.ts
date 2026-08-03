import { describe, expect, it } from 'vitest';

import { mapContainerErrorToPublicError } from '../src/public-error.js';
import type { LlmRuntimeSnapshot } from '../src/types.js';

const customRuntime = {
  source: 'custom',
  billingMode: 'none',
  modelConfigId: 'user-1',
  piApi: 'openai-completions',
  model: 'gpt-4o',
  apiKey: 'sk-user-custom-secret',
  baseUrl: 'https://models.example.com/v1',
  authMode: 'openai_api_key',
  providerKey: 'custom:user-1',
} satisfies LlmRuntimeSnapshot;

describe('mapContainerErrorToPublicError', () => {
  it('includes detailed custom model configuration for the owner', () => {
    const result = mapContainerErrorToPublicError(
      '404 Not Found: request to https://models.example.com/v1/chat/completions failed with sk-user-custom-secret',
      { llmRuntime: customRuntime },
    );

    expect(result.publicReasonCode).toBe('custom_model_error');
    expect(result.publicErrorText).toContain('自配模型调用失败');
    expect(result.publicErrorText).toContain('协议类型：openai-completions');
    expect(result.publicErrorText).toContain('模型名：gpt-4o');
    expect(result.publicErrorText).toContain('Base URL：已配置');
    expect(result.publicErrorText).toContain('认证方式：openai_api_key');
    expect(result.publicErrorText).toContain('API Key：已配置');
    expect(result.publicErrorText).not.toContain('sk-user-custom-secret');
    expect(result.publicErrorText).not.toContain('models.example.com');
    expect(result.publicErrorText).toContain(
      '供应商原始错误：404 Not Found: request to [已脱敏] failed with [已脱敏]',
    );
    expect(result.publicErrorText).toContain('优先检查模型名是否存在');
  });

  it('points custom model payment errors to the provider balance', () => {
    const result = mapContainerErrorToPublicError(
      'HTTP 402 Payment Required: insufficient balance',
      { llmRuntime: customRuntime },
    );

    expect(result.publicReasonCode).toBe('custom_model_error');
    expect(result.publicErrorText).toContain(
      '供应商原始错误：HTTP 402 Payment Required: insufficient balance',
    );
    expect(result.publicErrorText).toContain('优先检查 API Key 权限、账户额度');
  });

  it('keeps official model errors on the generic public path', () => {
    const result = mapContainerErrorToPublicError(
      '401 invalid api key: sk-official-secret from https://api.example.com/v1',
      {
        llmRuntime: {
          ...customRuntime,
          source: 'official',
          billingMode: 'metered',
          modelConfigId: 'official-1',
          apiKey: 'sk-official-secret',
          providerKey: 'main-openai',
        },
      },
    );

    expect(result.publicReasonCode).toBe('internal_error');
    expect(result.publicErrorText).toBe(
      '这次没有完成，原因：401 invalid api key: [已脱敏] from [已脱敏]',
    );
  });
});
