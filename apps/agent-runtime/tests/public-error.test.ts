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

const officialRuntime = {
  ...customRuntime,
  source: 'official',
  billingMode: 'metered',
  modelConfigId: 'official-1',
  providerKey: 'main-openai',
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

  it('explains official authentication failures without exposing connection details', () => {
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

    expect(result.publicReasonCode).toBe('model_auth_error');
    expect(result.publicErrorText).toContain('上游服务认证失败');
    expect(result.publicErrorText).toContain('管理员');
    expect(result.publicErrorText).not.toContain('sk-official-secret');
    expect(result.publicErrorText).not.toContain('api.example.com');
    expect(result.publicErrorText).not.toContain('invalid api key');
  });

  it.each([
    ['429 Too Many Requests', 'rate_limited', '限流'],
    [
      '429 {"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded: 60 requests per minute"}}',
      'rate_limited',
      '限流',
    ],
    [
      '429 {"error":{"code":"insufficient_quota","message":"Quota exceeded"}}',
      'model_quota_exhausted',
      '上游服务额度不足',
    ],
    [
      '403 {"error":{"code":"content_policy_violation","message":"Blocked"}}',
      'model_content_filtered',
      '内容安全规则',
    ],
    ['403 Forbidden', 'model_permission_denied', '拒绝访问'],
    ['404 Not Found', 'model_not_found', '模型或接口'],
    ['504 Gateway Timeout', 'agent_timeout', '超时'],
    ['529 {"error":{"type":"overloaded_error"}}', 'model_overloaded', '过载'],
    ['503 Service Unavailable', 'model_unavailable', '服务故障'],
    [
      '400 {"error":{"code":"context_length_exceeded"}}',
      'context_too_long',
      '缩短消息',
    ],
    ['413 Request Entity Too Large', 'context_too_long', '缩短消息'],
    [
      '400 {"error":{"message":"Unsupported parameter: max_tokens"}}',
      'model_request_invalid',
      '格式或参数',
    ],
    ['fetch failed: ECONNRESET', 'model_network_error', '平台与上游模型服务'],
    ['Provider returned an empty response', 'model_empty_response', '空回复'],
    [
      'Provider stream ended before terminal event',
      'model_response_interrupted',
      '中断',
    ],
  ])(
    'explains %s with a specific cause and next step',
    (error, reasonCode, detail) => {
      const result = mapContainerErrorToPublicError(error, {
        llmRuntime: officialRuntime,
      });
      expect(result.publicReasonCode).toBe(reasonCode);
      expect(result.publicErrorText).toContain(detail);
      expect(result.publicErrorText).toContain('请');
    },
  );

  it('explains shared free-provider limits and offers an available product action', () => {
    const result = mapContainerErrorToPublicError(
      '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"poolside/laguna-s-2.1:free is temporarily rate-limited upstream. Please retry shortly, or add your own key: https://synthetic.example/keys","provider_name":"Poolside","is_byok":false,"limit_source":"upstream_provider_shared_pool"}}',
      {
        llmRuntime: {
          ...officialRuntime,
          poolKey: 'benefit',
          billingMode: 'none',
        },
      },
    );
    expect(result.publicReasonCode).toBe('rate_limited');
    expect(result.publicErrorText).toContain('免费模型');
    expect(result.publicErrorText).toContain('共享');
    expect(result.publicErrorText).toContain('切换到官方模型');
    expect(result.publicErrorText).not.toContain('synthetic.example');
    expect(result.publicErrorText).not.toContain('add your own key');
  });

  it('keeps unknown official failures uncertain rather than interpreting incidental token text', () => {
    const result = mapContainerErrorToPublicError(
      'Unexpected token in tool state',
      { llmRuntime: officialRuntime },
    );
    expect(result.publicReasonCode).toBe('internal_error');
    expect(result.publicErrorText).toContain('暂时无法确定具体原因');
    expect(result.publicErrorText).not.toContain('消息内容太长');
    expect(result.publicErrorText).not.toContain('Unexpected token');
  });
});
