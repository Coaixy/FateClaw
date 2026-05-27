import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

import { getContext } from '../context.js';
import { traceEvent } from '../trace.js';
import type { ContainerInput, TokenUsage } from '../types.js';
import type { RequestRuntime } from '../runtime.js';
import type { RequestScope } from '../request-scope.js';
import { createPiResourceLoader } from './resource-loader.js';
import { createPiProviderRuntime } from './provider.js';
import { createPiCustomTools } from './tools.js';
import {
  createPiEventCollector,
  extractAssistantTextFromMessages,
} from './events.js';
import type { PiToolExecutionRecord } from './types.js';

export interface PiSessionRunResult {
  text: string | null;
  usage: TokenUsage;
  records: PiToolExecutionRecord[];
}

function buildPrompt(input: ContainerInput): string {
  const historyText = input.history
    .slice(-12)
    .map((message) => {
      const toolContext = message.toolContext?.length
        ? `\n[关联工具产物]\n${message.toolContext
            .map((entry) => `${entry.skill}: ${entry.output}`)
            .join('\n\n')}`
        : '';
      return `${message.role}: ${message.content}${toolContext}`;
    })
    .join('\n\n');

  const boardContext = input.activeBoardContext
    ? [
        '[当前选中盘面]',
        `sourceMessageId=${input.activeBoardContext.sourceMessageId}`,
        `skill=${input.activeBoardContext.skill}`,
        input.activeBoardContext.output,
      ].join('\n')
    : '';

  const pastedBoard = input.pastedBoard
    ? [
        '[用户自贴盘面入口]',
        `category=${input.pastedBoard.category}`,
        `question=${input.pastedBoard.question}`,
        input.pastedBoard.content,
      ].join('\n')
    : '';

  return [
    historyText ? `[最近对话]\n${historyText}` : '',
    boardContext,
    pastedBoard,
    `[本轮用户消息]\n${input.userMessage}`,
  ]
    .filter(Boolean)
    .join('\n\n');
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
  let finalReply: string | null = null;
  let lastAssistantText: string | null = null;

  const providerRuntime = createPiProviderRuntime(args.containerInput.llmRuntime);
  const userId = resolveUserId(args.containerInput);
  const resourceLoader = await createPiResourceLoader({
    deps: args.runtime.deps,
    userId,
    requestScope: args.requestScope,
    containerInput: args.containerInput,
  });
  const readableSkills = resourceLoader
    .getSkills()
    .skills.filter((skill) => !skill.disableModelInvocation);
  const enabledSkillNames =
    await args.runtime.deps.skillCatalog.listEnabledSkillNames(userId);
  const customTools = createPiCustomTools({
    runtime: args.runtime,
    requestScope: args.requestScope,
    llmRuntime: args.containerInput.llmRuntime,
    enabledSkillNames,
    inputKind: args.containerInput.inputKind,
    pastedBoard: args.containerInput.pastedBoard,
    activeBoardContext: args.containerInput.activeBoardContext,
    userId,
    readableSkills,
    recordExecution(record) {
      records.push(record);
    },
    setFinalReply(text) {
      finalReply = text;
    },
  });

  const allowedToolNames = customTools.map((tool) => tool.name);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
    images: { blockImages: true },
    enableInstallTelemetry: false,
  });
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    model: providerRuntime.model,
    thinkingLevel: 'off',
    authStorage: providerRuntime.authStorage,
    modelRegistry: providerRuntime.modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager,
    noTools: 'all',
    tools: allowedToolNames,
    customTools,
  });

  const unsubscribe = session.subscribe(
    createPiEventCollector({
      requestScope: args.requestScope,
      usage,
      setLastAssistantText(text) {
        lastAssistantText = text;
      },
    }),
  );

  try {
    traceEvent(
      {
        type: 'pi_session_started',
        provider: args.containerInput.llmRuntime.provider,
        model: args.containerInput.llmRuntime.model,
        customToolCount: customTools.length,
        builtinToolsDisabled: true,
      },
      args.requestScope,
    );
    await session.prompt(buildPrompt(args.containerInput), {
      source: 'extension',
    });
    return {
      text:
        finalReply ??
        extractAssistantTextFromMessages(session.state.messages) ??
        lastAssistantText,
      usage,
      records,
    };
  } finally {
    unsubscribe();
    session.dispose();
  }
}
