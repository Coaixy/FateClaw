/**
 * read_memory 工具 — 读取当前账号的长期记忆。
 *
 * 从数据库读取 soul_content。
 * 同一请求内如果已经调用过 write_memory，
 * 会优先返回内存缓存中的最新版本。
 */

import type { ToolSpec } from '../../types.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import { getContext } from '../../context.js';
import { log } from '../../io.js';
import { getPendingSoulContent } from '../../request-scope.js';

export const readMemory: ToolSpec = {
  executionMode: 'parallel',
  definition: {
    type: 'function',
    function: {
      name: 'read_memory',
      description: '读取当前账号的长期记忆 soul.md 全文。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },

  prompt: `## read_memory — 读取长期记忆

读取当前账号的 soul.md 长期记忆文件的完整内容。

### 什么是长期记忆
soul.md 是跨对话持久化的记忆文件，存储了用户的个人信息、偏好、重要事件等。
它不同于对话历史（有时间窗口限制），记忆文件的内容会永久保留直到被主动修改。

### 使用场景
- 需要回顾用户曾经告知的个人信息（生日、喜好、重要日期等）。
- 在修改记忆之前，先读取当前内容以便增量更新。
- 确认之前记录的信息是否仍然准确。

### 缓存行为
- 如果在同一次请求中已经调用过 write_memory，read_memory 会直接返回内存缓存中的最新版本，而不是重新读取数据库。
- 这确保了同一请求内 write → read 的一致性。

### 注意事项
- 如果记忆为空，会返回提示信息而非报错。
- 建议在调用 write_memory 之前先 read_memory，避免覆盖已有内容。`,

  execute: async (_args: Record<string, unknown>, options) => {
    const accountId = getContext().accountId;
    const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();

    // 优先返回同一请求内 write_memory 写入的缓存
    const cached = options?.requestScope
      ? getPendingSoulContent(options.requestScope)
      : null;
    if (cached !== null) {
      log(
        `工具结果: read_memory accountId=${accountId} length=${cached.length} (cached)`,
      );
      return { output: cached };
    }

    try {
      const content = await deps.memoryStore.read(accountId);
      if (!content) {
        return { output: '当前账号没有长期记忆。' };
      }
      log(
        `工具结果: read_memory accountId=${accountId} length=${content.length}`,
      );
      return { output: content };
    } catch (error) {
      return {
        output: `读取记忆失败: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};
