import {
  createAgentSession,
  SettingsManager,
  type SessionManager,
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
import { createPiProviderRuntime } from './provider.js';
import { createPiCustomTools } from './tools.js';
import {
  buildVisibleSessionBoardContexts,
  createPiSessionContext,
} from './context-layer.js';
import {
  createPiEventCollector,
  extractAssistantTextFromMessages,
} from './events.js';
import {
  enrichAiChatStreamEvent,
  publishAiChatStreamEvent,
  pushAiChatOutboxMessage,
} from '../ai-chat-stream.js';
import { log } from '../io.js';
import { attachPartialUsage } from '../partial-usage.js';
import { createFateClawPiSessionManager } from './session-manager.js';
import type { PiToolExecutionRecord } from './types.js';
import type { SkillContextEntry } from '../types.js';
import { getRequestId } from '../request-scope.js';

const DEFAULT_THINKING_LEVEL: PiThinkingLevel = 'medium';

function resolveThinkingLevel(
  level: PiThinkingLevel | undefined,
): PiThinkingLevel {
  return level ?? DEFAULT_THINKING_LEVEL;
}

/**
 * 把对外多轮历史（HistoryMessage）按真实 user/assistant 角色注入 pi 会话上下文。
 *
 * 仅用于对外 OpenAI 兼容入口的「无状态多轮」：每次请求会话独立（sessionId 随机），
 * 需把 messages 中末条 user 之前的轮次以真实角色补进会话树，createAgentSession 才能
 * 经 buildSessionContext 读到这些历史并送入 LLM。Web 内部多轮走持久化 sessionId，
 * history 恒为空、不进此分支。
 *
 * 注意：必须在 createAgentSession 之前调用——createAgentSession 在构造时一次性读取
 * manager 当前的会话上下文（sdk 内 buildSessionContext），之后追加的消息不再纳入本轮。
 *
 * AssistantMessage 的 api/provider/model 等元数据仅用于会话本地记账，不会回传给 provider；
 * usage 一律置零、stopReason 固定 'stop'——这些是「重放」的历史，而非本次真实生成结果。
 */
function injectHistoryMessages(
  manager: SessionManager,
  history: ContainerInput['history'],
  runtime: ContainerInput['llmRuntime'],
): void {
  for (const item of history) {
    const content = item.content?.trim();
    if (!content) continue;
    const timestamp = Date.now();
    if (item.role === 'user') {
      manager.appendMessage({
        role: 'user',
        content,
        timestamp,
      });
    } else {
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: content }],
        api: runtime.piApi,
        provider: runtime.providerKey,
        model: runtime.model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp,
      });
    }
  }
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

  const providerRuntime = createPiProviderRuntime(
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
    userMessage: args.containerInput.userMessage,
    recordExecution(record) {
      records.push(record);
    },
  });

  const allowedToolNames = customTools.map((tool) => tool.name);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
    images: { blockImages: true },
    enableInstallTelemetry: false,
  });
  const cwd = process.cwd();
  const piSession = createFateClawPiSessionManager({
    cwd,
    sessionId: args.containerInput.sessionId,
  });
  // 对外多轮历史按角色注入（Web 内部 history 恒为空，跳过）；必须先于 createAgentSession。
  if (args.containerInput.history.length > 0) {
    injectHistoryMessages(
      piSession.manager,
      args.containerInput.history,
      args.containerInput.llmRuntime,
    );
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    model: providerRuntime.model,
    thinkingLevel: resolveThinkingLevel(
      args.containerInput.llmRuntime.thinkingLevel,
    ),
    authStorage: providerRuntime.authStorage,
    modelRegistry: providerRuntime.modelRegistry,
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

  const unsubscribe = session.subscribe(
    createPiEventCollector({
      requestScope: args.requestScope,
      usage,
      accountId: args.containerInput.accountId,
      requestId: getRequestId(args.requestScope),
      setLastAssistantText(text) {
        lastAssistantText = text;
      },
      publishStreamEvent(event) {
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
      },
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
    return {
      text:
        extractAssistantTextFromMessages(session.state.messages) ??
        lastAssistantText,
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
    session.dispose();
  }
}
