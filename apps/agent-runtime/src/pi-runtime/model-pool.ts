import { randomUUID } from 'node:crypto';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type ModelsSimpleStreamOptions,
  type Usage,
} from '@earendil-works/pi-ai';
import {
  modelPoolCooldown,
  type RuntimeModelPoolNode,
} from '@fateclaw/contracts/model-settings';
import type { LlmRuntimeSnapshot } from '../types.js';
import {
  databaseModelPoolHealth,
  type ModelPoolHealthStore,
  type ModelPoolClaim,
  type BenefitAttemptUsage,
} from '../model-pool-health.js';
import {
  benefitCallBudget,
  markBenefitAnswerVisible,
} from '../benefit-budget.js';
import { createPiProviderRuntime, type PiProviderRuntime } from './provider.js';

const FIRST_CONTENT_TIMEOUT_MS = 45_000;
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 180_000;

export function weightedNodeOrder(
  nodes: RuntimeModelPoolNode[],
  random = Math.random,
): RuntimeModelPoolNode[] {
  const remaining = [...nodes];
  const result: RuntimeModelPoolNode[] = [];
  while (remaining.length) {
    let ticket =
      random() * remaining.reduce((sum, node) => sum + node.weight, 0);
    let index = 0;
    for (; index < remaining.length - 1; index += 1) {
      ticket -= remaining[index].weight;
      if (ticket < 0) break;
    }
    result.push(...remaining.splice(index, 1));
  }
  return result;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function isProviderFailure(status: number | undefined, text: string): boolean {
  if (status !== undefined && status >= 400) {
    if (
      [401, 402, 403, 404, 408, 409, 425, 429].includes(status) ||
      status >= 500
    )
      return true;
    return /quota|billing|balance|insufficient|rate.?limit|overload|model.*not.*found/i.test(
      text,
    );
  }
  if (
    /context.*(length|window)|maximum context|too many tokens|invalid.*(request|schema|tool)|content.*(policy|filter)/i.test(
      text,
    )
  )
    return false;
  return /timeout|timed out|fetch failed|econn|enotfound|socket|network|terminated|stream ended|empty response|50[0-9]|429|unauthori[sz]ed|invalid api key|quota|rate.?limit|billing|balance|insufficient|overload|unavailable/i.test(
    text,
  );
}

function hasContent(event: AssistantMessageEvent): boolean {
  return (
    ('delta' in event && event.delta.length > 0) ||
    event.type === 'toolcall_end' ||
    ((event.type === 'text_end' || event.type === 'thinking_end') &&
      event.content.length > 0)
  );
}

function publicFailureMessage(
  error: unknown,
  aborted: boolean,
  benefit = false,
): string {
  if (aborted) return '请求已取消';
  const message = error instanceof Error ? error.message : String(error);
  if (/context.*(length|window)|maximum context|too many tokens/i.test(message))
    return '消息内容过长，请精简对话后重试。';
  if (/timeout|timed out/i.test(message)) return '模型调用超时，请稍后重试。';
  if (/429|rate.?limit/i.test(message)) return '当前请求量较大，请稍后重试。';
  return benefit
    ? '免费模型暂不可用，请稍后重试。'
    : '官方模型调用失败，请稍后重试。';
}

async function nextEvent(
  iterator: AsyncIterator<AssistantMessageEvent>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<IteratorResult<AssistantMessageEvent>> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      finish(() => reject(new Error('Model request aborted')));
    const timer = setTimeout(
      () => finish(() => reject(new Error('Model pool provider timeout'))),
      Math.max(1, timeoutMs),
    );
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      complete();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else
      void iterator.next().then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}

/** Install at the model-call boundary so tools and the enclosing session are never replayed. */
export function installModelPool(
  primary: PiProviderRuntime,
  runtime: LlmRuntimeSnapshot,
  options: {
    health?: ModelPoolHealthStore;
    random?: () => number;
    trace?: (event: Record<string, unknown>) => void;
    firstContentTimeoutMs?: number;
    idleTimeoutMs?: number;
  } = {},
): void {
  if (
    runtime.poolKey === 'benefit' &&
    (runtime.source !== 'official' ||
      runtime.billingMode !== 'none' ||
      !runtime.poolNodes?.length ||
      !runtime.benefitRequestId)
  )
    throw new Error('Benefit execution requires an admitted benefit pool');
  if (runtime.source !== 'official' || !runtime.poolNodes?.length) return;
  const nodes = runtime.poolNodes;
  const health = options.health ?? databaseModelPoolHealth;
  const finishHealth = async (
    node: RuntimeModelPoolNode,
    claim: ModelPoolClaim,
    outcome: 'success' | 'failure' | 'release',
    usage?: BenefitAttemptUsage,
  ) => {
    try {
      if (claim.benefitAttemptId)
        await health.finish(node, claim, outcome, usage);
      else await health.finish(node, claim, outcome);
    } catch {
      if (claim.benefitAttemptId)
        // eslint-disable-next-line preserve-caught-error -- Database errors can contain private values; expose only the public failure.
        throw new Error('免费用量登记失败，请稍后重试');
      options.trace?.({
        type: 'model_pool_health_update_failed',
        nodeId: node.modelConfigId,
        outcome,
      });
    }
  };
  const providers = new Map<string, Promise<PiProviderRuntime>>();
  primary.modelRuntime.streamSimple = (
    _model,
    context: Context,
    requestOptions?: ModelsSimpleStreamOptions,
  ) => {
    const output = createAssistantMessageEventStream();
    let accumulated = emptyUsage();
    const fallbackError = (
      aborted: boolean,
      usage: Usage = accumulated,
    ): AssistantMessage => ({
      role: 'assistant',
      content: [],
      api: primary.model.api,
      provider: primary.model.provider,
      model: primary.model.id,
      usage,
      stopReason: aborted ? 'aborted' : 'error',
      timestamp: Date.now(),
      errorMessage: aborted
        ? '请求已取消'
        : runtime.poolKey === 'benefit'
          ? '免费额度或供应暂不可用，请稍后重试。'
          : '官方模型池暂不可用，请稍后重试。',
    });
    const run = async () => {
      const budget = await benefitCallBudget(runtime, context, options.trace);
      let answerVisible = false;
      for (const node of weightedNodeOrder(nodes, options.random)) {
        if (runtime.poolKey === 'benefit' && node.poolKey !== 'benefit')
          continue;
        if (requestOptions?.signal?.aborted) {
          output.push({
            type: 'error',
            reason: 'aborted',
            error: fallbackError(true, accumulated),
          });
          return;
        }
        const claim = budget
          ? await health.claim(node, randomUUID(), budget)
          : await health.claim(node, randomUUID());
        if (!claim) continue;
        options.trace?.({
          type: 'model_pool_attempt_started',
          nodeId: node.modelConfigId,
          model: node.model,
        });
        const controller = new AbortController();
        const signal = requestOptions?.signal
          ? AbortSignal.any([requestOptions.signal, controller.signal])
          : controller.signal;
        const buffered: AssistantMessageEvent[] = [];
        let published = false;
        let latest: AssistantMessage | undefined;
        let status: number | undefined;
        let retryAfter: string | undefined;
        let terminal: AssistantMessageEvent | undefined;
        const startedAt = Date.now();
        let activityAt = startedAt;
        try {
          let provider = providers.get(node.modelConfigId);
          if (!provider) {
            provider = createPiProviderRuntime({
              ...runtime,
              ...node,
              poolNodes: undefined,
            });
            providers.set(node.modelConfigId, provider);
          }
          const selected = await provider;
          const stream = selected.modelRuntime.streamSimple(
            selected.model,
            context,
            {
              ...requestOptions,
              // SDK compaction may carry the representative node's auth. Resolve each attempt's own credential.
              apiKey: node.apiKey,
              headers: undefined,
              env: undefined,
              signal,
              maxRetries: 0,
              ...(budget ? { maxTokens: budget.outputTokens } : {}),
              ...(budget && node.piApi !== 'google-generative-ai'
                ? {
                    // pi-ai 0.86 invokes onResponse only after SDK success; capture error headers before normalization.
                    fetch: async (
                      input: Parameters<typeof fetch>[0],
                      init?: Parameters<typeof fetch>[1],
                    ) => {
                      const response = await (
                        requestOptions?.fetch ?? globalThis.fetch
                      )(input, init);
                      status = response.status;
                      retryAfter =
                        response.headers.get('retry-after') ?? undefined;
                      return response;
                    },
                  }
                : {}),
              timeoutMs: options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
              async onResponse(response, model) {
                status = response.status;
                retryAfter = response.headers['retry-after'];
                await requestOptions?.onResponse?.(response, model);
              },
            },
          );
          const iterator = stream[Symbol.asyncIterator]();
          while (true) {
            const idle = published
              ? (options.idleTimeoutMs ??
                (budget ? 30_000 : STREAM_IDLE_TIMEOUT_MS))
              : (options.firstContentTimeoutMs ??
                (budget ? 20_000 : FIRST_CONTENT_TIMEOUT_MS));
            const deadline = Math.min(
              startedAt + (budget ? 60_000 : ATTEMPT_TIMEOUT_MS),
              budget?.deadlineAt ?? Infinity,
              activityAt + idle,
            );
            const item = await nextEvent(
              iterator,
              signal,
              deadline - Date.now(),
            );
            if (item.done)
              throw new Error('Provider stream ended before terminal event');
            const event = item.value;
            latest =
              event.type === 'error'
                ? event.error
                : event.type === 'done'
                  ? event.message
                  : event.partial;
            if (event.type === 'error' || event.type === 'done') {
              terminal = event;
              if (event.type === 'error')
                throw new Error(
                  event.error.errorMessage ?? 'Provider unavailable',
                );
              if (!event.message.content.length)
                throw new Error('Provider returned an empty response');
              if (
                budget &&
                !answerVisible &&
                event.message.content.some(
                  (block) => block.type === 'text' && block.text.length > 0,
                )
              ) {
                await markBenefitAnswerVisible(budget.requestId);
                answerVisible = true;
              }
              await finishHealth(
                node,
                claim,
                'success',
                budget
                  ? {
                      inputTokens:
                        event.message.usage.input +
                        event.message.usage.cacheRead +
                        event.message.usage.cacheWrite,
                      outputTokens: event.message.usage.output,
                      known: event.message.usage.totalTokens > 0,
                    }
                  : undefined,
              );
              for (const pending of buffered) output.push(pending);
              output.push({
                ...event,
                message: {
                  ...event.message,
                  usage: addUsage(accumulated, event.message.usage),
                },
              });
              options.trace?.({
                type: 'model_pool_attempt_completed',
                nodeId: node.modelConfigId,
                model: node.model,
                outcome: 'success',
              });
              return;
            }
            if (!published && hasContent(event)) {
              published = true;
              for (const pending of buffered) output.push(pending);
              buffered.length = 0;
            }
            if (published) {
              if (
                budget &&
                !answerVisible &&
                event.type === 'text_delta' &&
                event.delta.length
              ) {
                await markBenefitAnswerVisible(budget.requestId);
                answerVisible = true;
              }
              output.push(event);
              activityAt = Date.now();
            } else buffered.push(event);
          }
        } catch (error) {
          controller.abort();
          const aborted = Boolean(requestOptions?.signal?.aborted);
          const retryable =
            !aborted &&
            isProviderFailure(
              status,
              error instanceof Error ? error.message : String(error),
            );
          accumulated = addUsage(accumulated, latest?.usage ?? emptyUsage());
          const attemptUsage = latest?.usage;
          const cooldown =
            budget && retryable
              ? modelPoolCooldown(
                  status,
                  error instanceof Error ? error.message : String(error),
                  retryAfter,
                )
              : undefined;
          await finishHealth(
            node,
            claim,
            retryable ? 'failure' : 'release',
            budget
              ? {
                  inputTokens: attemptUsage
                    ? attemptUsage.input +
                      attemptUsage.cacheRead +
                      attemptUsage.cacheWrite
                    : 0,
                  outputTokens: attemptUsage?.output ?? 0,
                  known: Boolean(attemptUsage?.totalTokens),
                  retryAfterSeconds: cooldown?.seconds,
                  cooldownReason: cooldown?.reason,
                }
              : undefined,
          );
          options.trace?.({
            type: 'model_pool_attempt_completed',
            nodeId: node.modelConfigId,
            model: node.model,
            outcome: aborted
              ? 'cancelled'
              : retryable
                ? 'provider_failure'
                : 'request_error',
            statusCode: status,
          });
          if (aborted || published || !retryable) {
            const final = terminal?.type === 'error' ? terminal.error : latest;
            output.push({
              type: 'error',
              reason: aborted ? 'aborted' : 'error',
              error: {
                ...(final ?? fallbackError(aborted)),
                usage: accumulated,
                stopReason: aborted ? 'aborted' : 'error',
                errorMessage: publicFailureMessage(
                  error,
                  aborted,
                  runtime.poolKey === 'benefit',
                ),
              },
            });
            return;
          }
        } finally {
          controller.abort();
        }
      }
      output.push({
        type: 'error',
        reason: 'error',
        error: fallbackError(false, accumulated),
      });
    };
    void run().catch((error) => {
      // Infrastructure failures terminate the stream; no raw provider or database values cross the boundary.
      output.push({
        type: 'error',
        reason: 'error',
        error: {
          ...fallbackError(false),
          errorMessage: publicFailureMessage(
            error,
            false,
            runtime.poolKey === 'benefit',
          ),
        },
      });
    });
    return output;
  };
}
