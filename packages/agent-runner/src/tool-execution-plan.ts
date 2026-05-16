import type { ToolExecutionMode } from './types.js';

export interface ToolExecutionBatch<TToolCall> {
  mode: ToolExecutionMode;
  toolCalls: TToolCall[];
}

/**
 * 按工具调度语义切分执行批次。
 *
 * 规则：
 * - 连续的 parallel 工具可以并发执行
 * - serial / exclusive 工具各自独占一个批次
 * - 批次之间始终按原始顺序串行推进
 */
export function planToolExecutionBatches<TToolCall>(
  toolCalls: TToolCall[],
  resolveMode: (toolCall: TToolCall) => ToolExecutionMode,
): ToolExecutionBatch<TToolCall>[] {
  const batches: ToolExecutionBatch<TToolCall>[] = [];
  let parallelBatch: TToolCall[] = [];

  const flushParallel = () => {
    if (parallelBatch.length === 0) return;
    batches.push({ mode: 'parallel', toolCalls: parallelBatch });
    parallelBatch = [];
  };

  for (const toolCall of toolCalls) {
    const mode = resolveMode(toolCall);
    if (mode === 'parallel') {
      parallelBatch.push(toolCall);
      continue;
    }

    flushParallel();
    batches.push({ mode, toolCalls: [toolCall] });
  }

  flushParallel();
  return batches;
}
