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
      '404 Not Found: model gpt-4o does not exist with sk-user-custom-secret',
      { llmRuntime: customRuntime },
    );

    expect(result.publicReasonCode).toBe('custom_model_error');
    expect(result.publicErrorText).toContain('自配模型调用失败');
    expect(result.publicErrorText).toContain('协议类型：openai-completions');
    expect(result.publicErrorText).toContain('模型名：gpt-4o');
    expect(result.publicErrorText).toContain(
      'Base URL：https://models.example.com/v1',
    );
    expect(result.publicErrorText).toContain('认证方式：openai_api_key');
    expect(result.publicErrorText).toContain('API Key：已配置（...cret）');
    expect(result.publicErrorText).not.toContain('sk-user-custom-secret');
    expect(result.publicErrorText).toContain(
      '供应商原始错误：404 Not Found: model gpt-4o does not exist with [已脱敏]',
    );
    expect(result.publicErrorText).toContain('优先检查模型名是否存在');
  });

  it('keeps official model errors on the generic public path', () => {
    const result = mapContainerErrorToPublicError(
      '401 invalid api key: sk-official-secret',
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
      '这次没有完成，原因：401 invalid api key: [已脱敏]',
    );
  });
});
