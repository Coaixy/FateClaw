import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import type { LlmRuntimeSnapshot } from '#agent/types';
import {
  assertCustomBaseUrlIsPublic,
  createPiProviderRuntime,
} from '#agent/pi-runtime/provider';

const runtime: LlmRuntimeSnapshot = {
  source: 'custom',
  billingMode: 'none',
  modelConfigId: 'user-1',
  piApi: 'openai-completions',
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
    const pi = await createPiProviderRuntime(runtime);
    const provider = 'fateclaw-openai-completions-main-openai';

    expect(pi.model.provider).toBe(provider);
    expect(pi.model.id).toBe('gpt-4o');
    expect(pi.model.baseUrl).toBe('https://llm.example.test/v1');
    expect(pi.model.contextWindow).toBe(8192);
    expect(pi.model.maxTokens).toBe(1024);
    // 0.84 起 SDK 用 ModelRuntime 门面 + 内存凭据存储，不再有 AuthStorage。
    const auth = await pi.modelRuntime.getAuth(pi.model);
    expect(auth?.auth).toMatchObject({ apiKey: 'request-scoped-key' });
  });

  it('rejects custom model private base URLs as a runtime guard', async () => {
    await expect(
      createPiProviderRuntime({
        ...runtime,
        baseUrl: 'http://127.0.0.1:11434/v1',
      }),
    ).rejects.toThrow('自配模型 Base URL 不能指向本机、内网或 metadata 地址');
  });
});

describe('assertCustomBaseUrlIsPublic', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('rejects a public domain that DNS-resolves to a private address', async () => {
    // 解析型 SSRF：字面量是公网域名，但解析到内网必须被拦下。
    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    await expect(
      assertCustomBaseUrlIsPublic({
        ...runtime,
        baseUrl: 'https://sneaky.example.test/v1',
      }),
    ).rejects.toThrow('自配模型 Base URL 解析到本机、内网或 metadata 地址');
  });

  it('rejects a domain resolving to the cloud metadata address', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    await expect(
      assertCustomBaseUrlIsPublic({
        ...runtime,
        baseUrl: 'https://metadata-proxy.example.test/v1',
      }),
    ).rejects.toThrow('自配模型 Base URL 解析到本机、内网或 metadata 地址');
  });

  it('allows a domain that resolves to a public address', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    await expect(
      assertCustomBaseUrlIsPublic({
        ...runtime,
        baseUrl: 'https://llm.example.test/v1',
      }),
    ).resolves.toBeUndefined();
  });

  it('skips non-custom runtimes without resolving DNS', async () => {
    await expect(
      assertCustomBaseUrlIsPublic({
        ...runtime,
        source: 'official',
        baseUrl: 'https://llm.example.test/v1',
      }),
    ).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
