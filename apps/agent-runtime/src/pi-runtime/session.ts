import {
  createAgentSession,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

import { getContext } from '../context.js';
import { traceEvent } from '../trace.js';
import type {
  ContainerInput,
  PiThinkingLevel,
  PiSessionSnapshot,
  TokenUsage,
} from '../types.js';
import type { RequestRuntime } from '../runtime.js';
import type { RequestScope } from '../request-scope.js';
import { createPiResourceLoader } from './resource-loader.js';
import {
  assertCustomBaseUrlIsPublic,
  createPiProviderRuntime,
} from './provider.js';
import { createPiCustomTools } from './tools.js';
import {
  buildVisibleSessionBoardContexts,
  createPiSessionContext,
} from './context-layer.js';
import {
  createPiEventCollector,
  extractLatestAssistantResult,
} from './events.js';
import {
  createAiChatStreamPublisher,
  enrichAiChatStreamEvent,
  publishAiChatStreamEvent,
  pushAiChatOutboxMessage,
} from '../ai-chat-stream.js';
import { log } from '../io.js';
import { attachPartialUsage } from '../partial-usage.js';
import { recordBenefitToolCall } from '../benefit-execution.js';
import { createFateClawPiSessionManager } from './session-manager.js';
import type { PiToolExecutionRecord } from './types.js';
import type { SkillContextEntry } from '../types.js';
import { getRequestId } from '../request-scope.js';
import { installModelPool } from './model-pool.js';
import { ModelCallError } from '../public-error.js';

const DEFAULT_THINKING_LEVEL: PiThinkingLevel = 'medium';

function resolveThinkingLevel(
  level: PiThinkingLevel | undefined,
): PiThinkingLevel {
  return level ?? DEFAULT_THINKING_LEVEL;
}

export interface PiSessionRunResult {
  text: string | null;
  usage: TokenUsage;
  records: PiToolExecutionRecord[];
  persistedSkillContext: SkillContextEntry[];
  piSession?: PiSessionSnapshot;
}

function buildPiSessionSnapshot(args: {
  id?: string;
  file?: string;
  persisted: boolean;
  provider: string;
  model: string;
  userPrompt: string;
  systemPrompt: string;
  appendSystemPrompt: string[];
  allowedTools: string[];
  readableSkills: Array<{
    name: string;
    description?: string;
  }>;
  messages: unknown[];
}): PiSessionSnapshot {
  return {
    id: args.id,
    file: args.file,
    persisted: args.persisted,
    provider: args.provider,
    model: args.model,
    userPrompt: args.userPrompt,
    systemPrompt: args.systemPrompt,
    appendSystemPrompt: args.appendSystemPrompt,
    allowedTools: args.allowedTools,
    readableSkills: args.readableSkills,
    messageCount: args.messages.length,
    messages: args.messages,
  };
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

export async function runPiSession(args: {
  containerInput: ContainerInput;
  runtime: RequestRuntime;
  requestScope: RequestScope;
  /** session 创建完成后暴露最小控制面，宿主可据此中断当前 turn。 */
  onSessionReady?: (sessionControls: { abort: () => Promise<void> }) => void;
}): Promise<PiSessionRunResult> {
  const usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const records: PiToolExecutionRecord[] = [];
  let lastAssistantText: string | null = null;

  // 自配（BYOK）Base URL 的解析型 SSRF 校验：同步字面量校验挡不住「公网域名解析到内网」，
  // 建 provider（发起真实 LLM 请求）之前先做一次 DNS 解析级校验。
  await assertCustomBaseUrlIsPublic(args.containerInput.llmRuntime);
  const providerRuntime = await createPiProviderRuntime(
    args.containerInput.llmRuntime,
  );
  const userId = resolveUserId(args.containerInput);
  const soulEditEnabled = await args.runtime.deps.soulStore.canEdit(
    args.containerInput.accountId,
  );
  const sessionContext = await createPiSessionContext({
    containerInput: args.containerInput,
    runtime: args.runtime,
    requestScope: args.requestScope,
    soulEditEnabled,
  });
  const resourceLoader = await createPiResourceLoader({
    deps: args.runtime.deps,
    userId,
    requestScope: args.requestScope,
    containerInput: args.containerInput,
    piContextPrompt: sessionContext.prompt,
    soulEditEnabled,
  });
  try {
    const readableSkills = resourceLoader
      .getSkills()
      .skills.filter((skill) => !skill.disableModelInvocation);
    const systemPrompt = resourceLoader.getSystemPrompt() ?? '';
    const appendSystemPrompt = resourceLoader.getAppendSystemPrompt();
    const customTools = createPiCustomTools({
      requestScope: args.requestScope,
      readableSkills,
      sessionBoards: buildVisibleSessionBoardContexts(args.containerInput),
      accountId: args.containerInput.accountId,
      soulStore: args.runtime.deps.soulStore,
      soulEditEnabled,
      recordExecution(record) {
        records.push(record);
      },
    }).map((tool) =>
      args.containerInput.llmRuntime.poolKey !== 'benefit'
        ? tool
        : {
            ...tool,
            async execute(...params: Parameters<typeof tool.execute>) {
              await recordBenefitToolCall(args.containerInput.llmRuntime);
              return tool.execute(...params);
            },
          },
    );

    const allowedToolNames = customTools.map((tool) => tool.name);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      // Warming issues extra billable calls outside the user-requested turn.
      cacheWarming: 'off',
      retry: {
        enabled: !args.containerInput.llmRuntime.poolNodes?.length,
        maxRetries: 2,
      },
      images: { blockImages: true },
      enableInstallTelemetry: false,
    });
    const cwd = process.cwd();
    const piSession = createFateClawPiSessionManager({
      cwd,
      sessionId: args.containerInput.sessionId,
    });
    installModelPool(providerRuntime, args.containerInput.llmRuntime, {
      trace: (event) => traceEvent(event, args.requestScope),
      answerSessionId: piSession.manager.getSessionId(),
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model: providerRuntime.model,
      thinkingLevel: resolveThinkingLevel(
        args.containerInput.llmRuntime.thinkingLevel,
      ),
      modelRuntime: providerRuntime.modelRuntime,
      resourceLoader,
      sessionManager: piSession.manager,
      settingsManager,
      noTools: 'all',
      tools: allowedToolNames,
      customTools,
    });

    args.onSessionReady?.({
      abort: () => session.abort(),
    });

    const stream = createAiChatStreamPublisher((event) => {
      void publishAiChatStreamEvent({
        sessionId: args.containerInput.sessionId,
        event: enrichAiChatStreamEvent({
          event,
          requestId: getRequestId(args.requestScope),
          accountId: args.containerInput.accountId,
          sessionId: args.containerInput.sessionId,
        }),
      }).catch((err) => {
        log(
          `AI Chat stream event 发布失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    const unsubscribe = session.subscribe(
      createPiEventCollector({
        requestScope: args.requestScope,
        usage,
        accountId: args.containerInput.accountId,
        requestId: getRequestId(args.requestScope),
        setLastAssistantText(text) {
          lastAssistantText = text;
        },
        publishStreamEvent: stream.publish,
        pushOutboxProgress(message) {
          void pushAiChatOutboxMessage({
            outboxQueue: args.containerInput.outboxQueue,
            message,
          }).catch((err) => {
            log(
              `AI Chat tool progress 入队失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        },
      }),
    );

    try {
      traceEvent(
        {
          type: 'pi_session_started',
          provider: args.containerInput.llmRuntime.piApi,
          model: args.containerInput.llmRuntime.model,
          customToolCount: customTools.length,
          builtinToolsDisabled: true,
          piSessionId: piSession.piSessionId,
          piSessionFile: piSession.sessionFile,
          piSessionPersisted: piSession.persisted,
        },
        args.requestScope,
      );
      await session.prompt(args.containerInput.userMessage, {
        source: 'extension',
      });
      const latestAssistant = extractLatestAssistantResult(
        session.state.messages,
      );
      if (latestAssistant?.error) {
        // Pi 把 Provider 欠费、鉴权和协议错误写在 assistant.errorMessage，prompt 本身可能正常 resolve。
        // 转成异常后复用 request-boundary 的脱敏与 publicErrorText 映射，避免成功空回复。
        throw latestAssistant.modelFailure
          ? new ModelCallError(
              latestAssistant.modelFailure,
              args.containerInput.llmRuntime.poolKey ?? 'official',
            )
          : new Error(latestAssistant.error);
      }
      if (
        args.containerInput.llmRuntime.poolKey === 'benefit' &&
        !latestAssistant?.text?.trim()
      )
        throw new Error('免费模型未能完成回答，请稍后重试');
      return {
        text: latestAssistant?.text ?? lastAssistantText,
        usage,
        records,
        persistedSkillContext: sessionContext.persistedSkillContext,
        piSession: buildPiSessionSnapshot({
          id: piSession.piSessionId,
          file: piSession.sessionFile,
          persisted: piSession.persisted,
          provider: args.containerInput.llmRuntime.piApi,
          model: args.containerInput.llmRuntime.model,
          userPrompt: args.containerInput.userMessage,
          systemPrompt,
          appendSystemPrompt,
          allowedTools: allowedToolNames,
          readableSkills: readableSkills.map((skill) => ({
            name: skill.name,
            description: skill.description,
          })),
          messages: session.state.messages,
        }),
      };
    } catch (err) {
      // usage 已被事件采集器就地累加为"截至出错时的真实 partial 用量"。
      // 挂到 error 上,供 request-boundary 的 catch 取出回传给宿主结算,
      // 否则请求中途报错(provider 报错 / 工具异常 / compaction 失败 / 中断)时,
      // 出错前已消耗的 token 会按 0 关账,全部免费(漏收)。
      attachPartialUsage(err, usage);
      throw err;
    } finally {
      unsubscribe();
      stream.close();
      session.dispose();
    }
  } finally {
    resourceLoader.disposeSkillSnapshots();
  }
}
