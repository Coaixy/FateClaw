import { randomUUID } from 'node:crypto';
import { getContext } from '#agent/context';
import { createHostToolCaller } from '#agent/host-tool-client';
import { createPaipanCaller } from '#agent/paipan-client';
import { getRequestId, type RequestScope } from '#agent/request-scope';
import type { RequestRuntime } from '#agent/runtime';
import { traceEvent } from '#agent/trace';
import type { ContainerInput } from '#agent/types';
import { createPiSessionContext } from './context-layer.js';
import {
  assertCustomBaseUrlIsPublic,
  createPiProviderRuntime,
} from './provider.js';
import { createPiResourceLoader } from './resource-loader.js';

export interface PreparePiSessionOptions {
  containerInput: ContainerInput;
  runtime: RequestRuntime;
  requestScope: RequestScope;
}

function resolveUserId(input: ContainerInput): string | undefined {
  try {
    const ctxUserId = getContext().userId.trim();
    if (ctxUserId) return ctxUserId;
  } catch {
    // 单元测试和部分嵌入式调用不会初始化 AgentContext，此时回退到 web accountId。
  }
  return input.accountId.startsWith('web:')
    ? input.accountId.slice(4)
    : undefined;
}

export async function preparePiSession({
  containerInput,
  runtime,
  requestScope,
}: PreparePiSessionOptions) {
  // 自配（BYOK）Base URL 的解析型 SSRF 校验：同步字面量校验挡不住「公网域名解析到内网」，
  // 建 provider（发起真实 LLM 请求）之前先做一次 DNS 解析级校验。
  await assertCustomBaseUrlIsPublic(containerInput.llmRuntime);
  const preparationStartedAt = Date.now();
  const userId = resolveUserId(containerInput);
  const requestId = getRequestId(requestScope);
  const routingSessionId =
    containerInput.sessionId?.trim() || requestId || randomUUID();
  const paipan =
    requestId && containerInput.executionId && containerInput.sessionId
      ? createPaipanCaller({
          accountId: containerInput.accountId,
          requestId,
          executionId: containerInput.executionId,
        })
      : undefined;
  const visualization =
    requestId &&
    containerInput.executionId &&
    containerInput.sessionId &&
    containerInput.accountId.startsWith('web:')
      ? createHostToolCaller('visualization', {
          accountId: containerInput.accountId,
          requestId,
          executionId: containerInput.executionId,
        })
      : undefined;
  const contextPromise = runtime.deps.soulStore
    .canEdit(containerInput.accountId)
    .then(async (soulEditEnabled) => ({
      ...(await createPiSessionContext({
        containerInput,
        runtime,
        requestScope,
        soulEditEnabled,
        paipanEnabled: Boolean(paipan),
      })),
      soulEditEnabled,
    }));
  const [provider, context, resources] = await Promise.allSettled([
    createPiProviderRuntime(containerInput.llmRuntime, routingSessionId),
    contextPromise,
    createPiResourceLoader({
      deps: runtime.deps,
      userId,
      requestScope,
      containerInput,
      context: contextPromise,
      paipanEnabled: Boolean(paipan),
    }),
  ]);
  if (provider.status === 'rejected') {
    if (resources.status === 'fulfilled')
      resources.value.disposeSkillSnapshots();
    throw provider.reason;
  }
  if (context.status === 'rejected') {
    // The resource loader also awaits context and releases snapshots if it failed.
    throw context.reason;
  }
  if (resources.status === 'rejected') throw resources.reason;

  const resourceLoader = resources.value;
  try {
    traceEvent(
      {
        type: 'agent_timing',
        stage: 'preparation',
        durationMs: Date.now() - preparationStartedAt,
      },
      requestScope,
    );

    return {
      routingSessionId,
      paipan,
      visualization,
      providerRuntime: provider.value,
      sessionContext: context.value,
      resourceLoader,
    };
  } catch (error) {
    resourceLoader.disposeSkillSnapshots();
    throw error;
  }
}
