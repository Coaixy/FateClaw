import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type {
  Api,
  Model,
  OpenAICompletionsCompat,
} from '@earendil-works/pi-ai';

import type { LlmRuntimeSnapshot } from '#agent/types';

/**
 * 请求级模型/凭据运行时。
 *
 * pi 0.80.8 起 SDK 移除了 AuthStorage + ModelRegistry.inMemory 的组装方式，
 * 统一为异步 ModelRuntime 门面；凭据用 pi-ai 的内存 CredentialStore，
 * 请求结束时随 runtime 一起丢弃，绝不落盘、不跨请求共享。
 */
export interface PiProviderRuntime {
  modelRuntime: ModelRuntime;
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

/**
 * 主机名安全归一化：去 IPv6 方括号 + 转小写 + 去结尾点。
 *
 * @remarks 供字面量校验（{@link isBlockedHostname}）与 DNS 解析校验（{@link assertCustomBaseUrlIsPublic}）
 *   共用。去结尾点决定 `example.com.` 能否绕过后缀匹配、去括号决定 `isIP` 能否正确判定 IPv6 字面量，
 *   属安全判定的一部分，两条防线必须用同一口径，切勿各写一份以免日后补规则时产生「一拦一放」的绕过窗口。
 */
function normalizeHostname(hostname: string): string {
  return stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/, '');
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
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
    // eslint-disable-next-line preserve-caught-error -- URL parse errors can contain embedded credentials.
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

/**
 * 对自配（BYOK）模型 Base URL 做「解析后」SSRF 校验。
 *
 * @param runtime 请求级 LLM 运行时快照；仅 `source==='custom'` 且带 baseUrl 时才校验。
 * @remarks
 * 同步的 {@link requirePublicHttpBaseUrl} 只能拦截主机名「字面量」（IP / localhost / 内网后缀），
 * 挡不住「攻击者用一个解析到内网或云 metadata（169.254.169.254）的公网域名」这类解析型 SSRF。
 * 这里对域名做 DNS 解析，逐个解析出的 IP 复用私网/保留段判断，任一命中即拒绝。
 * IP 字面量已由同步字面量校验覆盖，此处直接放行交给它处理。
 *
 * 已知残留：解析校验与实际连接之间仍存在 TOCTOU 重绑定窗口，彻底封堵需在连接层对已校验 IP
 * 做 pinning（属更大改造）；本函数先堵住最常见的静态解析型 SSRF。
 */
export async function assertCustomBaseUrlIsPublic(
  runtime: LlmRuntimeSnapshot,
): Promise<void> {
  if (runtime.source !== 'custom' || !runtime.baseUrl) return;

  let parsed: URL;
  try {
    parsed = new URL(runtime.baseUrl);
  } catch {
    return; // URL 格式错误交由同步的 requirePublicHttpBaseUrl 报错
  }

  const hostname = normalizeHostname(parsed.hostname);
  // IP 字面量无需解析，其内网/保留段判断已由同步字面量校验覆盖。
  if (!hostname || isIP(hostname)) return;

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname, { all: true });
  } catch (error) {
    throw new Error('自配模型 Base URL 无法解析域名', { cause: error });
  }

  const hitsPrivateAddress = records.some((record) =>
    record.family === 6
      ? isBlockedIpv6(record.address)
      : isBlockedIpv4(record.address),
  );
  if (hitsPrivateAddress) {
    throw new Error('自配模型 Base URL 解析到本机、内网或 metadata 地址');
  }
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

export async function createPiProviderRuntime(
  runtime: LlmRuntimeSnapshot,
): Promise<PiProviderRuntime> {
  const provider = resolvePiProvider(runtime);
  const api = resolvePiApi(runtime);

  // 内存凭据存储 + 关闭目录刷新/网络模型目录：本 provider 完全由请求参数静态构造。
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    // null 表示不读 ~/.pi/agent/models.json，避免读到宿主机用户配置。
    modelsPath: null,
    refreshOnCreate: false,
  });

  await modelRuntime.setRuntimeApiKey(provider, runtime.apiKey);
  modelRuntime.registerProvider(provider, {
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

  const model = modelRuntime.getModel(provider, runtime.model);
  if (!model) {
    throw new Error(
      `Pi model registration failed: ${provider}/${runtime.model}`,
    );
  }

  return {
    modelRuntime,
    model,
  };
}
