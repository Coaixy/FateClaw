import { queryLatestFollowupWorkflowContext } from './agent-db.js';
import { tryExecuteCommand } from './commands.js';
import {
  resolveEvidenceCategoryBySkill,
} from './evidence-policy.js';
import { buildUserPastedBoardSkillContext } from './pasted-board-context.js';
import { log } from './io.js';
import { mapContainerErrorToPublicError } from './public-error.js';
import { listTranscriptEvents } from './transcript-store.js';
import { createRequestRuntime } from './runtime.js';
import type { AgentRuntimeDeps } from './deps.js';
import { executeAgentKernel } from './agent-kernel/index.js';
import {
  createRequestScope,
  setLatestFollowupInterpretation,
  listScopedTraceEvents,
  setRequestId,
  getRequestId,
  getLatestFollowupInterpretation,
  type RequestScope,
} from './request-scope.js';
import { traceEvent } from './trace.js';
import {
  ContainerInput,
  ContainerOutput,
  SkillContextEntry,
} from './types.js';

function buildSessionId(sessionId?: string): string {
  if (sessionId) {
    return sessionId;
  }

  return `hushbay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractLatestFollowupInterpretation(
  history: ContainerInput['history'],
  category: string | null | undefined,
): {
  category: string;
  interpretationOutput: string;
  boardSkill?: string;
  boardOutput?: string;
  boardArtifactData?: unknown;
} | null {
  if (!category) return null;

  let interpretationOutput = '';
  let boardSkill: string | undefined;
  let boardOutput: string | undefined;
  let boardArtifactData: unknown;

  for (let i = history.length - 1; i >= 0; i--) {
    const toolContext = history[i].toolContext ?? [];
    if (toolContext.length === 0) continue;

    if (!interpretationOutput) {
      const interpretation = toolContext.find(
        (entry) => entry.skill === 'xuanxue-jiedu',
      );
      interpretationOutput = interpretation?.output ?? '';
    }

    if (!boardSkill) {
      const board = toolContext.find(
        (entry) => resolveEvidenceCategoryBySkill(entry.skill) === category,
      );
      if (board) {
        boardSkill = board.skill;
        boardOutput = board.output;
        boardArtifactData = board.artifactData;
      }
    }

    if (interpretationOutput && boardSkill) {
      break;
    }
  }

  if (!interpretationOutput && !boardSkill) {
    return null;
  }

  return {
    category,
    interpretationOutput,
    boardSkill,
    boardOutput,
    boardArtifactData,
  };
}

function buildBoardSkillContextFromFollowup(
  context: ReturnType<typeof getLatestFollowupInterpretation>,
): SkillContextEntry | null {
  if (!context?.boardSkill) return null;
  if (!context.boardOutput && context.boardArtifactData === undefined) {
    return null;
  }

  return {
    skill: context.boardSkill,
    output:
      context.boardOutput ??
      JSON.stringify(context.boardArtifactData, null, 2),
    artifactType: `skill.${context.boardSkill}`,
    artifactTitle: `Skill 结果: ${context.boardSkill}`,
    artifactData: context.boardArtifactData,
  };
}

function mergeReferencedBoardContext(args: {
  containerInput: ContainerInput;
  requestScope: RequestScope;
  skillContext: SkillContextEntry[] | undefined;
}): SkillContextEntry[] | undefined {
  const skillContext = args.skillContext ?? [];
  const referencedBoardContext =
    args.containerInput.inputKind === 'user_pasted_board' &&
    args.containerInput.pastedBoard
      ? buildUserPastedBoardSkillContext(args.containerInput.pastedBoard)
      : buildBoardSkillContextFromFollowup(
          getLatestFollowupInterpretation(args.requestScope),
        );
  const hasInterpretation = skillContext.some(
    (entry) => entry.skill === 'xuanxue-jiedu',
  );
  if (!hasInterpretation) {
    return skillContext.length > 0 ? skillContext : undefined;
  }

  if (
    !referencedBoardContext ||
    skillContext.some(
      (entry) =>
        entry.skill === referencedBoardContext.skill &&
        entry.output === referencedBoardContext.output,
    )
  ) {
    return skillContext;
  }

  // 手动排盘后的解读需要把“本次引用的原盘”和“解读结果”一起落库，
  // 后续追问才不会只看到 xuanxue-jiedu 文本而丢掉原始盘面 JSON。
  return [referencedBoardContext, ...skillContext];
}

async function resolveLatestFollowupInterpretationContext(args: {
  containerInput: ContainerInput;
}): Promise<{
  category: string;
  interpretationOutput: string;
  boardSkill?: string;
  boardOutput?: string;
  boardArtifactData?: unknown;
} | null> {
  const fromHistory = (() => {
    for (let i = args.containerInput.history.length - 1; i >= 0; i--) {
      const toolContext = args.containerInput.history[i].toolContext ?? [];
      if (toolContext.length === 0) continue;

      const board = toolContext.find(
        (entry) => resolveEvidenceCategoryBySkill(entry.skill) !== null,
      );
      const interpretation = toolContext.find(
        (entry) => entry.skill === 'xuanxue-jiedu',
      );
      if (!board && !interpretation) continue;
      const category = board
        ? resolveEvidenceCategoryBySkill(board.skill)
        : null;
      if (!category) continue;
      return extractLatestFollowupInterpretation(
        args.containerInput.history,
        category,
      );
    }
    return null;
  })();
  if (fromHistory?.boardOutput || fromHistory?.boardArtifactData) {
    return fromHistory;
  }

  const category = fromHistory?.category;

  try {
    const fromDb = await queryLatestFollowupWorkflowContext({
      accountId: args.containerInput.accountId,
      category,
      sessionId: args.containerInput.sessionId,
    });
    return fromDb ?? fromHistory;
  } catch (error) {
    log(
      `followup context db fallback failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return fromHistory;
  }
}

