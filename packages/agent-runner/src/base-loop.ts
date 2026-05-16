/**
 * 统一 Agent 循环 — base-loop + adapter 模式。
 *
 * 将 openai-loop 和 anthropic-loop 的公共逻辑抽取到这里：
 * while 循环、工具迭代、fallback、token 累加、上下文截断调度。
 * 各 provider 的差异通过 LoopAdapter 泛型接口注入。
 */

import {
  MAX_TOOL_ITERATIONS,
  MAX_TRUNCATION_RETRIES,
  MAX_CONCURRENT_TOOLS,
  MAX_SKILL_CONTEXT_ENTRIES,
  MAX_PROTOCOL_REPAIR_RETRIES,
} from './constants.js';
import { log } from './io.js';
import {
  mapWithConcurrency,
  throwIfAborted,
} from './timeout.js';
import { appendTranscriptEvent } from './transcript-store.js';
import { traceEvent } from './trace.js';
import { planToolExecutionBatches } from './tool-execution-plan.js';
import type { RequestScope } from './request-scope.js';
import type { AgentRuntimeDeps } from './deps.js';
import {
  buildFinalText,
  FINAL_REPLY_DEFINITION,
  FINAL_REPLY_TOOL_NAME,
  PROTOCOL_REPAIR_INSTRUCTION,
  shouldShowSkillInFooter,
} from './loop/final-reply-protocol.js';
import { sendAssistantIntermediateText } from './loop/intermediate-message.js';
import {
  executeLoopTool,
  type ToolExecution,
} from './loop/tool-executor.js';
import {
  formatArgs,
  logLoopSummary,
  sizeLabel,
} from './loop/loop-logging.js';
import {
  accumulateUsage,
  estimateMessagesTokensRough,
  getContextWindowForModel,
  updateCalibration,
  type TokenCalibration,
} from './loop/token-calibration.js';
import {
  reorderToolCallsForSkillDependencies,
} from './loop/tool-call-ordering.js';
import type {
  ChatInputKind,
  ToolDefinition,
  ToolErrorInfo,
  ToolRegistrySnapshot,
  ToolResult,
  TokenUsage,
  SkillContextEntry,
  LlmRuntimeSnapshot,
  UserPastedBoardInput,
  ActiveBoardContext,
} from './types.js';
import type { SystemPromptParts } from './prompt/index.js';

// ---------------------------------------------------------------------------
// Adapter 接口
// ---------------------------------------------------------------------------

export interface CompletionOptions {
  model: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Anthropic 需要（system 不在 messages 里），OpenAI 不用。 */
  systemPrompt?: SystemPromptParts;
  /** 工具选择策略。部分 provider 支持 required，兼容端点可能会降级为 auto。 */
  toolChoice?: 'auto' | 'required';
  /** 当 required 不被端点支持时，是否直接报错而不是降级。 */
  strictToolChoice?: boolean;
  /** 请求级取消信号。 */
  signal?: AbortSignal;
}

export interface CompletionResult<TToolCall> {
  toolCalls: TToolCall[];
  textContent: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
  /** 原始 assistant 消息或消息片段，直接追加到 messages 数组。 */
  rawAssistantMessage: unknown;
}

export interface LoopAdapter<TMsg, TToolCall> {
  readonly providerName: string;

  createCompletion(
    messages: TMsg[],
    options: CompletionOptions,
  ): Promise<CompletionResult<TToolCall>>;

  /** 批量构造工具结果消息。OpenAI 返回多条 tool 消息，Anthropic 返回一条含多个 tool_result block 的 user 消息。 */
  buildToolResultMessages(
    results: Array<{ toolCall: TToolCall; result: ToolResult }>,
  ): TMsg[];

  buildUserMessage(content: string): TMsg;

  isStopDueToLength(result: CompletionResult<TToolCall>): boolean;
  isApiError(error: unknown): boolean;
  getApiErrorStatus(error: unknown): number | undefined;
  getApiErrorMessage(error: unknown): string;

  trimContextIfNeeded(
    messages: TMsg[],
    model: string,
    options?: { aggressive?: boolean; contextWindowTokens?: number },
  ): boolean;

