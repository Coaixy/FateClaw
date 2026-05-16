import { traceEvent } from '../trace.js';
import type { SkillContextEntry, TokenUsage } from '../types.js';
import { getContext } from '../context.js';
import { resolveEvidenceCategoryBySkill } from '../evidence-policy.js';
import { createCapabilityCatalog } from './capabilities.js';
import { createAgentGraphBuilder } from './graph.js';
import { SUPERVISOR_LOOP_TIMEOUT } from '../constants.js';
import { runKernelModelLoop } from './model-loop.js';
import { buildSupervisorPrompt } from './prompts.js';
import { executeSpecialist } from './specialists.js';
import { createSupervisorToolRegistry } from './supervisor-tools.js';
import {
  buildUserPastedBoardInterpretGoal,
  canUseUserPastedBoardContent,
} from './user-pasted-board.js';
import type {
  KernelExecutionInput,
  KernelExecutionResult,
  SpecialistExecutionResult,
  SpecialistName,
} from './types.js';

function emptyUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function mergeUsage(target: TokenUsage, next?: TokenUsage): void {
  if (!next) return;
  target.promptTokens += next.promptTokens;
  target.completionTokens += next.completionTokens;
  target.totalTokens += next.totalTokens;
}

function mergeSkillContext(
  target: SkillContextEntry[],
  next: SkillContextEntry[],
): void {
  for (const entry of next) {
    const exists = target.some(
      (item) => item.skill === entry.skill && item.output === entry.output,
    );
    if (!exists) {
      target.push(entry);
    }
  }
}