export async function executeContainerInput(
  containerInput: ContainerInput,
  requestScope: RequestScope = createRequestScope(),
  depsOverride?: AgentRuntimeDeps,
): Promise<ContainerOutput> {
  setLatestFollowupInterpretation(
    requestScope,
    await resolveLatestFollowupInterpretationContext({ containerInput }),
  );

  const sessionId = buildSessionId(containerInput.sessionId);
  const runtime = createRequestRuntime({ deps: depsOverride });
  if (!getRequestId(requestScope)) {
    setRequestId(requestScope, sessionId);
  }

  // 固定指令拦截：以 "/" 开头的消息
  const commandResult = await tryExecuteCommand(
    containerInput.accountId,
    containerInput.userMessage,
    runtime.deps,
  );
  if (commandResult) {
    if (commandResult.rewrite) {
      // 改写模式：替换用户消息后继续走 AI
      log(`指令改写: ${containerInput.userMessage.trim().split(' ')[0]} -> AI`);
      containerInput = {
        ...containerInput,
        userMessage: commandResult.rewrite,
      };
    } else {
      // 直接返回模式
      log(`固定指令已处理: ${containerInput.userMessage.trim().split(' ')[0]}`);
      return {
        status: 'success',
        result: commandResult.text,
        newSessionId: sessionId,
        clearHistory: commandResult.clearHistory,
      };
    }
  }

  const llmRuntime = containerInput.llmRuntime;
  const provider = llmRuntime.provider;
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
    const kernelResult = await executeAgentKernel({
      containerInput,
      llmRuntime,
      runtime,
      requestScope,
    });

    const transcript = listTranscriptEvents(requestScope);
    const traceEvents = listScopedTraceEvents(requestScope);
    return {
      status: 'success',
      result: kernelResult.text,
      newSessionId: sessionId,
      usage: kernelResult.usage,
      skillContext: mergeReferencedBoardContext({
        containerInput,
        requestScope,
        skillContext:
          kernelResult.skillContext.length > 0
            ? kernelResult.skillContext
            : undefined,
      }),
      transcript: transcript.length > 0 ? transcript : undefined,
      model,
      provider,
      traceEvents: traceEvents.length > 0 ? traceEvents : undefined,
      agentGraph: kernelResult.agentGraph,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    log(`Agent 出错: ${errorMessage}`);

    // 错误分支也带上 transcript / trace / model / provider，便于 admin 排障。
    // transcript 和 trace 可能已有部分内容（在出错前的工具调用/loop iteration），
    // 丢弃它们等于对排障场景丢失最有价值的信息。
    const transcript = listTranscriptEvents(requestScope);
    const traceEvents = listScopedTraceEvents(requestScope);
    return {
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
      ...mapContainerErrorToPublicError(errorMessage, { llmRuntime }),
      transcript: transcript.length > 0 ? transcript : undefined,
      model,
      provider,
      traceEvents: traceEvents.length > 0 ? traceEvents : undefined,
    };
  }
}