  getToolName(toolCall: TToolCall): string;
  getToolArgs(toolCall: TToolCall): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 历史说明：
// 旧版里曾有“skill 退出门/两步协议”的 prompt 约束。
// 当前实现已改为运行时校验 load_skill 前置条件，模型是否调用某个 skill
// 由 manifest + runtime 决定，不再依赖这里的额外退出门逻辑。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 统一主循环
// ---------------------------------------------------------------------------

export interface AgentLoopResult {
  text: string | null;
  usage: TokenUsage;
  /** 本次请求中所有 run_skill_script 的结果，用于跨请求保留 skill 数据。 */
  skillContext: SkillContextEntry[];
  /** 本次循环结束时的校准系数，可传入下次调用以加速收敛。 */
  calibrationFactor: number;
  /** 本轮最近一次结构化工具错误，供上层决定是否要转成用户提示。 */
  latestToolError: ToolErrorInfo | null;
}

let nextLoopRunSequence = 0;

function createLoopRunId(): string {
  nextLoopRunSequence += 1;
  return `loop-${nextLoopRunSequence}`;
}

/**
 * 循环协议（单通道动作协议）：
 * - 模型调用 final_reply → 提取文本，循环结束
 * - 模型调用其他工具 → 执行工具，结果回注，继续循环
 * - 裸文本 assistant 消息 → 视为协议违例，要求模型修复为合法动作
 */
export async function runAgentLoop<TMsg, TToolCall>(
  adapter: LoopAdapter<TMsg, TToolCall>,
  model: string,
  messages: TMsg[],
  options: {
    systemPrompt?: SystemPromptParts;
    currentUserMessage: string;
    accountId: string;
    /** 上次循环返回的校准系数，用于跨请求持久化。 */
    initialCalibrationFactor?: number;
    requestScope: RequestScope;
    toolRegistry: ToolRegistrySnapshot;
    runtimeDeps: AgentRuntimeDeps;
    llmRuntime: LlmRuntimeSnapshot;
    /** Supervisor 委派时的原始 goal，用于 interpret_xuanxue 等工具获取完整信息。 */
    delegationGoal?: string;
    inputKind?: ChatInputKind;
    pastedBoard?: UserPastedBoardInput;
    activeBoardContext?: ActiveBoardContext;
  },
  signal?: AbortSignal,
): Promise<AgentLoopResult> {
  const loopRunId = createLoopRunId();
  let iterations = 0;
  const totalUsage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const skillContext: SkillContextEntry[] = [];
  const toolsUsed: string[] = [];
  // 本次循环内所有成功执行过的 skill（独立于 skillContext，不受 MAX_SKILL_CONTEXT_ENTRIES 裁剪影响）
  const usedSkills = new Set<string>();
  const sentAssistantIntermediateTexts = new Set<string>();
  let truncationRetries = 0;
  let protocolRepairRetries = 0;
  let lastPlainTextProtocolViolation: string | null = null;
  let latestToolError: ToolErrorInfo | null = null;
  const calibration: TokenCalibration = {
    factor: options.initialCalibrationFactor ?? 1.2,
  };

  const completionOptions: CompletionOptions = {
    model,
    temperature: 0.7,
    maxOutputTokens: options.llmRuntime.maxOutputTokens,
    systemPrompt: options.systemPrompt,
    toolChoice: 'required',
    strictToolChoice: false,
    signal,
  };

  const finishLoop = (text: string | null): AgentLoopResult => ({
    text,
    usage: totalUsage,
    skillContext,
    calibrationFactor: calibration.factor,
    latestToolError,
  });

  while (true) {
    throwIfAborted(signal, 'agent-loop 已取消');
    completionOptions.tools = [
      ...options.toolRegistry.toolDefinitions,
      FINAL_REPLY_DEFINITION,
    ];
    // 1. 上下文预估与截断
    {
      const contextWindow =
        options.llmRuntime.contextWindowTokens ??
        getContextWindowForModel(model);
      const rawEstimate = estimateMessagesTokensRough(messages);
      const calibratedEstimate = Math.ceil(rawEstimate * calibration.factor);
      const limit = Math.floor(contextWindow * 0.8);

      if (iterations === 0) {
        // 首轮：只记录，不截断（首轮数据由宿主机 token-budget 控制）
        log(
          `首轮上下文预估 | ${calibratedEstimate}/${contextWindow} tokens (${Math.round((calibratedEstimate / contextWindow) * 100)}%)`,
        );
      } else if (calibratedEstimate > limit) {
        const aggressive = calibratedEstimate > contextWindow * 0.9;
        const trimmed = adapter.trimContextIfNeeded(messages, model, {
          aggressive,
          contextWindowTokens: options.llmRuntime.contextWindowTokens,
        });
        if (trimmed) {
          log(
            `上下文截断 | 已用=${calibratedEstimate}/${limit} token | 策略=${aggressive ? '激进' : '常规'}`,
          );
          traceEvent({
            type: 'context_trimmed',
            provider: adapter.providerName,
            iteration: iterations,
            calibratedEstimate,
            limit,
          }, options.requestScope);
        }
      }
    }

    // 1.5 API 调用前记录当前粗估 token 数（用于调用后校准）
    const preCallEstimate = estimateMessagesTokensRough(messages);

    log(
      `第${iterations}轮 | model=${model} | 消息数=${messages.length} | 预估token=${Math.ceil(preCallEstimate * calibration.factor)}`,
    );

    // 2. 调用 API
    let result: CompletionResult<TToolCall>;
    try {
      result = await adapter.createCompletion(messages, completionOptions);
      throwIfAborted(signal, 'agent-loop 已取消');
      truncationRetries = 0; // API 调用成功，重置截断重试计数
    } catch (error) {
      if (
        adapter.isApiError(error) &&
        adapter.getApiErrorStatus(error) === 429
      ) {
        // 1B: SDK maxRetries 耗尽后的 429，优雅返回而非抛出原始错误
        log(
          `API 429 速率限制 (iteration=${iterations}): ${adapter.getApiErrorMessage(error)}`,
        );
        traceEvent({
          type: 'rate_limit',
          provider: adapter.providerName,
          iteration: iterations,
          error: adapter.getApiErrorMessage(error),
        }, options.requestScope);
        logLoopSummary(iterations, toolsUsed, totalUsage);
        return finishLoop('当前请求量较大，请稍后再试');
      } else if (
        adapter.isApiError(error) &&
        (adapter.getApiErrorStatus(error) === 400 ||
          adapter.getApiErrorStatus(error) === 413) &&
        /token|context|length|too.long|maximum/i.test(
          adapter.getApiErrorMessage(error),
        )
      ) {
        log(
          `API ${adapter.getApiErrorStatus(error)} 错误，疑似上下文过长: ${adapter.getApiErrorMessage(error)}`,
        );
        traceEvent({
          type: 'context_too_long',
          provider: adapter.providerName,
          iteration: iterations,
          error: adapter.getApiErrorMessage(error),
        }, options.requestScope);
        // 1A: 截断重试有上限，防止截断不足导致无限循环
        truncationRetries++;
        if (
          truncationRetries <= MAX_TRUNCATION_RETRIES &&
          adapter.trimContextIfNeeded(messages, model, {
            aggressive: true,
            contextWindowTokens: options.llmRuntime.contextWindowTokens,
          })
        ) {
          log(`截断重试 ${truncationRetries}/${MAX_TRUNCATION_RETRIES}`);
          continue;
        }
        logLoopSummary(iterations, toolsUsed, totalUsage);
        return finishLoop('消息内容过长，请精简后重试');
      } else {
        throw error;
      }
    }

    // 3. 累加 token + 校准
    if (result.usage) {
      accumulateUsage(totalUsage, result.usage);
      if (result.usage.promptTokens > 0 && preCallEstimate > 0) {
        updateCalibration(
          calibration,
          preCallEstimate,
          result.usage.promptTokens,
        );
      }

      log(
        `本轮token | 输入=${result.usage.promptTokens} 输出=${result.usage.completionTokens} | 累计: 输入=${totalUsage.promptTokens} 输出=${totalUsage.completionTokens}`,
      );
    }

    // 4. 追加 assistant 消息
    throwIfAborted(signal, 'agent-loop 已取消');
    if (Array.isArray(result.rawAssistantMessage)) {
      messages.push(...(result.rawAssistantMessage as TMsg[]));
    } else {
      messages.push(result.rawAssistantMessage as TMsg);
    }
    if (result.textContent) {
      appendTranscriptEvent(options.requestScope, {
        type: 'assistant',
        text: result.textContent,
      });
    }

    const toolCalls = result.toolCalls;

    // 5. 输出截断 fallback（响应被截断且包含工具调用）
    if (toolCalls.length > 0 && adapter.isStopDueToLength(result)) {
      log(
        `响应被截断 | 包含${toolCalls.length}个工具调用 | 返回输出截断错误`,
      );
      logLoopSummary(iterations, toolsUsed, totalUsage);
      traceEvent({
        type: 'tool_call_output_truncated',
        provider: adapter.providerName,
        iteration: iterations,
        toolCount: toolCalls.length,
        finishReason: result.finishReason,
      }, options.requestScope);
      messages.pop();
      adapter.trimContextIfNeeded(messages, model, {
        aggressive: true,
        contextWindowTokens: options.llmRuntime.contextWindowTokens,
      });
      return finishLoop('模型本轮工具调用输出被截断，请重试或缩短本轮请求后再试');
    }

    // 6. 无工具调用：视为协议违例，要求模型修复为合法动作
    if (toolCalls.length === 0) {
      const text = result.textContent ?? '';
      if (text.trim()) {
        lastPlainTextProtocolViolation = text;
      }
      protocolRepairRetries++;
      iterations += 1; // 修复轮次也计入迭代守卫
      log(
        `第${iterations}轮 | 协议违例：收到裸文本而非动作 | 第${protocolRepairRetries}次 | ${sizeLabel(text.length)}`,
      );
      traceEvent({
        type: 'protocol_violation',
        provider: adapter.providerName,
        iteration: iterations,
        textLength: text.length,
        textPreview: text.slice(0, 500),
        repairAttempt: protocolRepairRetries,
      }, options.requestScope);
      if (
        protocolRepairRetries <= MAX_PROTOCOL_REPAIR_RETRIES &&
        iterations < MAX_TOOL_ITERATIONS
      ) {
        messages.push(
          adapter.buildUserMessage(
            PROTOCOL_REPAIR_INSTRUCTION,
          ),
        );
        continue;
      }

      if (lastPlainTextProtocolViolation) {
        const textWithFooter = buildFinalText(
          lastPlainTextProtocolViolation,
          usedSkills,
        );
        log(
          `协议修复失败，降级发送裸文本最终回复 | ${sizeLabel(lastPlainTextProtocolViolation.length)} | 第${iterations}轮`,
        );
        logLoopSummary(iterations, toolsUsed, totalUsage);
        traceEvent({
          type: 'plain_text_final_fallback',
          provider: adapter.providerName,
          iteration: iterations,
          textLength: lastPlainTextProtocolViolation.length,
          repairAttempt: protocolRepairRetries,
          usedSkills: Array.from(usedSkills),
        }, options.requestScope);
        return finishLoop(textWithFooter);
      }

      logLoopSummary(iterations, toolsUsed, totalUsage);
      return finishLoop('消息处理中遇到协议错误，请稍后重试');
    }
    protocolRepairRetries = 0;
    lastPlainTextProtocolViolation = null;

    // 7. 有工具调用 — 拦截 final_reply，执行其他工具
    iterations += 1;
    if (iterations >= MAX_TOOL_ITERATIONS) {
      throw new Error(`已达到最大工具迭代次数 (${MAX_TOOL_ITERATIONS})`);
    }

    // 分拣 final_reply 和常规工具
    let finalReplyTc: TToolCall | null = null;
    let finalReplyText: string | null = null;
    const regularToolCalls: TToolCall[] = [];

    for (const tc of toolCalls) {
      try {
        const name = adapter.getToolName(tc);
        if (name === FINAL_REPLY_TOOL_NAME) {
          finalReplyTc = tc;
          const args = adapter.getToolArgs(tc);
          finalReplyText = typeof args.text === 'string' ? args.text : '';
        } else {
          regularToolCalls.push(tc);
        }
      } catch {
        regularToolCalls.push(tc);
      }
    }

    if (finalReplyTc !== null && regularToolCalls.length > 0) {
      log(
        `第${iterations}轮 | 协议违例：final_reply 与普通工具同轮出现，忽略 final_reply 并执行工具 | toolCount=${regularToolCalls.length + 1}`,
      );
      traceEvent({
        type: 'protocol_violation',
        provider: adapter.providerName,
        iteration: iterations,
        reason: 'mixed_final_reply_and_tools',
        action: 'ignore_final_reply_execute_tools',
        toolCount: regularToolCalls.length + 1,
        regularTools: regularToolCalls.map((tc) => {
          try {
            return adapter.getToolName(tc);
          } catch {
            return 'unknown';
          }
        }),
      }, options.requestScope);
      finalReplyTc = null;
      finalReplyText = null;
    }

    if (regularToolCalls.length > 0 && result.textContent?.trim()) {
      await sendAssistantIntermediateText({
        accountId: options.accountId,
        text: result.textContent,
        requestScope: options.requestScope,
        runtimeDeps: options.runtimeDeps,
        provider: adapter.providerName,
        iteration: iterations,
        sentTexts: sentAssistantIntermediateTexts,
        signal,
      });
    }

    // ── AI 编排日志：展示模型的推理文本 + 本轮计划调用的工具 ──
    const plannedTools = regularToolCalls.map((tc) => {
      try {
        const n = adapter.getToolName(tc);
        const a = adapter.getToolArgs(tc);
        return `${n}(${formatArgs(a, 30)})`;
      } catch {
        return '(parse error)';
      }
    });
    if (finalReplyTc) {
      plannedTools.push(
        `final_reply(${sizeLabel((finalReplyText ?? '').length)})`,
      );
    }

    const reasoning = result.textContent?.trim();
    if (reasoning) {
      log(
        `AI 推理 | ${reasoning.length > 200 ? reasoning.slice(0, 200) + '…' : reasoning}`,
      );
    }
    log(
      `AI 编排 | 第${iterations}轮 | 计划调用 ${plannedTools.length} 个工具: ${plannedTools.join(', ')}`,
    );
    traceEvent({
      type: 'ai_orchestration',
      provider: adapter.providerName,
      iteration: iterations,
      reasoning: reasoning?.slice(0, 500),
      plannedTools: regularToolCalls.map((tc) => {
        try {
          return adapter.getToolName(tc);
        } catch {
          return 'unknown';
        }
      }),
      hasFinalReply: finalReplyTc !== null,
    }, options.requestScope);

    const scheduledToolCalls = reorderToolCallsForSkillDependencies(
      regularToolCalls,
      (toolCall) => adapter.getToolName(toolCall),
      (toolCall) => adapter.getToolArgs(toolCall),
    );
    const plannedRunSkillScripts = new Set<string>();
    if (scheduledToolCalls !== regularToolCalls) {
      log(
        `工具重排 | 第${iterations}轮 | 已将 load_skill 前置到依赖它的 skill 工具之前`,
      );
      traceEvent({
        type: 'tool_reordered',
        provider: adapter.providerName,
        iteration: iterations,
        reason: 'load_skill_dependency',
        originalTools: regularToolCalls.map((tc) => {
          try {
            return adapter.getToolName(tc);
          } catch {
            return 'unknown';
          }
        }),
        reorderedTools: scheduledToolCalls.map((tc) => {
          try {
            return adapter.getToolName(tc);
          } catch {
            return 'unknown';
          }
        }),
      }, options.requestScope);
    }

    const executeSingleTool = async (
      tc: TToolCall,
      idx: number,
    ): Promise<ToolExecution<TToolCall>> =>
      executeLoopTool({
        adapter,
        toolCall: tc,
        toolIndex: idx,
        iteration: iterations,
        loopRunId,
        accountId: options.accountId,
        model,
        requestScope: options.requestScope,
        toolRegistry: options.toolRegistry,
        runtimeDeps: options.runtimeDeps,
        llmRuntime: options.llmRuntime,
        plannedRunSkillScripts,
        signal,
        delegationGoal: options.delegationGoal,
        inputKind: options.inputKind,
        pastedBoard: options.pastedBoard,
        activeBoardContext: options.activeBoardContext,
      });

    const executionBatches = planToolExecutionBatches(
      scheduledToolCalls,
      (toolCall) => {
        try {
          return options.toolRegistry.getExecutionMode(
            adapter.getToolName(toolCall),
          );
        } catch {
          return 'serial';
        }
      },
    );

    const toolExecutions: ToolExecution<TToolCall>[] = [];
    let toolIndex = 0;
    let earlyFinalFound = false;

    for (const batch of executionBatches) {
      if (earlyFinalFound) break;

      if (batch.mode === 'parallel') {
        const parallelResults = await mapWithConcurrency(
          batch.toolCalls,
          MAX_CONCURRENT_TOOLS,
          async (toolCall, batchIdx) =>
            executeSingleTool(toolCall, toolIndex + batchIdx),
        );
        toolExecutions.push(...parallelResults);
      } else {
        for (const toolCall of batch.toolCalls) {
          const exec = await executeSingleTool(toolCall, toolIndex);
          toolExecutions.push(exec);
          toolIndex += 1;
          // 串行执行时，遇到 delivery: 'final' 立即停止后续批次
          if (!exec.result.isError && exec.result.delivery === 'final') {
            earlyFinalFound = true;
            break;
          }
        }
        continue;
      }
      toolIndex += batch.toolCalls.length;
    }

    // 按原始顺序汇总结果
    const toolResults: Array<{ toolCall: TToolCall; result: ToolResult }> = [];
    throwIfAborted(signal, '工具执行已取消');
    for (const exec of toolExecutions) {
      const succeeded = !exec.result.isError;
      toolsUsed.push(exec.toolName);
      accumulateUsage(totalUsage, exec.result.usage);
      toolResults.push({ toolCall: exec.toolCall, result: exec.result });
      if (exec.result.isError && exec.result.error) {
        latestToolError = exec.result.error;
      }
      if (exec.skillContextEntry && succeeded) {
        skillContext.push(exec.skillContextEntry);
        if (shouldShowSkillInFooter(exec.skillContextEntry)) {
          usedSkills.add(exec.skillContextEntry.skill);
        }
        while (skillContext.length > MAX_SKILL_CONTEXT_ENTRIES) {
          skillContext.shift();
        }
      }
    }

    const directFinalExecution = (() => {
      const directFinals = toolExecutions.filter(
        (exec) => !exec.result.isError && exec.result.delivery === 'final',
      );
      if (directFinals.length === 0) return null;

      // 终结工具名称集合（它们的输出不应覆盖其他 skill 的直通输出）
      const terminalTools = new Set(['final_reply', 'emit_final', 'ask_user']);

      // 优先选择非终结工具的 delivery: 'final' 结果
      const skillFinal = directFinals.find(
        (exec) => !terminalTools.has(exec.toolName),
      );
      const selectedFinal = skillFinal ?? (directFinals.length === 1 ? directFinals[0] : null);
      if (!selectedFinal) return null;

      // 检查是否有其他非 passthrough-safe 的成功工具阻止直通
      // check_artifacts 是只读查询工具，不阻止直通
      const passthroughSafeTools = new Set(['send_message', 'check_artifacts', ...terminalTools]);
      const otherSuccessfulTools = toolExecutions.filter(
        (exec) =>
          exec !== selectedFinal &&
          !exec.result.isError,
      );
      if (
        otherSuccessfulTools.some(
          (exec) =>
            !passthroughSafeTools.has(exec.toolName) &&
            !exec.result.passthroughSafe,
        )
      ) {
        return null;
      }
      if (toolExecutions.some((exec) => exec.result.isError)) {
        return null;
      }
      return selectedFinal;
    })();

    if (directFinalExecution) {
      const baseText = directFinalExecution.result.output;
      const textWithFooter = buildFinalText(baseText, usedSkills);
      log(
        `工具直通最终回复 | tool=${directFinalExecution.toolName} | ${sizeLabel(baseText.length)} | 第${iterations}轮 | skill=${usedSkills.size}`,
      );
      logLoopSummary(iterations, toolsUsed, totalUsage);
      traceEvent({
        type: 'tool_direct_reply',
        provider: adapter.providerName,
        iteration: iterations,
        toolName: directFinalExecution.toolName,
        textLength: baseText.length,
        usedSkills: Array.from(usedSkills),
      }, options.requestScope);
      return finishLoop(textWithFooter);
    }

    // final_reply：直接放行，返回最终回复
    if (finalReplyTc !== null) {
      const baseText = finalReplyText ?? '';
      const textWithFooter = buildFinalText(baseText, usedSkills);

      log(
        `最终回复 | ${sizeLabel(baseText.length)} | 第${iterations}轮 | skill=${usedSkills.size}`,
      );
      logLoopSummary(iterations, toolsUsed, totalUsage);
      traceEvent({
        type: 'final_reply',
        provider: adapter.providerName,
        iteration: iterations,
        textLength: baseText.length,
        usedSkills: Array.from(usedSkills),
      }, options.requestScope);
      return finishLoop(textWithFooter);
    }

    // 本轮汇总 trace（合并原 model_response + token_usage）
    traceEvent({
      type: 'loop_iteration',
      provider: adapter.providerName,
      iteration: iterations,
      model,
      toolCalls: regularToolCalls.map((tc) => {
        try {
          return adapter.getToolName(tc);
        } catch {
          return 'unknown';
        }
      }),
      toolResults: toolResults.map((tr) => {
        const n = (() => {
          try {
            return adapter.getToolName(tr.toolCall);
          } catch {
            return 'unknown';
          }
        })();
        return {
          tool: n,
          ok: !tr.result.isError,
          outputLength: tr.result.output.length,
          errorCode: tr.result.error?.code,
        };
      }),
      hasFinalReply: finalReplyTc !== null,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
      finishReason: result.finishReason,
    }, options.requestScope);

    // 注入工具结果继续循环
    const resultMessages = adapter.buildToolResultMessages(toolResults);
    messages.push(...resultMessages);
  }
}
