import { listArtifacts } from '../artifact-store.js';
import type { ContainerInput, TokenUsage } from '../types.js';
import { traceEvent } from '../trace.js';
import type { CapabilityCatalog } from './capabilities.js';
import { DELEGATE_TOOL_TIMEOUT } from '../constants.js';
import { renderHistoryContent, runKernelModelLoop } from './model-loop.js';
import { buildSpecialistPrompt } from './prompts.js';
import type {
  SpecialistExecutionResult,
  SpecialistName,
} from './types.js';

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function summarizeRecentArtifacts(
  artifacts: ReturnType<typeof listArtifacts>,
): string {
  if (artifacts.length === 0) {
    return '（本轮请求内暂无新证据，请从对话历史中的工具调用结果获取上下文）';
  }

  return artifacts
    .slice(-5)
    .map((artifact) => {
      const preview = artifact.rawOutput.slice(0, 300);
      const hasMore = artifact.rawOutput.length > 300;
      const payloadKeys =
        artifact.payload && typeof artifact.payload === 'object'
          ? Object.keys(artifact.payload as Record<string, unknown>).join(', ')
          : null;

      return [
        `- ${artifact.producer} | ${artifact.title} | ${artifact.category || '未分类'}`,
        `  预览: ${preview}${hasMore ? '...' : ''}`,
        payloadKeys ? `  结构化字段: ${payloadKeys}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

function buildDelegationMessage(args: {
  specialist: SpecialistName;
  goal: string;
  containerInput: ContainerInput;
  currentArtifacts: ReturnType<typeof listArtifacts>;
}): string {
  return [
    `你当前被委派给 ${args.specialist}。`,
    `【用户本轮消息】\n${args.containerInput.userMessage}`,
    args.goal.trim() &&
    args.goal.trim() !== args.containerInput.userMessage.trim()
      ? `【Supervisor 目标说明】\n${args.goal}`
      : '',
    `【本轮新证据】\n${summarizeRecentArtifacts(args.currentArtifacts)}`,
    '如果已有足够证据，直接继续；如果缺参，就明确索取。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildSpecialistRuntimePromptTrace(args: {
  systemPrompt: string;
  userMessage: string;
  history: ContainerInput['history'];
}): Array<{ role: string; content: string; contentChunks: string[] }> {
  const toMessageTrace = (role: string, content: string) => ({
    role,
    content,
    contentChunks: chunkTraceText(content),
  });

  return [
    toMessageTrace('system', args.systemPrompt),
    ...args.history.map((message) =>
      toMessageTrace(message.role, renderHistoryContent(message)),
    ),
    toMessageTrace('user', args.userMessage),
  ];
}

function chunkTraceText(text: string): string[] {
  const chunkSize = 3800;
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += chunkSize) {
    chunks.push(text.slice(start, start + chunkSize));
  }
  return chunks.length > 0 ? chunks : [''];
}

export async function executeSpecialist(args: {
  specialist: SpecialistName;
  goal: string;
  containerInput: ContainerInput;
  llmRuntime: import('../types.js').LlmRuntimeSnapshot;
  capabilityCatalog: CapabilityCatalog;
  runtime: import('../runtime.js').RequestRuntime;
  requestScope: import('../request-scope.js').RequestScope;
}): Promise<SpecialistExecutionResult> {
  const artifactStart = listArtifacts(args.requestScope).length;
  const toolRegistry = args.capabilityCatalog.createRegistryForSpecialist(
    args.specialist,
  );
  const systemPrompt = buildSpecialistPrompt({
    specialist: args.specialist,
    capabilityCatalog: args.capabilityCatalog,
    personaPrompt: args.containerInput.personaPrompt,
    toolPrompts: toolRegistry.buildToolPrompts(),
  });
  const currentArtifacts = listArtifacts(args.requestScope);
  const userMessage = buildDelegationMessage({
    specialist: args.specialist,
    goal: args.goal,
    containerInput: args.containerInput,
    currentArtifacts,
  });

  traceEvent(
    {
      type: 'specialist_started',
      specialist: args.specialist,
      goal: args.goal,
    },
    args.requestScope,
  );

  try {
    // Specialist 不需要看完整对话历史，只需要最近若干轮提供"对话语境感知"。
    // supervisor 已经在 delegation message 里压缩了关键证据；这里限制到最近 6 条
    // 避免长上下文请求时每个 specialist 调用都全量重传 history 导致 token 翻倍。
    const SPECIALIST_HISTORY_LIMIT = 6;
    const fullHistory = args.containerInput.history;
    const trimmedHistory =
      fullHistory.length > SPECIALIST_HISTORY_LIMIT
        ? fullHistory.slice(-SPECIALIST_HISTORY_LIMIT)
        : fullHistory;

    traceEvent(
      {
        type: 'specialist_prompt_prepared',
        specialist: args.specialist,
        goal: args.goal,
        historyCount: trimmedHistory.length,
        systemPrompt,
        delegationMessage: userMessage,
        // 这里记录的是 specialist 实际送进模型 loop 的消息结构，方便 admin
        // 排障时直接看运行时 prompt，而不是只看 supervisor 的委派目标。
        runtimePromptMessages: buildSpecialistRuntimePromptTrace({
          systemPrompt,
          userMessage,
          history: trimmedHistory,
        }),
      },
      args.requestScope,
    );

    // interpret-agent 需要保留更长工具超时，便于完成知识库读取与主 loop 解读。
    const loopTimeout =
      args.specialist === 'xuanxue-interpret-agent'
        ? DELEGATE_TOOL_TIMEOUT
        : undefined;

    const loopResult = await runKernelModelLoop({
      llmRuntime: args.llmRuntime,
      accountId: args.containerInput.accountId,
      systemPrompt,
      userMessage,
      history: trimmedHistory,
      requestScope: args.requestScope,
      toolRegistry,
      runtimeDeps: args.runtime.deps,
      delegationGoal: args.goal,
      inputKind: args.containerInput.inputKind,
      pastedBoard: args.containerInput.pastedBoard,
      activeBoardContext: args.containerInput.activeBoardContext,
      loopTimeout,
    });

    const newArtifacts = listArtifacts(args.requestScope).slice(artifactStart);

    traceEvent(
      {
        type: 'specialist_completed',
        specialist: args.specialist,
        goal: args.goal,
        textLength: loopResult.text?.length ?? 0,
        skillCount: loopResult.skillContext.length,
        newArtifactCount: newArtifacts.length,
      },
      args.requestScope,
    );

    return {
      specialist: args.specialist,
      success: true,
      text: loopResult.text,
      technicalFailure: loopResult.latestToolError,
      usage: loopResult.usage,
      skillContext: loopResult.skillContext,
      newArtifacts,
    };
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : String(error);

    traceEvent(
      {
        type: 'specialist_failed',
        specialist: args.specialist,
        goal: args.goal,
        failureReason,
      },
      args.requestScope,
    );

    return {
      specialist: args.specialist,
      success: false,
      failureReason,
      text: null,
      technicalFailure: null,
      usage: emptyUsage(),
      skillContext: [],
      newArtifacts: [],
    };
  }
}
