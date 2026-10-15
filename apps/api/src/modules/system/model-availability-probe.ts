import {
  normalizeContext,
  type Api,
  type Model,
  type StreamFunction,
} from '@earendil-works/pi-ai';
import type { RuntimeModelPoolNode } from '@fateclaw/contracts/model-settings';

const DEFAULT_BASE_URLS = {
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com',
};
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
  if (callerSignal.aborted) return null;
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
        },
      );
      for await (const event of events) {
        if (event.type === 'error') return null;
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
      return null;
    } catch {
      // Provider failures are probe outcomes. Never persist or log returned bodies or credentials.
      return null;
    }
  };
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal.removeEventListener('abort', onAbort);
  }
}
