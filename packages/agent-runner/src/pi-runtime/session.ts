import {
  createAgentSession,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

import { getContext } from '../context.js';
import { traceEvent } from '../trace.js';
import type {
  ContainerInput,
  PiSessionSnapshot,
  TokenUsage,
} from '../types.js';
import type { RequestRuntime } from '../runtime.js';
import type { RequestScope } from '../request-scope.js';
import { createPiResourceLoader } from './resource-loader.js';
import { createPiProviderRuntime } from './provider.js';
import { createPiCustomTools } from './tools.js';
import { createPiSessionContext } from './context-layer.js';
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
import { createFateClawPiSessionManager } from './session-manager.js';
import type { PiToolExecutionRecord } from './types.js';
import type { SkillContextEntry } from '../types.js';
import { getRequestId } from '../request-scope.js';

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
}): Promise<PiSessionRunResult> {
  const usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const records: PiToolExecutionRecord[] = [];
  let lastAssistantText: string | null = null;

  const providerRuntime = createPiProviderRuntime(args.containerInput.llmRuntime);
  const userId = resolveUserId(args.containerInput);
  const sessionContext = await createPiSessionContext({
    containerInput: args.containerInput,
    runtime: args.runtime,
    requestScope: args.requestScope,
  });
  const resourceLoader = await createPiResourceLoader({
    deps: args.runtime.deps,
    userId,
    requestScope: args.requestScope,
    containerInput: args.containerInput,
    piContextPrompt: sessionContext.prompt,
  });
  const readableSkills = resourceLoader
    .getSkills()
    .skills.filter((skill) => !skill.disableModelInvocation);
  const systemPrompt = resourceLoader.getSystemPrompt() ?? '';
  const appendSystemPrompt = resourceLoader.getAppendSystemPrompt();
  const customTools = createPiCustomTools({
    requestScope: args.requestScope,
    readableSkills,
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
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    model: providerRuntime.model,
    thinkingLevel: 'xhigh',
    authStorage: providerRuntime.authStorage,
    modelRegistry: providerRuntime.modelRegistry,
    resourceLoader,
    sessionManager: piSession.manager,
    settingsManager,
    noTools: 'all',
    tools: allowedToolNames,
    customTools,
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
  } finally {
    unsubscribe();
    session.dispose();
  }
}
