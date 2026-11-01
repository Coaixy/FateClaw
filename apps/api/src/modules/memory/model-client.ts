import type { Api, Model, StreamFunction } from '@earendil-works/pi-ai';
import type { MemoryRuntimePolicy } from '@fateclaw/contracts/memory';
import type { RuntimeModelPoolNode } from '@fateclaw/contracts/model-settings';

export type MemoryModelPurpose = 'memory.extract';

export interface MemoryModelUsage {
  inputTokens: number;
  outputTokens: number;
  estimated?: boolean;
}

export interface MemoryModelResult {
  usage: MemoryModelUsage;
  modelConfigId: string;
  model: string;
  durationMs: number;
}

export class MemoryModelError extends Error {
  usage?: MemoryModelUsage;
  modelConfigId?: string;
  model?: string;
  durationMs?: number;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryModelError';
  }
}

/** Credentials are an opaque request input, never part of a persisted result. */
export type MemoryModelConnection = Pick<
  RuntimeModelPoolNode,
  | 'modelConfigId'
  | 'providerKey'
  | 'piApi'
  | 'model'
  | 'apiKey'
  | 'baseUrl'
  | 'authMode'
> & {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
};

export type MemoryModelResolver = (
  modelConfigId: string | null,
  signal: AbortSignal,
) => Promise<MemoryModelConnection>;

export interface MemoryTextRequest {
  purpose: MemoryModelPurpose;
  connection: MemoryModelConnection;
  systemPrompt: string;
  input: string;
  maxOutputTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export type MemoryTextRunner = (request: MemoryTextRequest) => Promise<{
  text: string;
  usage: MemoryModelUsage;
}>;

export interface MemoryModelOptions {
  policy: MemoryRuntimePolicy;
  signal?: AbortSignal;
  resolveModel?: MemoryModelResolver;
}

const DEFAULT_BASE_URLS = {
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
};

export const resolveMemoryModel: MemoryModelResolver = async (
  modelConfigId,
  signal,
) => {
  signal.throwIfAborted();
  const { resolveOfficialLlmRuntime } =
    await import('#modules/system/system-config');
  const runtime = await resolveOfficialLlmRuntime('official');
  signal.throwIfAborted();
  // The canonical resolver orders enabled nodes with the primary first.
  const node = modelConfigId
    ? runtime?.poolNodes?.find((entry) => entry.modelConfigId === modelConfigId)
    : runtime?.poolNodes?.[0];
  if (!node)
    throw new MemoryModelError(
      'MEMORY_MODEL_UNAVAILABLE',
      modelConfigId
        ? '记忆模型节点不存在、已停用或尚未配置凭据。'
        : '官方记忆模型暂不可用，请联系管理员。',
    );
  return {
    ...node,
    contextWindowTokens: runtime?.contextWindowTokens,
    maxOutputTokens: runtime?.maxOutputTokens,
  };
};

function assertPolicy(policy: MemoryRuntimePolicy): void {
  if (!policy.enabled)
    throw new MemoryModelError('MEMORY_DISABLED', '记忆功能已停用。');
  if (
    !Number.isSafeInteger(policy.job_timeout_ms) ||
    policy.job_timeout_ms < 1 ||
    policy.job_timeout_ms > 2_147_483_647
  )
    throw new MemoryModelError(
      'MEMORY_INVALID_POLICY',
      '记忆任务超时配置无效。',
    );
}

function abortError(timedOut: boolean): MemoryModelError {
  return timedOut
    ? new MemoryModelError('MEMORY_MODEL_TIMEOUT', '记忆模型请求超时。')
    : new MemoryModelError('MEMORY_MODEL_CANCELLED', '记忆模型请求已取消。');
}

async function withDeadline<T>(
  options: MemoryModelOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertPolicy(options.policy);
  if (options.signal?.aborted) throw abortError(false);
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.policy.job_timeout_ms);
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(timedOut));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(signal), aborted]);
  } catch (error) {
    if (signal.aborted) throw abortError(timedOut);
    if (error instanceof MemoryModelError) throw error;
    // Upstream exceptions may include request bodies, URLs or authentication.
    throw new MemoryModelError(
      'MEMORY_MODEL_FAILED',
      '记忆模型调用失败，请检查模型节点状态后重试。',
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

function checkedUsage(usage: MemoryModelUsage): MemoryModelUsage {
  if (
    !usage ||
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0
  )
    throw new MemoryModelError(
      'MEMORY_MODEL_INVALID_USAGE',
      '记忆模型返回了无效的用量信息。',
    );
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.estimated ? { estimated: true } : {}),
  };
}

function baseUrl(connection: MemoryModelConnection): URL {
  const raw = connection.baseUrl ?? DEFAULT_BASE_URLS[connection.piApi];
  if (!URL.canParse(raw))
    throw new MemoryModelError(
      'MEMORY_MODEL_INVALID_URL',
      '记忆模型接口地址无效。',
    );
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new MemoryModelError(
      'MEMORY_MODEL_INVALID_URL',
      '记忆模型接口地址仅支持不含认证和查询参数的 HTTP 或 HTTPS。',
    );
  return url;
}

