import {
  DELEGATE_TOOL_TIMEOUT,
  SKILL_SCRIPT_TIMEOUT,
  TOOL_EXECUTION_TIMEOUT,
} from '../constants.js';
import type { AgentRuntimeDeps } from '../deps.js';
import { log } from '../io.js';
import type { RequestScope } from '../request-scope.js';
import { hasLoadedSkill } from '../request-scope.js';
import { runToolUse } from '../run-tool-use.js';
import {
  combineAbortSignals,
  isTimeoutError,
  throwIfAborted,
  withTimeout,
} from '../timeout.js';
import { traceEvent } from '../trace.js';
import type {
  ChatInputKind,
  ActiveBoardContext,
  LlmRuntimeSnapshot,
  SkillContextEntry,
  ToolRegistrySnapshot,
  ToolResult,
  UserPastedBoardInput,
} from '../types.js';
import {
  createToolError,
  createToolErrorResult,
} from '../tools/skill/tool-error.js';
import { formatArgs, sizeLabel } from './loop-logging.js';
import {
  resolveMissingLoadRepairSkillName,
  runSkillScriptKey,
} from './tool-call-ordering.js';

export interface ToolExecution<TToolCall> {
  toolCall: TToolCall;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: ToolResult;
  skillContextEntry?: SkillContextEntry;
  elapsed: number;
}

export interface ToolCallAdapter<TToolCall> {
  readonly providerName: string;
  getToolName(toolCall: TToolCall): string;
  getToolArgs(toolCall: TToolCall): Record<string, unknown>;
}

export interface ExecuteLoopToolOptions<TToolCall> {
  adapter: ToolCallAdapter<TToolCall>;
  toolCall: TToolCall;
  toolIndex: number;
  iteration: number;
  loopRunId: string;
  accountId: string;
  model: string;
  requestScope: RequestScope;
  toolRegistry: ToolRegistrySnapshot;
  runtimeDeps: AgentRuntimeDeps;
  llmRuntime: LlmRuntimeSnapshot;
  plannedRunSkillScripts: Set<string>;
  signal?: AbortSignal;
  delegationGoal?: string;
  inputKind?: ChatInputKind;
  pastedBoard?: UserPastedBoardInput;
  activeBoardContext?: ActiveBoardContext;
}

function resolveOuterTimeout(toolName: string): number {
  if (toolName === 'run_skill_script') return SKILL_SCRIPT_TIMEOUT + 5000;
  if (toolName === 'delegate_to_specialist' || toolName === 'interpret_xuanxue') {
    return DELEGATE_TOOL_TIMEOUT;
  }
  return TOOL_EXECUTION_TIMEOUT;
}

function buildTimeoutLabel(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  if (toolName === 'delegate_to_specialist') {
    const specialist =
      typeof toolArgs.specialist === 'string' ? toolArgs.specialist : '?';
    const goalPreview =
      typeof toolArgs.goal === 'string'
        ? toolArgs.goal.slice(0, 80).replace(/\n/g, ' ')
        : '';
    return `delegate_to_specialist(specialist=${specialist}${goalPreview ? `, goal=${goalPreview}` : ''})`;
  }

  if (toolName === 'interpret_xuanxue') {
    const category =
      typeof toolArgs.category === 'string' ? toolArgs.category : '?';
    const questionPreview =
      typeof toolArgs.question === 'string'
        ? toolArgs.question.slice(0, 60).replace(/\n/g, ' ')
        : '';
    return `interpret_xuanxue(category=${category}${questionPreview ? `, q=${questionPreview}` : ''})`;
  }

  return `tool:${toolName}`;
}

function classifyToolExecutionError(error: unknown): string {
  const errorName = error instanceof Error ? error.name : 'Error';
  if (isTimeoutError(error)) return 'timeout';
  if (errorName === 'AbortError') return 'cancelled';
  if (errorName === 'APIError' || errorName === 'APIStatusError') {
    return 'api_error';
  }
  if (errorName === 'APIConnectionError') return 'connection_error';
  return 'unknown';
}

