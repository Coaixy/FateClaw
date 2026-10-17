import { log } from './io.js';
import { mapContainerErrorToPublicError } from './public-error.js';
import { listTranscriptEvents } from './transcript-store.js';
import { createRequestRuntime } from './runtime.js';
import type { AgentRuntimeDeps } from './deps.js';
import { readPartialUsage } from './partial-usage.js';
import { executePiRuntime } from './pi-runtime/index.js';
import {
  createRequestScope,
  listScopedTraceEvents,
  setRequestId,
  getRequestId,
  type RequestScope,
} from './request-scope.js';
import { traceEvent } from './trace.js';
import {
  ContainerInput,
  ContainerOutput,
} from './types.js';

function buildSessionId(sessionId?: string): string {
  if (sessionId) {
    return sessionId;
  }

  return `fateclaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function executeContainerInput(
  containerInput: ContainerInput,
  requestScope: RequestScope = createRequestScope(),
  depsOverride?: AgentRuntimeDeps,
  options?: {
    /** Pi session 就绪后向宿主暴露中断当前 turn 的控制面。 */
    onSessionReady?: (sessionControls: { abort: () => Promise<void> }) => void;
  },
): Promise<ContainerOutput> {
  const sessionId = buildSessionId(containerInput.sessionId);
  const runtime = createRequestRuntime({ deps: depsOverride });
  if (!getRequestId(requestScope)) {
    setRequestId(requestScope, sessionId);
  }

  const llmRuntime = containerInput.llmRuntime;
  const provider = llmRuntime.piApi;
  const model = llmRuntime.model;

  traceEvent({
    type: 'request_start',
    provider,
    model,
    historyCount: containerInput.history.length,
    promptPreview: containerInput.userMessage.slice(0, 300),
  }, requestScope);

  log(
    `使用 provider=${provider}, model=${model}, historyCount=${containerInput.history.length}`,
  );

  try {
    const kernelResult = await executePiRuntime({
      containerInput,
      llmRuntime,
      runtime,
      requestScope,
      onSessionReady: options?.onSessionReady,
    });

    const transcript = listTranscriptEvents(requestScope);
    const traceEvents = listScopedTraceEvents(requestScope);
    return {
      status: 'success',
      result: kernelResult.text,
      newSessionId: sessionId,
      usage: kernelResult.usage,
      skillContext:
        kernelResult.skillContext.length > 0
          ? kernelResult.skillContext
          : undefined,
      transcript: transcript.length > 0 ? transcript : undefined,
      model,
      provider,
      traceEvents: traceEvents.length > 0 ? traceEvents : undefined,
      agentGraph: kernelResult.agentGraph,
      piSession: kernelResult.piSession,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    log(`Agent 出错: ${errorMessage}`);

    // 错误分支也带上 transcript / trace / model / provider，便于 admin 排障。
    // transcript 和 trace 可能已有部分内容（在出错前的工具调用/loop iteration），
    // 丢弃它们等于对排障场景丢失最有价值的信息。
    const transcript = listTranscriptEvents(requestScope);
    const traceEvents = listScopedTraceEvents(requestScope);
    // 回传截至出错时的真实 partial usage(由 runPiSession 挂在 error 上),
    // 让宿主对中途报错的请求也按真实已消耗 token 结算,而非按 0 关账漏收。
    const partialUsage = readPartialUsage(error);
    return {
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
      ...mapContainerErrorToPublicError(error, { llmRuntime }),
      usage: partialUsage,
      transcript: transcript.length > 0 ? transcript : undefined,
      model,
      provider,
      traceEvents: traceEvents.length > 0 ? traceEvents : undefined,
    };
  }
}
