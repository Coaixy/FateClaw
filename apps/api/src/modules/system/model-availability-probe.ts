import {
  normalizeContext,
  type Api,
  type Model,
  type StreamFunction,
} from '@earendil-works/pi-ai';
import {
  modelPoolCooldown,
  type ModelPoolCooldown,
  type RuntimeModelPoolNode,
} from '@fateclaw/contracts/model-settings';
import { randomUUID } from 'node:crypto';
import { getDbPool } from '#infrastructure/db-pool';

const DEFAULT_BASE_URLS = {
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com',
};

export async function probeBenefitModelAvailability(
  node: RuntimeModelPoolNode,
  signal: AbortSignal,
): Promise<{ latency: number | null; attempted: boolean }> {
  if (signal.aborted) return { latency: null, attempted: false };
  const id = randomUUID();
  const { rows } = await getDbPool().query<{ claim: unknown }>(
    'SELECT claim_benefit_attempt(NULL,$1,$2,$3,true) AS claim',
    [node.modelConfigId, node.revision, id],
  );
  if (!rows[0]?.claim) return { latency: null, attempted: false };
  const { latency, cooldown, providerFailure } = await probeModel(node, signal);
  await getDbPool().query(
    'SELECT settle_benefit_attempt($1,0,0,false,$2,$3,$4)',
    [
      id,
      latency !== null ? 'success' : providerFailure ? 'failure' : 'release',
      cooldown?.seconds ?? null,
      cooldown?.reason ?? null,
    ],
  );
  return { latency, attempted: true };
}
export const STATUS_PROBE_MAX_TOKENS = 16;
export const STATUS_PROBE_TIMEOUT_MS = 8_000;

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

/** A tiny inference checks generation, rather than treating an HTTP handshake as availability. */
export async function probeModelAvailability(
  node: RuntimeModelPoolNode,
  callerSignal: AbortSignal,
  timeoutMs = STATUS_PROBE_TIMEOUT_MS,
): Promise<number | null> {
  return (await probeModel(node, callerSignal, timeoutMs)).latency;
}

async function probeModel(
  node: RuntimeModelPoolNode,
  callerSignal: AbortSignal,
  timeoutMs = STATUS_PROBE_TIMEOUT_MS,
): Promise<{
  latency: number | null;
  cooldown?: ModelPoolCooldown;
  providerFailure: boolean;
}> {
  if (callerSignal.aborted) return { latency: null, providerFailure: false };
  let status: number | undefined;
  let retryAfter: string | undefined;
  let cooldown: ModelPoolCooldown | undefined;
  let providerFailure = false;
  let transportFailed = false;
  const controller = new AbortController();
  const signal = AbortSignal.any([callerSignal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let onAbort: () => void = () => {};
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const started = performance.now();
  const read = async (): Promise<number | null> => {
    try {
      const stream = await providerStream(node.piApi);
      if (signal.aborted) return null;
      const model: Model<Api> = {
        id: node.model,
        name: node.model,
        api: node.piApi,
        provider: `fateclaw-status-${node.providerKey}`,
        baseUrl: node.baseUrl ?? DEFAULT_BASE_URLS[node.piApi],
        reasoning: false,
        input: ['text'],
        contextWindow: 8192,
        maxTokens: STATUS_PROBE_MAX_TOKENS,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(node.piApi === 'openai-completions'
          ? {
              compat: {
                supportsStrictMode: false,
                supportsDeveloperRole: false,
              },
            }
          : {}),
      };
      const events = stream(
        model,
        normalizeContext({
          messages: [
            { role: 'user', content: 'Reply OK.', timestamp: Date.now() },
          ],
        }),
        {
          apiKey: node.apiKey,
          signal,
          maxTokens: STATUS_PROBE_MAX_TOKENS,
          maxRetries: 0,
          timeoutMs,
          cacheRetention: 'none',
          ...(node.poolKey === 'benefit' &&
          node.piApi !== 'google-generative-ai'
            ? {
                // onResponse follows SDK success; capture error headers before normalization.
                fetch: async (
                  input: Parameters<typeof fetch>[0],
                  init?: Parameters<typeof fetch>[1],
                ) => {
                  let response: Response;
                  try {
                    response = await globalThis.fetch(input, init);
                  } catch (error) {
                    transportFailed = true;
                    throw error;
                  }
                  status = response.status;
                  retryAfter = response.headers.get('retry-after') ?? undefined;
                  return response;
                },
              }
            : {}),
          onResponse(response) {
            status = response.status;
            retryAfter = response.headers['retry-after'];
          },
        },
      );
      for await (const event of events) {
        if (event.type === 'error') {
          providerFailure = !signal.aborted && !transportFailed;
          cooldown = modelPoolCooldown(
            status,
            event.error.errorMessage ?? '',
            retryAfter,
          );
          return null;
        }
        if (
          (event.type === 'text_delta' || event.type === 'thinking_delta') &&
          event.delta.length > 0
        )
          return Math.round(performance.now() - started);
        // Some reasoning models spend the small token allowance without returning visible text.
        if (
          event.type === 'done' &&
          (event.message.content.some(
            (block) =>
              (block.type === 'text' && block.text.length > 0) ||
              (block.type === 'thinking' && block.thinking.length > 0),
          ) ||
            event.message.usage.output > 0)
        )
          return Math.round(performance.now() - started);
      }
      providerFailure = !signal.aborted && !transportFailed;
      return null;
    } catch (error) {
      providerFailure =
        !signal.aborted &&
        !transportFailed &&
        status !== undefined &&
        status >= 400;
      // Provider failures are probe outcomes. Never persist or log returned bodies or credentials.
      cooldown = modelPoolCooldown(
        status,
        error instanceof Error ? error.message : String(error),
        retryAfter,
      );
      return null;
    }
  };
  try {
    const latency = await Promise.race([read(), aborted]);
    return {
      latency,
      cooldown: providerFailure ? cooldown : undefined,
      providerFailure: providerFailure && !signal.aborted,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal.removeEventListener('abort', onAbort);
  }
}
