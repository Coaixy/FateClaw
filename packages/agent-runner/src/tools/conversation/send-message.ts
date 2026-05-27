/**
 * send_message 工具 — 在处理过程中发送中间消息给用户。
 *
 * 用于在长时间处理流程中向用户发送进度更新或分段内容。
 * 发送后工具执行继续，最终文本回复由循环结束时的纯文本输出承载。
 */

import type { ToolSpec } from '../../types.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import { getContext } from '../../context.js';
import { log } from '../../io.js';
import {
  canSendIntermediateMessage,
  canSendOutbound,
  getRequestId,
  incrementOutbound,
  incrementSendMessage,
} from '../../request-scope.js';
import { throwIfAborted } from '../../timeout.js';

export const sendMessage: ToolSpec = {
  executionMode: 'exclusive',
  definition: {
    type: 'function',
    function: {
      name: 'send_message',
      description:
        '在处理过程中额外发送一条消息给用户。最终回复会自动发送，此工具用于需要发送多条消息的场景。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要发送给用户的消息内容' },
        },
        required: ['text'],
      },
    },
  },

  prompt: `## send_message — 中间消息发送

在执行多步工具操作时，适度发送中间消息让用户知道你在做什么。但要克制——用户不需要知道每一个步骤的进展。

### 核心原则：整个流程最多发 1 条中间消息
- 一次用户请求中，send_message 最多调用 1 次。只在流程开始时发一条即可，不要每个步骤都发
- 例如排盘+解读的完整流程，只在最开始发"我先帮你排个盘~"，后续步骤不再发进度消息

### 需要发送的场景
- 即将执行耗时较长的多步操作（如排盘+解读），在最开始发一条简短提示
- 检索大量历史消息前

### 不需要发送的场景
- 单个工具调用（如 get_time_detail、read_memory、read_skill_file）
- 工具链中间的每个步骤（排盘完成后不需要再发"正在解读"）
- 用户的闲聊回复（直接回复即可）

### 推荐的消息风格
口语化、简短。例如：
- "我先帮你排个盘~"
- "我翻翻之前的聊天记录"

### 配额
每次请求最多约 9 条出站消息。`,

  execute: async (args: Record<string, unknown>, options) => {
    const text = args.text as string;
    const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();

    if (!options?.requestScope || !canSendOutbound(options.requestScope)) {
      return { output: '消息配额已用完，本条消息已跳过。' };
    }
    if (!canSendIntermediateMessage(options.requestScope)) {
      return { output: '本次请求的中间消息已发送过，已跳过。' };
    }

    const accountId = getContext().accountId;
    const requestId = getRequestId(options.requestScope);

    throwIfAborted(options?.signal, 'send_message 已取消');
    await deps.messageBus.pushOutbox(accountId, {
      type: 'message',
      accountId,
      requestId,
      text,
      timestamp: new Date().toISOString(),
    });

    log(
      `工具结果: send_message accountId=${accountId} requestId=${requestId || '无'} textPreview=${text.slice(0, 80)}`,
    );

    incrementOutbound(options.requestScope);
    incrementSendMessage(options.requestScope);
    return { output: '消息已发送。' };
  },
};