export async function executeLoopTool<TToolCall>(
  options: ExecuteLoopToolOptions<TToolCall>,
): Promise<ToolExecution<TToolCall>> {
  throwIfAborted(options.signal, '工具执行已取消');
  let toolName: string;
  let toolArgs: Record<string, unknown>;

  try {
    toolName = options.adapter.getToolName(options.toolCall);
    toolArgs = options.adapter.getToolArgs(options.toolCall);
  } catch (parseError) {
    const errorMessage =
      parseError instanceof Error ? parseError.message : String(parseError);
    return {
      toolCall: options.toolCall,
      toolName: 'unknown',
      toolArgs: {},
      result: createToolErrorResult({
        code: 'SYSTEM.INTERNAL',
        kind: 'internal',
        retryable: false,
        userSafe: false,
        nextAction: 'stop',
        internalMessage: `工具处理过程中发生意外错误: ${errorMessage}`,
        details: {
          phase: 'parse_tool_call',
        },
      }),
      elapsed: 0,
    };
  }

  if (toolName === 'run_skill_script') {
    const key = runSkillScriptKey(toolArgs);
    if (key && options.plannedRunSkillScripts.has(key)) {
      log(`跳过重复工具调用 run_skill_script | ${key}`);
      traceEvent(
        {
          type: 'duplicate_tool_call_skipped',
          provider: options.adapter.providerName,
          iteration: options.iteration,
          toolName,
          key,
        },
        options.requestScope,
      );
      return {
        toolCall: options.toolCall,
        toolName,
        toolArgs,
        result: {
          output: `重复调用已跳过：第${options.iteration}轮已经成功执行过 ${key}。同一轮请直接使用第一次执行结果。`,
          skipArtifact: true,
          error: createToolError({
            code: 'SKILL.DUPLICATE_SAME_LOOP',
            kind: 'conflict',
            retryable: true,
            userSafe: false,
            nextAction: 'retry_next_turn',
            internalMessage: `重复调用已跳过：第${options.iteration}轮已经成功执行过 ${key}。同一轮请直接使用第一次执行结果。`,
            details: {
              skillScriptKey: key,
              loopIteration: options.iteration,
              loopRunId: options.loopRunId,
            },
          }),
        },
        elapsed: 0,
      };
    }
  }

  const toolStartTime = Date.now();
  const missingLoadSkillName = resolveMissingLoadRepairSkillName(
    toolName,
    toolArgs,
    options.runtimeDeps,
  );
  if (
    missingLoadSkillName &&
    !hasLoadedSkill(options.requestScope, missingLoadSkillName)
  ) {
    log(
      `工具自愈 | 第${options.iteration}轮 | ${toolName} 缺少前置 load_skill，自动补加载 ${missingLoadSkillName}`,
    );
    traceEvent(
      {
        type: 'tool_dependency_autoload',
        provider: options.adapter.providerName,
        iteration: options.iteration,
        toolName,
        skillName: missingLoadSkillName,
        reason: 'missing_load_skill',
      },
      options.requestScope,
    );
    try {
      const loadInvocation = {
        id: `repair-${options.iteration}-${toolName}-${options.toolIndex}-load_skill`,
        toolName: 'load_skill',
        args: { skill_name: missingLoadSkillName },
        source: 'model' as const,
      };
      const loadExecution = await withTimeout(
        (timeoutSignal) =>
          runToolUse(loadInvocation, {
            signal: combineAbortSignals(options.signal, timeoutSignal),
            requestScope: options.requestScope,
            loopIteration: options.iteration,
            loopRunId: options.loopRunId,
            toolRegistry: options.toolRegistry,
            runtimeDeps: options.runtimeDeps,
            llmRuntime: options.llmRuntime,
            delegationGoal: options.delegationGoal,
            inputKind: options.inputKind,
            pastedBoard: options.pastedBoard,
            activeBoardContext: options.activeBoardContext,
          }),
        TOOL_EXECUTION_TIMEOUT,
        'tool:load_skill:auto',
      );
      if (loadExecution.result.isError) {
        const elapsed = Date.now() - toolStartTime;
        log(
          `工具自愈失败 ${toolName} | 耗时 ${elapsed}ms | 错误: ${loadExecution.result.output}`,
        );
        return {
          toolCall: options.toolCall,
          toolName,
          toolArgs,
          result: loadExecution.result,
          elapsed,
        };
      }
    } catch (error) {
      const elapsed = Date.now() - toolStartTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(
        `工具自愈异常 ${toolName} | 耗时 ${elapsed}ms | 错误: ${errorMessage}`,
      );
      return {
        toolCall: options.toolCall,
        toolName,
        toolArgs,
        result: createToolErrorResult({
          code: 'SYSTEM.INTERNAL',
          kind: 'internal',
          retryable: true,
          userSafe: false,
          nextAction: 'retry',
          internalMessage: `执行 load_skill 自动补偿时出错: ${errorMessage}`,
          details: {
            toolName,
            missingLoadSkillName,
          },
        }),
        elapsed,
      };
    }
  }

  log(`调用工具 ${toolName} | ${formatArgs(toolArgs)}`);
  try {
    const invocation = {
      id: `model-${options.iteration}-${toolName}-${options.toolIndex}`,
      toolName,
      args: toolArgs,
      source: 'model' as const,
    };
    const execution = await withTimeout(
      (timeoutSignal) =>
        runToolUse(invocation, {
          signal: combineAbortSignals(options.signal, timeoutSignal),
          requestScope: options.requestScope,
          loopIteration: options.iteration,
          loopRunId: options.loopRunId,
          toolRegistry: options.toolRegistry,
          runtimeDeps: options.runtimeDeps,
          delegationGoal: options.delegationGoal,
          provider: options.adapter.providerName,
          model: options.model,
          llmRuntime: options.llmRuntime,
          inputKind: options.inputKind,
          pastedBoard: options.pastedBoard,
          activeBoardContext: options.activeBoardContext,
        }),
      resolveOuterTimeout(toolName),
      buildTimeoutLabel(toolName, toolArgs),
    );
    const elapsed = Date.now() - toolStartTime;
    const succeeded = !execution.result.isError;
    log(
      `工具完成 ${toolName} | ${succeeded ? '成功' : '失败'} | 耗时 ${elapsed}ms | 输出 ${sizeLabel(execution.result.output.length)} | ${execution.result.output.slice(0, 100)}`,
    );
    if (succeeded && toolName === 'run_skill_script') {
      const key = runSkillScriptKey(toolArgs);
      if (key) {
        // 同一轮只禁止“已经成功执行过”的同 skill/script 重复调用；
        // 失败尝试不占坑，允许模型在下一次动作里重试修正。
        options.plannedRunSkillScripts.add(key);
      }
    }
    return {
      toolCall: options.toolCall,
      toolName,
      toolArgs,
      result: execution.result,
      skillContextEntry: execution.skillContextEntry,
      elapsed,
    };
  } catch (error) {
    const elapsed = Date.now() - toolStartTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'Error';
    const errorType = classifyToolExecutionError(error);
    const argsSummary = formatArgs(toolArgs);
    log(
      `工具异常 ${toolName} | ${argsSummary} | 类型=${errorType} | 耗时 ${elapsed}ms | 错误: ${errorMessage}`,
    );
    traceEvent(
      {
        type: 'tool_error',
        provider: options.adapter.providerName,
        toolName,
        toolArgs: argsSummary,
        errorType,
        errorName,
        error: errorMessage,
        elapsedMs: elapsed,
      },
      options.requestScope,
    );
    return {
      toolCall: options.toolCall,
      toolName,
      toolArgs,
      result: createToolErrorResult({
        code: 'SYSTEM.INTERNAL',
        kind: 'internal',
        retryable: true,
        userSafe: false,
        nextAction: 'retry',
        internalMessage: `执行工具 ${toolName}(${argsSummary}) 时出错 [${errorType}]: ${errorMessage}`,
        details: {
          toolName,
          toolArgs: argsSummary,
          errorType,
          errorName,
          elapsedMs: elapsed,
        },
      }),
      elapsed,
    };
  }
}
