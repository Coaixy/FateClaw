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
  classifyModelFailure,
  formatModelFailure,
  type ModelFailure,
  type ModelFailureKind,
  type RuntimeModelPoolNode,
} from '@fateclaw/contracts/model-settings';
import type { LlmRuntimeSnapshot } from '../types.js';
import {
  databaseModelPoolHealth,
  type ModelPoolHealthStore,
  type ModelPoolClaim,
  type BenefitAttemptUsage,
} from '../model-pool-health.js';
import { markBenefitAnswerVisible } from '../benefit-execution.js';
import { redactRuntimeSensitiveValues } from '../public-error.js';
import { createPiProviderRuntime, type PiProviderRuntime } from './provider.js';

const FIRST_CONTENT_TIMEOUT_MS = 45_000;
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 180_000;

function errorDetails(
  error: unknown,
  runtime: LlmRuntimeSnapshot,
  includeMessage = true,
  depth = 0,
): Record<string, unknown> {
  const value =
    error && typeof error === 'object'
      ? (error as {
          name?: unknown;
          message?: unknown;
          code?: unknown;
          cause?: unknown;
        })
      : undefined;
  const redact = (text: string) =>
    redactRuntimeSensitiveValues(text, runtime)
      .replace(/\s+/g, ' ')
      .slice(0, 4096);
  return {
    name:
      typeof value?.name === 'string' && /^[\w.]{1,64}$/.test(value.name)
        ? redact(value.name)
        : 'Error',
    ...(includeMessage
      ? {
          message: redact(
            typeof value?.message === 'string' ? value.message : String(error),
          ),
        }
      : {}),
    ...(typeof value?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.code)
      ? { code: redact(value.code) }
      : {}),
    ...(depth < 3 && value?.cause !== undefined
      ? {
          cause: errorDetails(value.cause, runtime, includeMessage, depth + 1),
        }
      : {}),
  };
}

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
    answerSessionId?: string;
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
  const nodeContext = (node: RuntimeModelPoolNode) => ({
    poolKey: runtime.poolKey ?? 'official',
    nodeId: node.modelConfigId,
    provider: node.piApi,
    providerKey: node.providerKey,
    model: node.model,
  });
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
    } catch (error) {
      options.trace?.({
        type: 'model_pool_health_update_failed',
        level: claim.benefitAttemptId ? 'error' : 'warn',
        message: '模型池健康状态或用量登记失败',
        ...nodeContext(node),
        outcome,
        // Database messages may contain private row values; retain only error metadata.
        error: errorDetails(error, runtime, false),
      });
      if (claim.benefitAttemptId)
        // eslint-disable-next-line preserve-caught-error -- Database errors can contain private values; expose only the public failure.
        throw new Error('免费用量登记失败，请稍后重试');
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
    let currentNode: RuntimeModelPoolNode | undefined;
    let phase: 'claim' | 'provider' | 'answer_visibility' | 'settlement' =
      'claim';
    const fallbackError = (
      aborted: boolean,
      usage: Usage = accumulated,
      modelFailure: ModelFailure = { kinds: ['pool_unavailable'] },
    ): AssistantMessage & { modelFailure?: ModelFailure } => ({
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
        : formatModelFailure(modelFailure, runtime.poolKey).publicErrorText,
      ...(!aborted ? { modelFailure } : {}),
    });
    const run = async () => {
      const benefitRequestId =
        runtime.poolKey === 'benefit' ? runtime.benefitRequestId : undefined;
      // SDK compaction has its own routing ID and does not publish an answer.
      const answerCall =
        options.answerSessionId !== undefined &&
        requestOptions?.sessionId === options.answerSessionId;
      let answerVisible = false;
      const attemptedNodeIds: string[] = [];
      const skippedNodeIds: string[] = [];
      const failureKinds = new Set<ModelFailureKind>();
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
        currentNode = node;
        phase = 'claim';
        const claim = await health.claim(node, randomUUID(), benefitRequestId);
        if (!claim) {
          skippedNodeIds.push(node.modelConfigId);
          options.trace?.({
            type: 'model_pool_node_skipped',
            ...nodeContext(node),
            reason: 'claim_denied',
          });
          continue;
        }
        attemptedNodeIds.push(node.modelConfigId);
        phase = 'provider';
        options.trace?.({
          type: 'model_pool_attempt_started',
          ...nodeContext(node),
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
        let transportError: unknown;
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
              ...(node.piApi !== 'google-generative-ai'
                ? {
                    // pi-ai 0.86 invokes onResponse only after SDK success; capture error headers before normalization.
                    fetch: async (
                      input: Parameters<typeof fetch>[0],
                      init?: Parameters<typeof fetch>[1],
                    ) => {
                      try {
                        const response = await (
                          requestOptions?.fetch ?? globalThis.fetch
                        )(input, init);
                        status = response.status;
                        retryAfter =
                          response.headers.get('retry-after') ?? undefined;
                        return response;
                      } catch (error) {
                        transportError = error;
                        throw error;
                      }
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
              ? (options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS)
              : (options.firstContentTimeoutMs ?? FIRST_CONTENT_TIMEOUT_MS);
            const deadline = Math.min(
              startedAt + ATTEMPT_TIMEOUT_MS,
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
                benefitRequestId &&
                answerCall &&
                !answerVisible &&
                event.message.content.some(
                  (block) => block.type === 'text' && block.text.length > 0,
                )
              ) {
                phase = 'answer_visibility';
                await markBenefitAnswerVisible(benefitRequestId);
                phase = 'provider';
                answerVisible = true;
              }
              phase = 'settlement';
              await finishHealth(
                node,
                claim,
                'success',
                benefitRequestId
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
              phase = 'provider';
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
                ...nodeContext(node),
                outcome: 'success',
                statusCode: status,
                durationMs: Date.now() - startedAt,
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
                benefitRequestId &&
                answerCall &&
                !answerVisible &&
                event.type === 'text_delta' &&
                event.delta.length
              ) {
                phase = 'answer_visibility';
                await markBenefitAnswerVisible(benefitRequestId);
                phase = 'provider';
                answerVisible = true;
              }
              output.push(event);
              activityAt = Date.now();
            } else buffered.push(event);
          }
        } catch (error) {
          controller.abort();
          const failure = transportError ?? error;
          const failureMessage =
            failure instanceof Error ? failure.message : String(failure);
          const aborted = Boolean(requestOptions?.signal?.aborted);
          const modelFailure: ModelFailure = {
            kinds: [
              phase === 'provider'
                ? (classifyModelFailure(failureMessage, status) ?? 'unknown')
                : 'internal',
            ],
          };
          if (!aborted) failureKinds.add(modelFailure.kinds[0]);
          const retryable =
            !aborted &&
            phase === 'provider' &&
            isProviderFailure(status, failureMessage);
          accumulated = addUsage(accumulated, latest?.usage ?? emptyUsage());
          const attemptUsage = latest?.usage;
          const cooldown =
            benefitRequestId && retryable
              ? modelPoolCooldown(status, failureMessage, retryAfter)
              : undefined;
          options.trace?.({
            type: 'model_pool_attempt_completed',
            level: aborted ? 'debug' : 'warn',
            message: aborted ? '模型调用已取消' : '模型调用失败',
            ...nodeContext(node),
            outcome: aborted
              ? 'cancelled'
              : retryable
                ? 'provider_failure'
                : 'request_error',
            statusCode: status,
            phase,
            durationMs: Date.now() - startedAt,
            published,
            retryable,
            error: errorDetails(failure, runtime, phase === 'provider'),
          });
          await finishHealth(
            node,
            claim,
            retryable ? 'failure' : 'release',
            benefitRequestId
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
          if (aborted || published || !retryable) {
            const final = terminal?.type === 'error' ? terminal.error : latest;
            const publicFailure = fallbackError(
              aborted,
              accumulated,
              modelFailure,
            );
            output.push({
              type: 'error',
              reason: aborted ? 'aborted' : 'error',
              error: {
                ...(final ?? publicFailure),
                usage: accumulated,
                stopReason: aborted ? 'aborted' : 'error',
                errorMessage: publicFailure.errorMessage,
                ...(!aborted ? { modelFailure } : {}),
              },
            });
            return;
          }
        } finally {
          controller.abort();
        }
      }
      options.trace?.({
        type: 'model_pool_exhausted',
        level: 'error',
        message: attemptedNodeIds.length
          ? '模型池所有尝试均失败'
          : '模型池没有可认领节点',
        poolKey: runtime.poolKey ?? 'official',
        reason: attemptedNodeIds.length
          ? 'all_attempts_failed'
          : 'no_claimable_nodes',
        attemptedNodeIds,
        skippedNodeIds,
      });
      output.push({
        type: 'error',
        reason: 'error',
        error: fallbackError(false, accumulated, {
          kinds: failureKinds.size ? [...failureKinds] : ['pool_unavailable'],
        }),
      });
    };
    void run().catch((error) => {
      options.trace?.({
        type: 'model_pool_error',
        level: 'error',
        message: '模型池执行失败',
        poolKey: runtime.poolKey ?? 'official',
        ...(currentNode ? nodeContext(currentNode) : {}),
        phase,
        error: errorDetails(error, runtime, false),
      });
      // Infrastructure failures terminate the stream; no raw provider or database values cross the boundary.
      output.push({
        type: 'error',
        reason: 'error',
        error: fallbackError(false, accumulated, { kinds: ['internal'] }),
      });
    });
    return output;
  };
}