export async function executeAgentKernel(
  args: KernelExecutionInput,
): Promise<KernelExecutionResult> {
  const ctx = getContext();
  const capabilityCatalog = await createCapabilityCatalog({
    baseRegistry: args.runtime.toolRegistry,
    deps: args.runtime.deps,
    accountId: ctx.accountId,
    userId: ctx.userId || undefined,
  });
  const totalUsage = emptyUsage();
  const aggregatedSkillContext: SkillContextEntry[] = [];
  const graphBuilder = createAgentGraphBuilder({
    requestId: args.requestScope.requestId || `request-${Date.now()}`,
    containerInput: args.containerInput,
  });

  const runSpecialist = async (input: {
    specialist: SpecialistName;
    goal: string;
  }): Promise<SpecialistExecutionResult> => {
    const result = await executeSpecialist({
      specialist: input.specialist,
      goal: input.goal,
      containerInput: args.containerInput,
      llmRuntime: args.llmRuntime,
      capabilityCatalog,
      runtime: args.runtime,
      requestScope: args.requestScope,
    });
    mergeUsage(totalUsage, result.usage);
    mergeSkillContext(aggregatedSkillContext, result.skillContext);
    graphBuilder.addSpecialistTask({
      specialist: input.specialist,
      source: 'supervisor',
      goal: input.goal,
      category: result.newArtifacts[0]?.category,
      outputPreview: result.text,
      artifacts: result.newArtifacts,
    });
    return result;
  };

  traceEvent({ type: 'agent_kernel_started' }, args.requestScope);

  const canUsePastedBoard = canUseUserPastedBoardContent(
    args.containerInput.inputKind,
    args.containerInput.pastedBoard,
  );

  if (
    args.containerInput.inputKind === 'user_pasted_board' &&
    !canUsePastedBoard
  ) {
    const finalText =
      '自贴盘面数据缺失，请重新通过“自贴盘面”入口提交盘面原文和问题。';
    graphBuilder.addFinalReply(finalText);
    traceEvent(
      {
        type: 'agent_kernel_completed',
        textLength: finalText.length,
        totalSkillContext: aggregatedSkillContext.length,
        fastPath: 'user_pasted_board_invalid',
      },
      args.requestScope,
    );
    return {
      text: finalText,
      usage: totalUsage,
      skillContext: aggregatedSkillContext,
      agentGraph: graphBuilder.build(),
    };
  }

  if (
    canUsePastedBoard &&
    capabilityCatalog.xuanxueInterpretationEnabled
  ) {
    const interpretResult = await runSpecialist({
      specialist: 'xuanxue-interpret-agent',
      goal: buildUserPastedBoardInterpretGoal(args.containerInput.pastedBoard!),
    });

    const finalText = interpretResult.text;
    graphBuilder.addFinalReply(finalText);

    traceEvent(
      {
        type: 'agent_kernel_completed',
        textLength: finalText?.length ?? 0,
        totalSkillContext: aggregatedSkillContext.length,
        fastPath: 'user_pasted_board_interpret',
      },
      args.requestScope,
    );

    return {
      text: finalText,
      usage: totalUsage,
      skillContext: aggregatedSkillContext,
      agentGraph: graphBuilder.build(),
    };
  }

  if (
    canUsePastedBoard &&
    !capabilityCatalog.xuanxueInterpretationEnabled
  ) {
    const finalText =
      'Free 版可以免费对话和排盘，但暂不支持玄学专业解读。请升级套餐后再解读自贴盘面。';
    graphBuilder.addFinalReply(finalText);
    return {
      text: finalText,
      usage: totalUsage,
      skillContext: aggregatedSkillContext,
      agentGraph: graphBuilder.build(),
    };
  }

  if (
    args.containerInput.activeBoardContext &&
    capabilityCatalog.xuanxueInterpretationEnabled
  ) {
    const activeBoard = args.containerInput.activeBoardContext;
    const category = resolveEvidenceCategoryBySkill(activeBoard.skill);
    const forcedGoal = [
      '用户当前明确选中了一张盘面，请直接按该盘面解读。',
      category ? `类别：${category}` : null,
      `盘面来源消息：${activeBoard.sourceMessageId}`,
      `用户问题：${args.containerInput.userMessage}`,
      `盘面来源 skill：${activeBoard.skill}`,
      '调用 interpret_xuanxue 时不要复制盘面 JSON 到 content；运行时会通过 activeBoardContext 注入这张选中盘面。content_source="skill"。如果模型参数里的类别与选中盘面的 skill 不一致，以选中盘面 skill 为准。',
    ]
      .filter(Boolean)
      .join('\n\n');

    const interpretResult = await runSpecialist({
      specialist: 'xuanxue-interpret-agent',
      goal: forcedGoal,
    });

    const finalText = interpretResult.text;
    graphBuilder.addFinalReply(finalText);

    traceEvent(
      {
        type: 'agent_kernel_completed',
        textLength: finalText?.length ?? 0,
        totalSkillContext: aggregatedSkillContext.length,
        fastPath: 'active_board_interpret',
      },
      args.requestScope,
    );

    return {
      text: finalText,
      usage: totalUsage,
      skillContext: aggregatedSkillContext,
      agentGraph: graphBuilder.build(),
    };
  }

  const supervisorRegistry = createSupervisorToolRegistry({
    currentUserMessage: args.containerInput.userMessage,
    accountId: args.containerInput.accountId,
    requestScope: args.requestScope,
    messageBus: args.runtime.deps.messageBus,
    runSpecialist,
    availableSpecialists: capabilityCatalog
      .listSpecialists()
      .map((specialist) => specialist.name),
  });

  const supervisorResult = await runKernelModelLoop({
    llmRuntime: args.llmRuntime,
    accountId: args.containerInput.accountId,
    systemPrompt: buildSupervisorPrompt({
      specialists: capabilityCatalog.listSpecialists(),
      capabilityCatalog,
      personaPrompt: args.containerInput.personaPrompt,
    }),
    userMessage: args.containerInput.userMessage,
    history: args.containerInput.history,
    requestScope: args.requestScope,
    toolRegistry: supervisorRegistry,
    runtimeDeps: args.runtime.deps,
    loopTimeout: SUPERVISOR_LOOP_TIMEOUT,
  });
  mergeUsage(totalUsage, supervisorResult.usage);

  const finalText = supervisorResult.text;

  graphBuilder.addFinalReply(finalText);

  traceEvent(
    {
      type: 'agent_kernel_completed',
      textLength: finalText?.length ?? 0,
      totalSkillContext: aggregatedSkillContext.length,
    },
    args.requestScope,
  );

  return {
    text: finalText,
    usage: totalUsage,
    skillContext: aggregatedSkillContext,
    agentGraph: graphBuilder.build(),
  };
}
