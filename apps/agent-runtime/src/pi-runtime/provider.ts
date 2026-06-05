import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { isIP } from 'node:net';
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

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(ip: number, cidrBase: string, prefix: number): boolean {
  const base = ipv4ToNumber(cidrBase);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
}

function isBlockedIpv4(hostname: string): boolean {
  const ip = ipv4ToNumber(hostname);
  if (ip === null) return false;
  return [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ].some(([base, prefix]) => ipv4InCidr(ip, base as string, prefix as number));
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return true;
  const first = normalized.split(':').find((part) => part.length > 0);
  if (!first) return false;
  const firstHextet = Number.parseInt(first, 16);
  if (!Number.isFinite(firstHextet)) return false;
  return (
    (firstHextet & 0xfe00) === 0xfc00 ||
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xff00) === 0xff00 ||
    normalized === '2001:db8' ||
    normalized.startsWith('2001:db8:')
  );
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname)
    .toLowerCase()
    .replace(/\.$/, '');
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isBlockedIpv4(normalized);
  if (ipVersion === 6) return isBlockedIpv6(normalized);
  if (
    normalized === 'localhost' ||
    normalized === 'ip6-localhost' ||
    normalized === 'ip6-loopback' ||
    normalized === 'metadata' ||
    normalized === 'metadata.google.internal'
  ) {
    return true;
  }
  if (!normalized.includes('.')) return true;
  return ['.localhost', '.local', '.internal', '.lan', '.home', '.corp'].some(
    (suffix) => normalized.endsWith(suffix),
  );
}

function requirePublicHttpBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('自配模型 Base URL 格式不正确');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('自配模型 Base URL 仅支持 http 或 https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('自配模型 Base URL 含有不允许的凭据或参数');
  }
  if (!parsed.hostname || isBlockedHostname(parsed.hostname)) {
    throw new Error('自配模型 Base URL 不能指向本机、内网或 metadata 地址');
  }
  return value;
}

function resolveBaseUrl(runtime: LlmRuntimeSnapshot): string {
  if (runtime.baseUrl) {
    return runtime.source === 'custom'
      ? requirePublicHttpBaseUrl(runtime.baseUrl)
      : runtime.baseUrl;
  }
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
        reasoning: true,
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
    throw new Error(
      `Pi model registration failed: ${provider}/${runtime.model}`,
    );
  }

  return {
    authStorage,
    modelRegistry,
    model,
  };
}
