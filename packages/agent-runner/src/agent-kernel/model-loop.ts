import { runAgentLoop, type AgentLoopResult, type LoopAdapter } from '../base-loop.js';
import { AGENT_LOOP_TIMEOUT } from '../constants.js';
import type { RequestScope } from '../request-scope.js';
import { withTimeout } from '../timeout.js';
import type {
  ContainerInput,
  LlmRuntimeSnapshot,
  SkillContextEntry,
  ToolRegistrySnapshot,
} from '../types.js';
import type { AgentRuntimeDeps } from '../deps.js';
import { createLoopAdapterFromRuntime } from '../provider-factory.js';
import {
  formatBoardForAi,
  hasBoardFormatter,
} from '../tools/skill/board-formatters/index.js';

const calibrationCache = new Map<LlmRuntimeSnapshot['provider'], number>();

function renderSkillContextEntry(entry: SkillContextEntry): string {
  const content = hasBoardFormatter(entry.skill)
    ? formatBoardForAi({
        skill: entry.skill,
        output: entry.output,
        artifactData: entry.artifactData,
      })
    : entry.output;

  return [
    `【工具产物: ${entry.skill}】`,
    entry.artifactTitle ? `标题: ${entry.artifactTitle}` : null,
    content,
  ]
    .filter((line): line is string => Boolean(line && line.trim()))
    .join('\n');
}

export function renderHistoryContent(
  message: ContainerInput['history'][number],
): string {
  if (!Array.isArray(message.toolContext) || message.toolContext.length === 0) {
    return message.content;
  }
  return [
    message.content,
    '[关联工具产物]',
    message.toolContext.map(renderSkillContextEntry).join('\n\n'),
  ].join('\n\n');
}

function buildMessagesForRuntime(args: {
  llmRuntime: LlmRuntimeSnapshot;
  systemPrompt: string;
  userMessage: string;
  history: ContainerInput['history'];
}): unknown[] {
  const messages: unknown[] = [];

  if (args.llmRuntime.provider === 'openai-compatible') {
    messages.push({ role: 'system', content: args.systemPrompt });
  }

  for (const message of args.history) {
    messages.push({
      role: message.role,
      content: renderHistoryContent(message),
    });
  }
  messages.push({ role: 'user', content: args.userMessage });
  return messages;
}

export async function runKernelModelLoop(args: {
  llmRuntime: LlmRuntimeSnapshot;
  accountId: string;
  systemPrompt: string;
  userMessage: string;
  history: ContainerInput['history'];
  requestScope: RequestScope;
  toolRegistry: ToolRegistrySnapshot;
  runtimeDeps: AgentRuntimeDeps;
  /** Supervisor 委派时的原始 goal，用于 interpret_xuanxue 等工具获取完整信息。 */
  delegationGoal?: string;
  inputKind?: import('../types.js').ChatInputKind;
  pastedBoard?: import('../types.js').UserPastedBoardInput;
  activeBoardContext?: import('../types.js').ActiveBoardContext;
  /**
   * 循环级超时（毫秒）。默认 AGENT_LOOP_TIMEOUT=180s。
   * Supervisor 使用更长超时时间，因为内部会委派多个 specialist。
   */
  loopTimeout?: number;
}): Promise<AgentLoopResult> {
  const loopTimeout = args.loopTimeout ?? AGENT_LOOP_TIMEOUT;
  const { adapter, model } = createLoopAdapterFromRuntime(args.llmRuntime, {
    protectedToolNames: args.toolRegistry.getProtectedToolNames(),
  });
  const messages = buildMessagesForRuntime({
    llmRuntime: args.llmRuntime,
    systemPrompt: args.systemPrompt,
    userMessage: args.userMessage,
    history: args.history,
  });
  const systemPrompt =
    args.llmRuntime.provider === 'openai-compatible'
      ? undefined
      : {
          cached: args.systemPrompt,
          uncached: '',
        };

  const result = await withTimeout(
    (signal) =>
      runAgentLoop(
        adapter as LoopAdapter<unknown, unknown>,
        model,
        messages,
        {
          systemPrompt,
          currentUserMessage: args.userMessage,
          accountId: args.accountId,
          initialCalibrationFactor: calibrationCache.get(args.llmRuntime.provider),
          requestScope: args.requestScope,
          toolRegistry: args.toolRegistry,
          runtimeDeps: args.runtimeDeps,
          delegationGoal: args.delegationGoal,
          inputKind: args.inputKind,
          pastedBoard: args.pastedBoard,
          activeBoardContext: args.activeBoardContext,
          llmRuntime: args.llmRuntime,
        },
        signal,
      ),
    loopTimeout,
    `agent-kernel-${args.llmRuntime.provider}-loop`,
  );
  calibrationCache.set(args.llmRuntime.provider, result.calibrationFactor);
  return result;
}