async function providerStream(
  api: RuntimeModelPoolNode['piApi'],
): Promise<StreamFunction> {
  switch (api) {
    case 'openai-completions':
      return (await import('@earendil-works/pi-ai/api/openai-completions'))
        .streamSimple as StreamFunction;
    case 'openai-responses':
      return (await import('@earendil-works/pi-ai/api/openai-responses'))
        .streamSimple as StreamFunction;
    case 'anthropic-messages':
      return (await import('@earendil-works/pi-ai/api/anthropic-messages'))
        .streamSimple as StreamFunction;
    case 'google-generative-ai':
      return (await import('@earendil-works/pi-ai/api/google-generative-ai'))
        .streamSimple as StreamFunction;
  }
}

const defaultTextRunner: MemoryTextRunner = async (request) => {
  const { normalizeContext } = await import('@earendil-works/pi-ai');
  const { connection } = request;
  const model: Model<Api> = {
    id: connection.model,
    name: connection.model,
    api: connection.piApi,
    provider: `fateclaw-memory-${connection.providerKey}`,
    baseUrl: baseUrl(connection).toString().replace(/\/$/, ''),
    // pi-ai sends openai-completions providers their "thinking off" flag only for reasoning
    // models; otherwise DeepSeek-style defaults spend the output budget before the JSON answer.
    // openai-responses would send effort "none", which older reasoning models reject.
    reasoning: connection.piApi === 'openai-completions',
    input: ['text'],
    contextWindow: connection.contextWindowTokens ?? 8192,
    maxTokens: request.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(connection.piApi === 'openai-completions'
      ? {
          compat: {
            supportsStrictMode: false,
            supportsDeveloperRole: false,
          },
        }
      : {}),
  };
  const stream = await providerStream(connection.piApi);
  request.signal.throwIfAborted();
  const events = stream(
    model,
    normalizeContext({
      messages: [
        {
          role: 'system',
          content: request.systemPrompt,
          timestamp: Date.now(),
        },
        { role: 'user', content: request.input, timestamp: Date.now() },
      ],
    }),
    {
      apiKey: connection.apiKey,
      signal: request.signal,
      maxTokens: request.maxOutputTokens,
      maxRetries: 0,
      timeoutMs: request.timeoutMs,
      cacheRetention: 'none',
    },
  );
  for await (const event of events) {
    if (event.type === 'error') {
      const error = new MemoryModelError(
        'MEMORY_MODEL_FAILED',
        '记忆模型调用失败，请检查模型节点状态后重试。',
      );
      error.usage = checkedUsage({
        inputTokens:
          event.error.usage.input +
          event.error.usage.cacheRead +
          event.error.usage.cacheWrite,
        outputTokens: event.error.usage.output,
      });
      throw error;
    }
    if (event.type !== 'done') continue;
    const usage = checkedUsage({
      inputTokens:
        event.message.usage.input +
        event.message.usage.cacheRead +
        event.message.usage.cacheWrite,
      outputTokens: event.message.usage.output,
    });
    if (event.reason !== 'stop') {
      const error = new MemoryModelError(
        'MEMORY_MODEL_INCOMPLETE',
        '记忆模型未完整返回结果，请调整输出预算后重试。',
      );
      error.usage = usage;
      throw error;
    }
    return {
      text: event.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(''),
      usage,
    };
  }
  throw new MemoryModelError(
    'MEMORY_MODEL_INCOMPLETE',
    '记忆模型连接提前结束，未获得完整结果。',
  );
};

export async function runMemoryText(
  args: MemoryModelOptions & {
    purpose: MemoryModelPurpose;
    modelConfigId: string | null;
    systemPrompt: string;
    input: string;
    runner?: MemoryTextRunner;
  },
): Promise<MemoryModelResult & { text: string }> {
  const started = performance.now();
  let connection: MemoryModelConnection | undefined;
  try {
    return await withDeadline(args, async (signal) => {
      if (
        !Number.isSafeInteger(args.policy.extraction_output_tokens) ||
        args.policy.extraction_output_tokens < 1
      )
        throw new MemoryModelError(
          'MEMORY_INVALID_POLICY',
          '记忆模型输出预算无效。',
        );
      connection = await (args.resolveModel ?? resolveMemoryModel)(
        args.modelConfigId,
        signal,
      );
      signal.throwIfAborted();
      const result = await (args.runner ?? defaultTextRunner)({
        purpose: args.purpose,
        connection,
        systemPrompt: args.systemPrompt,
        input: args.input,
        maxOutputTokens: Math.min(
          args.policy.extraction_output_tokens,
          connection.maxOutputTokens ?? Infinity,
        ),
        timeoutMs: args.policy.job_timeout_ms,
        signal,
      });
      const usage = checkedUsage(result.usage);
      if (typeof result.text !== 'string')
        throw new MemoryModelError(
          'MEMORY_MODEL_INVALID_OUTPUT',
          '记忆模型返回的文本格式无效。',
        );
      return {
        text: result.text,
        usage,
        modelConfigId: connection.modelConfigId,
        model: connection.model,
        durationMs: Math.round(performance.now() - started),
      };
    });
  } catch (error) {
    if (error instanceof MemoryModelError) {
      error.modelConfigId ??= connection?.modelConfigId;
      error.model ??= connection?.model;
      error.durationMs ??= Math.round(performance.now() - started);
    }
    throw error;
  }
}
