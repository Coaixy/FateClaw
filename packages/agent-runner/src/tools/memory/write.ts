/**
 * write_memory 工具 — 整体替换当前账号的长期记忆。
 *
 * 直接更新数据库中的 soul_content。
 * 同时在内存中缓存最新内容，确保同一请求内 read_memory 可立即读取。
 */

import type { ToolSpec } from '../../types.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import { getContext } from '../../context.js';
import { log } from '../../io.js';
import { setPendingSoulContent } from '../../request-scope.js';
import { throwIfAborted } from '../../timeout.js';

export const writeMemory: ToolSpec = {
  executionMode: 'exclusive',
  definition: {
    type: 'function',
    function: {
      name: 'write_memory',
      description:
        '整体替换当前账号的长期记忆 soul.md。使用前应先 read_memory 获取当前内容，修改后写回完整内容。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '替换后的完整 soul.md 内容',
          },
        },
        required: ['content'],
      },
    },
  },

  prompt: `## write_memory — 更新长期记忆

将指定的内容整体替换为当前账号的 soul.md 长期记忆文件。

### 重要：全量替换语义
write_memory 是**全量替换**操作，传入的 content 会完全覆盖原有内容。
因此，正确的使用流程是：
1. 先调用 read_memory 获取当前完整内容。
2. 在原有内容的基础上进行增删改。
3. 将修改后的完整内容通过 write_memory 写回。

**绝对不要**跳过 read_memory 直接写入，否则会丢失已有记忆。

### 适合记录的内容
- 用户主动告知的个人信息（姓名、生日、职业、所在城市等）。
- 用户明确表达的偏好和习惯。
- 重要的里程碑事件或约定。
- 对话中发现的用户性格特点或沟通风格。

### 不适合记录的内容
- 临时性的对话内容或闲聊。
- 用户未明确表达的推测性信息。
- 过于琐碎的日常细节。

### 格式建议
- 使用 Markdown 格式组织内容，便于阅读和维护。
- 按主题分类（如"基本信息""偏好""重要事件"等）。
- 保持简洁，避免冗余描述。`,

  execute: async (args: Record<string, unknown>, options) => {
    const content = args.content as string;
    const accountId = getContext().accountId;
    const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();

    throwIfAborted(options?.signal, 'write_memory 已取消');
    await deps.memoryStore.write(accountId, content);

    // 缓存到内存，确保同一请求内 read_memory 能读到最新内容
    if (options?.requestScope) {
      setPendingSoulContent(options.requestScope, content);
    }

    log(`记忆写入已提交: accountId=${accountId} length=${content.length}`);

    return { output: '记忆已更新。' };
  },
};
